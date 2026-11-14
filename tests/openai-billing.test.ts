/** Synthetic usage fixtures only; no provider requests or historical ledger changes. */
import { describe, expect, it } from "vitest";
import { priceOpenAIResponse, reserveOpenAIAmount } from "../src/lib/server/openai-billing";

const config = { id: "gpt-6.1-terra", inputPrice: 1, outputPrice: 5 };
const response = (patch: Record<string, unknown> = {}) => ({
  model: config.id,
  service_tier: "default",
  usage: {
    input_tokens: 12000,
    output_tokens: 100,
    total_tokens: 12100,
    input_tokens_details: {
      cached_tokens: 4000,
      cache_write_tokens: 7000,
      cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
    },
  },
  ...patch,
});
describe("verified OpenAI rates", () => {
  it("prices mixed write lifetimes as disjoint totals, with the model's actual read rate", () => {
    expect(priceOpenAIResponse(response(), config)).toMatchObject({
      amount: 15450,
      serviceTier: "default",
      cacheWriteInputTokens: 7000,
      cacheWrite30mInputTokens: 3000,
      cacheWrite12hInputTokens: 4000,
    });
    expect(
      priceOpenAIResponse(response({ model: "gpt-6-astra" }), {
        id: "gpt-6-astra",
        inputPrice: 10,
        outputPrice: 50,
      }).amount,
    ).toBe(156500);
  });
  it.each(["fast", "priority"])(
    "accounts actual %s while reserving only the explicit standard/no-cache contract",
    (service_tier) => {
      expect(priceOpenAIResponse(response({ service_tier }), config).amount).toBe(30900);
      expect(reserveOpenAIAmount(12000, 100, config)).toBe(12500);
    },
  );
  it.each([272000, 272001])(
    "applies the documented input and output rates at %s tokens",
    (input_tokens) => {
      const raw = response({
        usage: {
          input_tokens,
          output_tokens: 100,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      });
      expect(priceOpenAIResponse(raw, config).amount).toBe(
        input_tokens === 272000 ? 272500 : 544752,
      );
      expect(reserveOpenAIAmount(input_tokens, 100, config)).toBe(
        input_tokens === 272000 ? 272500 : 544752,
      );
    },
  );
  it.each([
    { model: "gpt-6-astra" },
    { model: "gpt-6.1-terra-2099-01-01" },
    { model: undefined },
    { service_tier: "auto" },
    { service_tier: "ultrafast" },
    { service_tier: "flex" },
    { service_tier: undefined },
    { usage: { input_tokens: 100, output_tokens: 1 } },
    { usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } },
    {
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 50 },
      },
    },
    {
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        input_tokens_details: {
          cached_tokens: 60,
          cache_write_tokens: 50,
          cache_write_tokens_details: { ttl_30m_tokens: 50, ttl_12h_tokens: 0 },
        },
      },
    },
    {
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 50,
          cache_write_tokens_details: { ttl_30m_tokens: 49, ttl_12h_tokens: 0 },
        },
      },
    },
    {
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 50,
          cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0, ttl_24h_tokens: 50 },
        },
      },
    },
    {
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        total_tokens: 102,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    },
  ])("rejects unverifiable model, tier, lifetime or counts %#", (patch) => {
    expect(() => priceOpenAIResponse(response(patch), config)).toThrow();
  });
});
