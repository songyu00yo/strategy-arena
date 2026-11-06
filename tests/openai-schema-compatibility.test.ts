/** Provider-schema regression only; no credentials, runtime, ledger or network access. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AttackSchema,
  ChallengeSchema,
  StrategySchema,
  type StageInput,
} from "../src/lib/contracts";
import { buildMessages, buildRequestBody, getModelConfig } from "../src/lib/server/model";
import {
  bindStrictReferences,
  normalizeOpenAISchema,
  toStrictToolSchema,
} from "../src/lib/server/strict-schema";
const strategy = (id: "A" | "B" | "C") =>
  StrategySchema.parse({
    id,
    title: "核实已有报价",
    thesis: "先核实资源再作选择",
    steps: ["询问报价"],
    claims: [
      { id: `${id}-claim-1`, text: `${id}路线报价仍待确认`, status: "unknown", sourceIds: [] },
    ],
    resources: "已有材料",
    firstAction: "询价",
    failureCondition: "报价缺失",
  });
const input: StageInput = {
  role: "A",
  challenge: ChallengeSchema.parse({ goal: "比较三条执行路线并核实资源限制" }),
  strategies: [strategy("A"), strategy("B"), strategy("C")],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
};
beforeEach(() => {
  for (const key of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "MODEL_API_KEY"]) vi.stubEnv(key, "");
  for (const key of [
    "OPENAI_MODEL_ID",
    "OPENAI_BASE_URL",
    "OPENAI_STRUCTURED_OUTPUT",
    "OPENAI_REASONING_EFFORT",
    "MODEL_ID",
    "MODEL_TEMPERATURE",
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "strict-tool");
  vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com/beta");
});
afterEach(() => vi.unstubAllEnvs());

describe("OpenAI finite-enum schema compatibility", () => {
  it("removes only logically redundant enum patterns recursively and leaves the source untouched", () => {
    const schema = {
      type: "object",
      properties: {
        matching: { type: "string", enum: ["中文", "other"], pattern: "^[\\s\\S]{1,500}$" },
        restrictive: { type: "string", enum: ["valid", "INVALID"], pattern: "^[a-z]+$" },
        freeText: { type: "string", pattern: "^[a-z]+$" },
        invalidPattern: { type: "string", enum: ["A"], pattern: "[" },
        empty: { type: "string", enum: [], pattern: "^A$" },
        mixed: { enum: ["A", 1], pattern: "^A$" },
        nested: {
          type: "array",
          items: { anyOf: [{ type: "string", enum: ["A"], pattern: "^A$" }] },
        },
      },
    };
    const before = structuredClone(schema);
    const normalized = normalizeOpenAISchema(schema);
    expect(normalized).toEqual({
      ...before,
      properties: {
        ...before.properties,
        matching: { type: "string", enum: ["中文", "other"] },
        nested: { type: "array", items: { anyOf: [{ type: "string", enum: ["A"] }] } },
      },
    });
    expect(schema).toEqual(before);
  });
  it("uses the identical normalized attack schema in OpenAI tools and system instructions", () => {
    const bound = bindStrictReferences(
      toStrictToolSchema(z.toJSONSchema(AttackSchema)),
      "attack",
      input,
    );
    const original = structuredClone(bound);
    const body = buildRequestBody("attack", input, AttackSchema, getModelConfig("openai"));
    if (!("input" in body) || !("tools" in body)) throw new Error("Expected strict Responses body");
    const parameters = body.tools[0].parameters;
    const embedded = JSON.parse(
      body.input[0].content.split("输出 json 格式的 Schema：")[1].split("\n严格遵守")[0],
    );
    expect(parameters).toEqual(normalizeOpenAISchema(bound));
    expect(embedded).toEqual(parameters);
    expect(parameters).toMatchObject({
      properties: {
        from: { type: "string", enum: ["A"] },
        targetClaimId: { type: "string", enum: ["B-claim-1", "C-claim-1"] },
        claimQuote: { type: "string", enum: ["B路线报价仍待确认", "C路线报价仍待确认"] },
      },
    });
    for (const field of ["from", "targetClaimId", "claimQuote"])
      expect((parameters.properties as Record<string, unknown>)[field]).not.toHaveProperty(
        "pattern",
      );
    expect((parameters.properties as Record<string, unknown>).reason).toHaveProperty("pattern");
    expect(bound).toEqual(original);
    expect(body).toMatchObject({ max_output_tokens: 2200, reasoning: { effort: "low" } });
    expect(getModelConfig("openai").configurationVersion).toBe("openai-standard-no-cache-1.3.0");
  });
  it("leaves the complete DeepSeek chat request and its existing enum patterns unchanged", () => {
    const config = getModelConfig("deepseek");
    const parameters = bindStrictReferences(
      toStrictToolSchema(z.toJSONSchema(AttackSchema)),
      "attack",
      input,
    );
    const body = buildRequestBody("attack", input, AttackSchema, config);
    expect(body).toEqual({
      model: config.id,
      messages: buildMessages("attack", input, AttackSchema, "strict-tool"),
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
      thinking: { type: "disabled" },
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "submit_attack",
            description: "structured protocol output",
            strict: true,
            parameters,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "submit_attack" } },
    });
    expect((parameters.properties as Record<string, unknown>).from).toHaveProperty("pattern");
    expect((parameters.properties as Record<string, unknown>).claimQuote).toHaveProperty("pattern");
    expect(() =>
      AttackSchema.parse({
        id: "attack-A",
        from: "A",
        targetStrategyId: "B",
        targetClaimId: "B-claim-1",
        claimQuote: "x".repeat(501),
        reason: "需核实",
        impact: "影响选择",
        verification: "查材料",
        requests: [],
        status: "pending",
      }),
    ).toThrow();
  });
});
