/** Synthetic SSE transport, preview and billing regression coverage. No paid calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured, ModelCallError } from "../src/lib/server/model";
import { readModelStream } from "../src/lib/server/model-stream";
import {
  StreamPreview,
  type ModelPreview,
  MAX_PREVIEW_FIELD_CHARS,
  MAX_PREVIEW_FIELDS,
  MAX_PREVIEW_TOTAL_CHARS,
} from "../src/lib/server/stream-preview";

const billing = vi.hoisted(() => ({
  reserveBilling: vi.fn(),
  settleBilling: vi.fn(),
  holdBilling: vi.fn(),
}));
vi.mock("../src/lib/server/billing", async (original) => ({
  ...(await original<typeof import("../src/lib/server/billing")>()),
  ...billing,
}));
const output = { title: '先比较"路线"😀', steps: ["核实条件", "再作决定"] };
const argumentsText = JSON.stringify(output);
function frames(events: unknown[], ending = true) {
  return (
    events.map((event) => `event: fixture\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("") +
    (ending ? "data: [DONE]\r\n\r\n" : "")
  );
}
function streamResponse(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset = Math.min(offset + chunkSize, bytes.length);
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}
function deepseekEvents(args = argumentsText, functionName = "submit_agent_plan") {
  return [
    {
      id: "ds-fixture",
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "hidden internal reasoning",
            tool_calls: [
              {
                index: 0,
                type: "function",
                id: "call-1",
                function: { name: functionName, arguments: "" },
              },
            ],
          },
        },
      ],
    },
    ...Array.from(args, (delta) => ({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: delta } }] } },
      ],
    })),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    {
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 0 },
    },
  ];
}
function openaiTerminal(args = argumentsText) {
  return {
    id: "oa-fixture",
    model: "gpt-6.1-terra",
    service_tier: "default",
    status: "completed",
    output: [
      { type: "reasoning", id: "hidden" },
      {
        type: "function_call",
        id: "item-1",
        call_id: "call-1",
        name: "submit_agent_plan",
        arguments: args,
        status: "completed",
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  };
}
function openaiEvents(args = argumentsText) {
  return [
    { type: "response.created", response: { id: "oa-fixture", status: "in_progress" } },
    { type: "response.output_item.added", item: { type: "reasoning", id: "hidden" } },
    { type: "response.reasoning_text.delta", delta: "hidden internal reasoning" },
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "item-1", name: "submit_agent_plan", arguments: "" },
    },
    ...Array.from(args, (delta) => ({
      type: "response.function_call_arguments.delta",
      item_id: "item-1",
      delta,
    })),
    { type: "response.function_call_arguments.done", item_id: "item-1", arguments: args },
    { type: "response.output_item.done", item: openaiTerminal(args).output[1] },
    { type: "response.completed", response: openaiTerminal(args) },
  ];
}
const request = {
  name: "agent_plan",
  schema: z.object({ title: z.string(), steps: z.array(z.string()) }),
  system: "fixture",
  input: {},
  attemptId: "stream-fixture",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-not-secret");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-not-secret");
  vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com/beta");
  vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "strict-tool");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("incremental JSON display strings", () => {
  it("bounds individual fields, the displayed field count and cumulative draft size", () => {
    const latest = new Map<string, string>();
    const parser = new StreamPreview("propose", (p) => {
      latest.set(p.field, p.text);
    });
    const json = JSON.stringify({
      title: "x".repeat(3000),
      steps: Array.from({ length: 100 }, () => "y".repeat(1000)),
    });
    for (let index = 0; index < json.length; index += 100)
      parser.feed(json.slice(index, index + 100));
    expect(latest.size).toBeGreaterThan(0);
    expect(latest.size).toBeLessThanOrEqual(MAX_PREVIEW_FIELDS);
    expect([...latest.values()].every((text) => text.length <= MAX_PREVIEW_FIELD_CHARS)).toBe(true);
    expect([...latest.values()].reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(
      MAX_PREVIEW_TOTAL_CHARS,
    );
  });
  it("decodes escaped strings and split Unicode without exposing keys or private fields", () => {
    const previews: ModelPreview[] = [];
    const parser = new StreamPreview("propose", (preview) => {
      previews.push(preview);
    });
    const text =
      '{"reasoning":"SECRET","tool":{"title":"SECRET"},"title":"路\\u7ebf\\n\\\"A\\\"\\ud83d\\ude00","steps":["先查","再做"]}';
    for (const char of text) parser.feed(char);
    expect(previews.at(-1)).toMatchObject({ stage: "propose", field: "steps.1", text: "再做" });
    expect(previews.filter((p) => p.field === "title").at(-1)?.text).toBe('路线\n"A"😀');
    expect(previews.some((p) => p.text.includes("SECRET"))).toBe(false);
    expect(previews.some((p) => /[\uD800-\uDBFF]$/.test(p.text))).toBe(false);
  });
  it("disables malformed, duplicate-key and over-depth previews without throwing into execution", () => {
    for (const text of [
      '{"title":"ok","title":"SECRET"}',
      '{"title":"bad\\xSECRET"}',
      "[".repeat(34) + '{"title":"SECRET"}',
    ]) {
      const previews: ModelPreview[] = [];
      const parser = new StreamPreview("judge", (preview) => {
        previews.push(preview);
      });
      expect(() => {
        for (const char of text) parser.feed(char);
      }).not.toThrow();
      expect(previews.some((p) => p.text.includes("SECRET"))).toBe(false);
    }
  });
});

describe("streamed provider structured output", () => {
  it.each(["deepseek", "openai"] as const)(
    "receives %s one-byte SSE, emits real previews before terminal and settles once",
    async (provider) => {
      const previews: ModelPreview[] = [];
      const events = provider === "openai" ? openaiEvents() : deepseekEvents();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          const body = JSON.parse(init.body);
          expect(body.stream).toBe(true);
          if (provider === "deepseek") expect(body.stream_options).toEqual({ include_usage: true });
          return streamResponse(frames(events));
        }),
      );
      const result = await generateStructured({
        ...request,
        modelMode: provider === "openai" ? "gpt-6.1-terra" : "deepseek",
        onPreview: (preview) => {
          expect(billing.settleBilling).not.toHaveBeenCalled();
          previews.push(preview);
        },
      });
      expect(result.value).toEqual(output);
      expect(previews.some((p) => p.text === output.title)).toBe(true);
      expect(previews.every((p) => p.stage === "agent_plan")).toBe(true);
      expect(previews.some((p) => p.text.includes("hidden"))).toBe(false);
      expect(billing.reserveBilling).toHaveBeenCalledTimes(1);
      expect(billing.settleBilling).toHaveBeenCalledTimes(1);
      expect(billing.holdBilling).not.toHaveBeenCalled();
    },
  );
  it("keeps receiving and billing when a preview consumer throws or rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(frames(deepseekEvents()))),
    );
    const callback = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("viewer disconnected");
      })
      .mockRejectedValue(new Error("preview storage unavailable"));
    expect(
      (await generateStructured({ ...request, modelMode: "deepseek", onPreview: callback })).value,
    ).toEqual(output);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it.each(["deepseek", "openai"] as const)(
    "holds %s missing terminal usage without retry",
    async (provider) => {
      const events =
        provider === "openai" ? openaiEvents().slice(0, -1) : deepseekEvents().slice(0, -1);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => streamResponse(frames(events))),
      );
      await expect(
        generateStructured({
          ...request,
          modelMode: provider === "openai" ? "gpt-6.1-terra" : "deepseek",
        }),
      ).rejects.toMatchObject({ uncertain: true });
      expect(billing.holdBilling).toHaveBeenCalledTimes(1);
      expect(billing.settleBilling).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("settles known usage before rejecting mismatched OpenAI deltas", async () => {
    const events = openaiEvents();
    events[events.length - 1] = {
      type: "response.completed",
      response: openaiTerminal('{"title":"changed","steps":[]}'),
    } as (typeof events)[number];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(frames(events))),
    );
    await expect(
      generateStructured({ ...request, modelMode: "gpt-6.1-terra" }),
    ).rejects.toMatchObject({ uncertain: false, usage: { inputTokens: 100 } });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("settles known usage before rejecting malformed final JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(frames(deepseekEvents('{"title":')))),
    );
    await expect(generateStructured({ ...request, modelMode: "deepseek" })).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100 },
    });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("settles final usage before rejecting duplicate keys that JSON.parse alone would accept", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(frames(deepseekEvents('{"title":"first","title":"second","steps":[]}'))),
      ),
    );
    await expect(generateStructured({ ...request, modelMode: "deepseek" })).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100 },
    });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("drains a malformed intermediate event to final usage before rejecting the request", async () => {
    const text = 'data: {"invalid":\n\n' + frames(deepseekEvents());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(text)),
    );
    await expect(generateStructured({ ...request, modelMode: "deepseek" })).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100 },
    });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("rejects unexpected function names without exposing arguments", async () => {
    const previews: ModelPreview[] = [];
    const events = deepseekEvents(argumentsText, "submit_unauthorized");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(frames(events))),
    );
    await expect(
      generateStructured({
        ...request,
        modelMode: "deepseek",
        onPreview: (p) => {
          previews.push(p);
        },
      }),
    ).rejects.toBeInstanceOf(ModelCallError);
    expect(previews).toEqual([]);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("does not require a trailing sentinel after a complete OpenAI terminal response", async () => {
    const result = await readModelStream(
      streamResponse(frames(openaiEvents(), false), 100),
      "openai",
      "submit_agent_plan",
      true,
      "agent_plan",
    );
    expect(result.value).toEqual(openaiTerminal());
  });
  it("settles an OpenAI incomplete response using its final reported usage", async () => {
    const terminal = {
      ...openaiTerminal(),
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(frames([{ type: "response.incomplete", response: terminal }])),
      ),
    );
    await expect(
      generateStructured({ ...request, modelMode: "gpt-6.1-terra" }),
    ).rejects.toMatchObject({
      uncertain: false,
      usage: { outputTokens: 40 },
    });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("retains final known usage when OpenAI output entries are invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(
          frames([
            { type: "response.completed", response: { ...openaiTerminal(), output: [null] } },
          ]),
        ),
      ),
    );
    await expect(
      generateStructured({ ...request, modelMode: "gpt-6.1-terra" }),
    ).rejects.toMatchObject({
      uncertain: false,
      usage: { outputTokens: 40 },
    });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("refuses multiple DeepSeek function calls after settling known usage", async () => {
    const events = deepseekEvents();
    const first = events[0] as { choices: { delta: { tool_calls: unknown[] } }[] };
    first.choices[0].delta.tool_calls.push({
      index: 1,
      type: "function",
      id: "call-2",
      function: { name: "submit_agent_plan", arguments: argumentsText },
    });
    const previews: ModelPreview[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(frames(events))),
    );
    await expect(
      generateStructured({
        ...request,
        modelMode: "deepseek",
        onPreview: (p) => {
          previews.push(p);
        },
      }),
    ).rejects.toMatchObject({ uncertain: false });
    expect(previews).toEqual([]);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("holds a broken network body and never retries", async () => {
    const bytes = new TextEncoder().encode(frames(deepseekEvents().slice(0, 2), false));
    let started = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (!started) {
                  started = true;
                  controller.enqueue(bytes);
                } else controller.error(new Error("synthetic connection reset"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    await expect(generateStructured({ ...request, modelMode: "deepseek" })).rejects.toMatchObject({
      uncertain: true,
    });
    expect(billing.holdBilling).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["deepseek", "openai"] as const)(
    "supports %s JSON text deltas using the same safe preview paths",
    async (provider) => {
      const previews: ModelPreview[] = [];
      const events =
        provider === "deepseek"
          ? [
              ...Array.from(argumentsText, (content) => ({
                id: "text-fixture",
                model: "deepseek-chat",
                choices: [{ index: 0, delta: { content } }],
              })),
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              { choices: [], usage: { prompt_tokens: 100, completion_tokens: 40 } },
            ]
          : [
              ...Array.from(argumentsText, (delta) => ({
                type: "response.output_text.delta",
                delta,
              })),
              {
                type: "response.completed",
                response: {
                  ...openaiTerminal(),
                  output: [
                    { type: "message", content: [{ type: "output_text", text: argumentsText }] },
                  ],
                },
              },
            ];
      const result = await readModelStream(
        streamResponse(frames(events)),
        provider,
        "submit_agent_plan",
        false,
        "judge",
        (p) => {
          previews.push(p);
        },
      );
      expect(result.protocolError).toBeUndefined();
      expect(previews.some((p) => p.field === "title" && p.text === output.title)).toBe(true);
    },
  );
  it("holds malformed SSE JSON without publishing its raw text", async () => {
    const previews: ModelPreview[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse('data: {"SECRET":\n\n')),
    );
    await expect(
      generateStructured({
        ...request,
        modelMode: "deepseek",
        onPreview: (p) => {
          previews.push(p);
        },
      }),
    ).rejects.toMatchObject({ uncertain: true });
    expect(previews).toEqual([]);
    expect(billing.holdBilling).toHaveBeenCalledTimes(1);
  });
});
