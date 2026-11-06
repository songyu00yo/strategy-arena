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

describe("provider isolation and native billing with explicit test doubles", () => {
  const gptResponse = (content = JSON.stringify(strategy)) =>
    Response.json({
      id: "gpt-fixture",
      model: "gpt-6.1-terra",
      status: "completed",
      output: [
        { type: "function_call", name: "submit_propose", arguments: content, status: "completed" },
      ],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: { cached_tokens: 200 },
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
      estimatedUsd: 0.0035,
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
      amount: 3500,
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      responseId: "gpt-fixture",
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
    ).rejects.toMatchObject({ uncertain: false, usage: { estimatedUsd: 0.0035, estimatedCny: 0 } });
    expect(billing.settleBilling).toHaveBeenCalledWith(
      "invalid-gpt",
      expect.objectContaining({ amount: 3500 }),
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
