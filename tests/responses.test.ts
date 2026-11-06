/** Responses HTTP and billing doubles only: no live OpenAI request, key or budget. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  estimateCallTokens,
  generateStrategy,
  getModelConfig,
} from "../src/lib/server/model";
const billing = vi.hoisted(() => ({
  reserveBilling: vi.fn(),
  settleBilling: vi.fn(),
  holdBilling: vi.fn(),
}));
vi.mock("../src/lib/server/billing", () => ({
  ...billing,
  BillingError: class extends Error {
    code = "FIXTURE";
  },
}));
const input: StageInput = {
  role: "A",
  challenge: ChallengeSchema.parse({ goal: "比较两周内完成作品网站的三条路线" }),
  strategies: [],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
};
const strategy = {
  id: "A",
  title: "先整理作品",
  thesis: "利用已有材料建立网站",
  steps: ["整理一件作品"],
  claims: [{ id: "A-1", text: "权限待核验", status: "unknown", sourceIds: [] }],
  resources: "现有电脑",
  firstAction: "确认权限",
  failureCondition: "没有可发布作品",
  estimatedCost: "unknown",
  estimatedHours: 8,
};
const usage = {
  input_tokens: 1000,
  output_tokens: 500,
  input_tokens_details: { cached_tokens: 200 },
  output_tokens_details: { reasoning_tokens: 300 },
};
const call = () => ({
  type: "function_call",
  name: "submit_propose",
  arguments: JSON.stringify(strategy),
  status: "completed",
});
const response = (patch: Record<string, unknown> = {}) => ({
  id: "resp_fixture",
  model: "returned-gpt-snapshot",
  status: "completed",
  output: [{ type: "reasoning", summary: [] }, call()],
  usage,
  ...patch,
});
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of [
    "OPENAI_MODEL_ID",
    "OPENAI_STRUCTURED_OUTPUT",
    "OPENAI_BASE_URL",
    "OPENAI_REASONING_EFFORT",
    "OPENAI_MAX_OUTPUT_TOKENS",
    "OPENAI_INPUT_PRICE_PER_MILLION",
    "OPENAI_OUTPUT_PRICE_PER_MILLION",
    "OPENAI_TIMEOUT_MS",
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-responses-fixture");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function mockResponse(patch: Record<string, unknown> = {}) {
  const fetch = vi.fn().mockResolvedValue(Response.json(response(patch)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("OpenAI Responses with authorized low reasoning and forced structured tools", () => {
  it("sends the actual flat Responses schema, disables storage and accounts reasoning once", async () => {
    const fetch = mockResponse();
    const config = getModelConfig("openai");
    expect(config.configurationVersion).toBe("openai-1.1.0");
    const result = await generateStrategy(input, config, "responses-fixture");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: "gpt-6.1-terra",
      input: [{ role: "system" }, { role: "user" }],
      max_output_tokens: 2200,
      reasoning: { effort: "low" },
      store: false,
      parallel_tool_calls: false,
      stream: false,
      tools: [
        {
          type: "function",
          name: "submit_propose",
          strict: true,
          parameters: { type: "object", additionalProperties: false },
        },
      ],
      tool_choice: { type: "function", name: "submit_propose" },
    });
    expect(body.tools[0]).not.toHaveProperty("function");
    for (const key of [
      "messages",
      "max_completion_tokens",
      "reasoning_effort",
      "temperature",
      "response_format",
    ])
      expect(body).not.toHaveProperty(key);
    expect(result.value.estimatedCost).toBeNull();
    expect(result.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      estimatedUsd: 0.0035,
      estimatedCny: 0,
      responseId: "resp_fixture",
      model: "returned-gpt-snapshot",
      durationMs: expect.any(Number),
    });
    expect(billing.settleBilling).toHaveBeenCalledWith("responses-fixture", {
      amount: 3500,
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      responseId: "resp_fixture",
    });
    expect(billing.holdBilling).not.toHaveBeenCalled();
  });
  it("reserves against the largest actual Responses payload", () => {
    const config = getModelConfig("openai");
    const schemas = [
      ["propose", StrategySchema],
      ["attack", AttackSchema],
      ["revise", RevisionSchema],
      ["judge", VerdictSchema],
    ] as const;
    const largest = Math.max(
      ...schemas.map(([kind, schema]) =>
        Buffer.byteLength(JSON.stringify(buildRequestBody(kind, input, schema, config)), "utf8"),
      ),
    );
    expect(estimateCallTokens(input, config)).toBe(largest + 1024 + config.maxOutputTokens);
  });
  it("supports explicit Responses JSON mode without sending chat response_format", async () => {
    vi.stubEnv("OPENAI_STRUCTURED_OUTPUT", "json");
    const fetch = mockResponse({
      output: [
        {
          type: "message",
          status: "completed",
          content: [
            { type: "output_text", text: JSON.stringify({ ...strategy, estimatedCost: null }) },
          ],
        },
      ],
    });
    const result = await generateStrategy(input, getModelConfig("openai"));
    expect(result.value.id).toBe("A");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toEqual({ format: { type: "json_object" } });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("response_format");
    expect(body.reasoning).toEqual({ effort: "low" });
  });
  it.each([
    { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    { status: "failed", error: { message: "private upstream detail" } },
    {
      output: [
        { type: "message", content: [{ type: "refusal", refusal: "private refusal text" }] },
      ],
    },
    { output: [{ ...call(), name: "wrong_tool" }] },
    { output: [call(), call()] },
    { output: [{ ...call(), status: "incomplete" }] },
    { output: [{ ...call(), arguments: { wrong: "shape" } }] },
  ])(
    "settles known usage before rejecting incomplete/refused/invalid tool output %#",
    async (patch) => {
      const fetch = mockResponse(patch);
      const attempt = generateStrategy(input, getModelConfig("openai"), "known-response");
      await expect(attempt).rejects.toMatchObject({
        uncertain: false,
        usage: { estimatedUsd: 0.0035 },
      });
      await expect(attempt).rejects.not.toThrow("private upstream detail");
      await expect(attempt).rejects.not.toThrow("private refusal text");
      expect(billing.settleBilling).toHaveBeenCalledTimes(1);
      expect(billing.holdBilling).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { usage: undefined },
    { usage: { input_tokens: 1000, output_tokens: -1 } },
    {
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: { cached_tokens: 1001 },
      },
    },
    { usage: { prompt_tokens: 1000, completion_tokens: 500 } },
    { status: "in_progress" },
  ])("holds the reservation for unknown final usage %#", async (patch) => {
    mockResponse(patch);
    await expect(
      generateStrategy(input, getModelConfig("openai"), "unknown-response"),
    ).rejects.toMatchObject({ uncertain: true });
    expect(billing.holdBilling).toHaveBeenCalledWith("unknown-response");
    expect(billing.settleBilling).not.toHaveBeenCalled();
  });
  it("preserves invalid function arguments only in bounded private repair feedback", async () => {
    const bad = '{"id":"A" "title":"PRIVATE_FIXTURE"}';
    const fetch = mockResponse({ output: [{ ...call(), arguments: bad }] });
    const attempt = generateStrategy(input, getModelConfig("openai"));
    await expect(attempt).rejects.toMatchObject({
      uncertain: false,
      repair: { rejectedOutput: bad, feedback: expect.any(String) },
    });
    await expect(attempt).rejects.not.toThrow("PRIVATE_FIXTURE");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("reports the actual HTTP400 failure safely without downgrading low reasoning or retrying", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            param: "reasoning_effort",
            message: "Function tools with reasoning_effort are not supported PRIVATE_FIXTURE",
          },
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const attempt = generateStrategy(input, getModelConfig("openai"), "http400-fixture");
    await expect(attempt).rejects.toMatchObject({
      uncertain: false,
      message: expect.stringContaining("HTTP 400"),
    });
    await expect(attempt).rejects.not.toThrow("PRIVATE_FIXTURE");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).reasoning).toEqual({ effort: "low" });
    expect(billing.settleBilling).toHaveBeenCalledWith(
      "http400-fixture",
      expect.objectContaining({ amount: 0 }),
    );
  });
});
