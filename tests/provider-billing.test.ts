/** Real temporary SQLite ledger plus fake HTTP responses; no live model or money is used. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeSchema, type StageInput } from "../src/lib/contracts";
import { getBillingAttempt, getBillingSummary } from "../src/lib/server/billing";
import { generateStrategy, getModelConfig } from "../src/lib/server/model";

const input: StageInput = {
  role: "A",
  challenge: ChallengeSchema.parse({ goal: "两周内完成可以展示的作品网站" }),
  strategies: [],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
};
const strategy = {
  id: "A",
  title: "作品网站",
  thesis: "整理已有作品再发布网站",
  steps: ["整理三件作品"],
  claims: [{ id: "A-1", text: "作品发布权限待确认", status: "unknown", sourceIds: [] }],
  resources: "已有电脑",
  firstAction: "整理第一件作品",
  failureCondition: "没有可用作品",
  estimatedCost: null,
  estimatedHours: 8,
};
function response(content = JSON.stringify(strategy), id = "fixture-response") {
  return Response.json({
    id,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: content }],
      },
    ],
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      input_tokens_details: { cached_tokens: 200 },
    },
  });
}
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "arena-provider-ledger-test-"));
  vi.stubEnv("ARENA_BILLING_DATABASE_PATH", join(directory, "billing.sqlite"));
  vi.stubEnv("ARENA_BILLING_USD_LIMIT", "2");
  vi.stubEnv("ARENA_BILLING_REQUEST_LIMIT", "100");
  vi.stubEnv("ARENA_BILLING_TOKEN_LIMIT", "2000000");
  vi.stubEnv("OPENAI_API_KEY", "fake-openai-key-never-sent-live");
  vi.stubEnv("OPENAI_STRUCTURED_OUTPUT", "json");
  for (const name of [
    "OPENAI_MODEL_ID",
    "OPENAI_BASE_URL",
    "OPENAI_REASONING_EFFORT",
    "OPENAI_INPUT_PRICE_PER_MILLION",
    "OPENAI_OUTPUT_PRICE_PER_MILLION",
    "OPENAI_MAX_OUTPUT_TOKENS",
    "OPENAI_TIMEOUT_MS",
  ])
    vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
describe("adapter and real shared ledger integration", () => {
  it("blocks dispatch when the required shared ledger is unconfigured", async () => {
    vi.stubEnv("ARENA_BILLING_DATABASE_PATH", "");
    const fetchDouble = vi.fn();
    vi.stubGlobal("fetch", fetchDouble);
    await expect(generateStrategy(input, getModelConfig("openai"), "no-ledger")).rejects.toThrow(
      "共享计费配置缺失或无效",
    );
    expect(fetchDouble).not.toHaveBeenCalled();
  });
  it.each(["valid", "invalid JSON", "invalid schema"])(
    "settles real USD usage for %s output",
    async (kind) => {
      const content =
        kind === "valid" ? JSON.stringify(strategy) : kind === "invalid JSON" ? "{" : "{}";
      const fetchDouble = vi.fn().mockImplementation(() => {
        expect(getBillingAttempt("known-usage")?.state).toBe("reserved");
        return Promise.resolve(response(content));
      });
      vi.stubGlobal("fetch", fetchDouble);
      const call = generateStrategy(input, getModelConfig("openai"), "known-usage");
      if (kind === "valid") expect((await call).value.id).toBe("A");
      else
        await expect(call).rejects.toMatchObject({
          uncertain: false,
          usage: { estimatedUsd: 0.0035 },
        });
      expect(getBillingAttempt("known-usage")).toMatchObject({
        state: "settled",
        currency: "USD",
        amount_micros: 3500,
        input_tokens: 1000,
        output_tokens: 500,
        cached_input_tokens: 200,
      });
      expect(getBillingSummary()).toMatchObject({
        requests: 1,
        settledNativeUsdMicros: 3500,
        reservedUsdMicros: 0,
        tokens: 1500,
      });
    },
  );
  it("holds the real reservation on network uncertainty and forbids redispatch", async () => {
    const fetchDouble = vi.fn().mockRejectedValue(new Error("network failure test double"));
    vi.stubGlobal("fetch", fetchDouble);
    const config = getModelConfig("openai");
    await expect(generateStrategy(input, config, "unknown-request")).rejects.toMatchObject({
      uncertain: true,
    });
    const attempt = getBillingAttempt("unknown-request");
    expect(attempt?.state).toBe("held");
    expect(getBillingSummary()).toMatchObject({
      requests: 1,
      heldRequests: 1,
      reservedUsdMicros: attempt?.reserved_usd_micros,
      settledNativeUsdMicros: 0,
    });
    await expect(generateStrategy(input, config, "unknown-request")).rejects.toMatchObject({
      name: "ModelCallError",
      uncertain: true,
      message: expect.stringContaining("拒绝再次发送"),
    });
    expect(fetchDouble).toHaveBeenCalledTimes(1);
  });
  it("refuses duplicate settled attempts before sending a second request", async () => {
    const fetchDouble = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchDouble);
    const config = getModelConfig("openai");
    await generateStrategy(input, config, "settled-once");
    await expect(generateStrategy(input, config, "settled-once")).rejects.toMatchObject({
      name: "ModelCallError",
      uncertain: true,
      message: expect.stringContaining("拒绝再次发送"),
    });
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    expect(getBillingSummary().requests).toBe(1);
  });
  it("keeps a real reservation held if settlement fails after known usage arrives", async () => {
    // The real ledger rejects this invalid response ID; this is a storage-boundary failure fixture.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(JSON.stringify(strategy), "invalid response ID")),
    );
    await expect(
      generateStrategy(input, getModelConfig("openai"), "settlement-failure"),
    ).rejects.toMatchObject({ uncertain: true });
    expect(getBillingAttempt("settlement-failure")?.state).toBe("held");
    expect(getBillingSummary().reservedUsdMicros).toBeGreaterThan(0);
    expect(getBillingSummary().settledNativeUsdMicros).toBe(0);
  });
});
