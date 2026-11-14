/** Synthetic provider and ledger boundaries only: no paid calls or real images leave this process. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import sharp from "sharp";
import { IntakeAnalysisSchema } from "../src/lib/intake-contracts";
import { MODEL_CATALOG } from "../src/lib/model-catalog";
import {
  generateStructured,
  estimateStructuredCall,
  getModelConfig,
  MAX_STRUCTURED_IMAGE_TOKENS,
  resolveModelConfig,
} from "../src/lib/server/model";
const billing = vi.hoisted(() => ({
  reserveBilling: vi.fn(),
  settleBilling: vi.fn(),
  holdBilling: vi.fn(),
}));
vi.mock("../src/lib/server/billing", async (original) => ({
  ...(await original<typeof import("../src/lib/server/billing")>()),
  ...billing,
}));
const schema = z.object({ answer: z.string().min(1).max(100) });
const request = {
  name: "intake",
  schema,
  system: "整理用户原话，不虚构条件",
  input: { text: "先比较课程" },
  attemptId: "structured-fixture",
};
function response(
  provider: "openai" | "deepseek",
  output = '{"answer":"先试听"}',
  inputTokens = 100,
  model = "gpt-6.1-terra",
) {
  return Response.json(
    provider === "openai"
      ? {
          id: "response-fixture",
          status: "completed",
          model,
          service_tier: "default",
          usage: {
            input_tokens: inputTokens,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
          output: [
            {
              type: "function_call",
              name: "submit_intake",
              arguments: output,
              status: "completed",
            },
          ],
        }
      : {
          id: "response-fixture",
          model: "fixture-snapshot",
          usage: { prompt_tokens: inputTokens, completion_tokens: 10 },
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  { type: "function", function: { name: "submit_intake", arguments: output } },
                ],
              },
            },
          ],
        },
  );
}
async function image() {
  const data = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  return { width: 16, height: 16, dataUrl: `data:image/png;base64,${data.toString("base64")}` };
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of [
    "OPENAI_MODEL_ID",
    "OPENAI_BASE_URL",
    "OPENAI_REASONING_EFFORT",
    "OPENAI_STRUCTURED_OUTPUT",
    "OPENAI_INPUT_PRICE_PER_MILLION",
    "OPENAI_OUTPUT_PRICE_PER_MILLION",
    "MODEL_ID",
    "MODEL_BASE_URL",
    "MODEL_STRUCTURED_OUTPUT",
    "MODEL_INPUT_PRICE_PER_MILLION",
    "MODEL_OUTPUT_PRICE_PER_MILLION",
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-not-secret");
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-not-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("five model structured generation and shared billing", () => {
  it("resolves exact catalog prices despite legacy Terra global price overrides", () => {
    vi.stubEnv("OPENAI_INPUT_PRICE_PER_MILLION", "1");
    vi.stubEnv("OPENAI_OUTPUT_PRICE_PER_MILLION", "5");
    for (const model of MODEL_CATALOG)
      expect(resolveModelConfig(model.id)).toMatchObject({
        id: model.id,
        provider: model.provider,
        inputPrice: model.inputPrice,
        outputPrice: model.outputPrice,
      });
    expect(resolveModelConfig().id).toBe("gpt-6.1-terra");
  });
  it.each(MODEL_CATALOG)(
    "uses $id consistently with native currency and one shared settlement",
    async (model) => {
      const fetch = vi.fn().mockResolvedValue(response(model.provider, undefined, 100, model.id));
      vi.stubGlobal("fetch", fetch);
      const result = await generateStructured({ ...request, modelId: model.id });
      expect(result.value).toEqual({ answer: "先试听" });
      expect(result.usage).toMatchObject({
        currency: model.currency,
        provider: model.provider,
        billingAttemptId: request.attemptId,
      });
      expect(billing.reserveBilling).toHaveBeenCalledWith(
        expect.objectContaining({ provider: model.provider, currency: model.currency }),
      );
      const estimate = estimateStructuredCall({ ...request, modelId: model.id });
      expect(billing.reserveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTokens: estimate.tokens,
          estimatedAmount: Math.ceil(estimate.amount * 1e6),
        }),
      );
      expect(billing.settleBilling).toHaveBeenCalledWith(
        request.attemptId,
        expect.objectContaining({
          amount: Math.ceil(100 * model.inputPrice + 10 * model.outputPrice),
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(model.id);
      if (model.provider === "openai") {
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
          service_tier: "default",
          prompt_cache_options: { mode: "explicit", ttl: "30m" },
        });
        expect(fetch.mock.calls[0][1].body).not.toContain("prompt_cache_breakpoint");
      }
    },
  );
  it.each(["openai", "deepseek"] as const)(
    "sends real image parts for %s, budgets image tokens separately from base64",
    async (provider) => {
      const fetch = vi.fn().mockImplementation(async () => response(provider));
      vi.stubGlobal("fetch", fetch);
      await generateStructured({ ...request, config: getModelConfig(provider) });
      const textReservation = billing.reserveBilling.mock.calls[0][0];
      billing.reserveBilling.mockClear();
      const picture = await image();
      await generateStructured({ ...request, config: getModelConfig(provider), images: [picture] });
      const visionReservation = billing.reserveBilling.mock.calls[0][0];
      expect(visionReservation.maxTokens - textReservation.maxTokens).toBe(
        MAX_STRUCTURED_IMAGE_TOKENS,
      );
      const body = JSON.parse(fetch.mock.calls[1][1].body);
      const content = provider === "openai" ? body.input[1].content : body.messages[1].content;
      expect(content[1].type).toBe(provider === "openai" ? "input_image" : "image_url");
      expect(JSON.stringify(content)).toContain(picture.dataUrl);
    },
  );
  it("normalizes strict schema enums and still rejects an invalid finite value after settlement", async () => {
    const finite = z.object({ choice: z.enum(["A", "B"]), note: z.string().min(1).max(20) });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response("openai", JSON.stringify({ choice: "C", note: "invalid choice" })),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(generateStructured({ ...request, schema: finite })).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100 },
      repair: undefined,
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const parameters = body.tools[0].parameters;
    expect(parameters).toMatchObject({
      additionalProperties: false,
      required: ["choice", "note"],
      properties: { choice: { enum: ["A", "B"] } },
    });
    expect(parameters.properties.choice).not.toHaveProperty("pattern");
    expect(parameters.properties.note).toHaveProperty("pattern");
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("bills and rejects excess intake options without silently deleting facts or making a repair request", async () => {
    const tooMany = {
      ready: true,
      goal: "根据材料比较三条行动路线",
      constraints: "",
      preferences: "",
      options: ["路线A", "路线B", "路线C", "额外事实不应作为第四选项"],
      domain: "general",
      budget: -1,
      budgetQuote: "",
      timeHours: -1,
      timeQuote: "",
      assumptions: [],
      questions: [],
    };
    const fetch = vi.fn().mockResolvedValue(response("openai", JSON.stringify(tooMany)));
    vi.stubGlobal("fetch", fetch);
    await expect(
      generateStructured({ ...request, schema: IntakeAnalysisSchema }),
    ).rejects.toMatchObject({ uncertain: false, usage: { inputTokens: 100 }, repair: undefined });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tooMany.options).toHaveLength(4);
  });
  it("returns bounded repair diagnostics only when a structured caller explicitly opts in", async () => {
    const rejected = JSON.stringify({ summary: "长".repeat(614) });
    const fetch = vi.fn().mockResolvedValue(response("openai", rejected));
    vi.stubGlobal("fetch", fetch);
    await expect(
      generateStructured({
        ...request,
        schema: z.object({ summary: z.string().max(500) }),
        allowRepair: true,
      }),
    ).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100 },
      repair: {
        feedback: expect.stringContaining("summary"),
        rejectedOutput: rejected,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("includes supplied repair feedback and rejected output in the structured reservation estimate", () => {
    const original = estimateStructuredCall(request);
    const repaired = estimateStructuredCall({
      ...request,
      allowRepair: true,
      input: {
        ...request.input,
        repairFeedback: "summary最多500字符",
        rejectedOutput: "长".repeat(614),
      },
    });
    expect(repaired.tokens).toBeGreaterThan(original.tokens);
    expect(repaired.amount).toBeGreaterThan(original.amount);
  });
  it("never offers a format repair when an opted-in request has an unknown network result", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("synthetic lost connection"));
    vi.stubGlobal("fetch", fetch);
    await expect(generateStructured({ ...request, allowRepair: true })).rejects.toMatchObject({
      uncertain: true,
      repair: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(billing.holdBilling).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).not.toHaveBeenCalled();
  });
  it("accepts one redundant trailing brace without another paid attempt and retains normalization provenance", async () => {
    const original = '{"answer":"仅修正语法，不证明内容正确"}}';
    const fetch = vi.fn().mockResolvedValue(response("openai", original));
    vi.stubGlobal("fetch", fetch);
    const result = await generateStructured(request);
    expect(result.value).toEqual({ answer: "仅修正语法，不证明内容正确" });
    expect(result.formatNormalization).toMatchObject({
      originalOutput: original,
      kind: "single-redundant-trailing-object-brace",
      removedSuffix: "}",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(billing.reserveBilling).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("still rejects schema-invalid normalized objects with recorded usage and no silent field completion", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response("openai", '{"unrelated":"not the required answer"}}'));
    vi.stubGlobal("fetch", fetch);
    await expect(generateStructured(request)).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100 },
      repair: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("rejects forged dimensions before reserving or dispatching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      generateStructured({ ...request, images: [{ ...(await image()), width: 1536 }] }),
    ).rejects.toThrow("尺寸");
    expect(fetch).not.toHaveBeenCalled();
    expect(billing.reserveBilling).not.toHaveBeenCalled();
  });
  it("settles actual overrun and stops without pretending the reservation covered it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("openai", undefined, 1000000)));
    await expect(generateStructured(request)).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 1000000 },
    });
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("uses frozen config and never forwards malformed output in a repair payload", async () => {
    const config = resolveModelConfig("gpt-6.1-sol");
    vi.stubEnv("OPENAI_MODEL_ID", "unpriced");
    const fetch = vi
      .fn()
      .mockResolvedValue(response("openai", "PRIVATE_DOCUMENT_BODY", 100, config.id));
    vi.stubGlobal("fetch", fetch);
    await expect(generateStructured({ ...request, config })).rejects.toMatchObject({
      usage: { provider: "openai" },
      repair: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("gpt-6.1-sol");
  });
});
