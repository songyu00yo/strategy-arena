/** Synthetic regression data only. No model, provider, live ledger or factual quotes. */
import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  GeneratedRevisionSchema,
  GeneratedStrategySchema,
  GeneratedVerdictSchema,
  StrategySchema,
  VerdictSchema,
  type CostPlan,
  type StageInput,
  type Strategy,
  type Verdict,
} from "../src/lib/contracts";
import { costPlanTotal, normalizeCostPlan } from "../src/lib/server/resource-totals";
import {
  checkConstraints,
  normalizeStrategyResources,
  validateRevision,
  validateVerdict,
} from "../src/lib/server/tools";
import { restoreStrictNulls, toStrictToolSchema } from "../src/lib/server/strict-schema";
import { z } from "zod";

const item = (id: string, label: string, amount: number | null): CostPlan["items"][number] => ({
  id,
  label,
  amount,
  basis: amount === null ? "unknown" : "assumption",
  quote: "",
});
const route = (plan?: CostPlan): Strategy =>
  StrategySchema.parse({
    id: "A",
    title: "合成测试路线",
    thesis: "核实后按完整清单决定",
    steps: ["先核实必要项目，已花投入计入同一预算，安全通过后才正式执行"],
    claims: [{ id: "A1", text: "全程费用仍需核实", status: "unknown", sourceIds: [] }],
    resources: "已有设备",
    firstAction: "先询价",
    failureCondition: "超限则退出",
    estimatedCost: null,
    estimatedHours: null,
    ...(plan ? { costPlan: plan } : {}),
  });
const task = (strategy: Strategy): StageInput => ({
  challenge: ChallengeSchema.parse({ goal: "比较合成测试资源路线", budget: 650 }),
  role: "A",
  strategies: [strategy, { ...route(), id: "B" }],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
});
const verdict = (): Verdict => ({
  outcome: "recommendation",
  preferred: "A",
  headline: "有条件试行",
  rationale: "核实后决定",
  conditions: [],
  uncertainties: [],
  nextActions: ["询价"],
  exitCondition: "未核实不正式执行",
  evidenceIds: [],
  attackFindings: [],
  comparisons: [
    { strategyId: "A", status: "eligible", reason: "按假设待核实", basis: "assumption", quote: "" },
  ],
});

