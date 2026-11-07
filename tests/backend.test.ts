import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChallengeSchema,
  type ModelResult,
  type StageInput,
  type Strategy,
  type Attack,
  type Revision,
  type Verdict,
} from "../src/lib/contracts";

const model = vi.hoisted(() => ({
  generate: vi.fn(),
  configured: true,
  estimate: 0.2,
  id: "test-model",
}));
vi.mock("../src/lib/server/model", () => {
  class ModelCallError extends Error {
    constructor(
      message: string,
      public uncertain = false,
      public usage?: unknown,
      public repair?: { feedback: string; rejectedOutput: string },
    ) {
      super(message);
    }
  }
  return {
    ModelCallError,
    getModelConfig: (provider = "deepseek") => ({
      provider,
      currency: provider === "openai" ? "USD" : "CNY",
      id: model.id,
      configured: model.configured,
      promptVersion: "test",
      schemaVersion: "1.0.0",
      timeoutMs: 1000,
    }),
    estimateCallCost: () => model.estimate,
    generateStrategy: (input: unknown) => model.generate(input),
    generateAttack: (input: unknown) => model.generate(input),
    generateRevision: (input: unknown) => model.generate(input),
    generateVerdict: (input: unknown) => model.generate(input),
  };
});
import { closeDb, db, getVersion, saveVersion } from "../src/lib/server/db";
import {
  advanceArena,
  createArena,
  getArena,
  intervene,
  newVersion,
  stopArena,
} from "../src/lib/server/runtime";
import { ModelCallError } from "../src/lib/server/model";
import {
  ensureOwner,
  ownerFromRequest,
  checkOrigin,
  accessState,
  grantAccess,
  requireArenaAccess,
} from "../src/lib/server/auth";
import { validateRevision, validateVerdict } from "../src/lib/server/tools";
import { startArenaWorker, stopArenaWorker } from "../src/lib/server/runner";
import { stepContext } from "../src/lib/step-context";
import { advanceFixture, fixtureSnapshot } from "./e2e/ui.fixture";

