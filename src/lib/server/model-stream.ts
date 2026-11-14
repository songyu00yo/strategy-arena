import type { ModelProvider } from "../contracts";
import { StreamPreview, type ModelPreviewCallback } from "./stream-preview";

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid stream object");
  return value as Json;
}
type Call = { name: string; arguments: string; type: string; id?: string; emitted: number };

/** Parse transport frames independently of network chunks, including CRLF and multi-line data. */
async function* streamEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("Model stream size limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Model stream frame size limit");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
    // An unterminated frame has no transport-level completion guarantee.
    if (buffer.trim() && !buffer.trim().startsWith(":"))
      throw new Error("Truncated model stream frame");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface StreamResponse {
  value: unknown;
  protocolError?: string;
}
export async function readModelStream(
  response: Response,
  provider: ModelProvider,
  functionName: string,
  strict: boolean,
  stage: string,
  onPreview?: ModelPreviewCallback,
): Promise<StreamResponse> {
  if (!response.body) throw new Error("Missing model stream body");
  const preview = new StreamPreview(stage, onPreview);
  const calls = new Map<number | string, Call>();
  let text = "";
  let finish: string | null = null;
  let usage: unknown;
  let id: unknown;
  let model: unknown;
  let terminal: Json | undefined;
  let protocolError: string | undefined;
  function emitCall(call: Call) {
    if (protocolError || call.name !== functionName || call.type !== "function" || calls.size !== 1)
      return;
    preview.feed(call.arguments.slice(call.emitted));
    call.emitted = call.arguments.length;
  }
  function append(call: Call, delta: unknown) {
    if (typeof delta !== "string") throw new Error("Invalid model argument delta");
    call.arguments += delta;
    if (call.arguments.length > 256_000) throw new Error("Model argument size limit");
    emitCall(call);
  }
  for await (const data of streamEvents(response.body)) {
    if (data === "[DONE]") break;
    try {
      const event = object(JSON.parse(data));
      if (provider === "openai") {
        const type = event.type;
        if (
          ["response.completed", "response.incomplete", "response.failed"].includes(String(type))
        ) {
          terminal = object(event.response);
          if (terminal.status !== String(type).slice("response.".length))
            protocolError = "流式结束事件与响应状态不一致。";
          break; // The terminal response contains the authoritative final output and usage.
        }
        if (type === "error" || event.error) throw new Error("Model stream error");
        if (type === "response.output_item.added") {
          const item = object(event.item);
          if (item.type !== "function_call") continue;
          if (typeof item.id !== "string" || typeof item.name !== "string")
            throw new Error("Invalid model function item");
          if (calls.has(item.id)) throw new Error("Duplicate model function item");
          const call: Call = {
            id: item.id,
            type: "function",
            name: item.name,
            arguments: "",
            emitted: 0,
          };
          calls.set(item.id, call);
          if (typeof item.arguments === "string" && item.arguments) append(call, item.arguments);
        } else if (type === "response.function_call_arguments.delta") {
          const call = calls.get(String(event.item_id));
          if (!call) throw new Error("Unknown model function item");
          append(call, event.delta);
        } else if (type === "response.function_call_arguments.done") {
          const call = calls.get(String(event.item_id));
          if (!call || typeof event.arguments !== "string")
            throw new Error("Invalid model function completion");
          if (call.arguments !== event.arguments) protocolError = "流式函数参数与最终参数不一致。";
        } else if (!strict && type === "response.output_text.delta") {
          if (typeof event.delta !== "string") throw new Error("Invalid model text delta");
          text += event.delta;
          if (text.length > 256_000) throw new Error("Model text size limit");
          if (!protocolError) preview.feed(event.delta);
        }
      } else {
        if (event.error) throw new Error("Model stream error");
        if (event.id !== undefined) id = event.id;
        if (event.model !== undefined) model = event.model;
        if (event.usage !== undefined && event.usage !== null) usage = event.usage;
        if (!Array.isArray(event.choices)) throw new Error("Missing model stream choices");
        for (const rawChoice of event.choices) {
          const choice = object(rawChoice);
          if (choice.index !== 0) throw new Error("Unexpected model choice index");
          if (typeof choice.finish_reason === "string") {
            if (finish && finish !== choice.finish_reason)
              throw new Error("Conflicting model finish reasons");
            finish = choice.finish_reason;
          }
          const delta = choice.delta === undefined ? {} : object(choice.delta);
          if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls)) throw new Error("Invalid model calls delta");
            for (const rawCall of delta.tool_calls) {
              const part = object(rawCall);
              if (
                !Number.isSafeInteger(part.index) ||
                Number(part.index) < 0 ||
                Number(part.index) > 8
              )
                throw new Error("Invalid model call index");
              const index = Number(part.index);
              const call = calls.get(index) ?? { name: "", arguments: "", type: "", emitted: 0 };
              calls.set(index, call);
              if (typeof part.id === "string") call.id = part.id;
              if (typeof part.type === "string") call.type = part.type;
              if (part.function !== undefined) {
                const fn = object(part.function);
                if (typeof fn.name === "string") call.name += fn.name;
                if (fn.arguments !== undefined) append(call, fn.arguments);
                else emitCall(call);
              }
            }
          }
          if (!strict && typeof delta.content === "string") {
            text += delta.content;
            if (text.length > 256_000) throw new Error("Model text size limit");
            if (!protocolError) preview.feed(delta.content);
          }
        }
      }
    } catch {
      // Keep draining a malformed event stream to its final billing metadata.
      protocolError = "模型流式事件结构无效。";
    }
  }
  if (provider === "openai") {
    if (!terminal) throw new Error("Missing terminal model response");
    try {
      if (Array.isArray(terminal.output)) {
        const finalCalls = terminal.output
          .map(object)
          .filter((item) => item.type === "function_call");
        for (const call of calls.values()) {
          const final = finalCalls.find((item) => item.id === call.id);
          if (!final || final.name !== call.name || final.arguments !== call.arguments)
            protocolError = "流式函数参数与最终参数不一致。";
        }
        if (!strict && text) {
          const finalText = terminal.output
            .map(object)
            .filter((item) => item.type === "message")
            .flatMap((item) => (Array.isArray(item.content) ? item.content.map(object) : []))
            .filter((part) => part.type === "output_text")
            .map((part) => part.text)
            .join("");
          if (text !== finalText) protocolError = "流式正文与最终正文不一致。";
        }
      }
    } catch {
      // Final usage remains authoritative even when the final output structure is invalid.
      protocolError = "流式最终输出结构无效。";
    }
    return { value: terminal, protocolError };
  }
  if (!finish || !usage) throw new Error("Missing final model usage or finish reason");
  return {
    protocolError,
    value: {
      id,
      model,
      usage,
      choices: [
        {
          finish_reason: finish,
          message: {
            content: text,
            tool_calls: [...calls.entries()]
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([, call]) => ({
                id: call.id,
                type: call.type,
                function: { name: call.name, arguments: call.arguments },
              })),
          },
        },
      ],
    },
  };
}
