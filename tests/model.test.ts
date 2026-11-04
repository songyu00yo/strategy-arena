import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeSchema, StrategySchema, type StageInput } from "../src/lib/contracts";
import {
  buildMessages,
  estimateCallCost,
  generateStrategy,
  ModelCallError,
} from "../src/lib/server/model";
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
  vi.stubEnv("MODEL_API_KEY", "fixture-key-not-a-secret");
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
  it("sends bounded JSON request and records returned model and actual usage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
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
    const fn = vi
      .fn()
      .mockResolvedValue(
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