const challenge = ChallengeSchema.parse({ goal: "在两个月内完成一门入门课程并交付项目" });
function result(role = "A"): ModelResult<Strategy> {
  return {
    value: {
      id: role as Strategy["id"],
      title: `方案${role}`,
      thesis: `使用${role}路径学习`,
      steps: ["先完成一个小项目"],
      claims: [{ id: `${role}1`, text: "每周至少投入三小时", status: "unknown", sourceIds: [] }],
      resources: "现有设备",
      firstAction: "列出可用时间",
      failureCondition: "时间不足",
      estimatedCost: null,
      estimatedHours: 12,
    },
    usage: {
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 0,
      estimatedCny: 0.04,
      model: "test-model",
      responseId: "response-test",
      durationMs: 20,
    },
  };
}
beforeEach(() => {
  stopArenaWorker();
  closeDb();
  vi.stubEnv("ARENA_DATABASE_PATH", ":memory:");
  vi.stubEnv("ARENA_RUN_BUDGET_CNY", "1.5");
  vi.stubEnv("ARENA_GLOBAL_BUDGET_CNY", "90");
  vi.stubEnv("ARENA_DAILY_VISITOR_LIMIT", "6");
  vi.stubEnv("ARENA_MAX_CONCURRENT_CALLS", "3");
  vi.stubEnv("ARENA_SESSION_SECRET", "backend-test-secret-32-characters-long");
  vi.stubEnv("ARENA_ACCESS_CODE", "");
  vi.stubEnv("ARENA_PUBLIC_ORIGIN", "");
  vi.stubEnv("ARENA_WORKER_ENABLED", "false");
  model.configured = true;
  model.id = "test-model";
  model.estimate = 0.2;
  model.generate.mockReset();
  model.generate.mockImplementation(async (input: StageInput) => result(input.role));
});
afterEach(() => {
  stopArenaWorker();
  closeDb();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("durable execution and ownership", () => {
  it("pins non-secret configuration and stops before mixing models within one version", async () => {
    const arena = createArena(challenge, "owner");
    expect(arena.versions[0].runConfiguration?.id).toBe("test-model");
    expect(arena.versions[0].runConfiguration).not.toHaveProperty("configured");
    model.id = "different-model";
    const stopped = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(stopped.versions[0].status).toBe("failed");
    expect(stopped.versions[0].error).toContain("混用配置");
    expect(model.generate).not.toHaveBeenCalled();
    const changed = newVersion(arena.id, "owner", challenge, "使用新的模型配置");
    expect(changed.versions[1].runConfiguration?.id).toBe("different-model");
    expect(changed.versions[0].configurationHash).not.toBe(changed.versions[1].configurationHash);
  });
  it("runs the complete protocol with real local retrieval, arithmetic, revision and a conditional verdict", async () => {
    const arena = createArena(
      {
        ...challenge,
        materials: "课程费用为120元。每周可学习四小时。",
        budget: 500,
        timeHours: 50,
      },
      "owner",
    );
    const approaches: Record<string, { steps: string[]; resources: string }> = {
      A: {
        steps: ["报名课堂，按教学大纲完成作业并制作结课网站"],
        resources: "授课教师和课堂练习系统",
      },
      B: {
        steps: ["寻找行业导师结对编程，每周接受项目代码评审"],
        resources: "导师工时和远程会议工具",
      },
      C: {
        steps: ["阅读开源源码，自行拆解应用架构，编写技术实验报告"],
        resources: "公开代码仓库及研究笔记",
      },
    };
    model.generate.mockImplementation(async (input: StageInput) => {
      let value: Strategy | Attack | Revision | Verdict;
      if (input.role === "judge") {
        value = {
          outcome: "recommendation",
          preferred: "A",
          headline: "课程可作为有条件的首选",
          rationale: "已核对材料与算术，仍需验证实际教学质量。",
          conditions: ["实际课程符合现有时间"],
          uncertainties: ["教学质量需要试听确认"],
          nextActions: ["预约试听并记录完成时间"],
          exitCondition: "试听后无法按计划投入时间则退出",
          evidenceIds: input.evidence
            .filter((e) => e.status === "found" || e.status === "calculated")
            .map((e) => e.id),
          comparisons: input.strategies.map((s) => ({
            strategyId: s.id,
            status: "unknown",
            reason: "估计尚未实测",
          })),
          attackFindings: input.attacks.map((a) => ({
            attackId: a.id,
            status: "unresolved",
            reason: "材料只核实费用，未证实教学效果",
            evidenceIds: input.evidence
              .filter((e) => e.attackId === a.id && e.status === "found")
              .map((e) => e.id),
          })),
        };
      } else if (!input.strategies.length) {
        value = { ...result(input.role).value, ...approaches[input.role] };
      } else if (!input.evidence.length) {
        const target = input.strategies.find((s) => s.id !== input.role)!;
        value = {
          id: "same-model-id",
          from: input.role,
          targetStrategyId: target.id,
          targetClaimId: target.claims[0].id,
          claimQuote: target.claims[0].text,
          reason: `${input.role}要求核实课程成本和投入时间`,
          impact: "可能超出费用预期",
          verification: "检索原文并计算两期费用",
          requests: [
            { tool: "search_materials", query: "课程费用" },
            { tool: "calculate", expression: "120*2", assumptions: "以两期均为120元计算" },
          ],
          status: "pending",
        };
      } else {
        const original = input.strategies.find((s) => s.id === input.role)!;
        value = {
          strategyId: original.id,
          strategy: { ...original, firstAction: "先询问两期课程完整收费再执行原计划" },
          responses: input.attacks
            .filter((a) => a.targetStrategyId === original.id)
            .map((a) => ({
              attackId: a.id,
              decision: "accept",
              reason: "需要先确定总费用",
              evidenceIds: input.evidence
                .filter((e) => e.attackId === a.id && e.status === "calculated")
                .map((e) => e.id),
              change: "加入费用确认步骤",
            })),
          summary: "先核实收费再开始",
          changed: true,
        };
      }
      return { value, usage: result().usage };
    });
    let current = arena;
    for (let i = 0; i < 15 && current.versions[0].status !== "completed"; i++)
      current = await advanceArena(arena.id, "owner", arena.activeVersionId);
    const version = current.versions[0];
    expect(version.status).toBe("completed");
    expect(version.strategies).toHaveLength(3);
    expect(version.attacks).toHaveLength(3);
    expect(new Set(version.attacks.map((a) => a.id)).size).toBe(3);
    expect(version.evidence.some((e) => e.status === "found" && e.content.includes("120元"))).toBe(
      true,
    );
    expect(version.evidence.some((e) => e.status === "calculated" && e.result === 240)).toBe(true);
    expect(version.revisions).toHaveLength(3);
    expect(version.revisions.every((r) => r.changed)).toBe(true);
    expect(version.verdict?.conditions.length).toBeGreaterThan(0);
    expect(
      version.attacks.every(
        (attack) =>
          attack.status ===
          version.verdict?.attackFindings.find((finding) => finding.attackId === attack.id)?.status,
      ),
    ).toBe(true);
    expect(version.attacks.every((attack) => attack.status !== "pending")).toBe(true);
    expect(model.generate).toHaveBeenCalledTimes(10);
    expect(current.steps.filter((s) => s.status === "completed")).toHaveLength(11);
    expect(version.costCny).toBeCloseTo(0.4);
  });
  it("atomically claims one step, records real usage, and keeps independent proposal inputs empty", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Strategy>>((r) => {
          resolve = r;
        }),
    );
    const first = advanceArena(arena.id, "owner", arena.activeVersionId);
    const repeated = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(repeated.versions[0].reservedCny).toBe(0.2);
    expect(repeated.steps.filter((s) => s.status === "running")).toHaveLength(1);
    expect(model.generate.mock.calls[0][0]).toMatchObject({
      strategies: [],
      attacks: [],
      evidence: [],
      revisions: [],
      role: "A",
    });
    resolve(result());
    const completed = await first;
    expect(completed.versions[0].reservedCny).toBe(0);
    expect(completed.versions[0].costCny).toBe(0.04);
    const usage = db()
      .prepare("SELECT usage FROM steps WHERE version_id=? AND role='A' AND stage='propose'")
      .get(arena.activeVersionId) as { usage: string };
    expect(JSON.parse(usage.usage)).toMatchObject({
      responseId: "response-test",
      model: "test-model",
    });
    expect(completed.events.some((e) => e.type === "step_completed")).toBe(true);
    expect(() => getArena(arena.id, "someone-else")).toThrow("访问权限");
  });
  it("holds an unknown request reservation and never silently retries it", async () => {
    const arena = createArena(challenge, "owner");
    model.generate.mockRejectedValueOnce(new ModelCallError("请求结果未知", true));
    const failed = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(failed.versions[0]).toMatchObject({ status: "uncertain", reservedCny: 0.2, costCny: 0 });
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it("records rejected structured output and controlled validator diagnostics while charging actual usage", async () => {
    const arena = createArena(challenge, "owner");
    model.generate.mockResolvedValueOnce(result("B"));
    const failed = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(failed.versions[0]).toMatchObject({ status: "ready", costCny: 0.04, reservedCny: 0 });
    expect(failed.versions[0].status).toBe("ready");
    const audit = failed.events.find((e) => e.type === "step_failed");
    expect(audit?.data).toMatchObject({
      rejectedResult: { id: "B" },
      validationMessage: "模型返回的方案编号与指定角色不一致。",
      usage: { responseId: "response-test" },
    });
    expect(failed.versions[0].strategies).toHaveLength(0);
    const repaired = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate.mock.calls[1][0].repairFeedback).toContain("方案编号与指定角色不一致");
    expect(repaired.versions[0].strategies).toHaveLength(1);
    expect(repaired.versions[0].costCny).toBe(0.08);
    expect(repaired.events.filter((e) => e.type === "protocol_repair_scheduled")).toHaveLength(1);
  });
  it("bounds known-format repair to one attempt and charges both failed responses", async () => {
    const arena = createArena(challenge, "owner");
    model.generate.mockImplementation(async () => result("B"));
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    const stopped = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(stopped.versions[0]).toMatchObject({ status: "failed", costCny: 0.08, reservedCny: 0 });
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate).toHaveBeenCalledTimes(2);
  });
  it("treats stale leases as uncertain, but can settle a late response exactly once", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Strategy>>((r) => {
          resolve = r;
        }),
    );
    const first = advanceArena(arena.id, "owner", arena.activeVersionId);
    db()
      .prepare("UPDATE steps SET lease_until=0 WHERE version_id=? AND status='running'")
      .run(arena.activeVersionId);
    expect(getArena(arena.id, "owner").versions[0]).toMatchObject({
      status: "uncertain",
      reservedCny: 0.2,
    });
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate).toHaveBeenCalledTimes(1);
    resolve(result());
    const settled = await first;
    expect(settled.versions[0]).toMatchObject({ status: "ready", reservedCny: 0, costCny: 0.04 });
  });
  it("settles an old in-flight response only into its original superseded version", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Strategy>>((r) => {
          resolve = r;
        }),
    );
    const running = advanceArena(arena.id, "owner", arena.activeVersionId);
    const changed = newVersion(
      arena.id,
      "owner",
      { ...challenge, constraints: "每周两小时" },
      "缩短时间",
    );
    resolve(result());
    const after = await running;
    expect(after.activeVersionId).toBe(changed.activeVersionId);
    expect(after.versions[0]).toMatchObject({ status: "superseded", costCny: 0.04 });
    expect(after.versions[0].strategies).toHaveLength(1);
    expect(after.versions[1].strategies).toHaveLength(0);
    expect(
      after.steps.filter((s) => s.versionId === arena.activeVersionId && s.status === "pending"),
    ).toHaveLength(0);
  });
  it("stops future starts and creates an honest partial verdict while preserving the current call", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Strategy>>((r) => {
          resolve = r;
        }),
    );
    const running = advanceArena(arena.id, "owner", arena.activeVersionId);
    const stopped = stopArena(arena.id, "owner", arena.activeVersionId);
    expect(stopped.versions[0].verdict).toMatchObject({ outcome: "partial", preferred: null });
    resolve(result());
    const completed = await running;
    expect(completed.versions[0]).toMatchObject({ status: "paused", costCny: 0.04 });
    expect(completed.versions[0].verdict?.rationale).toContain("1 个提案");
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
});