describe("single necessary-expense list and server execution gate", () => {
  it("includes travel and follow-up verification in the same execution sum", () => {
    const plan: CostPlan = {
      complete: true,
      items: [
        item("purchase", "购入", 600),
        item("check", "检测", 20),
        item("accessory", "附件", 10),
        item("buffer", "缓冲", 20),
        item("travel", "必要路程", 20),
        item("followup", "交付后复检", 10),
      ],
    };
    expect(costPlanTotal(plan)).toBe(680);
    const strategy = normalizeStrategyResources(route(plan), task(route(plan)).challenge);
    expect(strategy.estimatedCost).toBe(680);
    expect(strategy.thesis).toContain("待验证的方案假设");
    expect(strategy.resources).toContain("必要路程(假设)20元");
    expect(strategy.resources).toContain("交付后复检(假设)10元");
    expect(strategy.resources).toContain("合计680元");
    expect(checkConstraints(task(strategy).challenge, [strategy], "final")[0].result).toBe(30);
    expect(validateVerdict(verdict(), task(strategy))).toMatchObject({
      preferred: null,
      comparisons: [{ status: "violates" }, { status: "unknown" }],
    });
    expect(() => normalizeCostPlan({ ...route(plan), estimatedCost: 650 })).toThrow("全程费用估计");
    expect(() => normalizeCostPlan({ ...route(plan), failureCondition: "总费用650元" })).toThrow(
      "正式门槛",
    );
  });

  it("counts a previously spent diagnostic charge exactly once when switching routes", () => {
    const plan: CostPlan = {
      complete: true,
      items: [
        item("sunk", "原路线已花检测费", 30),
        item("buy", "改选购入", 600),
        item("check", "后续检测", 20),
        item("extra", "必要附件", 10),
        item("buffer", "缓冲", 20),
      ],
    };
    const normalized = normalizeCostPlan(route(plan));
    expect(normalized.estimatedCost).toBe(680);
    expect(normalizeCostPlan(normalized)).toEqual(normalized);
    expect(normalized.resources.match(/原路线已花检测费/g)).toHaveLength(1);
    expect(() =>
      normalizeCostPlan(route({ ...plan, items: [...plan.items, plan.items[0]] })),
    ).toThrow("重复");
  });

  it("compares cumulative cost to the original budget without subtracting spent money twice", () => {
    const strategy = normalizeCostPlan(
      route({
        complete: true,
        items: [item("spent", "已花诊断", 30), item("future", "未来完整投入", 620)],
      }),
    );
    expect(strategy.estimatedCost).toBe(650);
    expect(strategy.resources).toContain("与原总预算比较");
    expect(strategy.resources).not.toContain("与剩余预算比较");
    expect(validateVerdict(verdict(), task(strategy)).comparisons[0].status).toBe("unknown");
    expect(checkConstraints(task(strategy).challenge, [strategy])[0].result).toBe(0);
  });

  it("keeps all eight bounded items and the derived gate valid for the public resource field", () => {
    const plan: CostPlan = {
      complete: true,
      items: Array.from({ length: 8 }, (_, index) =>
        item(`c${index}`, `${index}${"项目".repeat(11)}末`, 100000000),
      ),
    };
    const strategy = normalizeCostPlan(route(plan));
    expect(strategy.costPlan?.items).toHaveLength(8);
    expect(strategy.resources.length).toBeLessThanOrEqual(500);
    expect(StrategySchema.safeParse(strategy).success).toBe(true);
  });

  it.each([
    { complete: true, items: [] },
    { complete: false, items: [item("partial", "只知前置", 0)] },
    { complete: true, items: [item("included", "报价包含范围未核实", null)] },
  ])("keeps empty, partial and unknown scope unknown", (plan) => {
    const strategy = normalizeCostPlan(route(plan));
    expect(strategy.estimatedCost).toBeNull();
    expect(strategy.resources).toContain("累计总额未知");
    expect(validateVerdict(verdict(), task(strategy)).comparisons[0].status).toBe("unknown");
    expect(() => normalizeCostPlan({ ...route(plan), estimatedCost: 0 })).toThrow(
      "不得推出完整总额",
    );
  });

  it("retains a known over-limit item even when later expenses are unknown", () => {
    const strategy = route({
      complete: false,
      items: [item("price", "现有报价", 900), item("extra", "后续必要支出", null)],
    });
    expect(validateVerdict(verdict(), task(strategy)).comparisons[0].status).toBe("violates");
  });

  it("treats an affordable assumption as conditional and uses exact cents", () => {
    const strategy = normalizeCostPlan(
      route({
        complete: true,
        items: [item("one", "假设费用一", 0.1), item("two", "假设费用二", 0.2)],
      }),
    );
    expect(strategy.estimatedCost).toBe(0.3);
    expect(validateVerdict(verdict(), task(strategy)).comparisons[0]).toMatchObject({
      status: "unknown",
    });
    expect(() =>
      normalizeCostPlan(route({ complete: true, items: [item("fraction", "金额", 0.001)] })),
    ).toThrow("两位小数");
    expect(() =>
      normalizeCostPlan(
        route({ complete: true, items: [{ ...item("unknown", "金额未知", 0), basis: "unknown" }] }),
      ),
    ).toThrow("未知费用");
  });

  it("checks generated output requirements without upgrading historical records", () => {
    const legacy = route();
    expect(normalizeCostPlan(legacy)).toBe(legacy);
    expect(StrategySchema.safeParse(legacy).success).toBe(true);
    expect(GeneratedStrategySchema.safeParse(legacy).success).toBe(false);
    expect(
      GeneratedRevisionSchema.safeParse({
        strategyId: "A",
        strategy: legacy,
        responses: [],
        summary: "旧修订",
        changed: false,
      }).success,
    ).toBe(false);
    const oldVerdict = {
      ...verdict(),
      comparisons: [{ strategyId: "A", status: "unknown", reason: "旧记录" }],
    };
    expect(VerdictSchema.safeParse(oldVerdict).success).toBe(true);
    expect(GeneratedVerdictSchema.safeParse(oldVerdict).success).toBe(false);
    expect(() => toStrictToolSchema(z.toJSONSchema(GeneratedStrategySchema))).not.toThrow();
    expect(
      restoreStrictNulls({ costPlan: { items: [{ amount: "unknown", basis: "unknown" }] } }),
    ).toEqual({ costPlan: { items: [{ amount: null, basis: "unknown" }] } });
  });

  it("uses the same plan in a revision and rejects a forged server formula", () => {
    const strategy = route({
      complete: true,
      items: [item("diagnostic", "已花安全检测费", 20), item("execution", "后续正式执行", null)],
    });
    const checked = validateRevision(
      { strategyId: "A", strategy, responses: [], summary: "保留已花费用", changed: true },
      task(route()),
    );
    expect(checked.strategy.resources).toContain("已花安全检测费(假设)20元");
    expect(checked.strategy.estimatedCost).toBeNull();
    expect(() =>
      normalizeCostPlan({ ...strategy, resources: "【服务端费用门槛】总费用0元" }),
    ).toThrow("不得另行维护公式");
  });
});

