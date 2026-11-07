/** Real isolated SQLite and deterministic model boundaries. No provider or search request. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPlan } from "../src/lib/agent-contracts";
import { AGENT_LIMITS } from "../src/lib/agent-contracts";
import {
  ChallengeSchema,
  type ArenaSnapshot,
  type Attack,
  type ModelUsage,
  type Revision,
  type StageInput,
  type Strategy,
  type Verdict,
} from "../src/lib/contracts";

const models = vi.hoisted(() => ({
  plan: vi.fn(),
  propose: vi.fn(),
  attack: vi.fn(),
  revise: vi.fn(),
  judge: vi.fn(),
  estimateStructured: vi.fn(),
  estimate: 0.001,
}));
const externalTool = vi.hoisted(() => vi.fn());
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
    getModelConfig: (provider = "deepseek", modelId?: string) => ({
      provider,
      id: modelId ?? (provider === "deepseek" ? "deepseek-flash" : "gpt-6.1-terra"),
      currency: provider === "deepseek" ? "CNY" : "USD",
      configured: true,
      promptVersion: "synthetic-agent-runtime",
      schemaVersion: "synthetic",
      timeoutMs: 1000,
      inputPrice: 1,
      outputPrice: 1,
    }),
    estimateCallCost: () => models.estimate,
    estimateStructuredCall: models.estimateStructured,
    generateStructured: models.plan,
    generateStrategy: models.propose,
    generateAttack: models.attack,
    generateRevision: models.revise,
    generateVerdict: models.judge,
  };
});
vi.mock("../src/lib/server/mcp-tools", () => ({
  executeMcpTool: externalTool,
}));
import { ModelCallError } from "../src/lib/server/model";
import { atomic, closeDb, db, getVersion, id, now } from "../src/lib/server/db";
import { actionFor, hashOf, modelRequestsUsed } from "../src/lib/server/agent";
import {
  advanceArena,
  createArena,
  getArena,
  newVersion,
  stopArena,
} from "../src/lib/server/runtime";

const owner = "synthetic-agent-owner";
const challenge = ChallengeSchema.parse({
  goal: "比较三种学习方式并完成一个能展示的项目",
  budget: 100,
  timeHours: 20,
  materials: "课程允许先试听。教材提供章节练习。导师允许先沟通。源码可用于实验比较。",
});
const usage: ModelUsage = {
  inputTokens: 10,
  outputTokens: 10,
  cachedInputTokens: 0,
  estimatedCny: 0.0001,
  model: "deepseek-flash",
  responseId: "synthetic-agent-response",
  durationMs: 1,
};
const roles = ["A", "B", "C"] as const;
const mechanisms = {
  A: ["阅读纸质教材并完成章节练习", "教材与知识卡片"],
  B: ["请导师结对编程制作交互网站", "导师反馈与代码评审"],
  C: ["拆解公开源码开展性能实验", "代码仓库与实验日志"],
};
let directory = "";
let secondDecision: AgentPlan["next"] = "judge";
let thirdDecision: AgentPlan["next"] = "judge";

function proposal(role: Strategy["id"]): Strategy {
  return {
    id: role,
    title: `${role}路线`,
    thesis: mechanisms[role][0],
    steps: [mechanisms[role][0]],
    claims: [
      {
        id: "raw-claim",
        text: `${mechanisms[role][1]}能够支持学习交付`,
        status: "unknown",
        sourceIds: [],
      },
    ],
    resources: mechanisms[role][1],
    costPlan: {
      complete: true,
      items: [{ id: "free", label: "整理现有材料", amount: 0, basis: "assumption", quote: "" }],
    },
    firstAction: `先核对${mechanisms[role][1]}`,
    failureCondition: "无法取得必要材料则停止",
    estimatedCost: 0,
    estimatedHours: 5,
  };
}
function plan(checkpoint: number): AgentPlan {
  return {
    summary: `合成检查点${checkpoint}，按现有证据安排后续`,
    questions: ["材料是否足够"],
    directions: roles.map((role) => ({ role, brief: mechanisms[role][0] })),
    tools:
      checkpoint === 1
        ? [{ tool: "search_materials", query: "课程试听" }]
        : checkpoint === 2 && secondDecision === "supplement"
          ? [{ tool: "calculate", expression: "2+3", assumptions: "合成算术示例" }]
          : [],
    next: checkpoint === 1 ? "discuss" : checkpoint === 2 ? secondDecision : thirdDecision,
    reviseRoles: [],
    stopCondition: "缺少决定性资料则保留未知并裁决",
  };
}
function attack(input: StageInput, attemptId: string): Attack {
  const action = actionFor(attemptId)!;
  const target = input.strategies.find(
    (strategy) => strategy.id === roles[(roles.indexOf(input.role as Strategy["id"]) + 1) % 3],
  )!;
  return {
    id: "raw-attack",
    from: input.role,
    targetStrategyId: target.id,
    targetClaimId: target.claims[0].id,
    claimQuote: target.claims[0].text,
    reason: `${input.role}核对第${action.round}轮材料是否足以支持交付`,
    impact: "决定是否继续原路线",
    verification: "检索原材料",
    requests: [{ tool: "search_materials", query: "教材导师源码" }],
    status: "pending",
  };
}
function revision(input: StageInput, attemptId: string): Revision {
  const original = input.strategies.find((strategy) => strategy.id === input.role)!;
  const round = actionFor(attemptId)!.round;
  return {
    strategyId: original.id,
    strategy: {
      ...original,
      steps: [
        ...original.steps.filter((step) => !step.startsWith("完成第")),
        `完成第${round}轮原材料核对再继续本路线`,
      ],
      firstAction: `完成第${round}轮材料核对`,
    },
    responses: input.attacks
      .filter((item) => item.targetStrategyId === original.id)
      .map((item) => ({
        attackId: item.id,
        decision: "unresolved",
        reason: "材料只支持核对，不证明交付效果",
        evidenceIds: input.evidence
          .filter((evidence) => evidence.attackId === item.id)
          .map((evidence) => evidence.id),
        change: "增加材料核对",
      })),
    summary: "保留原机制并核对资料",
    changed: true,
  };
}
function verdict(input: StageInput): Verdict {
  return {
    outcome: "tie",
    preferred: null,
    headline: "资料仍不足以排序",
    rationale: "不同学习路线仍需验证实际效果",
    conditions: ["全程投入需要继续核实"],
    uncertainties: ["实际学习效果未知"],
    nextActions: ["先整理已有材料"],
    exitCondition: "必要材料无法取得则停止",
    evidenceIds: input.evidence.map((evidence) => evidence.id),
    comparisons: input.strategies.map((strategy) => ({
      strategyId: strategy.id,
      status: "unknown",
      reason: "实际效果未知",
      basis: "unknown",
      quote: "",
    })),
    attackFindings: input.attacks.map((item) => ({
      attackId: item.id,
      status: "unresolved",
      reason: "现有材料未证明效果",
      evidenceIds: input.evidence
        .filter((evidence) => evidence.attackId === item.id)
        .map((evidence) => evidence.id),
    })),
  };
}
function arena() {
  return createArena(challenge, owner, "deepseek", undefined, "agent");
}
async function drive(snapshot: ArenaSnapshot, until?: (snapshot: ArenaSnapshot) => boolean) {
  let current = snapshot;
  for (let index = 0; index < 80; index++) {
    if (until?.(current)) return current;
    const active = current.versions.find((version) => version.id === current.activeVersionId)!;
    if (!["ready", "running"].includes(active.status)) return current;
    current = await advanceArena(current.id, owner, current.activeVersionId);
  }
  throw new Error("Synthetic action graph did not settle within 80 advances");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function assertCompleted(snapshot: ArenaSnapshot, expectedFailures = 0) {
  const version = snapshot.versions[0];
  expect({
    status: version.status,
    error: version.error,
    events: snapshot.events
      .filter((event) => event.type === "step_failed")
      .map((event) => event.message),
  }).toMatchObject({ status: "completed", error: null });
  expect(snapshot.events.filter((event) => event.type === "step_failed")).toHaveLength(
    expectedFailures,
  );
  return version;
}
beforeEach(() => {
  closeDb();
  directory = mkdtempSync(join(tmpdir(), "arena-agent-test-"));
  vi.stubEnv("ARENA_DATABASE_PATH", join(directory, "runtime.sqlite"));
  vi.stubEnv("ARENA_RUN_BUDGET_USD", "10");
  vi.stubEnv("ARENA_GLOBAL_BUDGET_USD", "120");
  vi.stubEnv("ARENA_RUN_BUDGET_CNY", undefined);
  vi.stubEnv("ARENA_GLOBAL_BUDGET_CNY", undefined);
  vi.stubEnv("ARENA_DAILY_VISITOR_LIMIT", "100");
  vi.stubEnv("ARENA_WORKER_ENABLED", "false");
  vi.stubEnv("TAVILY_API_KEY", "");
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("MODEL_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ARENA_SEARCH_PROVIDER", "deepseek");
  vi.stubEnv("ARENA_ACCEPTANCE_BATCH_ID", "");
  vi.stubEnv("ARENA_TOOL_BATCH_ID", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in synthetic runtime tests");
    }),
  );
  secondDecision = thirdDecision = "judge";
  models.estimate = 0.001;
  models.estimateStructured
    .mockReset()
    .mockImplementation(() => ({ amount: models.estimate, tokens: 100, currency: "CNY" }));
  externalTool.mockReset().mockImplementation(() => {
    throw new Error("External tools are forbidden in this synthetic runtime suite");
  });
  for (const mock of [models.plan, models.propose, models.attack, models.revise, models.judge])
    mock.mockReset();
  models.plan.mockImplementation(async (request) => ({
    value: plan(request.input.checkpoint),
    usage,
  }));
  models.propose.mockImplementation(async (input) => ({ value: proposal(input.role), usage }));
  models.attack.mockImplementation(async (input, _config, attemptId) => ({
    value: attack(input, attemptId),
    usage,
  }));
  models.revise.mockImplementation(async (input, _config, attemptId) => ({
    value: revision(input, attemptId),
    usage,
  }));
  models.judge.mockImplementation(async (input) => ({ value: verdict(input), usage }));
});
afterEach(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("durable bounded agent with synthetic models", () => {
  it("compiles research, independent proposals, attacks, evidence, targeted revisions and final checks", async () => {
    const snapshot = arena();
    expect(snapshot.steps).toHaveLength(1);
    expect(actionFor(snapshot.steps[0].id)?.kind).toBe("plan");
    const completed = await drive(snapshot);
    const version = assertCompleted(completed);
    expect(version.agent?.plans.map((item) => item.checkpoint)).toEqual([1, 2]);
    expect(version.strategies.map((item) => item.id)).toEqual(roles);
    expect(version.attacks).toHaveLength(3);
    expect(version.revisions).toHaveLength(3);
    expect(version.verdict?.attackFindings).toHaveLength(3);
    for (const [input] of models.propose.mock.calls) {
      expect(input.strategies).toEqual([]);
      expect(input.attacks).toEqual([]);
      expect(input.revisions).toEqual([]);
      expect(
        input.researchContext.some((item: { status: string }) => item.status === "found"),
      ).toBe(true);
      expect(input.routeBrief).toBe(mechanisms[input.role as Strategy["id"]][0]);
    }
    expect(
      version.evidence.some(
        (item) => item.attackId === "research" && item.references?.[0].contentHash,
      ),
    ).toBe(true);
    expect(version.evidence.filter((item) => item.estimateScope === "final")).toHaveLength(6);
    const judgeInput = models.judge.mock.calls[0][0] as StageInput;
    expect(judgeInput.strategies.every((item) => item.firstAction.includes("第1轮"))).toBe(true);
    expect(modelRequestsUsed(version.id)).toBe(12);
    expect(version.agent?.toolsUsed).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    closeDb();
    expect(getArena(snapshot.id, owner).versions[0]).toEqual(version);
  });
  it("supplements one evidence gap and reaches the third planning checkpoint", async () => {
    secondDecision = "supplement";
    const completed = await drive(arena());
    const version = assertCompleted(completed);
    expect(version.agent?.plans.map((item) => item.checkpoint)).toEqual([1, 2, 3]);
    expect(version.evidence.some((item) => item.attackId === "research" && item.result === 5)).toBe(
      true,
    );
    expect(models.plan).toHaveBeenCalledTimes(3);
    expect(version.agent?.toolsUsed).toBe(3);
  });
  it("journals the exact structured planner input used for each checkpoint", async () => {
    secondDecision = "supplement";
    const version = assertCompleted(await drive(arena()));
    for (const [request] of models.plan.mock.calls) {
      const recorded = db()
        .prepare("SELECT input_body,input_hash FROM agent_actions WHERE step_id=?")
        .get(request.attemptId) as { input_body: string; input_hash: string };
      expect(JSON.parse(recorded.input_body)).toEqual(request.input);
      expect(recorded.input_hash).toBe(hashOf(request.input));
    }
    expect(version.agent?.plans).toHaveLength(3);
  });
  it("repairs an oversized checkpoint-two plan once using frozen diagnostics and a fresh estimate", async () => {
    const rejectedOutput = JSON.stringify({ ...plan(2), summary: "长".repeat(614) });
    const feedback = "summary: too_big（最多500字符；实收614字符）";
    models.plan.mockImplementation(async (request) => {
      expect(request.allowRepair).toBe(true);
      expect(request.system).toContain("summary建议120至180字");
      expect(request.system).toContain("绝不超过500字符");
      if (request.input.checkpoint === 2 && !request.input.repairFeedback)
        throw new ModelCallError("Synthetic summary too long", false, usage, {
          feedback,
          rejectedOutput,
        });
      return { value: plan(request.input.checkpoint), usage };
    });
    const completed = await drive(arena());
    const version = assertCompleted(completed, 1);
    expect(version.agent?.plans.map((item) => item.checkpoint)).toEqual([1, 2]);
    expect(models.plan).toHaveBeenCalledTimes(3);
    expect(modelRequestsUsed(version.id)).toBe(13);
    const repairRequest = models.plan.mock.calls.find(
      ([request]) => request.input.repairFeedback,
    )![0];
    expect(repairRequest.input).toMatchObject({
      checkpoint: 2,
      repairFeedback: feedback,
      rejectedOutput,
    });
    const repairAction = actionFor(repairRequest.attemptId)!;
    const sourceId = JSON.parse(repairAction.payload).repairOf;
    expect(sourceId).not.toBe(repairAction.step_id);
    expect(JSON.parse(repairAction.dependencies)).toEqual(
      JSON.parse(actionFor(sourceId)!.dependencies),
    );
    expect(JSON.parse(repairAction.input_body!)).toEqual(repairRequest.input);
    expect(repairAction.input_hash).toBe(hashOf(repairRequest.input));
    const estimation = models.estimateStructured.mock.calls.find(
      ([request]) => request.attemptId === repairAction.step_id,
    )![0];
    expect(estimation.input).toEqual(repairRequest.input);
    expect(JSON.parse(actionFor(sourceId)!.input_body!)).not.toHaveProperty("repairFeedback");
    expect(version.costCny).toBeCloseTo(usage.estimatedCny * 13);
    expect(version.reservedCny).toBe(0);
  });
  it("permits one independent repair per planning checkpoint without counting rejected plans as committed", async () => {
    secondDecision = "supplement";
    const failed = new Set<number>();
    models.plan.mockImplementation(async (request) => {
      const checkpoint = request.input.checkpoint as number;
      if (!failed.has(checkpoint)) {
        failed.add(checkpoint);
        throw new ModelCallError("Synthetic schema failure", false, usage, {
          feedback: `checkpoint-${checkpoint} summary too long`,
          rejectedOutput: `rejected-checkpoint-${checkpoint}`,
        });
      }
      expect(request.input.repairFeedback).toBe(`checkpoint-${checkpoint} summary too long`);
      expect(request.input.rejectedOutput).toBe(`rejected-checkpoint-${checkpoint}`);
      return { value: plan(checkpoint), usage };
    });
    const version = assertCompleted(await drive(arena()), 3);
    expect(version.agent?.plans.map((item) => item.checkpoint)).toEqual([1, 2, 3]);
    expect(models.plan).toHaveBeenCalledTimes(6);
    expect(modelRequestsUsed(version.id)).toBe(16);
    const repairs = version.agent!.actions.filter(
      (action) => action.kind === "plan" && JSON.parse(actionFor(action.id)!.payload).repairOf,
    );
    expect(repairs).toHaveLength(3);
    expect(
      new Set(repairs.map((action) => JSON.parse(actionFor(action.id)!.payload).repairOf)).size,
    ).toBe(3);
  });
  it("falls back to fixed actions after one failed planner repair without replacing failures", async () => {
    models.plan.mockRejectedValue(
      new ModelCallError("Synthetic repeated schema failure", false, usage, {
        feedback: "summary too long",
        rejectedOutput: "rejected",
      }),
    );
    const completed = await drive(arena());
    const version = assertCompleted(completed, 2);
    expect(version.agent?.plans).toHaveLength(0);
    expect(version.agent?.stopReason).toContain("summary too long");
    expect(
      completed.events
        .filter((entry) => entry.type === "step_failed")
        .every((entry) => entry.message.includes("Synthetic repeated schema failure")),
    ).toBe(true);
    expect(models.plan).toHaveBeenCalledTimes(2);
    expect(modelRequestsUsed(completed.activeVersionId)).toBe(12);
    expect(completed.steps.filter((step) => step.status === "failed")).toHaveLength(2);
    expect(completed.events.filter((entry) => entry.type === "agent_fallback")).toHaveLength(1);
    expect(version.strategies).toHaveLength(3);
    expect(version.costCny).toBeCloseTo(usage.estimatedCny * 12);
  });
  it("retains completed proposals and evidence when a semantically invalid second plan falls back", async () => {
    models.plan.mockImplementation(async (request) => ({
      value: { ...plan(request.input.checkpoint), next: "discuss" },
      usage,
    }));
    const before = await drive(
      arena(),
      (current) =>
        current.versions[0].attacks.length === 3 &&
        current.steps.find((step) => step.status === "pending")?.stage === "verify",
    );
    const preserved = structuredClone(before.versions[0].strategies);
    const completed = await drive(before);
    const version = assertCompleted(completed, 1);
    expect(version.strategies).toEqual(preserved);
    expect(version.agent?.plans.map((item) => item.checkpoint)).toEqual([1]);
    expect(version.agent?.stopReason).toContain("规划动作不符合当前检查点");
    expect(completed.events.find((entry) => entry.type === "agent_fallback")?.data).toMatchObject({
      reason: "规划动作不符合当前检查点。",
    });
    expect(completed.steps.find((step) => step.status === "failed")?.error).toContain(
      "规划动作不符合当前检查点",
    );
    expect(version.evidence.some((item) => item.status === "found")).toBe(true);
    expect(models.plan).toHaveBeenCalledTimes(2);
    expect(models.propose).toHaveBeenCalledTimes(3);
    expect(version.revisions).toHaveLength(3);
    expect(models.judge).toHaveBeenCalledTimes(1);
  });
  it("does not fallback after a stopped planner returns a known failure", async () => {
    const snapshot = arena();
    const pending = deferred<{ value: AgentPlan; usage: ModelUsage }>();
    models.plan.mockReturnValueOnce(pending.promise);
    const running = advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    stopArena(snapshot.id, owner, snapshot.activeVersionId);
    pending.resolve({ value: { ...plan(1), next: "judge" }, usage });
    const stopped = await running;
    expect(stopped.versions[0].status).toBe("paused");
    expect(stopped.events.some((entry) => entry.type === "agent_fallback")).toBe(false);
    expect(models.propose).not.toHaveBeenCalled();
  });
  it("requires a newly affordable reservation before a planner repair is sent", async () => {
    models.plan.mockRejectedValueOnce(
      new ModelCallError("Synthetic malformed plan", false, usage, {
        feedback: "summary too long",
        rejectedOutput: "rejected",
      }),
    );
    const created = arena();
    const first = await advanceArena(created.id, owner, created.activeVersionId);
    expect(first.versions[0].status).toBe("ready");
    models.estimate = 100;
    const stopped = await advanceArena(created.id, owner, created.activeVersionId);
    expect(stopped.versions[0]).toMatchObject({
      status: "paused",
      verdict: { outcome: "partial" },
      reservedCny: 0,
    });
    expect(models.plan).toHaveBeenCalledTimes(1);
    expect(modelRequestsUsed(created.activeVersionId)).toBe(1);
  });
  it("runs six attacks across two rounds and reads only the latest revision per role", async () => {
    secondDecision = "second_round";
    const completed = await drive(arena());
    const version = assertCompleted(completed);
    expect(version.attacks.map((item) => item.round)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(new Set(version.attacks.map((item) => item.id)).size).toBe(6);
    expect(version.revisions).toHaveLength(6);
    for (const [input, , attemptId] of models.attack.mock.calls) {
      const action = actionFor(attemptId)!;
      if (action.round === 2)
        expect(input.strategies.every((item: Strategy) => item.firstAction.includes("第1轮"))).toBe(
          true,
        );
      const target = input.strategies.find(
        (item: Strategy) => item.id === roles[(roles.indexOf(input.role) + 1) % 3],
      );
      expect(
        version.attacks.find((item) => item.round === action.round && item.from === input.role)
          ?.targetRevisionHash,
      ).toBe(hashOf(target));
    }
    const judgeInput = models.judge.mock.calls[0][0] as StageInput;
    expect(judgeInput.revisions).toHaveLength(3);
    expect(judgeInput.strategies.every((item) => item.firstAction.includes("第2轮"))).toBe(true);
    expect(version.verdict?.attackFindings.map((item) => item.attackId)).toEqual(
      version.attacks.map((item) => item.id),
    );
    expect(version.evidence.filter((item) => item.estimateScope === "final")).toHaveLength(6);
    expect(modelRequestsUsed(version.id)).toBe(18);
  });
  it("retains a new-round attack with the same wording when the target revision changed", async () => {
    secondDecision = "second_round";
    models.attack.mockImplementation(async (input, _config, attemptId) => ({
      value: { ...attack(input, attemptId), reason: `${input.role}核对该主张的材料依据` },
      usage,
    }));
    const version = assertCompleted(await drive(arena()));
    expect(version.attacks).toHaveLength(6);
    for (const role of roles) {
      const pair = version.attacks.filter((item) => item.from === role);
      expect(pair[0].reason).toBe(pair[1].reason);
      expect(pair[0].targetRevisionHash).not.toBe(pair[1].targetRevisionHash);
      expect(pair.map((item) => item.round)).toEqual([1, 2]);
      expect(
        version.evidence.some((item) => item.attackId === pair[1].id && item.status === "found"),
      ).toBe(true);
    }
  });
  it("rechecks final revised cost and hours even when earlier proposal checks passed", async () => {
    secondDecision = "second_round";
    models.revise.mockImplementation(async (input, _config, attemptId) => {
      const value = revision(input, attemptId);
      if (actionFor(attemptId)!.round === 2 && input.role === "C") {
        value.strategy.estimatedHours = 25;
        value.strategy.costPlan!.items[0].amount = 150;
        value.strategy.estimatedCost = 150;
      }
      return { value, usage };
    });
    models.judge.mockImplementation(async (input) => ({
      value: { ...verdict(input), outcome: "recommendation", preferred: "C" },
      usage,
    }));
    const version = assertCompleted(await drive(arena()));
    expect(version.verdict?.preferred).not.toBe("C");
    expect(version.verdict?.comparisons.find((item) => item.strategyId === "C")?.status).toBe(
      "violates",
    );
    const checks = version.evidence.filter((item) => item.attackId === "constraint-final-C");
    expect(checks.map((item) => item.result)).toEqual([50, 5]);
    expect(
      version.evidence.some((item) => item.attackId === "constraint-C" && item.result === -15),
    ).toBe(true);
  });
  it("bounds pre-proposal research and both rounds of attack requests under one twelve-tool allowance", async () => {
    secondDecision = "second_round";
    models.plan.mockImplementation(async (request) => {
      const value = plan(request.input.checkpoint);
      if (request.input.checkpoint === 1)
        value.tools = Array.from({ length: 6 }, (_, index) => ({
          tool: "search_materials",
          query: `教材导师源码${index}`,
        }));
      return { value, usage };
    });
    models.attack.mockImplementation(async (input, _config, attemptId) => ({
      value: {
        ...attack(input, attemptId),
        requests: [
          {
            tool: "search_materials",
            query: `课程教材${input.role}第${actionFor(attemptId)!.round}轮`,
          },
          {
            tool: "calculate",
            expression: "1+2",
            assumptions: `只核验${input.role}第${actionFor(attemptId)!.round}轮示例运算`,
          },
        ],
      },
      usage,
    }));
    const version = assertCompleted(await drive(arena()));
    expect(version.agent?.toolsUsed).toBe(12);
    expect(version.evidence.some((item) => item.content.includes("达到本版工具调用上限"))).toBe(
      true,
    );
    expect(version.verdict?.attackFindings).toHaveLength(6);
    expect(version.verdict?.attackFindings.every((item) => item.status === "unresolved")).toBe(
      true,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("enforces six external calls across research and later attack requests with synthetic MCP responses", async () => {
    vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
    vi.stubEnv("TAVILY_API_KEY", "synthetic-not-secret");
    vi.stubEnv("ARENA_TOOL_BATCH_ID", "synthetic-runtime-tool-batch");
    externalTool.mockImplementation(async ({ attemptId }) => ({
      attemptId,
      status: "unavailable",
      query: "synthetic query",
      sources: [],
      estimated: true,
    }));
    models.plan.mockImplementation(async (request) => {
      const value = plan(request.input.checkpoint);
      if (request.input.checkpoint === 1)
        value.tools = Array.from({ length: 6 }, (_, index) => ({
          tool: "search_web",
          query: `公开课程教学安排${index}`,
        }));
      return { value, usage };
    });
    models.attack.mockImplementation(async (input, _config, attemptId) => ({
      value: {
        ...attack(input, attemptId),
        requests: [{ tool: "search_web", query: "公开课程试听安排" }],
      },
      usage,
    }));
    const version = assertCompleted(await drive(arena()));
    expect(version.agent?.externalToolsUsed).toBe(6);
    expect(externalTool).toHaveBeenCalledTimes(6);
    expect(version.evidence.some((item) => item.content.includes("达到本版工具调用上限"))).toBe(
      true,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("charges a protocol repair against the same twenty-call ceiling", async () => {
    secondDecision = "supplement";
    thirdDecision = "second_round";
    models.propose.mockImplementationOnce(async () => {
      throw new ModelCallError("Synthetic malformed output", false, usage, {
        feedback: "修正字段",
        rejectedOutput: "{}",
      });
    });
    const completed = await drive(arena());
    const version = assertCompleted(completed, 1);
    expect(modelRequestsUsed(version.id)).toBe(20);
    expect(models.propose).toHaveBeenCalledTimes(4);
    expect(version.agent?.plans).toHaveLength(3);
    expect(version.attacks).toHaveLength(6);
    expect(completed.steps.filter((step) => step.status === "failed")).toHaveLength(1);
    expect(version.costCny).toBeCloseTo(usage.estimatedCny * 20);
  });
  it("counts a planner repair inside the twenty-request two-round allowance", async () => {
    secondDecision = "supplement";
    thirdDecision = "second_round";
    models.plan.mockImplementation(async (request) => {
      if (request.input.checkpoint === 2 && !request.input.repairFeedback)
        throw new ModelCallError("Synthetic plan too long", false, usage, {
          feedback: "summary too long",
          rejectedOutput: "rejected",
        });
      return { value: plan(request.input.checkpoint), usage };
    });
    const completed = await drive(arena());
    const version = assertCompleted(completed, 1);
    expect(modelRequestsUsed(version.id)).toBe(20);
    expect(models.plan).toHaveBeenCalledTimes(4);
    expect(version.agent?.plans).toHaveLength(3);
    expect(version.attacks).toHaveLength(6);
    expect(models.judge).toHaveBeenCalledTimes(1);
    expect(version.costCny).toBeCloseTo(usage.estimatedCny * 20);
  });
  it("does not dispatch the same claimed planner twice during concurrent advance", async () => {
    const snapshot = arena();
    const pending = deferred<{ value: AgentPlan; usage: ModelUsage }>();
    models.plan.mockReturnValueOnce(pending.promise);
    const first = advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    const duplicate = await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    expect(duplicate.steps.filter((step) => step.status === "running")).toHaveLength(1);
    expect(models.plan).toHaveBeenCalledTimes(1);
    pending.resolve({ value: plan(1), usage });
    const finished = await first;
    expect(finished.versions[0].agent?.plans).toHaveLength(1);
    expect(new Set(finished.steps.map((step) => step.id)).size).toBe(finished.steps.length);
  });
  it.each(["stop", "supersede"] as const)(
    "persists cancelled action states when a ready run is ended by %s",
    async (operation) => {
      const created = arena();
      const ready = await advanceArena(created.id, owner, created.activeVersionId);
      expect(ready.steps.some((step) => step.status === "pending")).toBe(true);
      if (operation === "stop") stopArena(ready.id, owner, ready.activeVersionId);
      else newVersion(ready.id, owner, challenge, "Synthetic cancellation of ready graph");
      closeDb();
      const restored = getArena(ready.id, owner);
      const old = restored.versions.find((version) => version.id === ready.activeVersionId)!;
      const steps = restored.steps.filter((step) => step.versionId === old.id);
      expect(old.status).toBe(operation === "stop" ? "paused" : "superseded");
      expect(
        old.agent!.actions.every(
          (action) => action.status === steps.find((step) => step.id === action.id)?.status,
        ),
      ).toBe(true);
      expect(old.agent!.actions.filter((action) => action.status === "skipped")).toHaveLength(
        steps.filter((step) => step.status === "skipped").length,
      );
      expect(old.agent!.actions.some((action) => action.status === "pending")).toBe(false);
    },
  );
  it("persists uncertain action status when a planner lease expires and forbids replay", async () => {
    const created = arena();
    const pending = deferred<{ value: AgentPlan; usage: ModelUsage }>();
    models.plan.mockReturnValueOnce(pending.promise);
    const running = advanceArena(created.id, owner, created.activeVersionId);
    db()
      .prepare("UPDATE steps SET lease_until=? WHERE version_id=? AND status='running'")
      .run(Date.now() - 1, created.activeVersionId);
    const expired = getArena(created.id, owner);
    expect(expired.versions[0].status).toBe("uncertain");
    expect(expired.versions[0].agent!.actions[0].status).toBe("uncertain");
    expect(expired.steps[0].status).toBe("uncertain");
    await advanceArena(created.id, owner, created.activeVersionId);
    expect(models.plan).toHaveBeenCalledTimes(1);
    pending.resolve({ value: plan(1), usage });
    const archived = await running;
    expect(archived.versions[0].status).toBe("paused");
    expect(archived.versions[0].agent?.plans).toHaveLength(0);
    expect(archived.steps.some((step) => step.status === "pending")).toBe(false);
    expect(archived.events.some((entry) => entry.type === "step_uncertain")).toBe(true);
    await advanceArena(created.id, owner, created.activeVersionId);
    expect(models.plan).toHaveBeenCalledTimes(1);
  });
  it("persists skipped action states when a frozen configuration changes before dispatch", async () => {
    const created = arena();
    vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
    const stopped = await advanceArena(created.id, owner, created.activeVersionId);
    expect(stopped.versions[0].status).toBe("failed");
    expect(stopped.versions[0].agent!.actions[0].status).toBe("skipped");
    expect(stopped.steps[0].status).toBe("skipped");
    expect(models.plan).not.toHaveBeenCalled();
    closeDb();
    expect(getArena(created.id, owner).versions[0].agent!.actions[0].status).toBe("skipped");
  });
  it.each(["stop", "supersede"] as const)(
    "archives a late planner after %s without compiling future actions",
    async (operation) => {
      const snapshot = arena();
      const pending = deferred<{ value: AgentPlan; usage: ModelUsage }>();
      models.plan.mockReturnValueOnce(pending.promise);
      const running = advanceArena(snapshot.id, owner, snapshot.activeVersionId);
      if (operation === "stop") stopArena(snapshot.id, owner, snapshot.activeVersionId);
      else newVersion(snapshot.id, owner, challenge, "Synthetic condition update");
      pending.resolve({ value: plan(1), usage });
      await running;
      const old = getVersion(snapshot.activeVersionId);
      expect(old.status).toBe(operation === "stop" ? "paused" : "superseded");
      expect(old.costCny).toBe(usage.estimatedCny);
      expect(
        db()
          .prepare("SELECT count(*) AS count FROM steps WHERE version_id=? AND status='pending'")
          .get(old.id),
      ).toMatchObject({ count: 0 });
      expect(
        db().prepare("SELECT count(*) AS count FROM agent_actions WHERE version_id=?").get(old.id),
      ).toMatchObject({ count: 1 });
    },
  );
  it("settles a late proposal into its original superseded version without contaminating the new run", async () => {
    const snapshot = await drive(
      arena(),
      (current) => current.steps.find((step) => step.status === "pending")?.stage === "propose",
    );
    const pending = deferred<{ value: Strategy; usage: ModelUsage }>();
    models.propose.mockReturnValueOnce(pending.promise);
    const running = advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    const rematch = newVersion(snapshot.id, owner, challenge, "Synthetic updated condition");
    pending.resolve({ value: proposal("A"), usage });
    await running;
    const old = getVersion(snapshot.activeVersionId);
    const active = getVersion(rematch.activeVersionId);
    expect(old.status).toBe("superseded");
    expect(old.strategies).toHaveLength(1);
    expect(old.costCny).toBeCloseTo(usage.estimatedCny * 2);
    expect(active.strategies).toEqual([]);
    expect(active.costCny).toBe(0);
    expect(active.agent?.actions).toHaveLength(1);
    expect(
      db()
        .prepare("SELECT count(*) AS count FROM steps WHERE version_id=? AND status='pending'")
        .get(old.id),
    ).toMatchObject({ count: 0 });
  });
  it("retains an uncertain planner reservation and never silently replays it", async () => {
    models.plan.mockRejectedValueOnce(
      new ModelCallError("Synthetic lost connection", true, undefined, {
        feedback: "do not retry unknown",
        rejectedOutput: "unconfirmed",
      }),
    );
    const snapshot = arena();
    const failed = await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    expect(failed.versions[0]).toMatchObject({
      status: "uncertain",
      reservedCny: models.estimate,
      verdict: { outcome: "partial" },
    });
    closeDb();
    await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    expect(models.plan).toHaveBeenCalledTimes(1);
  });
  it("produces deterministic partial output when its historical arena budget cannot reserve the next model", async () => {
    vi.stubEnv("ARENA_RUN_BUDGET_USD", "0.000001");
    const snapshot = arena();
    const stopped = await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    expect(stopped.versions[0]).toMatchObject({
      status: "paused",
      verdict: { outcome: "partial", preferred: null },
    });
    expect(models.plan).not.toHaveBeenCalled();
    expect(stopped.steps.every((step) => step.status === "skipped")).toBe(true);
  });
  it("does not send a twenty-first model call when synthetic persisted history reaches its cap", async () => {
    const snapshot = arena();
    atomic(() => {
      for (let index = 0; index < AGENT_LIMITS.modelRequests; index++) {
        const stepId = id();
        db()
          .prepare(
            "INSERT INTO steps(id,arena_id,version_id,stage,role,ordinal,status,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            stepId,
            snapshot.id,
            snapshot.activeVersionId,
            "propose",
            `synthetic-history-${index}`,
            -100 + index,
            "completed",
            now(),
            now(),
          );
        db()
          .prepare(
            "INSERT INTO agent_actions(step_id,version_id,kind,role,round,dependencies,payload) VALUES(?,?,?,?,?,?,?)",
          )
          .run(stepId, snapshot.activeVersionId, "propose", "A", 1, "[]", "{}");
      }
    });
    const stopped = await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    expect(stopped.versions[0]).toMatchObject({
      status: "paused",
      verdict: { outcome: "partial" },
    });
    expect(models.plan).not.toHaveBeenCalled();
    expect(modelRequestsUsed(snapshot.activeVersionId)).toBe(20);
  });
  it("keeps the fixed legacy entry path independent of planner exports and calls", async () => {
    const snapshot = createArena(challenge, owner, "deepseek");
    await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    expect(models.propose).toHaveBeenCalledTimes(1);
    expect(models.plan).not.toHaveBeenCalled();
    expect(snapshot.versions[0].executionMode).toBe("fixed");
  });
  it("persists real cumulative previews separately from official proposal state", async () => {
    const snapshot = await drive(
      arena(),
      (current) => current.steps.find((step) => step.status === "pending")?.stage === "propose",
    );
    const pending = deferred<{ value: Strategy; usage: ModelUsage }>();
    models.propose.mockImplementationOnce((_input, _config, _attemptId, preview) => {
      preview({ stage: "propose", field: "title", text: "合成流式草稿" });
      return pending.promise;
    });
    const running = advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const current = getArena(snapshot.id, owner);
    expect(current.versions[0].strategies).toEqual([]);
    expect(current.drafts?.find((draft) => draft.fields.title === "合成流式草稿")?.status).toBe(
      "generating",
    );
    pending.resolve({ value: proposal("A"), usage });
    const finished = await running;
    expect(finished.drafts?.find((draft) => draft.fields.title === "合成流式草稿")?.status).toBe(
      "committed",
    );
  });
  it("persists each successful tool result before a later tool becomes uncertain", async () => {
    vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
    vi.stubEnv("TAVILY_API_KEY", "synthetic-key");
    vi.stubEnv("ARENA_TOOL_BATCH_ID", "synthetic-lifecycle");
    models.attack.mockImplementation(async (input, _config, attemptId) => ({
      value: {
        ...attack(input, attemptId),
        requests:
          input.role === "A"
            ? [{ tool: "search_materials", query: "教材" }]
            : input.role === "B"
              ? [{ tool: "search_web", query: "公开课程材料" }]
              : [],
      },
      usage,
    }));
    externalTool.mockResolvedValue({
      status: "uncertain",
      sources: [],
      error: "Synthetic response lost",
      estimated: true,
    });
    const snapshot = await drive(arena());
    const version = snapshot.versions[0];
    const firstAttack = version.attacks.find((entry) => entry.from === "A")!;
    expect(version.status).toBe("uncertain");
    expect(version.error).toContain("Synthetic response lost");
    expect(
      version.evidence.some(
        (entry) => entry.attackId === firstAttack.id && entry.status === "found",
      ),
    ).toBe(true);
    expect(version.toolReservedUsd).toBeCloseTo(0.008);
    expect(models.judge).not.toHaveBeenCalled();
    await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
    expect(externalTool).toHaveBeenCalledTimes(1);
  });
  it.each(["error", "throw"] as const)(
    "preserves tool failures and stops only unknown %s outcomes",
    async (failure) => {
      vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
      vi.stubEnv("TAVILY_API_KEY", "synthetic-key");
      vi.stubEnv("ARENA_TOOL_BATCH_ID", "synthetic-tool-errors");
      models.attack.mockImplementation(async (input, _config, attemptId) => ({
        value: {
          ...attack(input, attemptId),
          requests: input.role === "A" ? [{ tool: "search_web", query: "公开课程资料" }] : [],
        },
        usage,
      }));
      if (failure === "throw")
        externalTool.mockRejectedValue(new Error("synthetic unexpected interruption"));
      else
        externalTool.mockResolvedValue({
          status: "error",
          sources: [],
          error: "Synthetic HTTP 403",
          estimatedUsd: 0,
        });
      const snapshot = await drive(arena());
      const version = snapshot.versions[0];
      expect(version.strategies).toHaveLength(3);
      expect(version.attacks).toHaveLength(3);
      if (failure === "throw") {
        expect(version.status).toBe("uncertain");
        expect(version.error).toContain("调用结果与费用待确认");
        expect(version.toolReservedUsd).toBeCloseTo(0.008);
        expect(models.judge).not.toHaveBeenCalled();
      } else {
        expect(version.status).toBe("completed");
        expect(version.evidence.find((item) => item.tool === "search_web")).toMatchObject({
          status: "error",
          content: "Synthetic HTTP 403",
        });
        expect(version.toolReservedUsd).toBe(0);
        expect(models.judge).toHaveBeenCalledTimes(1);
      }
      await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
      expect(externalTool).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses external requests before they exceed the arena's shared historical budget", async () => {
    vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
    vi.stubEnv("TAVILY_API_KEY", "synthetic-key");
    vi.stubEnv("ARENA_TOOL_BATCH_ID", "synthetic-local-budget");
    vi.stubEnv("ARENA_RUN_BUDGET_USD", "0.0025");
    models.attack.mockImplementation(async (input, _config, attemptId) => ({
      value: {
        ...attack(input, attemptId),
        requests: [{ tool: "search_web", query: "公开课程材料" }],
      },
      usage,
    }));
    const snapshot = await drive(arena());
    expect(externalTool).not.toHaveBeenCalled();
    expect(snapshot.versions[0].evidence.some((entry) => entry.title === "工具费用额度不足")).toBe(
      true,
    );
    expect(snapshot.versions[0].toolReservedUsd).toBe(0);
    expect(snapshot.versions[0].status).toBe("completed");
    const skipped = snapshot.versions[0].evidence.filter(
      (entry) => entry.title === "工具费用额度不足",
    );
    expect(skipped).toHaveLength(3);
    expect(new Set(skipped.map((entry) => entry.id)).size).toBe(3);
    expect(skipped.map((entry) => entry.attackId).sort()).toEqual(
      snapshot.versions[0].attacks.map((entry) => entry.id).sort(),
    );
  });
  describe("single-action tool deduplication with synthetic MCP results", () => {
    beforeEach(() => {
      vi.stubEnv("ARENA_SEARCH_PROVIDER", "tavily");
      vi.stubEnv("TAVILY_API_KEY", "synthetic-key");
      vi.stubEnv("ARENA_TOOL_BATCH_ID", "synthetic-deduplication");
      models.attack.mockImplementation(async (input, _config, attemptId) => ({
        value: {
          ...attack(input, attemptId),
          requests: input.role === "B" ? [] : [{ tool: "search_web", query: "公开课程试听安排" }],
        },
        usage,
      }));
      externalTool.mockImplementation(async ({ attemptId, request }) => ({
        attemptId,
        status: "found",
        query: request.query,
        sources: [
          {
            id: "W-synthetic-shared-source",
            url: "https://example.com/course",
            title: "合成公开课程材料",
            text: "合成资料仅用于工具去重回归。",
            accessedAt: "2026-11-08T01:00:00.000Z",
            contentHash: hashOf("synthetic shared source"),
            query: request.query,
            trust: "untrusted",
            basis: "assumption",
          },
        ],
        estimated: true,
        estimatedUsd: 0.008,
      }));
    });
    it("executes identical requests once and attributes separate evidence with the same source snapshot to each attack", async () => {
      models.attack.mockImplementation(async (input, _config, attemptId) => ({
        value: {
          ...attack(input, attemptId),
          requests:
            input.role === "B"
              ? []
              : Array.from({ length: input.role === "A" ? 2 : 1 }, () => ({
                  tool: "search_web",
                  query: "公开课程试听安排",
                })),
        },
        usage,
      }));
      const version = assertCompleted(await drive(arena()));
      const shared = version.evidence.filter((item) => item.tool === "search_web");
      expect(externalTool).toHaveBeenCalledTimes(1);
      expect(version.agent).toMatchObject({ toolsUsed: 2, externalToolsUsed: 1 });
      expect(version.toolCostUsd).toBeCloseTo(0.008);
      expect(version.toolReservedUsd).toBe(0);
      expect(shared).toHaveLength(2);
      expect(new Set(shared.map((item) => item.id)).size).toBe(2);
      expect(shared.map((item) => item.attackId).sort()).toEqual(
        version.attacks
          .filter((item) => item.from !== "B")
          .map((item) => item.id)
          .sort(),
      );
      expect(shared[0].references).toEqual(shared[1].references);
      expect(shared[0].references?.[0]).toMatchObject({
        accessedAt: "2026-11-08T01:00:00.000Z",
        contentHash: hashOf("synthetic shared source"),
        url: "https://example.com/course",
      });
      expect(shared[0].sourceIds).toEqual(shared[1].sourceIds);
      expect(shared[0].createdAt).toBe(shared[1].createdAt);
      expect(shared[0].actionId).toBe(shared[1].actionId);
      expect(fetch).not.toHaveBeenCalled();
    });
    it("keeps different exact parameters separate even when queries differ only by whitespace", async () => {
      models.attack.mockImplementation(async (input, _config, attemptId) => ({
        value: {
          ...attack(input, attemptId),
          requests:
            input.role === "B"
              ? []
              : [
                  {
                    tool: "search_web",
                    query: input.role === "A" ? "公开课程试听安排" : "公开课程试听安排 ",
                  },
                ],
        },
        usage,
      }));
      const version = assertCompleted(await drive(arena()));
      expect(externalTool).toHaveBeenCalledTimes(2);
      expect(externalTool.mock.calls.map(([input]) => input.request.query)).toEqual([
        "公开课程试听安排",
        "公开课程试听安排 ",
      ]);
      expect(version.agent).toMatchObject({ toolsUsed: 3, externalToolsUsed: 2 });
      expect(version.toolCostUsd).toBeCloseTo(0.016);
    });
    it("reuses a known failed result without automatically sending the same paid request again", async () => {
      externalTool.mockImplementation(async ({ attemptId, request }) => ({
        attemptId,
        query: request.query,
        status: "error",
        sources: [],
        error: "Synthetic confirmed tool failure",
        estimated: true,
        estimatedUsd: 0.004,
      }));
      const snapshot = await drive(arena());
      const version = assertCompleted(snapshot);
      const failed = version.evidence.filter((item) => item.tool === "search_web");
      expect(failed).toHaveLength(2);
      expect(failed.every((item) => item.status === "error")).toBe(true);
      expect(new Set(failed.map((item) => item.id)).size).toBe(2);
      expect(version.toolCostUsd).toBeCloseTo(0.004);
      expect(version.toolReservedUsd).toBe(0);
      expect(version.agent).toMatchObject({ toolsUsed: 2, externalToolsUsed: 1 });
      await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
      expect(externalTool).toHaveBeenCalledTimes(1);
    });
    it("persists shared successful evidence before a distinct uncertain request and retains only one uncertain reservation", async () => {
      const found = externalTool.getMockImplementation()!;
      externalTool.mockImplementation(async (input) =>
        input.request.query === "结果待确认的合成查询"
          ? { status: "uncertain", sources: [], error: "Synthetic response lost", estimated: true }
          : found(input),
      );
      models.attack.mockImplementation(async (input, _config, attemptId) => ({
        value: {
          ...attack(input, attemptId),
          requests: [
            {
              tool: "search_web",
              query: input.role === "B" ? "结果待确认的合成查询" : "公开课程试听安排",
            },
          ],
        },
        usage,
      }));
      const snapshot = await drive(arena());
      const version = snapshot.versions[0];
      const shared = version.evidence.filter((item) => item.tool === "search_web");
      expect(version.status).toBe("uncertain");
      expect(shared).toHaveLength(2);
      expect(shared.every((item) => item.status === "found")).toBe(true);
      expect(shared.map((item) => item.attackId).sort()).toEqual(
        version.attacks
          .filter((item) => item.from !== "B")
          .map((item) => item.id)
          .sort(),
      );
      expect(version.agent).toMatchObject({ toolsUsed: 3, externalToolsUsed: 2 });
      expect(version.toolCostUsd).toBeCloseTo(0.008);
      expect(version.toolReservedUsd).toBeCloseTo(0.008);
      expect(models.judge).not.toHaveBeenCalled();
      await advanceArena(snapshot.id, owner, snapshot.activeVersionId);
      expect(externalTool).toHaveBeenCalledTimes(2);
    });
    it("performs the same request anew in a later action and in a new version", async () => {
      secondDecision = "second_round";
      const first = await drive(arena());
      const version = assertCompleted(first);
      expect(externalTool).toHaveBeenCalledTimes(2);
      expect(version.agent).toMatchObject({ toolsUsed: 3, externalToolsUsed: 2 });
      expect(
        new Set(
          version.evidence
            .filter((item) => item.tool === "search_web")
            .map((item) => item.actionId),
        ).size,
      ).toBe(2);
      const second = await drive(
        newVersion(first.id, owner, challenge, "合成条件重赛，重新核验来源"),
      );
      const latest = second.versions.find((item) => item.id === second.activeVersionId)!;
      expect(latest.status).toBe("completed");
      expect(externalTool).toHaveBeenCalledTimes(4);
      expect(latest.toolCostUsd).toBeCloseTo(0.016);
      expect(latest.agent).toMatchObject({ toolsUsed: 3, externalToolsUsed: 2 });
    });
  });
  it("reports a missing frozen corpus as a persistence failure instead of an empty search", async () => {
    const created = arena();
    db().prepare("DELETE FROM version_corpora WHERE version_id=?").run(created.activeVersionId);
    const snapshot = await drive(created);
    expect(snapshot.versions[0].status).toBe("failed");
    expect(snapshot.versions[0].error).toContain("材料快照缺失");
    expect(snapshot.versions[0].evidence).toEqual([]);
    expect(models.propose).not.toHaveBeenCalled();
  });
});
