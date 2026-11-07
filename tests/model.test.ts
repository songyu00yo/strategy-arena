import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChallengeSchema,
  StrategySchema,
  AttackSchema,
  RevisionSchema,
  VerdictSchema,
  type StageInput,
} from "../src/lib/contracts";
import {
  buildMessages,
  buildRequestBody,
  getModelConfig,
  generateEvaluation,
  estimateCallTokens,
  estimateCallCost,
  generateStrategy,
  generateVerdict,
  ModelCallError,
} from "../src/lib/server/model";
// Explicit billing test double: these tests never touch a live budget or provider.
const billing = vi.hoisted(() => ({
  reserveBilling: vi.fn(),
  settleBilling: vi.fn(),
  holdBilling: vi.fn(),
}));
vi.mock("../src/lib/server/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/billing")>()),
  ...billing,
}));
import { BillingError } from "../src/lib/server/billing";
const input: StageInput = {
  role: "A",
  challenge: ChallengeSchema.parse({
    goal: "两周内完成自己的作品网站",
    options: ["静态生成网站", "模板建站", "手工编码"],
  }),
  strategies: [],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
};
const strategy = {
  id: "A",
  title: "静态作品页",
  thesis: "用现有作品组织静态页面",
  steps: ["先整理三件作品"],
  claims: [{ id: "A-1", text: "发布权限待核验", status: "unknown", sourceIds: [] }],
  resources: "已有电脑",
  firstAction: "整理一件作品",
  failureCondition: "没有素材",
  estimatedCost: null,
  estimatedHours: 8,
};
beforeEach(() => {
  vi.resetAllMocks();
  for (const name of [
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL_ID",
    "OPENAI_STRUCTURED_OUTPUT",
    "OPENAI_REASONING_EFFORT",
    "OPENAI_INPUT_PRICE_PER_MILLION",
    "OPENAI_OUTPUT_PRICE_PER_MILLION",
    "OPENAI_MAX_OUTPUT_TOKENS",
    "OPENAI_TIMEOUT_MS",
  ])
    vi.stubEnv(name, undefined);
  vi.stubEnv("MODEL_API_KEY", "fixture-key-not-a-secret");
  vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "json");
  vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("real adapter protocol with explicit HTTP test doubles", () => {
  it("excludes opponents from proposal context and assigns the correct route", () => {
    const contaminated = {
      ...input,
      strategies: [{ ...strategy, thesis: "OPPONENT_PRIVATE_PROPOSAL" }],
    } as StageInput;
    const messages = buildMessages("propose", contaminated, StrategySchema);
    expect(JSON.stringify(messages)).not.toContain("OPPONENT_PRIVATE_PROPOSAL");
    expect(messages[1].content).toContain("静态生成网站");
    expect(estimateCallCost(input)).toBeGreaterThan(0);
  });
  it("includes confirmed assumptions in every stage and prioritizes current fields over historical material", () => {
    const current: StageInput = {
      ...input,
      assumptions: ["先验证已有设备是否可用"],
      challenge: {
        ...input.challenge,
        constraints: "当前团队两人，不可增人",
        materials: "早期用户原话：团队五人",
      },
    };
    for (const [kind, schema] of [
      ["propose", StrategySchema],
      ["attack", AttackSchema],
      ["revise", RevisionSchema],
      ["judge", VerdictSchema],
    ] as const) {
      const messages = buildMessages(kind, current, schema);
      const data = JSON.parse(messages[1].content.slice(messages[1].content.indexOf("\n") + 1));
      expect(data).toMatchObject({
        assumptions: ["先验证已有设备是否可用"],
        challenge: { constraints: "当前团队两人，不可增人" },
      });
      expect(messages[0].content).toContain("优先于材料内的历史原话");
      expect(messages[0].content).toContain("不是材料原文或工具证据");
    }
  });
  it("keeps the assigned route and explicit deliverables in revision requests with the strengthened protocol", () => {
    const revision: StageInput = {
      ...input,
      role: "B",
      challenge: {
        ...input.challenge,
        goal: "交付三个可离线打开的练习页面，并保留互动按钮及全部说明",
        constraints: "固定两名成员，合计工时不超过12小时",
        options: ["手写HTML和CSS", "修改免费静态模板", "免费静态生成工具"],
      },
      strategies: [{ ...strategy, id: "B", title: "静态模板路线" }] as StageInput["strategies"],
    };
    const messages = buildMessages("revise", revision, RevisionSchema);
    expect(messages[1].content).toContain('本角色负责比较的已有路线："修改免费静态模板"');
    const data = JSON.parse(messages[1].content.slice(messages[1].content.indexOf("\n") + 1));
    expect(data).toMatchObject({
      role: "B",
      challenge: { goal: revision.challenge.goal, constraints: revision.challenge.constraints },
      strategies: [{ id: "B", title: "静态模板路线" }],
    });
    expect(messages[0].content).toContain("保留本角色原路线的关键执行机制");
    expect(messages[0].content).toContain(
      "减少交付数量、删除必要功能或缩减交付范围，必须先获得用户明确同意",
    );
    expect(messages[0].content).toContain(
      "标题、分项、第一步、下一步、停止阈值中的累计时间必须一致",
    );
    const judge = buildMessages("judge", revision, VerdictSchema)[0].content;
    expect(judge).toContain("逐个累计各验证或撤回节点之前的全部前置步骤");
    expect(judge).toContain("不等于“已证明满足全部硬限制”");
  });
  it("sends bounded JSON request and records returned model and actual usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "fixture-response",
        model: "provider-returned-snapshot",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(strategy),
              reasoning_content: "DO_NOT_STORE_PRIVATE_REASONING",
            },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 200 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateStrategy(input);
    expect(result.value.id).toBe("A");
    expect(result.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      model: "provider-returned-snapshot",
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_STORE_PRIVATE_REASONING");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      stream: false,
    });
    expect(body.max_tokens).toBeLessThanOrEqual(6000);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });
  it("retains charge metadata for invalid JSON, never silently retries", async () => {
    const fn = vi.fn().mockResolvedValue(
      Response.json({
        id: "invalid-fixture",
        choices: [{ finish_reason: "stop", message: { content: "invalid json" } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
    );
    vi.stubGlobal("fetch", fn);
    await expect(generateStrategy(input)).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        amount: 1200,
        inputTokens: 100,
        outputTokens: 100,
      }),
    );
  });
  it("returns the judge's five-condition boundary and received count with original output and usage", async () => {
    vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "strict-tool");
    vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com/beta");
    const rejected = JSON.stringify({
      outcome: "insufficient",
      preferred: "unknown",
      headline: "合成裁决，尚未核实",
      rationale: "仅测试超项反馈，不评价模型质量",
      conditions: Array.from({ length: 6 }, (_, index) => `合成硬限制${index + 1}须保留`),
      uncertainties: ["检测费用未知"],
      nextActions: ["先核实安全与总费用"],
      exitCondition: "必要前提未确认则停止",
      evidenceIds: [],
      comparisons: [],
      attackFindings: [],
    });
    const fetchDouble = vi.fn().mockResolvedValue(
      Response.json({
        id: "synthetic-six-conditions",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                { type: "function", function: { name: "submit_judge", arguments: rejected } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
    vi.stubGlobal("fetch", fetchDouble);
    const error = await generateVerdict({ ...input, role: "judge" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ModelCallError);
    if (!(error instanceof ModelCallError)) throw new Error("Expected bounded validation failure");
    expect(error).toMatchObject({
      uncertain: false,
      usage: { inputTokens: 100, outputTokens: 50 },
      repair: { rejectedOutput: rejected },
    });
    expect(error.repair?.feedback).toContain("conditions: too_big");
    expect(error.repair?.feedback).toContain("maximum=5");
    expect(error.repair?.feedback).toContain("最多5项");
    expect(error.repair?.feedback).toContain("实收6项");
    expect(error.repair?.feedback).not.toContain("合成硬限制");
    expect(error.repair!.feedback.length).toBeLessThanOrEqual(1500);
    const sent = JSON.parse(fetchDouble.mock.calls[0][1].body).messages[0].content;
    for (const limit of [
      "conditions 最多 5 项",
      "uncertainties 最多 6 项",
      "nextActions 最多 5 项",
    ])
      expect(sent).toContain(limit);
    expect(sent).toContain("数组超项时合并同类内容");
    expect(sent).toContain("保留全部硬限制、证据和未知");
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    expect(billing.reserveBilling).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ inputTokens: 100, outputTokens: 50 }),
    );
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it.each([
    {
      patch: { title: "PRIVATE-MODEL-CONTENT ".repeat(3) },
      path: "title",
      code: "too_big",
      bound: "maximum=50",
      rule: "最多50字符",
      count: "实收66字符",
    },
    {
      patch: { thesis: "" },
      path: "thesis",
      code: "too_small",
      bound: "minimum=1",
      rule: "至少1字符",
      count: "实收0字符",
    },
    {
      patch: { steps: [] },
      path: "steps",
      code: "too_small",
      bound: "minimum=1",
      rule: "至少1项",
      count: "实收0项",
    },
    {
      patch: { estimatedCost: -987654321 },
      path: "estimatedCost",
      code: "too_small",
      bound: "minimum=0",
      rule: "至少0（数值）",
      count: null,
    },
  ])(
    "reports safe $path bounds without exposing input contents or retrying",
    async ({ patch, path, code, bound, rule, count }) => {
      const rejected = JSON.stringify({ ...strategy, ...patch });
      const fetchDouble = vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: rejected } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      );
      vi.stubGlobal("fetch", fetchDouble);
      const error = await generateStrategy(input).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelCallError);
      if (!(error instanceof ModelCallError))
        throw new Error("Expected bounded validation failure");
      expect(error.repair?.rejectedOutput).toBe(rejected);
      expect(error.repair?.feedback).toContain(`${path}: ${code}`);
      expect(error.repair?.feedback).toContain(bound);
      expect(error.repair?.feedback).toContain(rule);
      if (count) expect(error.repair?.feedback).toContain(count);
      expect(error.repair?.feedback).not.toContain("PRIVATE-MODEL-CONTENT");
      expect(error.repair?.feedback).not.toContain("987654321");
      expect(error.repair!.feedback.length).toBeLessThanOrEqual(1500);
      expect(error.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
      expect(fetchDouble).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ["ETIMEDOUT", "连接模型服务超时"],
    ["ENOTFOUND", "模型服务域名暂时无法解析"],
    ["CERT_HAS_EXPIRED", "模型服务安全连接校验失败"],
    ["ECONNRESET", "模型服务连接中断或被拒绝"],
    ["PRIVATE_UNKNOWN_CODE", "模型服务连接异常"],
  ])(
    "stores only a safe connection category for %s without making the attempt retryable",
    async (code, category) => {
      const failure = new Error("private input and secret URL", {
        cause: { code, message: "private cause" },
      });
      const fetchDouble = vi.fn().mockRejectedValue(failure);
      vi.stubGlobal("fetch", fetchDouble);
      const error = await generateStrategy(input).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ uncertain: true });
      expect(String(error)).toContain(category);
      expect(String(error)).toMatch(/本次已等待 \d+\.\d 秒/);
      expect(String(error)).not.toContain("private");
      expect(String(error)).not.toContain("PRIVATE_UNKNOWN_CODE");
      expect(fetchDouble).toHaveBeenCalledTimes(1);
      expect(billing.holdBilling).toHaveBeenCalledTimes(1);
      expect(billing.settleBilling).not.toHaveBeenCalled();
    },
  );
  it("treats connection loss as unknown and hides arbitrary upstream body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sensitive upstream message")));
    try {
      await generateStrategy(input);
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelCallError);
      expect(e).toMatchObject({ uncertain: true });
      expect(String(e)).not.toContain("sensitive upstream");
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private user material", { status: 401 })),
    );
    await expect(generateStrategy(input)).rejects.toMatchObject({ uncertain: false });
  });
  it("refuses unconfigured calls before fetch", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    await expect(generateStrategy(input)).rejects.toThrow("未配置");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe.each(["deepseek", "openai"] as const)(
  "%s safe strict-function diagnostics",
  (provider) => {
    it.each([
      "two-calls",
      "wrong-name",
      "non-string-arguments",
      "untrusted-finish",
      "wrong-type",
    ] as const)("records only safe structure metadata for %s without retrying", async (variant) => {
      vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "strict-tool");
      vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com/beta");
      vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
      const config = getModelConfig(provider);
      const args = JSON.stringify({
        ...strategy,
        title: "PRIVATE_ARGUMENT_CONTENT",
        estimatedCost: "unknown",
      });
      const functions: { name: string; arguments: unknown }[] = [
        { name: "submit_propose", arguments: args },
      ];
      if (variant === "two-calls") functions.push({ ...functions[0] });
      if (variant === "wrong-name") functions[0].name = "PRIVATE_FUNCTION_NAME";
      if (variant === "non-string-arguments")
        functions[0].arguments = { private: "PRIVATE_ARGUMENT_CONTENT" };
      const finish =
        variant === "untrusted-finish"
          ? "PRIVATE_FINISH_STATE"
          : provider === "openai"
            ? "completed"
            : "tool_calls";
      const envelope =
        provider === "openai"
          ? {
              id: "synthetic-structure-response",
              model: config.id,
              service_tier: "default",
              status: finish,
              output: functions.map((call) => ({
                ...call,
                type: variant === "wrong-type" ? "PRIVATE_OUTPUT_TYPE" : "function_call",
                status: "completed",
              })),
              usage: {
                input_tokens: 10,
                output_tokens: 20,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              },
            }
          : {
              id: "synthetic-structure-response",
              model: config.id,
              choices: [
                {
                  finish_reason: finish,
                  message: {
                    content: "PRIVATE_MESSAGE_CONTENT",
                    tool_calls: functions.map((call) => ({
                      type: variant === "wrong-type" ? "PRIVATE_OUTPUT_TYPE" : "function",
                      function: call,
                    })),
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 20 },
            };
      const fetchDouble = vi.fn().mockResolvedValue(Response.json(envelope));
      vi.stubGlobal("fetch", fetchDouble);
      const error = await generateStrategy(input, config).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelCallError);
      if (!(error instanceof ModelCallError)) throw new Error("Expected strict structure failure");
      const count = variant === "two-calls" ? 2 : 1;
      const countedCalls = variant === "wrong-type" && provider === "openai" ? 0 : count;
      expect(error).toMatchObject({
        uncertain: false,
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      expect(error.repair).toBeUndefined();
      expect(error.diagnostic).toEqual({
        expectedFunction: "submit_propose",
        receivedFunctionCount: countedCalls,
        matchingFunctionCount: variant === "wrong-name" ? 0 : countedCalls,
        stringArgumentCount: variant === "non-string-arguments" ? 0 : countedCalls,
        unexpectedItemCount: variant === "wrong-type" ? 1 : 0,
        incompleteFunctionCount: 0,
        finishState:
          variant === "untrusted-finish"
            ? "other"
            : provider === "openai"
              ? "completed"
              : "tool_calls",
      });
      expect(JSON.stringify(error.diagnostic)).not.toContain("PRIVATE_");
      expect(String(error)).not.toContain("PRIVATE_");
      expect(fetchDouble).toHaveBeenCalledTimes(1);
      expect(billing.reserveBilling).toHaveBeenCalledTimes(1);
      expect(billing.settleBilling).toHaveBeenCalledTimes(1);
      expect(billing.holdBilling).not.toHaveBeenCalled();
    });
  },
);

describe("strict unknown sentinel is exact", () => {
  it.each(["unknown", '"unknown"', String.raw`\"unknown\"`, "unknown "])(
    "does not silently normalize extra quoting or whitespace: %j",
    async (sentinel) => {
      vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "strict-tool");
      vi.stubEnv("MODEL_BASE_URL", "https://api.deepseek.com/beta");
      const output = JSON.stringify({
        ...strategy,
        estimatedCost: sentinel,
        estimatedHours: "unknown",
      });
      const fetchDouble = vi.fn().mockResolvedValue(
        Response.json({
          id: "synthetic-unknown-response",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  { type: "function", function: { name: "submit_propose", arguments: output } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );
      vi.stubGlobal("fetch", fetchDouble);
      const result = await generateStrategy(input).catch((caught: unknown) => caught);
      if (sentinel === "unknown") {
        expect(result).toMatchObject({ value: { estimatedCost: null, estimatedHours: null } });
      } else {
        expect(result).toBeInstanceOf(ModelCallError);
        if (!(result instanceof ModelCallError))
          throw new Error("Expected unchanged invalid sentinel");
        expect(result.repair).toMatchObject({
          feedback: expect.stringContaining("estimatedCost: invalid_type"),
          rejectedOutput: output,
        });
        expect(result.diagnostic).toBeUndefined();
      }
      const sent = JSON.parse(fetchDouble.mock.calls[0][1].body).messages[0].content;
      const rule = sent.slice(sent.indexOf("在 estimatedCost"), sent.indexOf("其他字段的 unknown"));
      expect(rule).toContain("字符串“unknown”");
      expect(rule).toContain("字符串内容仅为 unknown，不含额外引号或反斜杠");
      expect(rule).not.toContain(String.raw`\"`);
      expect(fetchDouble).toHaveBeenCalledTimes(1);
    },
  );
});

describe("provider isolation and native billing with explicit test doubles", () => {
  const gptResponse = (content = JSON.stringify(strategy)) =>
    Response.json({
      id: "gpt-fixture",
      model: "gpt-6.1-terra",
      service_tier: "default",
      status: "completed",
      output: [
        { type: "function_call", name: "submit_propose", arguments: content, status: "completed" },
      ],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 300 },
      },
    });
  it("separates credentials, model parameters and currency across providers", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai-key");
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-deepseek-key");
    vi.stubEnv("MODEL_ID", "legacy-deepseek-only");
    vi.stubEnv("MODEL_TEMPERATURE", "1.5");
    vi.stubEnv("MODEL_INPUT_PRICE_PER_MILLION", "42");
    const gpt = getModelConfig("openai");
    const ds = getModelConfig("deepseek");
    expect(gpt).toMatchObject({
      id: "gpt-6.1-terra",
      currency: "USD",
      reasoningEffort: "low",
      inputPrice: 1,
      outputPrice: 5,
    });
    expect(ds).toMatchObject({ id: "legacy-deepseek-only", currency: "CNY", inputPrice: 42 });
    expect(JSON.stringify([gpt, ds])).not.toContain("fake-");
    const body = buildRequestBody("propose", input, StrategySchema, gpt);
    expect(body).toMatchObject({
      max_output_tokens: 2200,
      service_tier: "default",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      reasoning: { effort: "low" },
      store: false,
      parallel_tool_calls: false,
    });
    for (const field of [
      "temperature",
      "max_tokens",
      "thinking",
      "max_completion_tokens",
      "reasoning_effort",
      "messages",
    ])
      expect(body).not.toHaveProperty(field);
    const dsBody = buildRequestBody("propose", input, StrategySchema, ds);
    expect(dsBody).toMatchObject({
      max_tokens: 2200,
      temperature: 1.5,
      thinking: { type: "disabled" },
    });
    expect(dsBody).not.toHaveProperty("reasoning_effort");
    const fn = vi
      .fn()
      .mockResolvedValueOnce(gptResponse())
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(strategy) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );
    vi.stubGlobal("fetch", fn);
    const result = await generateStrategy(input, gpt, "gpt-attempt-fixture");
    await generateStrategy(input, ds, "ds-attempt-fixture");
    expect(fn.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(fn.mock.calls[0][1].headers.Authorization).toBe("Bearer fake-openai-key");
    expect(fn.mock.calls[1][1].headers.Authorization).toBe("Bearer fake-deepseek-key");
    expect(result.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      estimatedCny: 0,
      estimatedUsd: 0.00331,
      currency: "USD",
      provider: "openai",
      billingAttemptId: "gpt-attempt-fixture",
    });
    expect(billing.reserveBilling).toHaveBeenCalledWith({
      attemptId: "gpt-attempt-fixture",
      provider: "openai",
      currency: "USD",
      estimatedAmount: Math.ceil(estimateCallCost(input, gpt) * 1e6),
      maxTokens: estimateCallTokens(input, gpt),
    });
    expect(billing.settleBilling).toHaveBeenCalledWith("gpt-attempt-fixture", {
      amount: 3310,
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      responseId: "gpt-fixture",
      model: "gpt-6.1-terra",
      serviceTier: "default",
      cacheWriteInputTokens: 0,
      cacheWrite30mInputTokens: 0,
      cacheWrite12hInputTokens: 0,
    });
    expect(billing.reserveBilling.mock.invocationCallOrder[0]).toBeLessThan(
      fn.mock.invocationCallOrder[0],
    );
  });
  it("uses pinned config after environment changes without provider fallback", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai-key");
    const config = getModelConfig("openai");
    vi.stubEnv("OPENAI_MODEL_ID", "unsupported-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://untrusted.example/v1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gptResponse()));
    const result = await generateStrategy(input, config);
    expect(result.usage.provider).toBe("openai");
    expect(result.usage.billingAttemptId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("refuses missing provider credentials and unpriced models without fetch or reservation", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    await expect(generateStrategy(input, getModelConfig("openai"))).rejects.toThrow("未配置");
    vi.stubEnv("MODEL_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "fake-openai-key");
    await expect(generateStrategy(input, getModelConfig("deepseek"))).rejects.toThrow("未配置");
    vi.stubEnv("OPENAI_MODEL_ID", "unpriced-model");
    expect(() => getModelConfig("openai")).toThrow("价格");
    expect(fn).not.toHaveBeenCalled();
    expect(billing.reserveBilling).not.toHaveBeenCalled();
  });
  it.each([
    ["deepseek", "MODEL_BASE_URL", "https://untrusted.example/beta"],
    ["openai", "OPENAI_BASE_URL", "https://api.deepseek.com/v1"],
    ["openai", "OPENAI_BASE_URL", "https://api.openai.com:8443/v1"],
  ] as const)(
    "rejects nonofficial %s destinations before sending secrets",
    (provider, env, value) => {
      vi.stubEnv(env, value);
      expect(() => getModelConfig(provider)).toThrow("官方");
    },
  );
  it("refuses GPT in the legacy CNY evaluator before network use", () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai-key");
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(() => generateEvaluation("propose", input, "arena", getModelConfig("openai"))).toThrow(
      "CNY",
    );
    expect(fn).not.toHaveBeenCalled();
  });
  it("refuses fetch when the required central budget is unavailable or exhausted", async () => {
    billing.reserveBilling.mockImplementation(() => {
      throw new Error("budget test-double refuses reservation");
    });
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    await expect(generateStrategy(input)).rejects.toMatchObject({
      name: "ModelCallError",
      uncertain: false,
      message: "共享计费账本暂时无法预留额度，本次请求未发送，请检查服务器计费状态。",
    });
    expect(fn).not.toHaveBeenCalled();
  });
  it.each([408, 500, 503])("holds unknown HTTP %s requests", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream", { status })));
    await expect(generateStrategy(input, getModelConfig(), "unknown-http")).rejects.toMatchObject({
      uncertain: true,
    });
    expect(billing.holdBilling).toHaveBeenCalledWith("unknown-http");
    expect(billing.settleBilling).not.toHaveBeenCalled();
  });
  it.each([401, 402, 429])("settles definitive HTTP %s with zero spend", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream", { status })));
    await expect(generateStrategy(input, getModelConfig(), "failed-http")).rejects.toMatchObject({
      uncertain: false,
    });
    expect(billing.settleBilling).toHaveBeenCalledWith("failed-http", {
      amount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      responseId: undefined,
    });
  });
  it.each([
    {},
    { prompt_tokens: 100, completion_tokens: -1 },
    { prompt_tokens: 1.5, completion_tokens: 1 },
  ])("holds reservations when provider usage is missing or invalid", async (usage) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ usage, choices: [] })));
    await expect(generateStrategy(input, getModelConfig(), "missing-usage")).rejects.toMatchObject({
      uncertain: true,
    });
    expect(billing.holdBilling).toHaveBeenCalledWith("missing-usage");
    expect(billing.settleBilling).not.toHaveBeenCalled();
  });
  it("settles known GPT spend before rejecting malformed structured output", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gptResponse("invalid JSON")));
    await expect(
      generateStrategy(input, getModelConfig("openai"), "invalid-gpt"),
    ).rejects.toMatchObject({
      uncertain: false,
      usage: { estimatedUsd: 0.00331, estimatedCny: 0 },
    });
    expect(billing.settleBilling).toHaveBeenCalledWith(
      "invalid-gpt",
      expect.objectContaining({ amount: 3310 }),
    );
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("retains unknown state if central settlement fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          usage: { prompt_tokens: 100, completion_tokens: 10 },
          choices: [],
        }),
      ),
    );
    billing.settleBilling.mockImplementation(() => {
      throw new Error("storage failure fixture");
    });
    await expect(
      generateStrategy(input, getModelConfig(), "failed-settlement"),
    ).rejects.toMatchObject({ uncertain: true });
    expect(billing.holdBilling).toHaveBeenCalledWith("failed-settlement");
  });
});

