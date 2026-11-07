import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  type Revision,
  type StageInput,
  type Strategy,
  type Verdict,
} from "../src/lib/contracts";
import {
  assertStrategyArithmetic,
  validateRevision,
  validateVerdict,
} from "../src/lib/server/tools";

const strategy = (overrides: Partial<Strategy> = {}): Strategy => ({
  id: "A",
  title: "合成测试路线",
  thesis: "先验证，再实施",
  steps: ["先核实当前条件"],
  resources: "使用现有资源，具体数量待确认",
  firstAction: "做可撤回的小样",
  failureCondition: "条件未满足则暂停",
  claims: [{ id: "A-1", text: "完成时间未知", status: "unknown", sourceIds: [] }],
  estimatedCost: 20,
  estimatedHours: 2,
  ...overrides,
});

function input(route = strategy()): StageInput {
  return {
    challenge: ChallengeSchema.parse({ goal: "比较合成测试行动路线", budget: 100, timeHours: 10 }),
    role: "judge",
    strategies: [route, strategy({ id: "B", title: "另一条测试路线" })],
    attacks: [],
    evidence: [],
    revisions: [],
    userChallenges: [],
  };
}

function verdict(comparisons: Verdict["comparisons"] = []): Verdict {
  return {
    outcome: "recommendation",
    preferred: "A",
    headline: "按假设有条件试行路线A",
    rationale: "这是合成回归测试，不代表真实模型验收",
    comparisons,
    attackFindings: [],
    conditions: ["先核实资源条件再实施"],
    uncertainties: ["实际投入尚未测量"],
    nextActions: ["先做低成本、可撤回的验证"],
    exitCondition: "核实发现超限则停止",
    evidenceIds: [],
  };
}

describe("resource uncertainty keeps route-specific explanations", () => {
  it("retains a specific career-route limitation when estimates are unknown", () => {
    const reason = "远程已被书面拒绝，本路线退出；不能作为当前可用选项。";
    const candidate = verdict([{ strategyId: "A", status: "unknown", reason }]);
    candidate.preferred = "B";
    const checked = validateVerdict(
      candidate,
      input(strategy({ estimatedCost: null, estimatedHours: null })),
    );
    expect(checked.comparisons[0]).toEqual({
      strategyId: "A",
      status: "unknown",
      reason: `${reason} 缺少完整支出估算，尚不能确认满足预算上限。 缺少全程工时估算，尚不能确认满足总工时上限。`,
    });
  });

  it.each([
    [null, 2, "缺少完整支出估算", "缺少全程工时估算"],
    [20, null, "缺少全程工时估算", "缺少完整支出估算"],
  ] as const)("describes only the missing resource (%s, %s)", (cost, hours, included, excluded) => {
    const checked = validateVerdict(
      verdict(),
      input(strategy({ estimatedCost: cost, estimatedHours: hours })),
    );
    expect(checked.comparisons[0].status).toBe("unknown");
    expect(checked.comparisons[0].reason).toContain(included);
    expect(checked.comparisons[0].reason).not.toContain(excluded);
  });

  it("does not append the same explanation twice", () => {
    const task = input(strategy({ estimatedCost: null, estimatedHours: null }));
    const first = validateVerdict(
      verdict([{ strategyId: "A", status: "unknown", reason: "留任收入较低，照护安排待核实。" }]),
      task,
    );
    expect(validateVerdict(first, task).comparisons).toEqual(first.comparisons);
  });

  it("keeps an identified hard conflict ahead of unknown estimates", () => {
    const conflict = {
      strategyId: "A" as const,
      status: "violates" as const,
      reason: "对方已明确拒绝远程，本路线当前不可用。",
    };
    const checked = validateVerdict(
      verdict([conflict]),
      input(strategy({ estimatedCost: null, estimatedHours: null })),
    );
    expect(checked.comparisons[0]).toEqual(conflict);
    expect(checked.preferred).toBeNull();
  });

  it("does not let a missing resource mask a separate numeric conflict", () => {
    const checked = validateVerdict(
      verdict([{ strategyId: "A", status: "unknown", reason: "费用未估算。" }]),
      input(strategy({ estimatedCost: null, estimatedHours: 11 })),
    );
    expect(checked.comparisons[0].status).toBe("violates");
    expect(checked.preferred).toBeNull();
  });

  it("keeps a conditional recommendation without tool evidence or complete estimates", () => {
    const checked = validateVerdict(
      verdict([
        { strategyId: "A", status: "eligible", reason: "先做可撤回验证，之后按实测决定。" },
      ]),
      input(strategy({ estimatedCost: null, estimatedHours: null })),
    );
    expect(checked).toMatchObject({ outcome: "recommendation", preferred: "A" });
    expect(checked.comparisons[0].status).toBe("unknown");
    expect(checked.comparisons[0].reason).toContain("先做可撤回验证");
    expect(checked.conditions.join(" ")).toContain("尚无有效工具证据");
  });

  it("does not invent a missing upper limit when that resource is unspecified", () => {
    const task = input(strategy({ estimatedCost: null, estimatedHours: null }));
    task.challenge.budget = null;
    task.challenge.timeHours = null;
    const reason = "照护安排尚待核实。";
    expect(
      validateVerdict(verdict([{ strategyId: "A", status: "unknown", reason }]), task)
        .comparisons[0].reason,
    ).toBe(reason);
  });
});

