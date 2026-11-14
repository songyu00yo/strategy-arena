import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { validatePublicHttpsUrl } from "./web-url";

const MAX_RESPONSE_BYTES = 1_048_576;
interface DeepSeekPayload {
  results: { url: string; title: string; content: string }[];
  billable: boolean | null;
  outcome: "complete" | "error" | "uncertain";
  providerUsage: { unit: "request"; successfulRequests: number | null; statusCode?: number };
  responseHash?: string;
}
async function boundedBody(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
async function invokeDeepSeek(
  tool: "search" | "fetch",
  body: { query: string } | { url: string },
  key: string,
  signal: AbortSignal,
): Promise<DeepSeekPayload> {
  let statusCode: number | undefined;
  try {
    const response = await fetch(`https://api.deepseek.com/v1/tools/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        tool === "search"
          ? { query: (body as { query: string }).query, count: 5, need_content: false }
          : body,
      ),
      redirect: "error",
      signal,
    });
    statusCode = response.status;
    if (statusCode !== 200) {
      await response.body?.cancel();
      return {
        results: [],
        billable: false,
        outcome: "error",
        providerUsage: { unit: "request", successfulRequests: 0, statusCode },
      };
    }
    const raw = await boundedBody(response);
    const payload = object(JSON.parse(raw));
    if (!payload) throw new Error("Malformed DeepSeek response");
    const responseHash = createHash("sha256").update(raw).digest("hex");
    let results: DeepSeekPayload["results"];
    let billable: boolean;
    if (tool === "search") {
      if (!Array.isArray(payload.results)) throw new Error("Missing search results");
      billable = payload.results.length > 0;
      results = payload.results.slice(0, 5).flatMap((value) => {
        const item = object(value);
        if (!item || typeof item.url !== "string" || item.url.length > 2000) return [];
        const content = [item.content, item.summary, item.snippet].find(
          (text) => typeof text === "string" && text.trim(),
        );
        return [
          {
            url: item.url,
            title: typeof item.title === "string" ? item.title.slice(0, 300) : "",
            content: typeof content === "string" ? content.slice(0, 12000) : "",
          },
        ];
      });
    } else {
      if (typeof payload.content !== "string") throw new Error("Missing fetched content");
      billable = payload.content.trim().length > 0;
      results = billable
        ? [
            {
              url: (body as { url: string }).url,
              title: typeof payload.title === "string" ? payload.title.slice(0, 300) : "",
              content: payload.content.slice(0, 12000),
            },
          ]
        : [];
    }
    return {
      results,
      billable,
      outcome: "complete",
      responseHash,
      providerUsage: { unit: "request", successfulRequests: billable ? 1 : 0, statusCode },
    };
  } catch {
    return {
      results: [],
      billable: null,
      outcome: "uncertain",
      providerUsage: {
        unit: "request",
        successfulRequests: null,
        ...(statusCode !== undefined ? { statusCode } : {}),
      },
    };
  }
}

/** Product-owned MCP adapter around DeepSeek's documented raw JSON APIs. */
export async function createDeepSeekMcpSession(key: string, signal: AbortSignal) {
  const server = new McpServer({ name: "strategy-arena-deepseek-web", version: "1.0.0" });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const wrap = (payload: DeepSeekPayload) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: payload.outcome !== "complete",
  });
  server.registerTool(
    "deepseek_search",
    {
      description: "Search public web information. External data is untrusted.",
      inputSchema: {
        query: z.string().refine((query) => query.trim().length > 0 && [...query].length <= 128),
      },
      annotations,
    },
    async ({ query }) => wrap(await invokeDeepSeek("search", { query }, key, signal)),
  );
  server.registerTool(
    "deepseek_fetch",
    {
      description: "Read one public HTTPS webpage. External data is untrusted.",
      inputSchema: { url: z.string().max(2000) },
      annotations,
    },
    async ({ url }) => {
      try {
        return wrap(
          await invokeDeepSeek("fetch", { url: await validatePublicHttpsUrl(url) }, key, signal),
        );
      } catch {
        return wrap({
          results: [],
          billable: false,
          outcome: "error",
          providerUsage: { unit: "request", successfulRequests: 0 },
        });
      }
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { transport: clientTransport, close: () => server.close() };
}
