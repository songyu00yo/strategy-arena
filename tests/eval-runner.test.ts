/** Explicit mock model adapter tests. No real API calls or evaluation scores. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  EVALUATION_MODES,
  exportBlinded,
  ledger,
  runTrajectory,
  type EvaluationAdapter,
  type EvaluationCase,
  type EvaluationMode,
  type EvaluationStage,
  type TrajectoryResult,
} from "../scripts/run-evals";
import { ModelCallError } from "../src/lib/server/model";
import {
  ChallengeSchema,
  type Attack,
  type ModelUsage,
  type Revision,
  type StageInput,
  type Strategy,
  type Verdict,
} from "../src/lib/contracts";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const initial = ChallengeSchema.parse({
  goal: "合成测试任务：在十小时内整理资料并制作一份报告。",
  constraints: "不上传私人材料。",
  budget: 10,
  timeHours: 10,
  materials: "合成测试材料：准备 2 小时，制作 3 小时。",
});
const item: EvaluationCase = {
  id: "synthetic-test-case",
  partition: "development",
  initial,
  changed: { ...initial, budget: 5, timeHours: 6 },
  changeReason: "合成条件变化：减少预算和可用时间。",
  positiveChecks: ["调整方案。"],
  negativeChecks: ["不得忽略预算。"],
};
const usage: ModelUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  estimatedCny: 0.01,
  model: "explicit-mock-adapter",
  responseId: "fixture-response",
  durationMs: 1,
};
function output(
  stage: EvaluationStage,
  input: StageInput,
  mode: EvaluationMode,
): Strategy | Attack | Revision | Verdict {
  const role = input.role as "A" | "B" | "C";
  if (stage === "propose")
    return {
      id: role,
      title: `合成路线${role}`,
      thesis: "仅供测试。",
      steps: [`采取路线${role}的测试行动。`],
      claims: [
        {
          id: `${role}-raw-id`,
          text: `路线${role}测试时长为四小时。`,
          status: "estimate",
          sourceIds: [],
        },
      ],
      resources: `路线${role}资源`,
      firstAction: `开始路线${role}。`,
      failureCondition: "超过限制就停止。",
      estimatedCost: 5,
      estimatedHours: 4,
    };
  if (stage === "attack") {
    const target =
      mode === "arena"
        ? input.strategies.find((strategy) => strategy.id !== role)!
        : input.strategies.find((strategy) => strategy.id === role)!;
    return {
      id: "raw-attack-id",
      from: role,
      targetStrategyId: target.id,
      targetClaimId: target.claims[0].id,
      claimQuote: target.claims[0].text,
      reason: "测试：重新核算总时间。",
      impact: "时间可能影响方案。",
      verification: "计算 2+3。",
      requests: [{ tool: "calculate", expression: "2+3", assumptions: "仅为合成测试数字。" }],
      status: "pending",
    };
  }
  if (stage === "revise") {
    const strategy = input.strategies.find((strategy) => strategy.id === role)!;
    return {
      strategyId: role,
      strategy: { ...strategy, firstAction: `调整后的路线${role}行动。` },
      responses: input.attacks
        .filter((attack) => attack.targetStrategyId === role)
        .map((attack) => ({
          attackId: attack.id,
          decision: "accept",
          reason: "合成计算支持调整。",
          evidenceIds: input.evidence
            .filter((evidence) => evidence.attackId === attack.id)
            .map((evidence) => evidence.id),
          change: "更改第一步。",
        })),
      summary: "合成修订。",
      changed: true,
    };
  }
  return {
    outcome: "recommendation",
    preferred: "A",
    headline: "合成测试裁决",
    rationale: "不是真实模型结论。",
    conditions: ["先验证假设。"],
    uncertainties: ["实际时长未测。"],
    nextActions: ["开始小步验证。"],
    exitCondition: "超时则停止。",
    evidenceIds: input.evidence.map((evidence) => evidence.id),
    comparisons: input.strategies.map((strategy) => ({
      strategyId: strategy.id,
      status: "unknown",
      reason: "文字约束未完全验证。",
    })),
    attackFindings: input.attacks.map((attack) => ({
      attackId: attack.id,
      status: "supported",
      reason: "测试计算。",
      evidenceIds: input.evidence
        .filter((evidence) => evidence.attackId === attack.id)
        .map((evidence) => evidence.id),
    })),
  };
}
function adapter() {
  const calls: { stage: EvaluationStage; input: StageInput; mode: EvaluationMode }[] = [];
  const value: EvaluationAdapter = {
    estimateCost: () => 0.05,
    estimateTokens: () => 100,
    generate: async (stage, input, mode) => {
      calls.push({ stage, input: structuredClone(input), mode });
      return { value: output(stage, input, mode), usage };
    },
  };
  return { value, calls };
}
async function run(mode: EvaluationMode, dependency = adapter().value, cap = 1.5) {
  const events: Record<string, unknown>[] = [];
  const global = ledger({ maxCny: 20, maxTokens: 1_000_000, maxToolCalls: 100 });
  const result = await runTrajectory({
    item,
    mode,
    adapter: dependency,
    global,
    caps: { maxCny: cap, maxTokens: 250_000, maxToolCalls: 12 },
    checkpoint: (event) => events.push(event),
  });
  return { result, global, events };
}
describe("explicit mock adapter evaluation orchestration", () => {
  it.each(EVALUATION_MODES)(
    "keeps fixed stages, real tools and information boundaries for %s",
    async (mode) => {
      const fixture = adapter();
      const { result } = await run(mode, fixture.value);
      expect(result.status).toBe("completed");
      expect(result.conditions).toHaveLength(2);
      expect(fixture.calls).toHaveLength(20);
      expect(result.accounting.toolCalls).toBe(6);
      expect(result.accounting.spentCny).toBeCloseTo(0.2);
      expect(result.conditions[0].strategies[0].claims[0].id).toBe("A-claim-1");
      expect(
        result.conditions[0].evidence.some(
          (evidence) => evidence.tool === "calculate" && evidence.result === 5,
        ),
      ).toBe(true);
      const secondProposal = fixture.calls[1].input;
      expect(secondProposal.strategies).toHaveLength(mode === "strong-single" ? 1 : 0);
      expect(secondProposal.contextHistory?.length ?? 0).toBe(mode === "strong-single" ? 1 : 0);
      const critique = fixture.calls[3].input;
      expect(critique.strategies).toHaveLength(mode === "independent" ? 1 : 3);
      if (mode === "independent") {
        expect(critique.strategies[0].id).toBe("A");
        const revision = fixture.calls[6].input;
        expect(revision.strategies.every((strategy) => strategy.id === "A")).toBe(true);
        expect(
          revision.evidence.every(
            (evidence) => evidence.attackId === "attack-A" || evidence.attackId === "constraint-A",
          ),
        ).toBe(true);
      }
      expect(fixture.calls[9].input.strategies).toHaveLength(3);
      expect(fixture.calls[10].input.previousStrategy?.firstAction).toBe("调整后的路线A行动。");
      expect(fixture.calls[10].input.userChallenges[0]).toContain(item.changeReason);
    },
  );
  it("refuses before the call when the upper-bound reservation does not fit", async () => {
    const fixture = adapter();
    const { result } = await run("arena", fixture.value, 0.04);
    expect(fixture.calls).toHaveLength(0);
    expect(result.status).toBe("budget_exhausted");
    expect(result.conditions.map((condition) => condition.status)).toEqual([
      "budget_exhausted",
      "skipped",
    ]);
    expect(result.accounting.heldCny).toBe(0);
  });
  it("enforces the command cap even when the trajectory has money left", async () => {
    const fixture = adapter();
    const result = await runTrajectory({
      item,
      mode: "arena",
      adapter: fixture.value,
      global: ledger({ maxCny: 0.04, maxTokens: 1_000_000, maxToolCalls: 100 }),
      checkpoint: () => {},
    });
    expect(fixture.calls).toHaveLength(0);
    expect(result.status).toBe("budget_exhausted");
  });
  it("checks conservative Token reservations before making a paid call", async () => {
    const fixture = adapter();
    fixture.value.estimateTokens = () => 250_001;
    const { result } = await run("arena", fixture.value);
    expect(fixture.calls).toHaveLength(0);
    expect(result.status).toBe("budget_exhausted");
  });
  it("shares the trajectory cap across initial and changed conditions", async () => {
    const fixture = adapter();
    const { result } = await run("arena", fixture.value, 0.15);
    expect(result.conditions[0].status).toBe("completed");
    expect(result.conditions[1].status).toBe("budget_exhausted");
    expect(result.accounting.spentCny).toBeLessThanOrEqual(0.15);
    expect(fixture.calls.length).toBeGreaterThan(10);
    expect(fixture.calls.length).toBeLessThan(20);
  });
  it("retains unknown reservations, records the failure, and never retries it", async () => {
    let calls = 0;
    const fixture = adapter().value;
    fixture.generate = async () => {
      calls++;
      throw new ModelCallError("synthetic unknown completion", true);
    };
    const { result, global, events } = await run("arena", fixture);
    expect(calls).toBe(1);
    expect(result.status).toBe("uncertain");
    expect(result.accounting.heldCny).toBeCloseTo(0.05);
    expect(global.heldCny).toBeCloseTo(0.05);
    expect(result.accounting.heldTokens).toBe(100);
    expect(result.conditions[1].status).toBe("skipped");
    expect(events.some((event) => event.type === "call_started")).toBe(true);
    expect(
      events.some((event) => event.type === "call_failed" && event.heldReservation === true),
    ).toBe(true);
  });
  it("charges a rejected response and permits exactly one explicit repair", async () => {
    const fixture = adapter();
    const original = fixture.value.generate;
    let calls = 0;
    fixture.value.generate = async (stage, input, mode) => {
      calls++;
      if (calls === 1)
        throw new ModelCallError("synthetic invalid JSON", false, usage, {
          feedback: "Return JSON.",
          rejectedOutput: "synthetic rejected response",
        });
      return original(stage, input, mode);
    };
    const { result, events } = await run("strong-single", fixture.value);
    expect(result.status).toBe("completed");
    expect(calls).toBe(21);
    expect(result.accounting.spentCny).toBeCloseTo(0.21);
    expect(result.attempts[0].usage).toEqual(usage);
    expect(result.attempts[0].rejectedOutput).toBe("synthetic rejected response");
    expect(fixture.calls[0].input.repairFeedback).toBe("Return JSON.");
    expect(events.filter((event) => event.type === "format_repair_scheduled")).toHaveLength(1);
    fixture.value.generate = async () => {
      throw new ModelCallError("synthetic still invalid", false, usage, {
        feedback: "Invalid again.",
        rejectedOutput: "synthetic",
      });
    };
    const failure = await run("arena", fixture.value);
    expect(failure.result.attempts).toHaveLength(2);
    expect(failure.result.status).toBe("failed");
    expect(failure.result.accounting.spentCny).toBeCloseTo(0.02);
  });
  it("rejects tool requests above the shared cap before executing them", async () => {
    const fixture = adapter();
    const result = await runTrajectory({
      item,
      mode: "arena",
      adapter: fixture.value,
      global: ledger({ maxCny: 20, maxTokens: 1_000_000, maxToolCalls: 100 }),
      caps: { maxCny: 1.5, maxTokens: 250_000, maxToolCalls: 2 },
      checkpoint: () => {},
    });
    expect(result.status).toBe("budget_exhausted");
    expect(result.conditions[0].failedStage).toBe("verify");
    expect(result.conditions[0].evidence).toHaveLength(0);
    expect(result.accounting.toolCalls).toBe(0);
  });
  it("exports paired blinded cards without arm identity, usage, history or quality scores", async () => {
    const results: TrajectoryResult[] = [];
    for (const mode of EVALUATION_MODES) results.push((await run(mode)).result);
    const directory = mkdtempSync(resolve(tmpdir(), "arena-blind-fixture-"));
    directories.push(directory);
    exportBlinded(results, [item], directory);
    const names = readdirSync(resolve(directory, "blind")).filter(
      (name) => name !== "scorecards.json",
    );
    expect(names).toHaveLength(3);
    const card = JSON.parse(readFileSync(resolve(directory, "blind", names[0]), "utf8"));
    expect(card.conditions).toHaveLength(2);
    expect(card.arm).toBeUndefined();
    expect(card.accounting).toBeUndefined();
    expect(card.attempts).toBeUndefined();
    const scorecards = JSON.parse(
      readFileSync(resolve(directory, "blind", "scorecards.json"), "utf8"),
    );
    expect(scorecards.records).toHaveLength(6);
    expect(scorecards.records[0].scores.actionability).toBeNull();
    const mapping = JSON.parse(
      readFileSync(resolve(directory, "private", "blind-mapping.json"), "utf8"),
    );
    expect(new Set(mapping.cards.map((record: { arm: string }) => record.arm))).toEqual(
      new Set(EVALUATION_MODES),
    );
  });
});
