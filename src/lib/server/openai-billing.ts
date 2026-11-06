import { z } from "zod";

const count = z.number().int().nonnegative().refine(Number.isSafeInteger);
const Writes = z.object({ ttl_30m_tokens: count, ttl_12h_tokens: count }).strict();
const Usage = z.object({
  input_tokens: count,
  output_tokens: count,
  total_tokens: count.optional(),
  input_tokens_details: z
    .object({
      cached_tokens: count,
      cache_write_tokens: count,
      cache_write_tokens_details: Writes.optional(),
    })
    .strict(),
});

/** Only exact catalog identities have verified prices; never accept an arbitrary snapshot suffix.
 * Sources: OpenAI Responses reference, prompt-caching guide and pricing, checked 2026-11-06. */
export function priceOpenAIResponse(
  response: { model?: unknown; service_tier?: unknown; usage?: unknown },
  config: { id: string; inputPrice: number; outputPrice: number },
) {
  if (response.model !== config.id) throw new Error("Unverified returned model identity");
  const tier = z.enum(["default", "fast", "priority"]).parse(response.service_tier);
  const u = Usage.parse(response.usage);
  const d = u.input_tokens_details;
  const writes = d.cache_write_tokens_details;
  if (d.cache_write_tokens > 0 && !writes) throw new Error("Unknown cache write lifetime");
  const cacheWrite30mInputTokens = writes?.ttl_30m_tokens ?? 0;
  const cacheWrite12hInputTokens = writes?.ttl_12h_tokens ?? 0;
  if (
    cacheWrite30mInputTokens + cacheWrite12hInputTokens !== d.cache_write_tokens ||
    d.cached_tokens + d.cache_write_tokens > u.input_tokens ||
    (u.total_tokens !== undefined && u.total_tokens !== u.input_tokens + u.output_tokens)
  )
    throw new Error("Inconsistent reported token counts");
  const long = u.input_tokens > 272000;
  const tierMultiplier = tier === "default" ? 1 : 2;
  const cachedRatio = ["gpt-6.1-terra", "gpt-6.1-sol"].includes(config.id) ? 0.05 : 0.1;
  const amount = Math.ceil(
    tierMultiplier *
      (config.inputPrice *
        (long ? 2 : 1) *
        (u.input_tokens -
          d.cached_tokens -
          d.cache_write_tokens +
          d.cached_tokens * cachedRatio +
          cacheWrite30mInputTokens * 1.25 +
          cacheWrite12hInputTokens * 2.5) +
        u.output_tokens * config.outputPrice * (long ? 1.5 : 1)),
  );
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid billable amount");
  return {
    amount,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedInputTokens: d.cached_tokens,
    cacheWriteInputTokens: d.cache_write_tokens,
    cacheWrite30mInputTokens,
    cacheWrite12hInputTokens,
    serviceTier: tier,
    model: config.id,
  };
}

/** Reserve the explicit standard/no-cache contract, including the input-bound context tier.
 * Unexpected verified charges are settled truthfully and stop the caller. */
export function reserveOpenAIAmount(
  inputTokens: number,
  outputTokens: number,
  config: {
    inputPrice: number;
    outputPrice: number;
  },
) {
  const long = inputTokens > 272000;
  return Math.ceil(
    inputTokens * config.inputPrice * (long ? 2 : 1) +
      outputTokens * config.outputPrice * (long ? 1.5 : 1),
  );
}
