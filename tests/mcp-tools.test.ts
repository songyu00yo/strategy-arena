import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBillingLedger } from "../src/lib/server/billing";
import { ensureToolBudgetBatch, getToolAttempt } from "../src/lib/server/tool-budget";
import { executeMcpTool, validatePublicHttpsUrl } from "../src/lib/server/mcp-tools";

// MCP and DNS are explicit test doubles. No external or paid requests are made.
const doubles = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  transport: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = doubles.connect;
    listTools = doubles.listTools;
    callTool = doubles.callTool;
    close = doubles.close;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) {
      doubles.transport(...args);
    }
  },
}));
vi.mock("node:dns/promises", () => ({ lookup: doubles.lookup }));
let directory: string;
let databasePath: string;
let ledger: ReturnType<typeof openBillingLedger>;
const runSearch = (attemptId = "search") =>
  executeMcpTool({
    attemptId,
    versionId: "version",
    request: { tool: "tavily_search", query: "公开课程价格" },
  });
beforeEach(() => {
  vi.resetAllMocks();
  doubles.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  doubles.connect.mockResolvedValue(undefined);
  doubles.listTools.mockResolvedValue({
    tools: [{ name: "tavily_search" }, { name: "tavily_extract" }],
  });
  doubles.close.mockResolvedValue(undefined);
  doubles.callTool.mockResolvedValue({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [
            {
              url: "https://public.edu/course",
              title: "课程",
              content: "外部课程报价100元，仅供核对",
            },
          ],
          usage: { credits: 1 },
        }),
      },
    ],
  });
  directory = mkdtempSync(join(tmpdir(), "arena-mcp-tools-"));
  databasePath = join(directory, "central.sqlite");
  ledger = openBillingLedger({ databasePath });
  ensureToolBudgetBatch("batch", databasePath);
  vi.stubEnv("ARENA_BILLING_DATABASE_PATH", databasePath);
  vi.stubEnv("ARENA_ACCEPTANCE_BATCH_ID", "batch");
  vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
  vi.stubEnv("TAVILY_API_KEY", "tvly-test-fixture-only");
});
afterEach(() => {
  ledger.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
describe("bounded read-only Tavily MCP adapter", () => {
  it("uses official Streamable HTTP, bearer auth and only basic five-result search", async () => {
    const result = await runSearch();
    expect(doubles.transport).toHaveBeenCalledWith(
      new URL("https://mcp.tavily.com/mcp/"),
      expect.objectContaining({
        requestInit: expect.objectContaining({
          headers: { Authorization: "Bearer tvly-test-fixture-only" },
        }),
        reconnectionOptions: expect.objectContaining({ maxRetries: 0 }),
      }),
    );
    expect(doubles.callTool.mock.calls[0][0]).toEqual({
      name: "tavily_search",
      arguments: {
        query: "公开课程价格",
        search_depth: "basic",
        max_results: 5,
        include_raw_content: false,
        include_images: false,
      },
    });
    expect(result).toMatchObject({
      status: "found",
      estimated: true,
      providerUsage: { credits: 1 },
      sources: [
        {
          url: "https://public.edu/course",
          query: "公开课程价格",
          trust: "untrusted",
          basis: "assumption",
        },
      ],
    });
    expect(result.sources[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sources[0].accessedAt).toMatch(/^20/);
    expect(getToolAttempt("search", databasePath)).toMatchObject({
      state: "settled",
      settled_usd_micros: 8000,
      estimated: 1,
    });
  });
  it("reports missing key or batch as unavailable without dispatch", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    expect(await runSearch()).toMatchObject({
      status: "unavailable",
      error: expect.stringContaining("未配置"),
    });
    vi.stubEnv("TAVILY_API_KEY", "tvly-test-fixture-only");
    vi.stubEnv("ARENA_ACCEPTANCE_BATCH_ID", "");
    vi.stubEnv("ARENA_TOOL_BATCH_ID", "");
    expect(await runSearch()).toMatchObject({
      status: "unavailable",
      error: expect.stringContaining("批次"),
    });
    expect(doubles.connect).not.toHaveBeenCalled();
  });
  it("restricts basic extraction to one public HTTPS URL and retains its content snapshot", async () => {
    doubles.callTool.mockResolvedValue({
      structuredContent: {
        results: [{ url: "https://public.edu/course", raw_content: "公开网页正文" }],
      },
      content: [],
    });
    const result = await executeMcpTool({
      attemptId: "extract",
      versionId: "version",
      request: { tool: "tavily_extract", url: "https://public.edu/course#details" },
    });
    expect(doubles.callTool.mock.calls[0][0]).toEqual({
      name: "tavily_extract",
      arguments: {
        urls: ["https://public.edu/course"],
        extract_depth: "basic",
        include_images: false,
      },
    });
    expect(result).toMatchObject({ status: "found", sources: [{ text: "公开网页正文" }] });
    expect(getToolAttempt("extract", databasePath)?.state).toBe("settled");
  });
  it.each([
    "http://public.edu",
    "https://localhost/a",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://169.254.169.254/",
    "https://[::1]",
    "https://[::ffff:7f00:1]",
    "https://user:password@public.edu",
    "https://public.edu:444/",
    "https://router.internal/",
  ])("blocks a non-public or credential-bearing URL %s", async (url) => {
    await expect(validatePublicHttpsUrl(url)).rejects.toThrow();
    expect(doubles.callTool).not.toHaveBeenCalled();
  });
  it("rejects a DNS name resolving to private addresses and supports public IPv6", async () => {
    doubles.lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "192.168.0.1" }]);
    await expect(validatePublicHttpsUrl("https://public.edu")).rejects.toThrow(/公共/);
    await expect(validatePublicHttpsUrl("https://[2606:4700:4700::1111]/")).resolves.toBe(
      "https://[2606:4700:4700::1111]/",
    );
  });
  it("keeps unknown network outcomes held and refuses to retry an existing attempt", async () => {
    doubles.callTool.mockRejectedValue(
      new Error("synthetic timeout containing tvly-test-fixture-only"),
    );
    const result = await runSearch();
    expect(result.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("tvly-test-fixture-only");
    expect(getToolAttempt("search", databasePath)?.state).toBe("held");
    expect((await runSearch()).status).toBe("unavailable");
    expect(doubles.callTool).toHaveBeenCalledTimes(1);
    expect(getToolAttempt("search", databasePath)?.state).toBe("held");
  });
  it("distinguishes empty matches, explicit errors and unreadable complete responses", async () => {
    doubles.callTool.mockResolvedValueOnce({ structuredContent: { results: [] }, content: [] });
    expect((await runSearch("empty")).status).toBe("unavailable");
    doubles.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "provider error" }],
    });
    expect((await runSearch("error")).status).toBe("error");
    doubles.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "not structured JSON" }],
    });
    expect((await runSearch("malformed")).status).toBe("error");
    expect(getToolAttempt("malformed", databasePath)?.state).toBe("settled");
  });
  it("keeps valid successful results settled when provider usage is absent", async () => {
    doubles.callTool.mockResolvedValue({
      structuredContent: { results: [{ url: "https://public.edu", content: "外部信息" }] },
      content: [],
    });
    expect((await runSearch()).status).toBe("found");
    expect(getToolAttempt("search", databasePath)).toMatchObject({
      state: "settled",
      estimated: 1,
      credits: 1,
    });
  });
  it("bounds output, removes duplicate URLs and never promotes private sources", async () => {
    doubles.callTool.mockResolvedValue({
      structuredContent: {
        results: [
          { url: "https://public.edu", content: "第一份" },
          { url: "https://public.edu/", content: "重复份" },
          { url: "https://127.0.0.1/", content: "私网" },
          { url: "https://public.edu/long", content: "长".repeat(20000) },
        ],
      },
      content: [],
    });
    const result = await runSearch();
    expect(result.sources).toHaveLength(2);
    expect(result.sources[1].text).toHaveLength(12000);
    expect(result.sources.every((source) => source.basis === "assumption")).toBe(true);
  });
  it("refuses credential-bearing queries without echoing the configured key", async () => {
    const result = await executeMcpTool({
      attemptId: "secret",
      versionId: "version",
      request: { tool: "tavily_search", query: "请查询tvly-test-fixture-only" },
    });
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("tvly-test-fixture-only");
    expect(doubles.callTool).not.toHaveBeenCalled();
  });
});