describe("budgets and limits", () => {
  it("allows absorbing a cross-route attack with its own valid evidence and still requires direct responses", () => {
    const original = result().value;
    const other = result("B").value;
    const attack: Attack = {
      id: "own-attack",
      from: "B",
      targetStrategyId: "A",
      targetClaimId: original.claims[0].id,
      claimQuote: original.claims[0].text,
      reason: "时间可能不足",
      impact: "无法完成",
      verification: "计算时间",
      requests: [],
      status: "pending",
    };
    const crossAttack: Attack = {
      ...attack,
      id: "cross-attack",
      from: "A",
      targetStrategyId: "B",
      targetClaimId: other.claims[0].id,
      claimQuote: other.claims[0].text,
    };
    const evidence = {
      id: "cross-evidence",
      attackId: crossAttack.id,
      tool: "calculate" as const,
      status: "calculated" as const,
      title: "时间计算",
      content: "3*4=12",
      source: "算术工具",
      sourceIds: [],
      expression: "3*4",
      result: 12,
      assumptions: "按四周计算",
      createdAt: new Date().toISOString(),
    };
    const input: StageInput = {
      challenge,
      role: "A",
      strategies: [original, other],
      attacks: [attack, crossAttack],
      evidence: [
        evidence,
        { ...evidence, id: "failed-evidence", attackId: attack.id, status: "error", result: null },
      ],
      revisions: [],
      userChallenges: [],
    };
    const revision: Revision = {
      strategyId: "A",
      strategy: {
        ...original,
        firstAction: "先记录四周可用时间，再安排学习任务",
        claims: [{ ...original.claims[0], status: "supported", sourceIds: ["failed-evidence"] }],
      },
      responses: [
        {
          attackId: crossAttack.id,
          decision: "accept",
          reason: "对B的时间质疑同样适用于本方案",
          evidenceIds: [evidence.id],
          change: "加入时间确认步骤",
        },
      ],
      summary: "吸收其他方案的经验",
      changed: true,
    };
    const checked = validateRevision(revision, input);
    expect(
      checked.responses.find((response) => response.attackId === crossAttack.id),
    ).toMatchObject({ decision: "accept", evidenceIds: [evidence.id] });
    expect(checked.responses.find((response) => response.attackId === attack.id)).toMatchObject({
      decision: "unresolved",
      evidenceIds: [],
    });
    expect(checked.summary).toContain("接受1项质疑，拒绝0项，未解决1项");
    expect(checked.summary).not.toBe(revision.summary);
    expect(checked.strategy.claims[0]).toMatchObject({ status: "unknown", sourceIds: [] });
    expect(() =>
      validateRevision(
        {
          ...revision,
          responses: [{ ...revision.responses[0], evidenceIds: ["failed-evidence"] }],
        },
        input,
      ),
    ).toThrow("证据引用与攻击不对应");
  });
  it("allows citing unavailable results as unknowns without treating them as proof", () => {
    const strategy = result().value;
    const attack: Attack = {
      id: "attack-B",
      from: "B",
      targetStrategyId: "A",
      targetClaimId: "A1",
      claimQuote: strategy.claims[0].text,
      reason: "成本尚未证实",
      impact: "可能超过预算",
      verification: "查询材料",
      requests: [],
      status: "pending",
    };
    const input: StageInput = {
      challenge,
      role: "judge",
      strategies: [strategy],
      attacks: [attack],
      revisions: [],
      userChallenges: [],
      evidence: [
        {
          id: "E-failed",
          attackId: attack.id,
          tool: "search_materials",
          status: "unavailable",
          title: "缺少材料",
          content: "没有文字材料",
          source: "用户材料",
          sourceIds: [],
          expression: null,
          result: null,
          assumptions: "",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const verdict: Verdict = {
      outcome: "insufficient",
      preferred: null,
      headline: "证据尚不足",
      rationale: "等待核实成本",
      conditions: [],
      uncertainties: ["成本未知"],
      nextActions: ["提供报价单"],
      exitCondition: "成本核实前不执行",
      evidenceIds: [],
      comparisons: [],
      attackFindings: [
        {
          attackId: attack.id,
          status: "refuted",
          reason: "模型声称质疑已被反驳",
          evidenceIds: ["E-failed"],
        },
      ],
    };
    const checked = validateVerdict(verdict, input);
    expect(checked.preferred).toBeNull();
    expect(checked.attackFindings[0]).toMatchObject({ status: "unresolved", evidenceIds: [] });
    expect(validateVerdict({ ...verdict, evidenceIds: ["E-failed"] }, input)).toMatchObject({
      outcome: "insufficient",
      preferred: null,
    });
    expect(() =>
      validateVerdict({ ...verdict, evidenceIds: ["invented-evidence"] }, input),
    ).toThrow("不存在的证据");
    expect(() =>
      validateVerdict({ ...verdict, outcome: "recommendation", preferred: "C" }, input),
    ).toThrow("不存在的策略");
    expect(
      validateVerdict({ ...verdict, outcome: "recommendation", preferred: "A" }, input),
    ).toMatchObject({ outcome: "insufficient", preferred: null });
  });
  it("blocks a call before any external request when the historical arena budget is exhausted", async () => {
    process.env.ARENA_RUN_BUDGET_CNY = "0.21";
    const arena = createArena(challenge, "owner");
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    const changed = newVersion(arena.id, "owner", challenge, "再次比较");
    await expect(advanceArena(arena.id, "owner", changed.activeVersionId)).rejects.toMatchObject({
      code: "RUN_BUDGET",
    });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(getVersion(changed.activeVersionId).reservedCny).toBe(0);
  });
  it("counts held reservations toward global budget across owners", async () => {
    process.env.ARENA_GLOBAL_BUDGET_CNY = "0.21";
    const arena = createArena(challenge, "owner");
    model.generate.mockRejectedValueOnce(new ModelCallError("请求结果未知", true));
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    const other = createArena(challenge, "other");
    await expect(advanceArena(other.id, "other", other.activeVersionId)).rejects.toMatchObject({
      code: "GLOBAL_BUDGET",
    });
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it("enforces global concurrency before requests and visitor limit across rematches", async () => {
    process.env.ARENA_MAX_CONCURRENT_CALLS = "1";
    const arena = createArena(challenge, "owner");
    const other = createArena(challenge, "other");
    model.generate.mockRejectedValueOnce(new ModelCallError("请求结果未知", true));
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    await expect(advanceArena(other.id, "other", other.activeVersionId)).rejects.toMatchObject({
      code: "CONCURRENCY_LIMIT",
    });
    for (let i = 0; i < 5; i++) newVersion(arena.id, "owner", challenge, `重赛${i}`);
    expect(() => newVersion(arena.id, "owner", challenge, "超额重赛")).toThrow("次数已用完");
    expect(getArena(arena.id, "owner").versions).toHaveLength(6);
  });
  it("fails explicitly without a model key and makes no model request", async () => {
    model.configured = false;
    const arena = createArena(challenge, "owner");
    await expect(advanceArena(arena.id, "owner", arena.activeVersionId)).rejects.toMatchObject({
      code: "MODEL_NOT_CONFIGURED",
      status: 503,
    });
    expect(model.generate).not.toHaveBeenCalled();
    expect(getVersion(arena.activeVersionId).reservedCny).toBe(0);
  });
});

describe("opt-in long-lived Node worker", () => {
  it("requires opt-in and a configured model", () => {
    expect(startArenaWorker()).toBeUndefined();
    process.env.ARENA_WORKER_ENABLED = "true";
    model.configured = false;
    expect(startArenaWorker()).toBeUndefined();
  });
  it("advances without an open browser and shares atomic claims with manual requests", async () => {
    vi.useFakeTimers();
    process.env.ARENA_WORKER_ENABLED = "true";
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Strategy>>((r) => {
          resolve = r;
        }),
    );
    startArenaWorker();
    startArenaWorker();
    await vi.advanceTimersByTimeAsync(1000);
    expect(model.generate).toHaveBeenCalledTimes(1);
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(model.generate).toHaveBeenCalledTimes(1);
    resolve(result());
    await vi.advanceTimersByTimeAsync(0);
    expect(getArena(arena.id, "owner").versions[0].strategies).toHaveLength(1);
    stopArenaWorker();
    await vi.advanceTimersByTimeAsync(10000);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it("never replays uncertain requests after worker restart", async () => {
    vi.useFakeTimers();
    process.env.ARENA_WORKER_ENABLED = "true";
    const arena = createArena(challenge, "owner");
    model.generate.mockRejectedValueOnce(new ModelCallError("请求结果未知", true));
    startArenaWorker();
    await vi.advanceTimersByTimeAsync(1000);
    stopArenaWorker();
    startArenaWorker();
    await vi.advanceTimersByTimeAsync(10000);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(getArena(arena.id, "owner").versions[0]).toMatchObject({
      status: "uncertain",
      reservedCny: 0.2,
    });
  });
  it("cools down budget failures before attempting another safe preflight", async () => {
    vi.useFakeTimers();
    process.env.ARENA_WORKER_ENABLED = "true";
    process.env.ARENA_RUN_BUDGET_CNY = "0.1";
    createArena(challenge, "owner");
    startArenaWorker();
    await vi.advanceTimersByTimeAsync(1000);
    expect(model.generate).not.toHaveBeenCalled();
    process.env.ARENA_RUN_BUDGET_CNY = "1.5";
    await vi.advanceTimersByTimeAsync(29000);
    expect(model.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
});

describe("browser ownership and request origin", () => {
  it("requires signed invite access when configured, rotates with code changes and bounds attempts", () => {
    process.env.ARENA_ACCESS_CODE = "private-invite";
    const request = new Request("http://localhost/api/arenas");
    expect(accessState(request)).toMatchObject({ requiresAccessCode: true, accessGranted: false });
    expect(() => requireArenaAccess(request)).toThrow("访问口令");
    const cookie = grantAccess("private-invite").split(";")[0];
    const invited = new Request(request.url, { headers: { cookie } });
    expect(() => requireArenaAccess(invited)).not.toThrow();
    process.env.ARENA_ACCESS_CODE = "new-invite";
    expect(accessState(invited).accessGranted).toBe(false);
    for (let i = 0; i < 29; i++) expect(() => grantAccess("wrong")).toThrow("不正确");
    expect(() => grantAccess("new-invite")).toThrow("过于频繁");
  });
  it("signs private HttpOnly sessions and rejects tampering", () => {
    const initial = new Request("http://localhost/api/arenas");
    const owner = ensureOwner(initial);
    expect(owner.cookie).toContain("HttpOnly; SameSite=Lax");
    const cookie = owner.cookie!.split(";")[0];
    expect(ownerFromRequest(new Request(initial.url, { headers: { cookie } }))).toBe(owner.owner);
    expect(
      ownerFromRequest(new Request(initial.url, { headers: { cookie: cookie + "x" } })),
    ).toBeNull();
  });
  it("checks same origin, including rejecting missing origin", () => {
    process.env.ARENA_PUBLIC_ORIGIN = "https://arena.test";
    expect(() =>
      checkOrigin(
        new Request("https://arena.test/api/arenas", { headers: { origin: "https://evil.test" } }),
      ),
    ).toThrow("来源校验失败");
    expect(() => checkOrigin(new Request("https://arena.test/api/arenas"))).toThrow();
    expect(() =>
      checkOrigin(
        new Request("https://arena.test/api/arenas", { headers: { origin: "https://arena.test" } }),
      ),
    ).not.toThrow();
  });
  it("uses the local Host when Next normalizes the request URL and requires explicit remote origin", () => {
    expect(() =>
      checkOrigin(
        new Request("http://localhost:3100/api/arenas", {
          headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      checkOrigin(
        new Request("http://localhost:3100/api/arenas", {
          headers: { host: "127.0.0.1:3100", origin: "https://evil.test" },
        }),
      ),
    ).toThrow("来源校验失败");
    expect(() =>
      checkOrigin(
        new Request("http://localhost/api/arenas", {
          headers: { host: "public.test", origin: "http://public.test" },
        }),
      ),
    ).toThrow("ARENA_PUBLIC_ORIGIN");
  });
});

// Explicit synthetic source records and mocked model boundary; no provider is contacted.
describe("version-bound follow-up regressions", () => {
  function preparedSource() {
    const arena = createArena(challenge, "owner");
    const synthetic = fixtureSnapshot();
    for (let stage = 0; stage < 5; stage++) advanceFixture(synthetic);
    const completed = synthetic.versions[0];
    const version = getVersion(arena.activeVersionId);
    Object.assign(version, {
      status: "completed",
      stage: "judge",
      strategies: completed.strategies,
      attacks: completed.attacks,
      evidence: completed.evidence,
      revisions: completed.revisions,
      verdict: completed.verdict,
    });
    saveVersion(version);
    return { arena, version };
  }
  function persistedState() {
    return ["arenas", "versions", "steps", "events", "visitor_runs", "interventions"].map((table) =>
      db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  }
  function rejectsWithoutMutation(action: () => unknown, code: string) {
    const before = persistedState();
    expect(action).toThrowError(expect.objectContaining({ status: 409, code }));
    expect(persistedState()).toEqual(before);
    expect(model.generate).not.toHaveBeenCalled();
  }

  it("resolves all five source kinds and uses the original proposal when a revision exists", () => {
    const { version } = preparedSource();
    version.revisions[0].strategy.thesis = "修订后的测试论点，与原始提案不同。";
    const ids = ["p:A", "a:attack-fixture", "v:attack-fixture", "r:A", "judge"];
    for (const stepId of ids) {
      const source = stepContext(version, stepId);
      expect(source).toMatchObject({
        stepId,
        title: expect.any(String),
        quote: expect.any(String),
      });
      expect(source!.title.length).toBeGreaterThan(0);
      expect(source!.quote.length).toBeGreaterThan(0);
    }
    expect(stepContext(version, "p:A")!.quote).toContain(version.strategies[0].thesis);
    expect(stepContext(version, "p:A")!.quote).not.toContain(version.revisions[0].strategy.thesis);
    expect(stepContext(version, "r:A")!.quote).toContain(version.revisions[0].strategy.thesis);
    for (const stepId of ["p:Z", "a:missing", "v:missing", "r:Z", "unknown"])
      expect(stepContext(version, stepId)).toBeNull();
    version.verdict = null;
    expect(stepContext(version, "judge")).toBeNull();
  });

  it.each(["p:A", "a:attack-fixture", "v:attack-fixture", "r:A", "judge"])(
    "persists %s follow-up and starts a complete fresh protocol with user opinion separated from facts",
    async (stepId) => {
      const { arena, version } = preparedSource();
      const context = stepContext(version, stepId)!;
      const followUp = {
        stepId,
        quote: context.quote,
        text: "测试用户意见：这个前提可能还需核对。",
      };
      const changed = newVersion(
        arena.id,
        "owner",
        version.challenge,
        "用户补充",
        undefined,
        undefined,
        {
          baseVersionId: version.id,
          followUp,
        },
      );
      const next = getVersion(changed.activeVersionId);
      expect(next.followUp).toEqual({ ...followUp, sourceVersionId: version.id });
      expect(next).toMatchObject({
        parentVersionId: version.id,
        stage: "propose",
        status: "ready",
        costCny: 0,
        reservedCny: 0,
      });
      expect(next.challenge).toEqual(version.challenge);
      expect(next.strategies).toEqual([]);
      expect(next.attacks).toEqual([]);
      expect(next.evidence).toEqual([]);
      expect(next.revisions).toEqual([]);
      expect(next.verdict).toBeNull();
      expect(changed.steps.filter((step) => step.versionId === next.id)).toHaveLength(11);
      expect(
        changed.steps
          .filter((step) => step.versionId === next.id)
          .every((step) => step.status === "pending"),
      ).toBe(true);
      await advanceArena(arena.id, "owner", next.id);
      const input = model.generate.mock.calls[0][0] as StageInput;
      expect(input.userChallenges.join("\n")).toContain(followUp.text);
      expect(input.userChallenges.join("\n")).toContain(followUp.quote);
      expect(input.userChallenges.join("\n")).toMatch(/用户|意见|待核/);
      expect(input.challenge.materials).toBe(version.challenge.materials);
      expect(getVersion(version.id).followUp).toBeUndefined();
    },
  );

  it("rejects changed, missing and duplicate sources without spending a run or altering prior records", () => {
    const { arena, version } = preparedSource();
    const context = stepContext(version, "p:A")!;
    const submit = (stepId: string, quote: string, baseVersionId = version.id) =>
      newVersion(arena.id, "owner", challenge, "用户补充", undefined, undefined, {
        baseVersionId,
        followUp: { stepId, quote, text: "测试：请核对这个条件。" },
      });
    rejectsWithoutMutation(() => submit("p:A", `${context.quote}被改写`), "STALE_SOURCE");
    rejectsWithoutMutation(() => submit("a:missing", context.quote), "STALE_SOURCE");
    rejectsWithoutMutation(() => submit("p:A", context.quote, "missing-version"), "STALE_VERSION");
    submit("p:A", context.quote);
    rejectsWithoutMutation(() => submit("p:A", context.quote), "STALE_VERSION");
    rejectsWithoutMutation(
      () =>
        newVersion(arena.id, "owner", challenge, "旧条件", undefined, undefined, {
          baseVersionId: version.id,
        }),
      "STALE_VERSION",
    );
  });

  it("checks exact claim quotes after revision and retains old intervention and version clients", () => {
    const { arena, version } = preparedSource();
    const revised = version.revisions[0].strategy.claims[0];
    const oldQuote = revised.text;
    revised.text = "修订后的测试判断：请先计算等待时间。";
    saveVersion(version);
    rejectsWithoutMutation(
      () =>
        intervene(arena.id, "owner", {
          targetStrategyId: "A",
          targetClaimId: revised.id,
          text: "测试：补充质疑。",
          baseVersionId: version.id,
          quote: oldQuote,
        }),
      "STALE_SOURCE",
    );
    const changed = intervene(arena.id, "owner", {
      targetStrategyId: "A",
      targetClaimId: revised.id,
      text: "测试：补充质疑。",
      baseVersionId: version.id,
      quote: revised.text,
    });
    rejectsWithoutMutation(
      () =>
        intervene(arena.id, "owner", {
          targetStrategyId: "A",
          targetClaimId: revised.id,
          text: "测试：再次提交。",
          baseVersionId: version.id,
          quote: revised.text,
        }),
      "STALE_VERSION",
    );
    expect(changed.versions).toHaveLength(2);
    const legacy = newVersion(arena.id, "owner", challenge, "旧客户端条件更新");
    expect(legacy.versions).toHaveLength(3);
    const source = getVersion(legacy.activeVersionId);
    source.strategies = [result().value];
    saveVersion(source);
    const legacyIntervention = intervene(arena.id, "owner", {
      targetStrategyId: "A",
      targetClaimId: "A1",
      text: "旧客户端不携带版本与原文。",
    });
    expect(legacyIntervention.versions).toHaveLength(4);
  });

  it("settles an in-flight result into its source version after a step follow-up creates the new version", async () => {
    const { arena, version } = preparedSource();
    version.status = "ready";
    version.stage = "propose";
    version.strategies = [result().value];
    saveVersion(version);
    db()
      .prepare(
        "UPDATE steps SET status='completed' WHERE version_id=? AND stage='propose' AND role='A'",
      )
      .run(version.id);
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(
      () =>
        new Promise<ModelResult<Strategy>>((done) => {
          resolve = done;
        }),
    );
    const running = advanceArena(arena.id, "owner", version.id);
    const context = stepContext(version, "p:A")!;
    const changed = newVersion(arena.id, "owner", challenge, "用户补充", undefined, undefined, {
      baseVersionId: version.id,
      followUp: { stepId: context.stepId, quote: context.quote, text: "测试：补充投入时间。" },
    });
    const late = result("B");
    late.value.steps = ["阅读公开源码，自行制作结构拆解和实验报告"];
    late.value.resources = "开源代码仓库和独立研究记录";
    late.value.thesis = "通过自主研究开源实现来完成学习目标。";
    resolve(late);
    await running;
    const after = getArena(arena.id, "owner");
    expect(after.activeVersionId).toBe(changed.activeVersionId);
    expect(after.versions[0]).toMatchObject({
      status: "superseded",
      reservedCny: 0,
      costCny: 0.04,
    });
    expect(after.versions[0].strategies.map((strategy) => strategy.id)).toEqual(["A", "B"]);
    expect(after.versions[1].strategies).toEqual([]);
    expect(after.versions[1].costCny).toBe(0);
  });
});
