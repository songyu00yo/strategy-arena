import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeSchema, type ModelResult, type StageInput, type Strategy, type Attack, type Revision, type Verdict } from "../src/lib/contracts";

const model = vi.hoisted(() => ({ generate: vi.fn(), configured: true, estimate: 0.2 }));
vi.mock("../src/lib/server/model", () => {
  class ModelCallError extends Error { constructor(message: string, public uncertain = false, public usage?: unknown) { super(message); } }
  return {
    ModelCallError,
    getModelConfig: () => ({ id: "test-model", configured: model.configured, promptVersion: "test", schemaVersion: "1.0.0", timeoutMs: 1000 }),
    estimateCallCost: () => model.estimate,
    generateStrategy: (input: unknown) => model.generate(input), generateAttack: (input: unknown) => model.generate(input),
    generateRevision: (input: unknown) => model.generate(input), generateVerdict: (input: unknown) => model.generate(input)
  };
});
import { closeDb, db, getVersion } from "../src/lib/server/db";
import { advanceArena, createArena, getArena, newVersion, stopArena } from "../src/lib/server/runtime";
import { ModelCallError } from "../src/lib/server/model";
import { ensureOwner, ownerFromRequest, checkOrigin, accessState, grantAccess, requireArenaAccess } from "../src/lib/server/auth";

const challenge = ChallengeSchema.parse({ goal: "在两个月内完成一门入门课程并交付项目" });
function result(role = "A"): ModelResult<Strategy> {
  return { value: { id: role as Strategy["id"], title: `方案${role}`, thesis: `使用${role}路径学习`, steps: ["先完成一个小项目"], claims: [{ id: `${role}1`, text: "每周至少投入三小时", status: "unknown", sourceIds: [] }], resources: "现有设备", firstAction: "列出可用时间", failureCondition: "时间不足", estimatedCost: null, estimatedHours: 12 }, usage: { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0, estimatedCny: 0.04, model: "test-model", responseId: "response-test", durationMs: 20 } };
}
beforeEach(() => {
  closeDb();
  vi.stubEnv("ARENA_DATABASE_PATH", ":memory:");
  vi.stubEnv("ARENA_RUN_BUDGET_CNY", "1.5");
  vi.stubEnv("ARENA_GLOBAL_BUDGET_CNY", "90");
  vi.stubEnv("ARENA_DAILY_VISITOR_LIMIT", "6");
  vi.stubEnv("ARENA_MAX_CONCURRENT_CALLS", "3");
  vi.stubEnv("ARENA_SESSION_SECRET", "backend-test-secret-32-characters-long");
  vi.stubEnv("ARENA_ACCESS_CODE", "");
  model.configured = true; model.estimate = 0.2;
  model.generate.mockReset();
  model.generate.mockImplementation(async (input: StageInput) => result(input.role));
});
afterEach(() => { closeDb(); vi.unstubAllEnvs(); });

