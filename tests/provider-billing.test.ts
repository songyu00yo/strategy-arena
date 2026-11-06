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
function response(
  content = JSON.stringify(strategy),
  id = "fixture-response",
  patch: Record<string, unknown> = {},
) {
  return Response.json({
    id,
    model: "gpt-6.1-terra",
    service_tier: "default",
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
      input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
    },
    ...patch,
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
  it.each([
    { model: "gpt-6-astra" },
    { model: "gpt-6.1-terra-2099-01-01" },
    { service_tier: undefined },
    { service_tier: "ultrafast" },
    {
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 500 },
      },
    },
    {
      usage: { input_tokens: 1000, output_tokens: 500, input_tokens_details: { cached_tokens: 0 } },
    },
  ])("holds unverifiable billing without settlement or redispatch %#", async (patch) => {
    const fetchDouble = vi.fn().mockResolvedValue(response(undefined, undefined, patch));
    vi.stubGlobal("fetch", fetchDouble);
    const config = getModelConfig("openai");
    await expect(generateStrategy(input, config, "unknown-billing")).rejects.toMatchObject({
      uncertain: true,
    });
    expect(getBillingAttempt("unknown-billing")).toMatchObject({
      state: "held",
      amount_micros: null,
    });
    await expect(generateStrategy(input, config, "unknown-billing")).rejects.toMatchObject({
      uncertain: true,
    });
    expect(fetchDouble).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["fast", 0, 0, 7000],
    ["priority", 0, 0, 7000],
    ["default", 400, 0, 3600],
    ["default", 0, 400, 4100],
  ] as const)(
    "settles actual %s writes %s/%s and stops without repair",
    async (tier, short, long, amount) => {
      const fetchDouble = vi.fn().mockResolvedValue(
        response(undefined, undefined, {
          service_tier: tier,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            input_tokens_details: {
              cached_tokens: 0,
              cache_write_tokens: short + long,
              cache_write_tokens_details: { ttl_30m_tokens: short, ttl_12h_tokens: long },
            },
          },
        }),
      );
      vi.stubGlobal("fetch", fetchDouble);
      await expect(
        generateStrategy(input, getModelConfig("openai"), "billing-policy-deviation"),
      ).rejects.toMatchObject({
        uncertain: false,
        repair: undefined,
        usage: { serviceTier: tier, estimatedUsd: amount / 1e6 },
      });
      expect(getBillingAttempt("billing-policy-deviation")).toMatchObject({
        state: "settled",
        amount_micros: amount,
        model: "gpt-6.1-terra",
        service_tier: tier,
        cache_write_input_tokens: short + long,
        cache_write_30m_input_tokens: short,
        cache_write_12h_input_tokens: long,
      });
      expect(fetchDouble).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchDouble.mock.calls[0][1].body);
      expect(body).toMatchObject({
        service_tier: "default",
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
      });
      expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
    },
  );
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
          usage: { estimatedUsd: 0.00331 },
        });
      expect(getBillingAttempt("known-usage")).toMatchObject({
        state: "settled",
        currency: "USD",
        amount_micros: 3310,
        input_tokens: 1000,
        output_tokens: 500,
        cached_input_tokens: 200,
        service_tier: "default",
        model: "gpt-6.1-terra",
        cache_write_input_tokens: 0,
        cache_write_30m_input_tokens: 0,
        cache_write_12h_input_tokens: 0,
      });
      expect(getBillingSummary()).toMatchObject({
        requests: 1,
        settledNativeUsdMicros: 3310,
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