describe("bounded arithmetic in strategy-owned fields", () => {
  const ownFields = ["thesis", "resources", "firstAction", "failureCondition"] as const;

  it.each(ownFields)("rejects explicit incorrect arithmetic in %s", (field) => {
    const candidate = strategy({ [field]: "总计1+2=4小时" });
    expect(() => assertStrategyArithmetic(candidate)).toThrow("正确计算结果为 3");
  });

  it("checks every step and leaves the rejected strategy unchanged", () => {
    const candidate = strategy({ steps: ["先核实资源", "总计1+2=4小时"] });
    const before = structuredClone(candidate);
    expect(() => assertStrategyArithmetic(candidate)).toThrow("正确计算结果为 3");
    expect(candidate).toEqual(before);
  });

  it("accepts correct explicit equations with unknown full-stage estimates", () => {
    expect(() =>
      assertStrategyArithmetic(
        strategy({
          thesis: "验证窗口1+2=3小时；完整实施仍待估算。",
          steps: ["准备0.5+0.5=1小时", "执行2×3=6小时"],
          resources: "当前情景费用900-650=250元",
          firstAction: "小样0.5+0.5=1小时",
          failureCondition: "若阶段投入1+2=3小时仍不满足条件则暂停",
          estimatedCost: null,
          estimatedHours: null,
        }),
      ),
    ).not.toThrow();
  });

  it("does not inspect claim quotations or quoted original text", () => {
    expect(() =>
      assertStrategyArithmetic(
        strategy({
          thesis: "材料原文“1+2=4”，此处只引用，不确认其正确。",
          steps: ['原文写着"900-650=150"，先核实该原文。'],
          resources: "原文‘2+2=5’，不作为资源估算。",
          firstAction: "核查「1+1=3」的原始口径",
          failureCondition: "记录『3+3=7』原话并核查",
          claims: [{ id: "A-1", text: "1+1=3", status: "unknown", sourceIds: [] }],
        }),
      ),
    ).not.toThrow();
  });

  it("does not sum ambiguous natural-language steps or infer complete project duration", () => {
    expect(() =>
      assertStrategyArithmetic(
        strategy({
          steps: ["小样可能用2小时", "另用3小时或复用已有工作", "剩余时间实施并检查"],
          failureCondition: "若累计超过验证窗口则暂停，完整投入未知",
          estimatedCost: null,
          estimatedHours: null,
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    "解释为什么1+1=3不成立",
    "判断1+1=3是否正确",
    "纠正示例1+2=4",
    "2小时内解释为什么1+1=3不成立",
    "纠正示例总计1+2=4小时",
    "总计1+2=4小时是否成立？",
  ])("does not reject an educational task discussing an incorrect equation: %s", (text) => {
    expect(() => assertStrategyArithmetic(strategy({ steps: [text] }))).not.toThrow();
  });

  it("applies the same explicit arithmetic check to revision validation", () => {
    const task = input();
    task.role = "A";
    const revision: Revision = {
      strategyId: "A",
      strategy: strategy({ steps: ["总计1+2=4小时"] }),
      responses: [],
      summary: "合成修订检查",
      changed: true,
    };
    expect(() => validateRevision(revision, task)).toThrow("正确计算结果为 3");
    revision.strategy.steps = ["验证总计1+2=3小时，完整实施仍未知"];
    revision.strategy.estimatedHours = null;
    expect(() => validateRevision(revision, task)).not.toThrow();
  });
});