describe("durable execution and ownership", () => {
  it("runs the complete protocol with real local retrieval, arithmetic, revision and a conditional verdict", async () => {
    const arena = createArena({ ...challenge, materials: "课程费用为120元。每周可学习四小时。", budget: 500, timeHours: 50 }, "owner");
    const approaches: Record<string, { steps: string[]; resources: string }> = {
      A: { steps: ["报名课堂，按教学大纲完成作业并制作结课网站"], resources: "授课教师和课堂练习系统" },
      B: { steps: ["寻找行业导师结对编程，每周接受项目代码评审"], resources: "导师工时和远程会议工具" },
      C: { steps: ["阅读开源源码，自行拆解应用架构，编写技术实验报告"], resources: "公开代码仓库及研究笔记" }
    };
    model.generate.mockImplementation(async (input: StageInput) => {
      let value: Strategy | Attack | Revision | Verdict;
      if (input.role === "judge") {
        value = { outcome: "recommendation", preferred: "A", headline: "课程可作为有条件的首选", rationale: "已核对材料与算术，仍需验证实际教学质量。", conditions: ["实际课程符合现有时间"], uncertainties: ["教学质量需要试听确认"], nextActions: ["预约试听并记录完成时间"], exitCondition: "试听后无法按计划投入时间则退出", evidenceIds: input.evidence.filter(e => e.status === "found" || e.status === "calculated").map(e => e.id), comparisons: input.strategies.map(s => ({ strategyId: s.id, status: "unknown", reason: "估计尚未实测" })), attackFindings: input.attacks.map(a => ({ attackId: a.id, status: "unresolved", reason: "材料只核实费用，未证实教学效果", evidenceIds: input.evidence.filter(e => e.attackId === a.id && e.status === "found").map(e => e.id) })) };
      } else if (!input.strategies.length) {
        value = { ...result(input.role).value, ...approaches[input.role] };
      } else if (!input.evidence.length) {
        const target = input.strategies.find(s => s.id !== input.role)!;
        value = { id: "same-model-id", from: input.role, targetStrategyId: target.id, targetClaimId: target.claims[0].id, claimQuote: target.claims[0].text, reason: `${input.role}要求核实课程成本和投入时间`, impact: "可能超出费用预期", verification: "检索原文并计算两期费用", requests: [{ tool: "search_materials", query: "课程费用" }, { tool: "calculate", expression: "120*2", assumptions: "以两期均为120元计算" }], status: "pending" };
      } else {
        const original = input.strategies.find(s => s.id === input.role)!;
        value = { strategyId: original.id, strategy: { ...original, firstAction: "先询问两期课程完整收费再执行原计划" }, responses: input.attacks.filter(a => a.targetStrategyId === original.id).map(a => ({ attackId: a.id, decision: "accept", reason: "需要先确定总费用", evidenceIds: input.evidence.filter(e => e.attackId === a.id && e.status === "calculated").map(e => e.id), change: "加入费用确认步骤" })), summary: "先核实收费再开始", changed: true };
      }
      return { value, usage: result().usage };
    });
    let current = arena;
    for (let i = 0; i < 15 && current.versions[0].status !== "completed"; i++) current = await advanceArena(arena.id, "owner", arena.activeVersionId);
    const version = current.versions[0];
    expect(version.status).toBe("completed");
    expect(version.strategies).toHaveLength(3);
    expect(version.attacks).toHaveLength(3);
    expect(new Set(version.attacks.map(a => a.id)).size).toBe(3);
    expect(version.evidence.some(e => e.status === "found" && e.content.includes("120元"))).toBe(true);
    expect(version.evidence.some(e => e.status === "calculated" && e.result === 240)).toBe(true);
    expect(version.revisions).toHaveLength(3);
    expect(version.revisions.every(r => r.changed)).toBe(true);
    expect(version.verdict?.conditions.length).toBeGreaterThan(0);
    expect(model.generate).toHaveBeenCalledTimes(10);
    expect(current.steps.filter(s => s.status === "completed")).toHaveLength(11);
    expect(version.costCny).toBeCloseTo(0.4);
  });
  it("atomically claims one step, records real usage, and keeps independent proposal inputs empty", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(() => new Promise<ModelResult<Strategy>>(r => { resolve = r; }));
    const first = advanceArena(arena.id, "owner", arena.activeVersionId);
    const repeated = await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(repeated.versions[0].reservedCny).toBe(0.2);
    expect(repeated.steps.filter(s => s.status === "running")).toHaveLength(1);
    expect(model.generate.mock.calls[0][0]).toMatchObject({ strategies: [], attacks: [], evidence: [], revisions: [], role: "A" });
    resolve(result());
    const completed = await first;
    expect(completed.versions[0].reservedCny).toBe(0);
    expect(completed.versions[0].costCny).toBe(0.04);
    const usage = db().prepare("SELECT usage FROM steps WHERE version_id=? AND role='A' AND stage='propose'").get(arena.activeVersionId) as { usage: string };
    expect(JSON.parse(usage.usage)).toMatchObject({ responseId: "response-test", model: "test-model" });
    expect(completed.events.some(e => e.type === "step_completed")).toBe(true);
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
  it("treats stale leases as uncertain, but can settle a late response exactly once", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(() => new Promise<ModelResult<Strategy>>(r => { resolve = r; }));
    const first = advanceArena(arena.id, "owner", arena.activeVersionId);
    db().prepare("UPDATE steps SET lease_until=0 WHERE version_id=? AND status='running'").run(arena.activeVersionId);
    expect(getArena(arena.id, "owner").versions[0]).toMatchObject({ status: "uncertain", reservedCny: 0.2 });
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    expect(model.generate).toHaveBeenCalledTimes(1);
    resolve(result());
    const settled = await first;
    expect(settled.versions[0]).toMatchObject({ status: "ready", reservedCny: 0, costCny: 0.04 });
  });
  it("settles an old in-flight response only into its original superseded version", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(() => new Promise<ModelResult<Strategy>>(r => { resolve = r; }));
    const running = advanceArena(arena.id, "owner", arena.activeVersionId);
    const changed = newVersion(arena.id, "owner", { ...challenge, constraints: "每周两小时" }, "缩短时间");
    resolve(result());
    const after = await running;
    expect(after.activeVersionId).toBe(changed.activeVersionId);
    expect(after.versions[0]).toMatchObject({ status: "superseded", costCny: 0.04 });
    expect(after.versions[0].strategies).toHaveLength(1);
    expect(after.versions[1].strategies).toHaveLength(0);
    expect(after.steps.filter(s => s.versionId === arena.activeVersionId && s.status === "pending")).toHaveLength(0);
  });
  it("stops future starts and creates an honest partial verdict while preserving the current call", async () => {
    const arena = createArena(challenge, "owner");
    let resolve!: (value: ModelResult<Strategy>) => void;
    model.generate.mockImplementationOnce(() => new Promise<ModelResult<Strategy>>(r => { resolve = r; }));
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
  it("blocks a call before any external request when the historical arena budget is exhausted", async () => {
    process.env.ARENA_RUN_BUDGET_CNY = "0.21";
    const arena = createArena(challenge, "owner");
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    const changed = newVersion(arena.id, "owner", challenge, "再次比较");
    await expect(advanceArena(arena.id, "owner", changed.activeVersionId)).rejects.toMatchObject({ code: "RUN_BUDGET" });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(getVersion(changed.activeVersionId).reservedCny).toBe(0);
  });
  it("counts held reservations toward global budget across owners", async () => {
    process.env.ARENA_GLOBAL_BUDGET_CNY = "0.21";
    const arena = createArena(challenge, "owner");
    model.generate.mockRejectedValueOnce(new ModelCallError("请求结果未知", true));
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    const other = createArena(challenge, "other");
    await expect(advanceArena(other.id, "other", other.activeVersionId)).rejects.toMatchObject({ code: "GLOBAL_BUDGET" });
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it("enforces global concurrency before requests and visitor limit across rematches", async () => {
    process.env.ARENA_MAX_CONCURRENT_CALLS = "1";
    const arena = createArena(challenge, "owner");
    const other = createArena(challenge, "other");
    model.generate.mockRejectedValueOnce(new ModelCallError("请求结果未知", true));
    await advanceArena(arena.id, "owner", arena.activeVersionId);
    await expect(advanceArena(other.id, "other", other.activeVersionId)).rejects.toMatchObject({ code: "CONCURRENCY_LIMIT" });
    for (let i = 0; i < 5; i++) newVersion(arena.id, "owner", challenge, `重赛${i}`);
    expect(() => newVersion(arena.id, "owner", challenge, "超额重赛")).toThrow("次数已用完");
    expect(getArena(arena.id, "owner").versions).toHaveLength(6);
  });
  it("fails explicitly without a model key and makes no model request", async () => {
    model.configured = false;
    const arena = createArena(challenge, "owner");
    await expect(advanceArena(arena.id, "owner", arena.activeVersionId)).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED", status: 503 });
    expect(model.generate).not.toHaveBeenCalled();
    expect(getVersion(arena.activeVersionId).reservedCny).toBe(0);
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
    expect(ownerFromRequest(new Request(initial.url, { headers: { cookie: cookie + "x" } }))).toBeNull();
  });
  it("checks same origin, including rejecting missing origin", () => {
    expect(() => checkOrigin(new Request("https://arena.test/api/arenas", { headers: { origin: "https://evil.test" } }))).toThrow("来源校验失败");
    expect(() => checkOrigin(new Request("https://arena.test/api/arenas"))).toThrow();
    expect(() => checkOrigin(new Request("https://arena.test/api/arenas", { headers: { origin: "https://arena.test" } }))).not.toThrow();
  });
});
