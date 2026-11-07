/** Synthetic and recorded-sentence regression only. No provider or real execution. */
import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  StrategySchema,
  type StageInput,
  type Verdict,
} from "../src/lib/contracts";
import {
  assertNoCircularPreconditions,
  assertStrategyArithmetic,
  validateRevision,
  validateVerdict,
} from "../src/lib/server/tools";

const strategy = StrategySchema.parse({
  id: "A",
  title: "合成测试路线",
  thesis: "先核实前置检查，再决定执行",
  steps: ["执行前检查通过后才实施，实施后验收"],
  claims: [{ id: "A1", text: "安全条件仍需核实", status: "unknown", sourceIds: [] }],
  resources: "已有设备",
  firstAction: "核实允许的诊断费用",
  failureCondition: "检查未通过则不正式执行",
});
const input: StageInput = {
  challenge: ChallengeSchema.parse({ goal: "检查合成测试执行顺序" }),
  role: "A",
  strategies: [strategy],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
};
const verdict = (): Verdict => ({
  outcome: "insufficient",
  preferred: null,
  headline: "先核实前置检查",
  rationale: "条件仍未知",
  conditions: [],
  uncertainties: [],
  nextActions: ["核实诊断费上限"],
  exitCondition: "前置检查未通过则不正式执行",
  evidenceIds: [],
  comparisons: [],
  attackFindings: [],
});
const bad = "维修后安全复检达标时才执行维修";

describe("bounded explicit circular execution prerequisites", () => {
  it.each([
    bad,
    "A 仅在书面封顶合计（检测费+维修费+配件+锁具+缓冲）≤1000元且维修后安全复检达标时才执行维修；任一关键金额未知即不付款。",
    "制作完成后验收通过才能开始制作。",
    "购买后检查合格方可购买。",
    "安装之后检测通过才允许安装。",
    "编制计划完成后审核验收合格才执行编制计划。",
  ])("rejects an explicitly repeated first action after its own post-check: %s", (text) => {
    expect(() => assertNoCircularPreconditions(text)).toThrow("执行前置条件存在循环");
  });

  it.each([
    "维修前安全检查通过才维修；维修后复检达标再通勤。",
    "先在用户允许的封顶额度内支付诊断费取得结论，无论通过与否都计入已花；通过前不付正式维修费。",
    "制作前检查授权，制作后验收通过才交付。",
    "维修后复检不合格才再次维修。",
    "维修后未通过检测才执行维修。",
    "维修后复检达标才执行维修下一辆车。",
    "材料原文“维修后安全复检达标时才执行维修”，需要核实顺序。",
    '原文写着"制作后验收合格才开始制作"，此处只记录问题。',
    "不得要求维修后安全复检达标时才执行维修。",
    "不能写成制作完成后验收通过才能开始制作。",
    "解释维修后复检达标才执行维修这个错误句。",
    "维修后复检达标才执行维修是否存在循环？",
    "维修后安全复检达标，才支付已经约定的维修尾款。",
  ])(
    "does not reinterpret proper sequences, rework, quotes, negations or discussion: %s",
    (text) => {
      expect(() => assertNoCircularPreconditions(text)).not.toThrow();
    },
  );

  it("does not let an unrelated earlier negation hide a positive circular gate", () => {
    expect(() => assertNoCircularPreconditions(`不能免检，${bad}`)).toThrow("循环");
  });

  it("checks each strategy-owned execution field and the normal revision entry point", () => {
    for (const field of ["thesis", "resources", "firstAction", "failureCondition"] as const)
      expect(() => assertStrategyArithmetic({ ...strategy, [field]: bad })).toThrow("循环");
    expect(() => assertStrategyArithmetic({ ...strategy, steps: ["先询问费用", bad] })).toThrow(
      "循环",
    );
    expect(() =>
      validateRevision(
        {
          strategyId: "A",
          strategy: { ...strategy, steps: [bad] },
          responses: [],
          summary: "合成回归",
          changed: true,
        },
        input,
      ),
    ).toThrow("循环");
  });

  it("checks the verdict fields including the recorded conditions failure before rewriting", () => {
    for (const field of ["headline", "rationale", "exitCondition"] as const)
      expect(() => validateVerdict({ ...verdict(), [field]: bad }, input)).toThrow("循环");
    for (const field of ["conditions", "nextActions"] as const)
      expect(() => validateVerdict({ ...verdict(), [field]: [bad] }, input)).toThrow("循环");
    expect(() =>
      validateVerdict(
        { ...verdict(), comparisons: [{ strategyId: "A", status: "unknown", reason: bad }] },
        input,
      ),
    ).toThrow("循环");
  });
});
