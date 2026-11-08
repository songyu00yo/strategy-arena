import { createHash } from "node:crypto";
import { publicUrl, validatePublicHttpsUrl } from "./web-url";
import { createDeepSeekMcpSession } from "./deepseek-web";
export { validatePublicHttpsUrl } from "./web-url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  configuredToolBatchId,
  finishToolAttempt,
  reserveToolAttempt,
  ToolBudgetError,
  DEEPSEEK_WEB_PRICE_ESTIMATE,
} from "./tool-budget";

export type McpToolRequest =
  | { tool: "tavily_search"; query: string }
  | { tool: "tavily_extract"; url: string };
export interface WebSource {
  id: string;
  url: string;
  title: string;
  text: string;
  accessedAt: string;
  contentHash: string;
  query: string;
  trust: "untrusted";
  basis: "assumption";
}
export interface McpToolResult {
  attemptId: string;
  status: "found" | "unavailable" | "error" | "uncertain";
  query: string;
  sources: WebSource[];
  error?: string;
  responseHash?: string;
  providerUsage?: unknown;
  estimated: true;
  estimatedUsd?: number;
  reservedUsd?: number;
  provider?: "deepseek" | "tavily";
  pricing?: typeof DEEPSEEK_WEB_PRICE_ESTIMATE;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
class McpToolUnavailable extends Error {}
/** The SDK consumes this stream. Enforce a byte ceiling before its JSON/SSE parser. */
async function boundedMcpFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (Number(response.headers.get("content-length")) > 1_048_576) {
    await response.body?.cancel();
    throw new Error("MCP response exceeds byte limit");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let size = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel();
          throw new Error("MCP response exceeds byte limit");
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function parseResponse(response: Awaited<ReturnType<Client["callTool"]>>) {
  if (response.structuredContent) return record(response.structuredContent);
  if (!Array.isArray(response.content)) throw new Error("工具响应缺少内容。");
  const text = response.content
    .map(record)
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item!.text)
    .join("\n");
  return record(JSON.parse(text));
}
function sourceSnapshots(
  payload: Record<string, unknown>,
  query: string,
  secret: string,
): WebSource[] {
  if (!Array.isArray(payload.results)) throw new Error("工具响应缺少结果列表。");
  const seen = new Set<string>();
  const accessedAt = new Date().toISOString();
  return payload.results.slice(0, 5).flatMap((value) => {
    const item = record(value);
    if (!item || typeof item.url !== "string" || item.url.includes(secret)) return [];
    let url: string;
    try {
      url = publicUrl(item.url).href;
    } catch {
      return [];
    }
    if (seen.has(url)) return [];
    const rawText = typeof item.raw_content === "string" ? item.raw_content : item.content;
    if (typeof rawText !== "string" || !rawText.trim()) return [];
    const text = rawText.replaceAll(secret, "[已移除凭据]").slice(0, 12000);
    const title = (typeof item.title === "string" ? item.title : url)
      .replaceAll(secret, "[已移除凭据]")
      .slice(0, 300);
    const contentHash = hash(text);
    seen.add(url);
    return [
      {
        id: `W-${hash(`${url}:${contentHash}`).slice(0, 24)}`,
        url,
        title,
        text,
        accessedAt,
        contentHash,
        query,
        trust: "untrusted" as const,
        basis: "assumption" as const,
      },
    ];
  });
}

/** Only the bounded query or one public URL crosses the MCP boundary. No corpus is sent. */
export async function executeMcpTool(input: {
  attemptId: string;
  versionId: string;
  batchId?: string;
  request: McpToolRequest;
  signal?: AbortSignal;
}): Promise<McpToolResult> {
  const configuredProvider = process.env.ARENA_SEARCH_PROVIDER || "deepseek";
  const provider = configuredProvider === "deepseek" ? "deepseek" : "tavily";
  const isSearch = input.request.tool === "tavily_search";
  const query = input.request.tool === "tavily_search" ? input.request.query : input.request.url;
  const secret = (
    provider === "deepseek"
      ? process.env.DEEPSEEK_API_KEY || process.env.MODEL_API_KEY
      : process.env.TAVILY_API_KEY
  )?.trim();
  const base: McpToolResult = {
    attemptId: input.attemptId,
    query: secret ? query.replaceAll(secret, "[已移除凭据]") : query,
    sources: [],
    status: "unavailable",
    estimated: true,
    estimatedUsd: 0,
    reservedUsd: 0,
    provider,
    ...(provider === "deepseek" ? { pricing: DEEPSEEK_WEB_PRICE_ESTIMATE } : {}),
  };
  if (!["deepseek", "tavily"].includes(configuredProvider))
    return { ...base, error: "ARENA_SEARCH_PROVIDER须显式选择deepseek或tavily。" };
  if (!secret)
    return {
      ...base,
      error:
        provider === "deepseek"
          ? "DeepSeek密钥未配置，联网工具不可用。"
          : "TAVILY_API_KEY未配置，联网工具不可用。",
    };
  const batchId = input.batchId || configuredToolBatchId();
  if (!batchId) return { ...base, error: "工具批次标识未配置，联网工具不可用。" };
  let args: Record<string, unknown>;
  let requestedUrl: string | undefined;
  try {
    const maxQuery = provider === "deepseek" ? 128 : 300;
    if (
      !query.trim() ||
      [...query].length > (isSearch ? maxQuery : 2000) ||
      query.includes(secret) ||
      /(?:Bearer\s|\bsk-[A-Za-z0-9]|\btvly-[A-Za-z0-9]|(?:api[_-]?key|token|password|secret)=|[\r\n])/i.test(
        query,
      )
    )
      throw new Error("Invalid public query");
    if (input.request.tool === "tavily_extract")
      requestedUrl = await validatePublicHttpsUrl(input.request.url);
    args =
      provider === "deepseek"
        ? isSearch
          ? { query: query.trim() }
          : { url: requestedUrl }
        : isSearch
          ? {
              query: query.trim(),
              search_depth: "basic",
              max_results: 5,
              include_raw_content: false,
              include_images: false,
            }
          : { urls: [requestedUrl], extract_depth: "basic", include_images: false };
  } catch {
    return { ...base, error: "查询须为简短公开信息，提取须为一个公共HTTPS网址，且不能包含凭据。" };
  }
  const toolName =
    provider === "deepseek"
      ? isSearch
        ? "deepseek_search"
        : "deepseek_fetch"
      : input.request.tool;
  try {
    reserveToolAttempt({
      attemptId: input.attemptId,
      versionId: input.versionId,
      batchId,
      tool: toolName,
      request: args,
    });
  } catch (error) {
    return {
      ...base,
      ...(error instanceof ToolBudgetError && error.code === "TOOL_DUPLICATE_ATTEMPT"
        ? { status: "uncertain" as const }
        : {}),
      error: error instanceof ToolBudgetError ? error.message : "中央工具账本不可用。",
    };
  }
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  const client = new Client({ name: "strategy-arena-readonly-tools", version: "1.0.0" });
  let localSession: Awaited<ReturnType<typeof createDeepSeekMcpSession>> | undefined;
  let receivedResponse = false;
  let settlement: number | undefined;
  let result: McpToolResult;
  try {
    localSession =
      provider === "deepseek" ? await createDeepSeekMcpSession(secret, signal) : undefined;
    const transport =
      localSession?.transport ??
      new StreamableHTTPClientTransport(new URL("https://mcp.tavily.com/mcp/"), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` }, signal, redirect: "error" },
        fetch: boundedMcpFetch,
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
    await client.connect(transport, { signal, timeout: 30000 });
    const available = await client.listTools(undefined, { signal, timeout: 10000 });
    if (!available.tools.some((tool) => tool.name === toolName)) {
      settlement = provider === "deepseek" ? 0 : undefined;
      throw new McpToolUnavailable("远程服务未提供所请求的只读工具。");
    }
    const response = await client.callTool({ name: toolName, arguments: args }, undefined, {
      signal,
      timeout: 30000,
    });
    receivedResponse = true;
    const raw = JSON.stringify(response);
    if (raw.length > 500000) throw new Error("Response too large");
    const responseHash = hash(raw);
    const payload =
      provider === "deepseek" || !response.isError ? parseResponse(response) : undefined;
    if (provider === "deepseek" && payload?.outcome === "uncertain") {
      result = {
        ...base,
        status: "uncertain",
        responseHash,
        error: "DeepSeek联网调用结果未知，已保留预留，不能自动重试。",
        providerUsage: payload.providerUsage,
      };
    } else if (response.isError) {
      settlement = provider === "deepseek" ? 0 : undefined;
      result = {
        ...base,
        responseHash,
        status: "error",
        error:
          provider === "deepseek" && typeof record(payload?.providerUsage)?.statusCode === "number"
            ? `DeepSeek联网工具返回 HTTP ${record(payload?.providerUsage)!.statusCode}，本次未取得可用资料。`
            : "联网工具明确返回执行错误。",
        ...(payload?.providerUsage ? { providerUsage: payload.providerUsage } : {}),
      };
    } else {
      if (!payload) throw new Error("Invalid tool payload");
      if (provider === "deepseek") {
        if (typeof payload.billable !== "boolean") throw new Error("Unknown billing outcome");
        settlement = payload.billable ? DEEPSEEK_WEB_PRICE_ESTIMATE.reservedUsdMicros : 0;
      }
      const sources = sourceSnapshots(payload, query, secret);
      const bounded = requestedUrl
        ? sources.filter((source) => source.url === requestedUrl).slice(0, 1)
        : sources;
      const providerUsage = provider === "deepseek" ? payload.providerUsage : payload.usage;
      result = {
        ...base,
        responseHash:
          typeof payload.responseHash === "string" ? payload.responseHash : responseHash,
        status: bounded.length ? "found" : "unavailable",
        sources: bounded,
        ...(providerUsage !== undefined
          ? {
              providerUsage: JSON.parse(
                JSON.stringify(providerUsage).replaceAll(secret, "[已移除凭据]"),
              ),
            }
          : {}),
      };
    }
  } catch (error) {
    const knownError = provider === "tavily" && receivedResponse;
    result = {
      ...base,
      status:
        error instanceof McpToolUnavailable ? "unavailable" : knownError ? "error" : "uncertain",
      error:
        error instanceof McpToolUnavailable
          ? error.message
          : knownError
            ? "联网工具已响应，但结果无法安全解析。"
            : "联网调用未获得完整结果，已保留费用预留，不能自动重试。",
    };
  } finally {
    await client.close().catch(() => {});
    await localSession?.close().catch(() => {});
  }
  const charge =
    settlement ??
    (provider === "deepseek"
      ? DEEPSEEK_WEB_PRICE_ESTIMATE.reservedUsdMicros
      : Math.round(Number(process.env.TAVILY_USD_PER_CREDIT ?? "0.008") * 1e6));
  result.estimatedUsd = result.status === "uncertain" ? 0 : charge / 1e6;
  result.reservedUsd = result.status === "uncertain" ? charge / 1e6 : 0;
  try {
    finishToolAttempt(
      input.attemptId,
      result.status === "uncertain" ? "held" : "settled",
      result,
      undefined,
      settlement,
    );
  } catch {
    return {
      ...base,
      status: "uncertain",
      error: "工具结果未能写入账本，已保留原调用记录与预留。",
    };
  }
  return result;
}
