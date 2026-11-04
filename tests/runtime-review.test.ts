/** Adversarial orchestration regressions. Only the model boundary is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChallengeSchema,
  type ArenaVersion,
  type Attack,
  type Evidence,
  type ModelResult,
  type ModelUsage,
  type Strategy,
  type Verdict,
} from "../src/lib/contracts";
const fixture = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../src/lib/server/model", () => {
  class ModelCallError extends Error {
    constructor(
      message: string,
      public uncertain = false,
      public usage?: ModelUsage,
      public repair?: { feedback: string; rejectedOutput: string },
    ) {
      super(message);
    }
  }
  return {
    ModelCallError,
    getModelConfig: () => ({
      id: "review-fixture",
      configured: true,
      promptVersion: "review",
      schemaVersion: "1",
      timeoutMs: 1000,
    }),
    estimateCallCost: () => 0.2,
    generateStrategy: fixture.generate,
    generateAttack: fixture.generate,
    generateRevision: fixture.generate,
    generateVerdict: fixture.generate,
  };
});
import { closeDb, db, getVersion, saveVersion } from "../src/lib/server/db";
import {
  advanceArena,
  createArena,
  getArena,
  newVersion,
  stopArena,
} from "../src/lib/server/runtime";
import { ModelCallError } from "../src/lib/server/model";
import {
  checkConstraints,
  validateAttack,
  validateRevision,
  validateVerdict,
} from "../src/lib/server/tools";

const usage: ModelUsage = {
  inputTokens: 10,
  outputTokens: 10,
  cachedInputTokens: 0,
  estimatedCny: 0.04,
  model: "review-fixture",
  responseId: "review-response",
  durationMs: 1,
};
const challenge = ChallengeSchema.parse({ goal: "在有限时间内完成课程并制作一个可演示的项目" });
const strategy: Strategy = {
  id: "A",
  title: "课堂路径",
  thesis: "课堂指导",
  steps: ["跟随课堂完成练习"],
  claims: [{ id: "A-claim-1", text: "每周投入三小时", status: "unknown", sourceIds: [] }],
  resources: "课程教材",
  firstAction: "试听课程",
  failureCondition: "时间不足",
  estimatedCost: 100,
  estimatedHours: 12,
};
function prepareB() {
  const arena = createArena(challenge, "review-owner");
  const version = getVersion(arena.activeVersionId);
  version.strategies = [structuredClone(strategy)];
  saveVersion(version);
  db()
    .prepare(
      "UPDATE steps SET status='completed' WHERE version_id=? AND stage='propose' AND role='A'",
    )
    .run(version.id);
  return arena;
}
function duplicate(): ModelResult<Strategy> {
  return { value: { ...structuredClone(strategy), id: "B" }, usage };
}
function pairedInput(budget: number, timeHours = 10) {
  const task = { ...challenge, budget, timeHours };
  const strategies: Strategy[] = [
    { ...strategy, estimatedCost: 80, estimatedHours: 4 },
    {
      ...strategy,
      id: "B",
      estimatedCost: 40,
      estimatedHours: 3,
      steps: ["阅读源码制作实验报告"],
      resources: "公开代码仓库",
    },
  ];
  return {
    challenge: task,
    role: "judge",
    strategies,
    attacks: [],
    evidence: checkConstraints(task, strategies),
    revisions: [],
    userChallenges: [],
  };
}
function proposedVerdict(preferred: "A" | "B"): Verdict {
  return {
    outcome: "recommendation",
    preferred,
    headline: "合成条件测试",
    rationale: "仅测试限制门槛，不评价模型质量",
    conditions: ["实际费用符合估计"],
    uncertainties: ["费用仍需实测"],
    nextActions: ["先验证费用"],
    exitCondition: "费用超标则停止",
    evidenceIds: [],
    comparisons: [],
    attackFindings: [],
  };
}
beforeEach(() => {
  closeDb();
  fixture.generate.mockReset();
  for (const [name, value] of Object.entries({
    ARENA_DATABASE_PATH: ":memory:",
    ARENA_RUN_BUDGET_CNY: "1.5",
    ARENA_GLOBAL_BUDGET_CNY: "90",
    ARENA_DAILY_VISITOR_LIMIT: "6",
    ARENA_MAX_CONCURRENT_CALLS: "3",
    ARENA_WORKER_ENABLED: "false",
  }))
    vi.stubEnv(name, value);
});
afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runtime adversarial review", () => {
  it("preserves an identified restriction conflict when another resource estimate is unknown", () => {
    const input = pairedInput(300);
    input.challenge.constraints = "全部画面必须来自真实记录，禁止生成虚构画面";
    input.strategies[0].estimatedCost = null;
    const verdict = proposedVerdict("A");
    verdict.comparisons = [
      { strategyId: "A", status: "violates", reason: "此路线仍计划生成虚构画面" },
      { strategyId: "B", status: "unknown", reason: "导出权限待确认" },
    ];
    const checked = validateVerdict(verdict, input);
    expect(checked.comparisons[0]).toEqual(verdict.comparisons[0]);
    expect(checked.preferred).toBeNull();
    expect(checked.headline).toContain("违反限制");
    expect(checked.comparisons[1].status).toBe("unknown");
  });
  it("retains the parsed model output separately from the normalized proposal", async () => {
    const arena = createArena(challenge, "review-owner");
    fixture.generate.mockResolvedValueOnce({
      value: {
        ...structuredClone(strategy),
        claims: [
          {
            id: "original-id",
            text: "尚无证据的判断",
            status: "supported",
            sourceIds: ["made-up"],
          },
        ],
      },
      usage,
    });
    const snapshot = await advanceArena(arena.id, "review-owner", arena.activeVersionId);
    const saved = snapshot.events.find((event) => event.type === "step_completed")?.data as {
      modelOutput: Strategy;
      result: Strategy;
      modelOutputScope: string;
    };
    expect(saved.modelOutput.claims[0]).toMatchObject({ id: "original-id", status: "supported" });
    expect(saved.result.claims[0]).toMatchObject({
      id: "A-claim-1",
      status: "unknown",
      sourceIds: [],
    });
    expect(saved.modelOutputScope).toBe("parsed-structured-output-before-server-rules");
  });
  it("does not overwrite a reconciled step when an old request rejects late", async () => {
    const arena = createArena(challenge, "review-owner");
    let reject!: (reason: Error) => void;
    fixture.generate.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = advanceArena(arena.id, "review-owner", arena.activeVersionId);
    const version = getVersion(arena.activeVersionId);
    version.reservedCny = 0;
    version.costCny = 0.03;
    version.status = "failed";
    version.error = "operator reconciled";
    saveVersion(version);
    db()
      .prepare(
        "UPDATE steps SET status='failed',reservation=0,error='operator reconciled' WHERE version_id=? AND status='running'",
      )
      .run(version.id);
    reject(new ModelCallError("late error", false, usage));
    await pending;
    expect(getVersion(version.id)).toMatchObject({
      costCny: 0.03,
      reservedCny: 0,
      error: "operator reconciled",
    });
  });
  it("does not create a second duplicate retry after repairing the first duplicate retry", async () => {
    const arena = prepareB();
    fixture.generate
      .mockResolvedValueOnce(duplicate())
      .mockRejectedValueOnce(
        new ModelCallError("format fixture", false, usage, {
          feedback: "Return valid JSON",
          rejectedOutput: "invalid fixture",
        }),
      )
      .mockResolvedValueOnce(duplicate());
    await advanceArena(arena.id, "review-owner", arena.activeVersionId);
    await advanceArena(arena.id, "review-owner", arena.activeVersionId);
    const completed = await advanceArena(arena.id, "review-owner", arena.activeVersionId);
    expect(completed.versions[0].status).toBe("ready");
    expect(completed.versions[0].strategies).toHaveLength(1);
    expect(completed.steps.filter((step) => step.role === "B:retry")).toHaveLength(1);
    expect(completed.versions[0].costCny).toBeCloseTo(0.12);
  });
  it("does not schedule duplicate retries when an old proposal completes after superseding", async () => {
    const arena = prepareB();
    let resolve!: (value: ModelResult<Strategy>) => void;
    fixture.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Strategy>>((done) => {
          resolve = done;
        }),
    );
    const running = advanceArena(arena.id, "review-owner", arena.activeVersionId);
    newVersion(arena.id, "review-owner", { ...challenge, timeHours: 3 }, "时间缩短");
    resolve(duplicate());
    const completed = await running;
    expect(completed.versions[0].status).toBe("superseded");
    expect(
      completed.steps.filter(
        (step) => step.versionId === arena.activeVersionId && step.status === "pending",
      ),
    ).toHaveLength(0);
    await advanceArena(arena.id, "review-owner", arena.activeVersionId);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });
  it("keeps attack cards aligned with the final partial verdict after stopping an in-flight judge", async () => {
    const arena = createArena(challenge, "review-owner");
    const version: ArenaVersion = getVersion(arena.activeVersionId);
    version.strategies = [
      strategy,
      { ...strategy, id: "B", steps: ["独立阅读源码"], resources: "开源代码" },
    ];
    const attack: Attack = {
      id: "attack-B",
      from: "B",
      targetStrategyId: "A",
      targetClaimId: strategy.claims[0].id,
      claimQuote: strategy.claims[0].text,
      reason: "时间未经验证",
      impact: "可能超时",
      verification: "核对材料",
      requests: [],
      status: "pending",
    };
    const evidence: Evidence = {
      id: "E-review",
      attackId: attack.id,
      tool: "calculate",
      status: "calculated",
      title: "工时计算",
      content: "3*4=12",
      source: "有限算术",
      sourceIds: [],
      expression: "3*4",
      result: 12,
      assumptions: "每周三小时",
      createdAt: new Date().toISOString(),
    };
    version.attacks = [attack];
    version.evidence = [evidence];
    saveVersion(version);
    db()
      .prepare("UPDATE steps SET status='completed' WHERE version_id=? AND stage!='judge'")
      .run(version.id);
    let resolve!: (value: ModelResult<Verdict>) => void;
    fixture.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Verdict>>((done) => {
          resolve = done;
        }),
    );
    const running = advanceArena(arena.id, "review-owner", version.id);
    stopArena(arena.id, "review-owner", version.id);
    resolve({
      value: {
        outcome: "recommendation",
        preferred: "A",
        headline: "有条件选择A",
        rationale: "有限信息下的建议",
        conditions: ["实际时间符合假设"],
        uncertainties: ["估计仍需验证"],
        nextActions: ["先试听"],
        exitCondition: "工时不足则退出",
        evidenceIds: [evidence.id],
        comparisons: [],
        attackFindings: [
          {
            attackId: attack.id,
            status: "refuted",
            reason: "工时可覆盖",
            evidenceIds: [evidence.id],
          },
        ],
      },
      usage,
    });
    const completed = await running;
    expect(completed.versions[0]).toMatchObject({
      status: "paused",
      verdict: { outcome: "partial", preferred: null },
    });
    expect(completed.versions[0].attacks[0].status).toBe(
      completed.versions[0].verdict?.attackFindings[0].status,
    );
  });
  it("requires a fresh affordable reservation before any repair call", async () => {
    process.env.ARENA_RUN_BUDGET_CNY = "0.21";
    const arena = createArena(challenge, "review-owner");
    fixture.generate.mockRejectedValueOnce(
      new ModelCallError("format fixture", false, usage, {
        feedback: "Return JSON",
        rejectedOutput: "fixture",
      }),
    );
    await advanceArena(arena.id, "review-owner", arena.activeVersionId);
    await expect(
      advanceArena(arena.id, "review-owner", arena.activeVersionId),
    ).rejects.toMatchObject({ code: "RUN_BUDGET" });
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(getArena(arena.id, "review-owner").versions[0]).toMatchObject({
      costCny: 0.04,
      reservedCny: 0,
    });
  });
  it("rejects self attacks and evidence borrowed from a different attack", () => {
    const attack: Attack = {
      id: "attack-A",
      from: "A",
      targetStrategyId: "A",
      targetClaimId: strategy.claims[0].id,
      claimQuote: strategy.claims[0].text,
      reason: "时间未经验证",
      impact: "超时",
      verification: "计算",
      requests: [],
      status: "pending",
    };
    expect(() => validateAttack(attack, [strategy])).toThrow("不能攻击自己");
    expect(() =>
      validateRevision(
        {
          strategyId: "A",
          strategy,
          summary: "修订",
          changed: false,
          responses: [
            {
              attackId: attack.id,
              decision: "reject",
              reason: "引用其他质疑的证据",
              evidenceIds: ["E-foreign"],
              change: "",
            },
          ],
        },
        {
          challenge,
          role: "A",
          strategies: [strategy],
          attacks: [attack],
          evidence: [
            {
              id: "E-foreign",
              attackId: "different-attack",
              tool: "calculate",
              status: "calculated",
              title: "计算",
              content: "1+1=2",
              source: "算术",
              sourceIds: [],
              expression: "1+1",
              result: 2,
              assumptions: "测试",
              createdAt: new Date().toISOString(),
            },
          ],
          revisions: [],
          userChallenges: [],
        },
      ),
    ).toThrow("证据引用与攻击不对应");
  });
  it("treats a provider HTTP 200 null body as an unknown paid request", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/server/model")>("../src/lib/server/model");
    vi.stubEnv("MODEL_API_KEY", "explicit-review-fixture");
    vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(null)));
    await expect(
      actual.generateStrategy({
        challenge,
        role: "A",
        strategies: [],
        attacks: [],
        evidence: [],
        revisions: [],
        userChallenges: [],
      }),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it("retains known usage when provider message content has an unexpected JSON shape", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/server/model")>("../src/lib/server/model");
    vi.stubEnv("MODEL_API_KEY", "explicit-review-fixture");
    vi.stubEnv("MODEL_STRUCTURED_OUTPUT", "json");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id: "review-response",
          usage: { prompt_tokens: 10, completion_tokens: 10 },
          choices: [{ finish_reason: "stop", message: { content: { unexpected: "object" } } }],
        }),
      ),
    );
    await expect(
      actual.generateStrategy({
        challenge,
        role: "A",
        strategies: [],
        attacks: [],
        evidence: [],
        revisions: [],
        userChallenges: [],
      }),
    ).rejects.toMatchObject({ uncertain: false, usage: { inputTokens: 10, outputTokens: 10 } });
  });
  it("accepts a synthetic A→B flip after a binding budget change while retaining the original snapshot", () => {
    const initial = pairedInput(100);
    const changed = pairedInput(50);
    const arena = createArena(initial.challenge, "review-owner");
    const original = getVersion(arena.activeVersionId);
    original.strategies = initial.strategies;
    original.verdict = validateVerdict(proposedVerdict("A"), initial);
    original.status = "completed";
    original.costCny = 0.08;
    saveVersion(original);
    const forked = newVersion(arena.id, "review-owner", changed.challenge, "预算由100缩减为50");
    const next = getVersion(forked.activeVersionId);
    next.strategies = changed.strategies;
    next.verdict = validateVerdict(proposedVerdict("B"), changed);
    next.status = "completed";
    next.costCny = 0.04;
    saveVersion(next);
    const snapshots = getArena(arena.id, "review-owner").versions;
    expect(snapshots[0]).toMatchObject({
      challenge: { budget: 100 },
      verdict: { preferred: "A" },
      costCny: 0.08,
    });
    expect(snapshots[1]).toMatchObject({
      challenge: { budget: 50 },
      verdict: { preferred: "B" },
      costCny: 0.04,
      parentVersionId: original.id,
    });
    expect(validateVerdict(proposedVerdict("A"), changed)).toMatchObject({
      outcome: "insufficient",
      preferred: null,
    });
  });
  it("does not force a flip for a nonbinding condition change", () => {
    expect(validateVerdict(proposedVerdict("A"), pairedInput(100, 10)).preferred).toBe("A");
    expect(validateVerdict(proposedVerdict("A"), pairedInput(100, 8)).preferred).toBe("A");
  });
  it("withdraws a synthetic winner when all tool checks are unavailable", () => {
    const input = pairedInput(100);
    input.evidence = input.evidence.map((evidence) => ({
      ...evidence,
      status: "unavailable",
      result: null,
    }));
    expect(validateVerdict(proposedVerdict("A"), input)).toMatchObject({
      outcome: "insufficient",
      preferred: null,
    });
  });
});