describe("quote attribution and comparison assumptions", () => {
  const quote = "方案报价600元，包含项目未知";
  const userItem = { id: "price", label: "报价", amount: 600, basis: "user" as const, quote };
  it("rejects nested quotes of one charge without merging independent equal-price items", () => {
    const quoted = (id: string, label: string, quote: string): CostPlan["items"][number] => ({
      id,
      label,
      quote,
      amount: 300,
      basis: "user",
    });
    expect(() =>
      normalizeCostPlan(
        route({
          complete: true,
          items: [quoted("one", "维修", "维修报价300元"), quoted("two", "报价", "报价300元")],
        }),
        "维修报价300元",
      ),
    ).toThrow("同一原文报价");
    const independent = normalizeCostPlan(
      route({
        complete: true,
        items: [quoted("one", "维修", "维修报价300元"), quoted("two", "配件", "配件报价300元")],
      }),
      "维修报价300元，配件报价300元",
    );
    expect(independent.estimatedCost).toBe(600);
  });
  it("requires the current literal quote and rejects an invented quote scope", () => {
    const strategy = route({ complete: false, items: [userItem] });
    expect(normalizeCostPlan(strategy, quote).estimatedCost).toBeNull();
    expect(() => normalizeCostPlan(strategy, "旧条件已不适用")).toThrow("逐字引用");
    const wide = "维修300元，二手600元，新车900元";
    expect(() =>
      normalizeCostPlan(
        route({
          complete: false,
          items: [{ ...userItem, label: "维修", amount: 900, quote: wide }],
        }),
        wide,
      ),
    ).toThrow("其他项目金额");
    expect(() => normalizeCostPlan(route({ complete: true, items: [userItem] }), quote)).toThrow(
      "包含范围",
    );
    expect(() =>
      normalizeCostPlan(
        route({ complete: false, items: [{ ...userItem, label: "裸车价" }] }),
        quote,
      ),
    ).toThrow("报价形式");
    expect(() =>
      normalizeCostPlan(route({ complete: false, items: [{ ...userItem, amount: 500 }] }), quote),
    ).toThrow("补造报价");
    expect(() =>
      normalizeCostPlan(
        route({ complete: true, items: [{ ...userItem, quote: "若报价600元则采用" }] }),
        "若报价600元则采用",
      ),
    ).toThrow("条件或估计");
  });

  it("does not turn a user quote into a superlative or an assumed quote range", () => {
    const input = task(route());
    input.challenge.materials = quote;
    const candidate = verdict();
    candidate.comparisons[0] = {
      strategyId: "A",
      status: "unknown",
      basis: "user",
      quote,
      reason: "这是裸车价，外部依赖最少",
    };
    candidate.rationale = "外部依赖最少";
    candidate.headline = "本路线优先";
    const checked = validateVerdict(candidate, input);
    expect(checked.rationale).toBe("待验证的比较假设，以所列条件为前提，外部依赖最少");
    expect(checked.headline).toBe("条件性判断，本路线优先");
    expect(checked.comparisons[0].reason).toContain(quote);
    expect(checked.comparisons[0].reason).not.toContain("依赖最少");
    expect(checked.comparisons[0].reason).not.toContain("裸车价");
    expect(validateVerdict(checked, input).comparisons).toEqual(checked.comparisons);
    candidate.comparisons[0].quote = "材料未写的事实";
    expect(() => validateVerdict(candidate, input)).toThrow("逐字引用");
  });

  it("labels comparison assumptions explicitly", () => {
    const candidate = verdict();
    candidate.comparisons[0].reason = "仅在附件可复用时投入较少";
    expect(validateVerdict(candidate, task(route())).comparisons[0].reason).toContain(
      "按假设比较，仅在",
    );
  });

  it("reserves space for server attribution and missing-resource explanations", () => {
    const candidate = verdict();
    candidate.comparisons[0].reason = "待".repeat(320);
    expect(GeneratedVerdictSchema.safeParse(candidate).success).toBe(true);
    const checked = validateVerdict(candidate, task(route()));
    expect(checked.comparisons[0].reason.length).toBeLessThanOrEqual(500);
    expect(VerdictSchema.safeParse(checked).success).toBe(true);
    candidate.comparisons[0].reason += "待";
    expect(GeneratedVerdictSchema.safeParse(candidate).success).toBe(false);
  });
});
