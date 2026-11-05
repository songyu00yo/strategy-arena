/** Synthetic provider boundaries; no external request or bill is produced. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChallengeSchema,
  type ModelProvider,
  type ModelResult,
  type StageInput,
  type Strategy,
} from "../src/lib/contracts";
const fixture = vi.hoisted(() => ({
  generate: vi.fn(),
  deepseekId: "deepseek-fixture",
  openaiId: "gpt-fixture",
  deepseekConfigured: true,
  openaiConfigured: true,
  invalidProvider: "" as ModelProvider | "",
}));
vi.mock("../src/lib/server/model", () => {
  class ModelCallError extends Error {
    constructor(
      message: string,
      public uncertain = false,
    ) {
      super(message);
    }
  }
  return {
    ModelCallError,
    getModelConfig: (provider: ModelProvider = "deepseek") => {
      if (provider === fixture.invalidProvider)
        throw new Error("SYNTHETIC_INVALID_CONFIG_PRIVATE_DETAILS");
      return {
        provider,
        id: provider === "openai" ? fixture.openaiId : fixture.deepseekId,
        currency: provider === "openai" ? "USD" : "CNY",
        configured: provider === "openai" ? fixture.openaiConfigured : fixture.deepseekConfigured,
        timeoutMs: 1000,
        promptVersion: "synthetic-runtime-model-test",
        schemaVersion: "1",
      };
    },
    estimateCallCost: () => 0.04,
    generateStrategy: fixture.generate,
    generateAttack: fixture.generate,
    generateRevision: fixture.generate,
    generateVerdict: fixture.generate,
  };
});
import { ModelCallError } from "../src/lib/server/model";
import { atomic, closeDb, getVersion, saveVersion } from "../src/lib/server/db";
import {
  advanceArena,
  createArena,
  getArena,
  modelInfo,
  newVersion,
  reserveCall,
} from "../src/lib/server/runtime";
const challenge = ChallengeSchema.parse({ goal: "选择课程并完成一个可演示的入门项目" });
function result(
  input: StageInput,
  config: { id: string; provider: ModelProvider; currency: "CNY" | "USD" },
): ModelResult<Strategy> {
  return {
    value: {
      id: input.role as Strategy["id"],
      title: "合成方案",
      thesis: "课程学习",
      steps: ["完成课程练习"],
      claims: [],
      resources: "教材",
      firstAction: "试听课程",
      failureCondition: "缺少学习时间",
      estimatedCost: null,
      estimatedHours: null,
    },
    usage: {
      model: config.id,
      provider: config.provider,
      currency: config.currency,
      estimatedCny: config.currency === "CNY" ? 0.02 : 0,
      ...(config.currency === "USD" ? { estimatedUsd: 0.02 } : {}),
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      responseId: "fixture",
      durationMs: 1,
    },
  };
}
beforeEach(() => {
  closeDb();
  vi.stubEnv("ARENA_DATABASE_PATH", ":memory:");
  vi.stubEnv("ARENA_RUN_BUDGET_USD", "0.25");
  vi.stubEnv("ARENA_GLOBAL_BUDGET_USD", "120");
  vi.stubEnv("ARENA_DAILY_VISITOR_LIMIT", "20");
  fixture.invalidProvider = "";
  fixture.deepseekId = "deepseek-fixture";
  fixture.openaiId = "gpt-fixture";
  fixture.deepseekConfigured = fixture.openaiConfigured = true;
  fixture.generate.mockReset();
  fixture.generate.mockImplementation(async (input, config) => result(input, config));
});
afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
});

describe("per-version selected provider and native currency", () => {
  it("pins the automatic choice, records its reason, and reevaluates only on a new version", async () => {
    const first = createArena(challenge, "owner");
    expect(first.versions[0].modelSelection).toMatchObject({
      requestedMode: "auto",
      provider: "deepseek",
      currency: "CNY",
    });
    expect(first.events.find((event) => event.type === "model_selected")?.data).toMatchObject({
      modelId: "deepseek-fixture",
    });
    const second = newVersion(
      first.id,
      "owner",
      { ...challenge, materials: "资料".repeat(3000) },
      "补充长材料",
    );
    expect(second.versions[1].modelSelection).toMatchObject({
      requestedMode: "auto",
      provider: "openai",
      currency: "USD",
    });
    expect(second.versions[0].modelSelection?.provider).toBe("deepseek");
    await advanceArena(second.id, "owner", second.activeVersionId);
    expect(fixture.generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "openai", id: "gpt-fixture" }),
      expect.any(String),
    );
  });
  it("inherits manual mode and allows explicitly choosing auto on a rematch", () => {
    const first = createArena(challenge, "owner", "gpt");
    const second = newVersion(first.id, "owner", challenge, "保留选择");
    expect(second.versions[1].modelSelection).toMatchObject({
      requestedMode: "gpt",
      provider: "openai",
    });
    const third = newVersion(first.id, "owner", challenge, "重新自动选择", undefined, "auto");
    expect(third.versions[2].modelSelection).toMatchObject({
      requestedMode: "auto",
      provider: "deepseek",
    });
  });
  it("isolates provider fingerprints and stops only when the selected provider changes", async () => {
    const arena = createArena(challenge, "owner", "gpt");
    fixture.deepseekId = "unselected-config-changed";
    const completed = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(completed.versions[0].status).toBe("ready");
    fixture.openaiId = "selected-config-changed";
    const stopped = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(stopped.versions[0].status).toBe("failed");
    expect(stopped.versions[0].error).toContain("混用配置");
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });
  it.each(["deepseek", "openai"] as const)(
    "keeps selected %s running when the other provider configuration is invalid",
    async (provider) => {
      fixture.invalidProvider = provider === "openai" ? "deepseek" : "openai";
      const arena = createArena(challenge, "owner", provider === "openai" ? "gpt" : "deepseek");
      expect(arena.model.configured).toBe(true);
      expect(
        arena.model.providers?.find((option) => option.provider === fixture.invalidProvider),
      ).toMatchObject({ configured: false, error: "模型配置无效，请运行者检查服务端配置。" });
      expect(JSON.stringify(arena.model)).not.toContain("SYNTHETIC_INVALID_CONFIG_PRIVATE_DETAILS");
      expect(getArena(arena.id, "owner").activeVersionId).toBe(arena.activeVersionId);
      const advanced = await advanceArena(arena.id, "owner", arena.activeVersionId);
      expect(advanced.versions[0].status).toBe("ready");
      expect(fixture.generate).toHaveBeenCalledTimes(1);
    },
  );
  it("reports an invalid provider catalog without exposing server configuration details", () => {
    fixture.invalidProvider = "deepseek";
    fixture.openaiConfigured = false;
    const info = modelInfo();
    expect(info.configured).toBe(false);
    expect(info.providers).toHaveLength(2);
    expect(JSON.stringify(info)).not.toContain("SYNTHETIC_INVALID_CONFIG_PRIVATE_DETAILS");
  });
  it("refuses a missing selected key even when the other provider is configured", async () => {
    fixture.openaiConfigured = false;
    const arena = createArena(challenge, "owner", "gpt");
    expect(arena.model.configured).toBe(true);
    await expect(advanceArena(arena.id, "owner", arena.activeVersionId)).rejects.toMatchObject({
      code: "MODEL_NOT_CONFIGURED",
    });
    expect(fixture.generate).not.toHaveBeenCalled();
  });
  it("settles USD exclusively in dollar fields", async () => {
    const arena = createArena(challenge, "owner", "gpt");
    const finished = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(finished.versions[0]).toMatchObject({
      costCny: 0,
      reservedCny: 0,
      costUsd: 0.02,
      reservedUsd: 0,
    });
    expect(finished.events.find((event) => event.type === "step_started")?.data).toMatchObject({
      currency: "USD",
      reservedUsd: 0.04,
    });
    expect(finished.events.find((event) => event.type === "step_started")?.data).not.toHaveProperty(
      "reservedCny",
    );
  });
  it("retains only the USD hold when the result is unknown", async () => {
    const arena = createArena(challenge, "owner", "gpt");
    fixture.generate.mockRejectedValue(new ModelCallError("合成网络故障：请求结果未知", true));
    const failed = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(failed.versions[0]).toMatchObject({
      status: "uncertain",
      costCny: 0,
      reservedCny: 0,
      costUsd: 0,
      reservedUsd: 0.04,
    });
    expect(failed.events.find((event) => event.type === "step_uncertain")?.data).toMatchObject({
      currency: "USD",
      heldReservationUsd: 0.04,
    });
  });
  it("counts older yuan expenditure after switching to a USD version", () => {
    const arena = createArena(challenge, "owner", "deepseek");
    const old = getVersion(arena.activeVersionId);
    old.costCny = 1.2;
    saveVersion(old);
    const rematch = newVersion(arena.id, "owner", challenge, "切换模型", undefined, "gpt");
    expect(() => atomic(() => reserveCall(getVersion(rematch.activeVersionId), 0.06))).toThrow(
      "费用上限",
    );
  });
  it("counts older dollar expenditure after switching back to yuan", () => {
    const arena = createArena(challenge, "owner", "gpt");
    const old = getVersion(arena.activeVersionId);
    old.costUsd = 0.2;
    saveVersion(old);
    const rematch = newVersion(
      arena.id,
      "owner",
      challenge,
      "切回人民币模型",
      undefined,
      "deepseek",
    );
    expect(() => atomic(() => reserveCall(getVersion(rematch.activeVersionId), 0.4))).toThrow(
      "费用上限",
    );
  });
  it("releases the local dollar hold on a confirmed failure", async () => {
    const arena = createArena(challenge, "owner", "gpt");
    fixture.generate.mockRejectedValue(new ModelCallError("合成请求明确拒绝", false));
    const failed = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(failed.versions[0]).toMatchObject({
      status: "failed",
      costCny: 0,
      reservedCny: 0,
      costUsd: 0,
      reservedUsd: 0,
    });
  });
  it("keeps legacy history readable but will not resume an unlabelled active configuration", async () => {
    const arena = createArena(challenge, "owner");
    const legacy = getVersion(arena.activeVersionId);
    delete legacy.modelSelection;
    delete legacy.runConfiguration?.provider;
    saveVersion(legacy);
    const stopped = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(stopped.versions[0].status).toBe("failed");
    expect(fixture.generate).not.toHaveBeenCalled();
    const rematch = newVersion(
      arena.id,
      "owner",
      { ...challenge, materials: "字".repeat(7000) },
      "兼容旧版本",
    );
    expect(rematch.versions[1].modelSelection).toMatchObject({
      requestedMode: "deepseek",
      provider: "deepseek",
    });
  });
});