it.each([
  ["BILLING_LIMIT_REACHED", "金额、请求次数或 Token 上限", false],
  ["BILLING_INVALID_CONFIG", "共享计费配置缺失或无效", false],
  ["BILLING_SETTINGS_MISMATCH", "共享账本的固定额度", false],
  ["BILLING_DUPLICATE_ATTEMPT", "拒绝再次发送", true],
] as const)("explains %s safely without fallback or dispatch", async (code, message, uncertain) => {
  vi.stubEnv("OPENAI_API_KEY", "fake-openai-key");
  billing.reserveBilling.mockImplementation(() => {
    throw new BillingError("private database path and upstream data", code);
  });
  const fetchDouble = vi.fn();
  vi.stubGlobal("fetch", fetchDouble);
  const call = generateStrategy(input, getModelConfig("openai"), "blocked-reservation");
  await expect(call).rejects.toMatchObject({ name: "ModelCallError", uncertain });
  await expect(call).rejects.toThrow(message);
  await expect(call).rejects.not.toThrow("private database");
  expect(fetchDouble).not.toHaveBeenCalled();
  expect(billing.reserveBilling).toHaveBeenCalledTimes(1);
  expect(billing.reserveBilling).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "openai" }),
  );
  expect(billing.settleBilling).not.toHaveBeenCalled();
});
