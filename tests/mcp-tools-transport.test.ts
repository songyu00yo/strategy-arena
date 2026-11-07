import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBillingLedger } from "../src/lib/server/billing";
import { ensureToolBudgetBatch, getToolAttempt } from "../src/lib/server/tool-budget";
import { executeMcpTool } from "../src/lib/server/mcp-tools";

// Actual MCP SDK and Streamable HTTP transport, with HTTP replaced entirely by a test double.
let directory: string;
let databasePath: string;
let ledger: ReturnType<typeof openBillingLedger>;
let calls: { method: string; params?: Record<string, unknown> }[];
let callResult: Record<string, unknown>;
let upstreamFailure: "none" | "abort";
let controller: AbortController;
let fetchDouble: ReturnType<typeof vi.fn>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "arena-mcp-protocol-"));
  databasePath = join(directory, "central.sqlite");
  ledger = openBillingLedger({ databasePath });
  ensureToolBudgetBatch("batch", databasePath);
  vi.stubEnv("ARENA_BILLING_DATABASE_PATH", databasePath);
  vi.stubEnv("ARENA_ACCEPTANCE_BATCH_ID", "batch");
  vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
  vi.stubEnv("TAVILY_API_KEY", "tvly-protocol-fixture-only");
  controller = new AbortController();
  upstreamFailure = "none";
  calls = [];
  callResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          query: "公开课程价格",
          results: [
            {
              url: "https://public.edu/course",
              title: "中文课程说明",
              content: "课程价格为100元，仍需用户核实适用条件。",
            },
          ],
        }),
      },
    ],
  };
  fetchDouble = vi.fn(async (input: URL | RequestInfo, init: RequestInit = {}) => {
    expect(String(input)).toBe("https://mcp.tavily.com/mcp/");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer tvly-protocol-fixture-only",
    );
    if (init.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body)) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    calls.push(message);
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: Record<string, unknown>;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "tavily-test-double", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [{ name: "tavily_search", inputSchema: { type: "object", properties: {} } }],
      };
    } else if (message.method === "tools/call") {
      if (upstreamFailure === "abort") {
        queueMicrotask(() => controller.abort());
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("synthetic interrupted request")),
            { once: true },
          );
        });
      }
      result = callResult;
    } else {
      throw new Error(`Unexpected test protocol method ${message.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  vi.stubGlobal("fetch", fetchDouble);
});
afterEach(() => {
  ledger.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
const run = () =>
  executeMcpTool({
    attemptId: "protocol",
    versionId: "version",
    request: { tool: "tavily_search", query: "公开课程价格" },
    signal: controller.signal,
  });
describe("actual SDK against a synthetic HTTP MCP server", () => {
  it("performs initialize, initialized, listTools and one bounded tool call with Chinese JSON content", async () => {
    const result = await run();
    expect(result).toMatchObject({
      status: "found",
      sources: [{ title: "中文课程说明", basis: "assumption" }],
    });
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(calls.at(-1)?.params).toEqual({
      name: "tavily_search",
      arguments: {
        query: "公开课程价格",
        search_depth: "basic",
        max_results: 5,
        include_raw_content: false,
        include_images: false,
      },
    });
    expect(getToolAttempt("protocol", databasePath)).toMatchObject({
      state: "settled",
      estimated: 1,
    });
  });
  it("treats HTTP 200 with MCP isError=true as a complete error", async () => {
    callResult = { isError: true, content: [{ type: "text", text: "模拟供应商明确错误" }] };
    expect(await run()).toMatchObject({ status: "error", sources: [] });
    expect(getToolAttempt("protocol", databasePath)?.state).toBe("settled");
  });
  it("holds an aborted tools/call and never sends another tools/call", async () => {
    upstreamFailure = "abort";
    expect(await run()).toMatchObject({ status: "uncertain", sources: [] });
    expect(getToolAttempt("protocol", databasePath)?.state).toBe("held");
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(1);
  });
  it("refuses redirects without sending the bearer credential to another host", async () => {
    fetchDouble.mockImplementationOnce(async (input, init) => {
      expect(String(input)).toBe("https://mcp.tavily.com/mcp/");
      expect(init.redirect).toBe("error");
      return new Response(null, {
        status: 307,
        headers: { location: "https://another-host.invalid/collect" },
      });
    });
    expect((await run()).status).toBe("uncertain");
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(0);
  });
  it("enforces the one-MiB body limit before the SDK JSON parser", async () => {
    fetchDouble.mockResolvedValueOnce(
      new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
    );
    expect((await run()).status).toBe("uncertain");
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    expect(getToolAttempt("protocol", databasePath)?.state).toBe("held");
  });
});
