import { describe, expect, it } from "vitest";
import { ChallengeSchema, type StageInput, type Verdict } from "../src/lib/contracts";
import { assertExplicitArithmetic, validateVerdict } from "../src/lib/server/tools";

const verdict = (): Verdict => ({
  outcome: "insufficient",
  preferred: null,
  headline: "费用仍需核实",
  rationale: "先核实完整报价",
  comparisons: [],
  attackFindings: [],
  conditions: [],
  uncertainties: [],
  nextActions: ["询价"],
  exitCondition: "完整报价未确认前不购买",
  evidenceIds: [],
});
const input: StageInput = {
  challenge: ChallengeSchema.parse({ goal: "比较日常通勤交通方案" }),
  role: "judge",
  strategies: [],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
};

describe("bounded arithmetic checks on explicit verdict statements", () => {
  it.each([
    "新车裸价900元已超650元预算150元",
    "900元超过650元上限150元",
    "900元超出预算650元，差额为150元",
    "报价900.5元高出限额650.25元150.25元",
  ])("rejects the recorded wrong gap without changing its operands: %s", (text) => {
    expect(() => assertExplicitArithmetic(text)).toThrow(/正确计算结果为 250(?:\.25)?/);
    expect(() => assertExplicitArithmetic(text)).toThrow(/同一口径/);
  });
  it.each([
    "新车裸价900元已超650元预算250元",
    "900元超过650元上限250元",
    "900元超出预算650元，差额为250元",
    "报价900.5元高出限额650.25元250.25元",
  ])("accepts explicitly correct money gaps: %s", (text) => {
    expect(() => assertExplicitArithmetic(text)).not.toThrow();
  });
  it.each([
    ["总计1+4+2+3=12小时", "10"],
    ["预算900-650=150元", "250"],
    ["0.1+0.2=0.4", "0.3"],
    ["(2+3)*4/2=11", "10"],
    ["2×3÷4=2", "1.5"],
    ["先核实；1+1=2，另一处4-1=2", "3"],
  ])("rejects an incorrect explicit numeric equation: %s", (text, correct) => {
    expect(() => assertExplicitArithmetic(text)).toThrow(`正确计算结果为 ${correct}`);
  });
  it.each([
    "1+4+2+3=10",
    "0.1+0.2=0.3",
    "(2+3)*4/2=10",
    "-2+1=-1",
    ".5*2=1",
    "0.1+0.2=0.300000001",
    "900-650=250元；差额仍为250元",
    "金额待核验，可能超出预算，尚不知道实际差额。",
    "预算650元，预计超出150元；裸价待询问。",
    "2026-11-06到2026-11-09；报价900-1200元，工时1-4小时。",
    "日期2026-11-06=待定",
    "日期2026-11-06=12",
    "报价900-1200元已超650元预算250元",
    "原文声称“900元超过650元上限150元”，尚待核验。",
    '材料写着"1+1=3"，此处仅引用原文。',
    "Math.max(1,2)+1=4",
    "amount+1+2=4",
    "1e3+1=1002",
    "2^3+1=10",
    "1,000+2=1003",
    "1,900元超过650元上限1250元",
    "1/0=0",
    "1**2=4",
  ])("does not infer unsupported or ambiguous claims: %s", (text) => {
    expect(() => assertExplicitArithmetic(text)).not.toThrow();
  });

  it("checks every requested verdict-owned field before server rewriting and preserves rejected output", () => {
    const bad = "900元超过650元上限150元";
    const cases: Verdict[] = [
      { ...verdict(), headline: bad },
      { ...verdict(), rationale: bad },
      { ...verdict(), comparisons: [{ strategyId: "A", status: "unknown", reason: bad }] },
      { ...verdict(), nextActions: [bad] },
      { ...verdict(), conditions: [bad] },
      { ...verdict(), exitCondition: bad },
    ];
    for (const candidate of cases) {
      const before = structuredClone(candidate);
      expect(() => validateVerdict(candidate, input)).toThrow(/正确计算结果为 250/);
      expect(candidate).toEqual(before);
    }
  });
  it("does not validate quoted attack text or introduce an unrequested general fact checker", () => {
    const withQuote: StageInput = {
      ...input,
      attacks: [
        {
          id: "attack-A",
          from: "A",
          targetStrategyId: "B",
          targetClaimId: "B-1",
          claimQuote: "900元超过650元上限150元；1+1=3",
          reason: "原文报价待核实",
          impact: "可能不适合",
          verification: "查报价",
          requests: [],
          status: "pending",
        },
      ],
    };
    expect(() => validateVerdict(verdict(), withQuote)).not.toThrow();
    expect(() =>
      assertExplicitArithmetic("出租车通常更舒适；未给报价，不计算差额。"),
    ).not.toThrow();
  });
});
