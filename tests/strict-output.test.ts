/** HTTP doubles only: these tests do not call DeepSeek or establish model quality. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AttackSchema,
  ChallengeSchema,
  RevisionSchema,
  StrategySchema,
  VerdictSchema,
  type StageInput,
} from "../src/lib/contracts";
import {
  buildRequestBody,
  estimateCallCost,
  estimateCallTokens,
  generateStrategy,
  generateVerdict,
  getModelConfig,
} from "../src/lib/server/model";
import {
  bindStrictReferences,
  referenceInstructions,
  restoreStrictNulls,
  toStrictToolSchema,
} from "../src/lib/server/strict-schema";
const input: StageInput = {
  role: "A",
  challenge: ChallengeSchema.parse({ goal: "两周内完成课程并制作一个可以演示的项目" }),
  strategies: [],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
};
const strategy = {
  id: "A",
  title: "课程练习",
  thesis: "用课程练习制作项目",
  steps: ["先完成试听"],
  claims: [{ id: "A1", text: "课程质量未知", status: "unknown", sourceIds: [] }],
  resources: "现有设备",
  firstAction: "试听",
  failureCondition: "时间不足",
  estimatedCost: "unknown",
  estimatedHours: 8,
};
function response(args = JSON.stringify(strategy), name = "submit_propose") {
  return {
    id: "strict-fixture",
    model: "returned-model",
    usage: { prompt_tokens: 100, completion_tokens: 200 },
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{ type: "function", function: { name, arguments: args } }],
        },
      },
    ],
  };
}
beforeEach(() => {
  vi.stubEnv("MODEL_API_KEY", "strict-output-fixture");
  vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "strict-tool");
  vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com/beta");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("strict provider schema", () => {
  it("pairs each attack with only its own evidence in response and finding anyOf variants", () => {
    const attack = {
      id: "attack-A",
      from: "A",
      targetStrategyId: "B" as const,
      targetClaimId: "B1",
      claimQuote: "待核验观点",
      reason: "核实成本",
      impact: "影响选择",
      verification: "检索材料",
      requests: [],
      status: "pending" as const,
    };
    const evidence = {
      id: "E-A",
      attackId: "attack-A",
      tool: "search_materials" as const,
      status: "unavailable" as const,
      title: "材料缺失",
      content: "没有材料",
      source: "用户材料",
      sourceIds: [],
      expression: null,
      result: null,
      assumptions: "",
      createdAt: "2026-11-04T00:00:00Z",
    };
    const current: StageInput = {
      ...input,
      attacks: [attack, { ...attack, id: "attack-B" }, { ...attack, id: "attack-C" }],
      evidence: [
        evidence,
        { ...evidence, id: "E-B", attackId: "attack-B" },
        { ...evidence, id: "E-constraint", attackId: "constraint-A" },
      ],
    };
    type Variant = {
      properties: {
        attackId: { enum: string[] };
        evidenceIds: { items: { enum?: string[] }; description?: string };
      };
      required: string[];
      additionalProperties: boolean;
    };
    for (const [kind, source, field] of [
      ["revise", RevisionSchema, "responses"],
      ["judge", VerdictSchema, "attackFindings"],
    ] as const) {
      const raw = toStrictToolSchema(z.toJSONSchema(source));
      const before = JSON.stringify(raw);
      const bound = bindStrictReferences(raw, kind, current) as {
        properties: Record<string, { items: { anyOf: Variant[] } }>;
      };
      const variants = bound.properties[field].items.anyOf;
      expect(variants).toHaveLength(3);
      expect(variants.map((item) => item.properties.attackId.enum)).toEqual([
        ["attack-A"],
        ["attack-B"],
        ["attack-C"],
      ]);
      expect(variants[0].properties.evidenceIds.items.enum).toEqual(["E-A"]);
      expect(variants[1].properties.evidenceIds.items.enum).toEqual(["E-B"]);
      expect(variants[2].properties.evidenceIds.items).not.toHaveProperty("enum");
      expect(variants[2].properties.evidenceIds.description).toContain("必须为 []");
      for (const item of variants) {
        expect(item.additionalProperties).toBe(false);
        expect(item.required).toContain("attackId");
      }
      expect(JSON.stringify(bound.properties[field])).not.toContain("E-constraint");
      expect(JSON.stringify(raw)).toBe(before);
    }
    expect(referenceInstructions("revise", current)).toContain(
      '["attack-C"]，其 evidenceIds 必须为 []',
    );
  });
  it("binds attack/response/judgment references while excluding constraint pseudo-attacks", () => {
    const current: StageInput = {
      ...input,
      strategies: [
        StrategySchema.parse({ ...strategy, estimatedCost: null }),
        StrategySchema.parse({
          ...strategy,
          id: "B",
          estimatedCost: null,
          claims: [
            {
              id: "B-only-claim",
              text: "另一条路线的待核验主张",
              status: "unknown",
              sourceIds: [],
            },
          ],
        }),
      ],
      attacks: [
        {
          id: "attack-C",
          from: "B",
          targetStrategyId: "A",
          targetClaimId: "A1",
          claimQuote: "课程质量未知",
          reason: "待核验",
          impact: "影响选择",
          verification: "查材料",
          requests: [],
          status: "pending",
        },
        {
          id: "constraint-A",
          from: "A",
          targetStrategyId: "B",
          targetClaimId: "B-only-claim",
          claimQuote: "另一条路线的待核验主张",
          reason: "合成无效攻击",
          impact: "测试",
          verification: "测试",
          requests: [],
          status: "pending",
        },
      ],
      evidence: [
        {
          id: "E-known",
          attackId: "attack-C",
          tool: "search_materials",
          status: "unavailable",
          title: "材料缺失",
          content: "缺失",
          source: "用户材料",
          sourceIds: [],
          expression: null,
          result: null,
          assumptions: "",
          createdAt: "2026-11-04T00:00:00Z",
        },
      ],
    };
    const revise = bindStrictReferences(
      toStrictToolSchema(z.toJSONSchema(RevisionSchema)),
      "revise",
      current,
    );
    expect(revise).toMatchObject({
      properties: {
        strategyId: { enum: ["A"] },
        strategy: { properties: { id: { enum: ["A"] } } },
        responses: {
          items: {
            anyOf: [
              {
                properties: {
                  attackId: { enum: ["attack-C"] },
                  evidenceIds: { items: { enum: ["E-known"] } },
                },
              },
            ],
          },
        },
      },
    });
    const judge = bindStrictReferences(
      toStrictToolSchema(z.toJSONSchema(VerdictSchema)),
      "judge",
      current,
    );
    expect(judge).toMatchObject({
      properties: {
        preferred: { enum: ["A", "B", "unknown"] },
        evidenceIds: { items: { enum: ["E-known"] } },
        comparisons: { items: { properties: { strategyId: { enum: ["A", "B"] } } } },
        attackFindings: {
          items: {
            anyOf: [
              {
                properties: {
                  attackId: { enum: ["attack-C"] },
                  evidenceIds: { items: { enum: ["E-known"] } },
                },
              },
            ],
          },
        },
      },
    });
    expect(judge.properties).not.toHaveProperty("anyOf");
    const attack = bindStrictReferences(
      toStrictToolSchema(z.toJSONSchema(AttackSchema)),
      "attack",
      current,
    );
    expect(attack).toMatchObject({
      properties: {
        from: { enum: ["A"] },
        targetStrategyId: { enum: ["B"] },
        targetClaimId: { enum: ["B-only-claim"] },
        claimQuote: { enum: ["另一条路线的待核验主张"] },
      },
    });
    const self = bindStrictReferences(toStrictToolSchema(z.toJSONSchema(AttackSchema)), "attack", {
      ...current,
      evaluationMode: "independent",
    });
    expect(self).toMatchObject({
      properties: { targetStrategyId: { enum: ["A"] }, targetClaimId: { enum: ["A1"] } },
    });
    const body = buildRequestBody("revise", current);
    expect(body.tools?.[0].function.parameters).toEqual(revise);
    expect(body.messages[0].content).toContain("不得为它生成 responses 项");
    expect(body.messages[0].content).toContain('attackId=["attack-C"]');
  });
  it("never emits empty enum arrays and instructs empty reference lists without leaking proposal opponents", () => {
    const converted = bindStrictReferences(
      toStrictToolSchema(z.toJSONSchema(RevisionSchema)),
      "revise",
      input,
    );
    function inspect(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }
      const item = value as Record<string, unknown>;
      if (Array.isArray(item.enum)) expect(item.enum.length).toBeGreaterThan(0);
      Object.values(item).forEach(inspect);
    }
    inspect(converted);
    expect(referenceInstructions("revise", input)).toContain(
      "responses 和 attackFindings 必须为 []",
    );
    expect(referenceInstructions("revise", input)).toContain("所有 evidenceIds 必须为 []");
    expect(
      referenceInstructions("propose", {
        ...input,
        strategies: [
          StrategySchema.parse({ ...strategy, title: "PRIVATE_OPPONENT", estimatedCost: null }),
        ],
      }),
    ).not.toContain("PRIVATE_OPPONENT");
  });
  it("reserves the largest actual serialized request plus framing and maximum output", () => {
    const entries = [
      ["propose", StrategySchema],
      ["attack", AttackSchema],
      ["revise", RevisionSchema],
      ["judge", VerdictSchema],
    ] as const;
    const config = getModelConfig();
    const largest = Math.max(
      ...entries.map(([kind, schema]) =>
        Buffer.byteLength(JSON.stringify(buildRequestBody(kind, input, schema, config)), "utf8"),
      ),
    );
    expect(estimateCallTokens(input)).toBe(largest + 1024 + config.maxOutputTokens);
    expect(estimateCallCost(input)).toBeGreaterThanOrEqual(
      ((largest + 1024) * config.inputPrice + config.maxOutputTokens * config.outputPrice) / 1e6,
    );
    expect(JSON.stringify(buildRequestBody("propose", input))).not.toContain(
      "strict-output-fixture",
    );
  });
  it.each([StrategySchema, AttackSchema, RevisionSchema, VerdictSchema])(
    "closes every object, requires defaults and removes unsupported keywords",
    (schema) => {
      const converted = toStrictToolSchema(z.toJSONSchema(schema));
      function inspect(value: unknown) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(inspect);
          return;
        }
        const node = value as Record<string, unknown>;
        for (const key of [
          "$schema",
          "default",
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "oneOf",
        ])
          expect(node).not.toHaveProperty(key);
        expect(node.type).not.toBe("null");
        if (node.type === "object") {
          expect(node.additionalProperties).toBe(false);
          expect(node.required).toEqual(Object.keys(node.properties as object));
        }
        Object.values(node).forEach(inspect);
      }
      inspect(converted);
      expect(JSON.stringify(converted)).toContain("pattern");
    },
  );
  it("converts discriminant constants and restores only known nullable fields recursively", () => {
    expect(
      toStrictToolSchema({
        oneOf: [{ type: "object", properties: { tool: { type: "string", const: "calculate" } } }],
      }),
    ).toMatchObject({
      anyOf: [
        {
          properties: { tool: { type: "string", enum: ["calculate"] } },
          required: ["tool"],
          additionalProperties: false,
        },
      ],
    });
    expect(
      restoreStrictNulls({
        strategy: { estimatedCost: "unknown", estimatedHours: "unknown", thesis: "unknown" },
        preferred: "unknown",
        status: "unknown",
      }),
    ).toEqual({
      strategy: { estimatedCost: null, estimatedHours: null, thesis: "unknown" },
      preferred: null,
      status: "unknown",
    });
  });
});
describe("explicit strict-tool adapter", () => {
  it("sends one forced strict function to the configured beta endpoint and restores null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(response()));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateStrategy(input);
    expect(result.value).toMatchObject({ estimatedCost: null, estimatedHours: 8 });
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 200,
      model: "returned-model",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/beta/chat/completions");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "submit_propose",
            strict: true,
            description: "structured protocol output",
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "submit_propose" } },
      thinking: { type: "disabled" },
      stream: false,
    });
    expect(body).not.toHaveProperty("response_format");
    expect(body.messages[0].content).toContain('"unknown"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("restores the nullable preferred verdict without changing unknown comparison statuses", async () => {
    const verdict = {
      outcome: "insufficient",
      preferred: "unknown",
      headline: "证据不足",
      rationale: "仅为测试",
      conditions: [],
      uncertainties: ["未知"],
      nextActions: ["补充材料"],
      exitCondition: "证据不足不执行",
      evidenceIds: [],
      comparisons: [{ strategyId: "A", status: "unknown", reason: "待核验" }],
      attackFindings: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(response(JSON.stringify(verdict), "submit_judge"))),
    );
    expect((await generateVerdict(input)).value).toMatchObject({
      preferred: null,
      comparisons: [{ status: "unknown" }],
    });
  });
  it.each(["wrong-function", "multiple-calls", "non-string-arguments", "wrong-finish"])(
    "rejects %s and never falls back to JSON mode",
    async (variant) => {
      const data = response();
      if (variant === "wrong-function")
        data.choices[0].message.tool_calls[0].function.name = "different_function";
      if (variant === "multiple-calls")
        data.choices[0].message.tool_calls.push(data.choices[0].message.tool_calls[0]);
      if (variant === "non-string-arguments")
        Object.assign(data.choices[0].message.tool_calls[0].function, {
          arguments: { invalid: true },
        });
      if (variant === "wrong-finish") data.choices[0].finish_reason = "stop";
      const fetchMock = vi.fn().mockResolvedValue(Response.json(data));
      vi.stubGlobal("fetch", fetchMock);
      await expect(generateStrategy(input)).rejects.toMatchObject({
        uncertain: false,
        usage: { inputTokens: 100 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("holds unknown usage instead of assuming the strict response was free", async () => {
    const data = response();
    const { usage: ignored, ...withoutUsage } = data;
    void ignored;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(withoutUsage)));
    await expect(generateStrategy(input)).rejects.toMatchObject({ uncertain: true });
  });
  it("does not silently rewrite the configured non-beta endpoint", async () => {
    vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateStrategy(input)).rejects.toThrow("显式设置");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("supports explicitly selected JSON mode and records syntax detail only in private repair feedback", async () => {
    vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "json");
    vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com");
    expect(getModelConfig().structuredOutput).toBe("json");
    const bad = '{"id":"A" "title":"PRIVATE_FIXTURE"}';
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        usage: { prompt_tokens: 1, completion_tokens: 2 },
        choices: [{ finish_reason: "stop", message: { content: bad } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await generateStrategy(input);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({
        uncertain: false,
        usage: { inputTokens: 1 },
        repair: { rejectedOutput: bad },
      });
      expect((error as { repair: { feedback: string } }).repair.feedback).toContain("position");
      expect((error as Error).message).not.toContain("PRIVATE_FIXTURE");
    }
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveProperty("response_format");
  });
});
