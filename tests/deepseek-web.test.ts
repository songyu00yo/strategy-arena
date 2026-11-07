import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBillingLedger } from "../src/lib/server/billing";
import {
  ensureToolBudgetBatch,
  getToolAttempt,
  DEEPSEEK_WEB_PRICE_ESTIMATE,
} from "../src/lib/server/tool-budget";
import { executeMcpTool } from "../src/lib/server/mcp-tools";

// The actual product-owned MCP server/client/in-memory transport is used.
// Only public DNS and DeepSeek's raw HTTP API are test doubles, with no paid calls.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
let directory: string;
let databasePath: string;
let ledger: ReturnType<typeof openBillingLedger>;
let fetchDouble: ReturnType<typeof vi.fn>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "arena-deepseek-web-"));
  databasePath = join(directory, "central.sqlite");
  ledger = openBillingLedger({ databasePath });
  ensureToolBudgetBatch("batch", databasePath);
  vi.stubEnv("ARENA_BILLING_DATABASE_PATH", databasePath);
  vi.stubEnv("ARENA_ACCEPTANCE_BATCH_ID", "batch");
  vi.stubEnv("ARENA_SEARCH_PROVIDER", "");
  vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-web-fixture-only");
  vi.stubEnv("MODEL_API_KEY", "");
  vi.stubEnv("TAVILY_API_KEY", "");
  dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchDouble = vi.fn(async () =>
    Response.json({
      results: [
        {
          url: "https://public.edu/course",
          title: "课程说明",
          content: "",
          summary: "课程参考价格100元，需核对实际条件。",
          snippet: "短摘要",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchDouble);
});
afterEach(() => {
  ledger.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
const search = (attemptId = "search", query = "公开课程价格") =>
  executeMcpTool({ attemptId, versionId: "version", request: { tool: "tavily_search", query } });
const read = (attemptId = "read", url = "https://public.edu/course") =>
  executeMcpTool({ attemptId, versionId: "version", request: { tool: "tavily_extract", url } });
describe("DeepSeek raw web APIs through the actual local MCP adapter", () => {
  it("defaults to DeepSeek without Tavily and sends only a five-result bounded public query", async () => {
    const result = await search();
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    const [url, request] = fetchDouble.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer deepseek-web-fixture-only",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(request.body))).toEqual({
      query: "公开课程价格",
      count: 5,
      need_content: false,
    });
    expect(result).toMatchObject({
      provider: "deepseek",
      status: "found",
      sources: [
        { text: "课程参考价格100元，需核对实际条件。", basis: "assumption", trust: "untrusted" },
      ],
      pricing: DEEPSEEK_WEB_PRICE_ESTIMATE,
    });
    expect(getToolAttempt("search", databasePath)).toMatchObject({
      tool: "deepseek_search",
      provider: "deepseek",
      unit: "request",
      credits: 0,
      state: "settled",
      settled_usd_micros: 834,
      estimated: 1,
    });
    expect(ledger.summary().requests).toBe(0);
  });
  it("fetches one public HTTPS URL, records markdown and bounds the content snapshot", async () => {
    fetchDouble.mockResolvedValue(
      Response.json({ title: "网页正文", content: "正文".repeat(10000) }),
    );
    const result = await read();
    expect(fetchDouble.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(String(fetchDouble.mock.calls[0][1].body))).toEqual({
      url: "https://public.edu/course",
    });
    expect(result.status).toBe("found");
    expect(result.sources[0].text).toHaveLength(12000);
    expect(getToolAttempt("read", databasePath)).toMatchObject({
      provider: "deepseek",
      unit: "request",
      settled_usd_micros: 834,
    });
  });
  it("settles successful empty search and empty fetch at zero with explicit request units", async () => {
    fetchDouble.mockResolvedValueOnce(Response.json({ results: [] }));
    expect(await search()).toMatchObject({
      status: "unavailable",
      providerUsage: { unit: "request", successfulRequests: 0 },
    });
    expect(getToolAttempt("search", databasePath)?.settled_usd_micros).toBe(0);
    fetchDouble.mockResolvedValueOnce(Response.json({ title: "", content: "" }));
    expect((await read()).status).toBe("unavailable");
    expect(getToolAttempt("read", databasePath)?.settled_usd_micros).toBe(0);
  });
  it.each([400, 401, 402, 403, 404, 408, 429, 500, 504])(
    "records a complete HTTP %s failure at zero and never retries",
    async (status) => {
      fetchDouble.mockResolvedValue(
        Response.json({ error: { message: "synthetic provider error" } }, { status }),
      );
      expect(await search()).toMatchObject({
        status: "error",
        providerUsage: { successfulRequests: 0, statusCode: status },
      });
      expect(getToolAttempt("search", databasePath)).toMatchObject({
        state: "settled",
        settled_usd_micros: 0,
      });
      expect(fetchDouble).toHaveBeenCalledTimes(1);
    },
  );
  it("holds network, malformed JSON and oversized response outcomes without redispatch", async () => {
    fetchDouble.mockRejectedValueOnce(new Error("synthetic interrupted connection"));
    expect((await search("network")).status).toBe("uncertain");
    fetchDouble.mockResolvedValueOnce(new Response("bad JSON", { status: 200 }));
    expect((await search("malformed")).status).toBe("uncertain");
    fetchDouble.mockResolvedValueOnce(new Response("x".repeat(1_048_577), { status: 200 }));
    expect((await search("oversized")).status).toBe("uncertain");
    for (const id of ["network", "malformed", "oversized"])
      expect(getToolAttempt(id, databasePath)).toMatchObject({
        state: "held",
        reserved_usd_micros: 834,
        settled_usd_micros: null,
      });
    expect((await search("network")).status).toBe("unavailable");
    expect(fetchDouble).toHaveBeenCalledTimes(3);
  });
  it("enforces 128 Unicode characters without splitting supplementary characters", async () => {
    expect((await search("unicode", "🌱".repeat(128))).status).toBe("found");
    expect((await search("too-long", "🌱".repeat(129))).status).toBe("unavailable");
    expect(fetchDouble).toHaveBeenCalledTimes(1);
  });
  it("rejects private or credential-bearing URLs before any provider call", async () => {
    expect((await read("private", "https://127.0.0.1")).status).toBe("unavailable");
    expect((await read("credential", "https://user:password@public.edu")).status).toBe(
      "unavailable",
    );
    dns.lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    expect((await read("dns-private")).status).toBe("unavailable");
    expect(fetchDouble).not.toHaveBeenCalled();
  });
  it("supports MODEL_API_KEY and never switches providers after failure or missing configuration", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("MODEL_API_KEY", "fallback-model-fixture-only");
    expect((await search()).status).toBe("found");
    expect(fetchDouble.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer fallback-model-fixture-only",
    );
    vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
    expect((await search("missing-tavily")).status).toBe("unavailable");
    vi.stubEnv("ARENA_SEARCH_PROVIDER", "unknown");
    expect((await search("invalid-provider")).status).toBe("unavailable");
    expect(fetchDouble).toHaveBeenCalledTimes(1);
  });
});
