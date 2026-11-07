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
import {
  assertCanonicalCostReference,
  CostPlanValidationError,
  costPlanTotal,
  normalizeCostPlan,
} from "../src/lib/server/resource-totals";
import {
  checkConstraints,
  normalizeStrategyResources,
  validateRevision,
  validateVerdict,
} from "../src/lib/server/tools";
import { restoreStrictNulls, toStrictToolSchema } from "../src/lib/server/strict-schema";
import { z } from "zod";
import { PROMPT_VERSION, SYSTEM } from "../prompts/protocol";

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
  it.each([
    "将完整费用清单累计总额与1000元预算比较，并预留交付后复检与缓冲。",
    "完整费用清单累计总额超过1000元预算则退出。",
    "完整费用清单累计总额核实且不超过1000元预算后才付款。",
    "完整费用清单累计总额≤1000元才可正式执行。",
    "完整费用清单累计总额不超过当前预算1000元后才付款。",
    "完整费用清单累计总额<=1000元才可正式执行。",
  ])("retains the verified current-budget comparison without declaring a total: %s", (text) => {
    expect(() => assertCanonicalCostReference(text, 1000)).not.toThrow();
    expect(() => assertCanonicalCostReference(text)).not.toThrow();
    expect(() => assertCanonicalCostReference(text, 650)).toThrow("当前用户预算");
    expect(() => assertCanonicalCostReference(text, null)).toThrow("当前上限未知");
  });

  it.each([
    "完整费用清单累计总额=1000元才付款。",
    "完整费用清单累计总额算出总额1000元才付款。",
    "完整费用清单累计总额不超过1000元，同时租金+押金合计500元才签约。",
    "完整费用清单累计总额≤1000元+500元才付款。",
    "完整费用清单累计总额与1000元预算比较，另核对场地费＋设备费合计500元才付款。",
  ])("does not exempt another formula merely because a valid reference is present: %s", (text) => {
    expect(() => assertCanonicalCostReference(text, 1000)).toThrow("费用正文格式");
  });

  it.each([
    "利用已有旧车减少外部依赖：先自行做免费静态检查（车架、刹车、轮胎、传动、锁具），确认能安全测试后才安排试骑；维修口头报价300元仅为线索，配件、锁具与安全检测费用未知，须在完整费用核清且累计不超1000元预算后才付款维修。若静态检查发现车架裂纹或刹车失效等不可安全修复问题，则退出本路线。",
    "利用已有旧车减少外部依赖：先自行做免费静态检查（车架、刹车、轮胎、传动、锁具），确认能安全测试后才安排试骑；维修口头报价300元仅为线索，配件、锁具与安全检测费用未知，须在完整费用清单累计总额核实且不超过1000元预算后才付款维修。若静态检查发现车架裂纹或刹车失效等不可安全修复问题，则退出本路线。",
  ])(
    "replays the complete recorded R4 thesis and cost comparison with an unknown total",
    (thesis) => {
      const candidate = route({
        complete: false,
        items: [
          item("quote", "原文报价", 300),
          item("safety", "安全检测费用", null),
          item("extra", "其它必要费用", null),
        ],
      });
      candidate.thesis = thesis;
      candidate.steps = [
        "将完整费用清单累计总额与1000元预算比较，并预留交付后复检与缓冲；若累计总额未知或超预算，暂停维修，不先付款。",
      ];
      candidate.failureCondition =
        "若静态检查发现车架裂纹、刹车失效等无法安全修复的问题，或书面分项报价后完整费用清单累计总额超过1000元预算、或关键费用仍无法核实，则停止维修并退出本路线。";
      const before = structuredClone(candidate);
      const normalized = normalizeCostPlan(candidate, undefined, 1000);
      expect(normalized.estimatedCost).toBeNull();
      expect(normalized.resources).toContain("累计总额未知");
      expect(candidate).toEqual(before);
      expect(() => normalizeCostPlan(candidate, undefined, 650)).toThrow("当前用户预算");
    },
  );
  it("rejects the complete recorded R3 narrow gate despite a separate canonical unknown fee", () => {
    const plan: CostPlan = {
      complete: false,
      items: [
        item("base", "原文报价", 300),
        item("part", "必要配件", null),
        item("accessory", "必要附件", null),
        item("diagnostic", "安全检测费", null),
        item("buffer", "缓冲", null),
      ],
    };
    const candidate = route(plan);
    candidate.steps = [
      "按明细核算：维修费+必要配件+锁具+缓冲，与1000元上限比较；若合计超限或关键项目仍无报价，则退出本路线，不支付维修费。",
    ];
    const before = structuredClone(candidate);
    expect(() => normalizeCostPlan(candidate)).toThrow("正文正式门槛仅引用");
    expect(candidate).toEqual(before);
  });

  it.each([
    "房租+押金+水电，与原预算比较，满足才签约。",
    "活动场地费＋器材费＋清洁费合计不超过500元才付款。",
    "教材、课程和报名费合计须≤800元才开始。",
    "预算650-300=350元，按此剩余额度执行。",
    "正式执行前总支出合计为300元。",
    "完整费用清单累计总额=1000元才付款。",
    "费用100+20=120元，算术正确才付款。",
    "先问场地费+器材费合计是否不超预算，确认后才启动活动。",
    "只有“房租+押金合计不超过预算”满足才签约。",
    "工时分为准备+执行，共3小时，正式费用门槛为场地费+设备费合计500元才付款。",
    "“房租+押金合计500元。”满足后才签约。",
  ])("rejects independently maintained financial formulas and execution gates: %s", (text) => {
    expect(() => assertCanonicalCostReference(text)).toThrow("费用正文格式");
  });

  it.each([
    "完整费用清单累计总额已核实且不超过原总预算，才可正式执行。",
    "完整费用清单累计总额未知，先核实费用，暂不付正式执行费。",
    "用户总预算1000元，不借贷。",
    "已知报价超过用户预算，当前路线退出。",
    "先确认诊断费已封顶且不超剩余额度，已付诊断费无论结果均计入清单。",
    "询问房租+押金是否已含在总价900元内，暂不签约。",
    "请判断费用示例20+30=50元是否正确，仅讨论加法。",
    "数学讨论中1+2=3，费用仍按完整费用清单累计总额判断。",
    "材料原文“场地费+器材费合计500元”，此处只是记录待核实信息。",
    "只讨论原文中的错误等式“费用1+1=3元”。",
    "第一步1小时，第二步2小时，总工时1+2=3小时，资金按完整费用清单累计总额核对。",
    "单元测试中A+B验证输入组合。",
    "工时分为准备+执行，共3小时，费用按完整费用清单累计总额核对。",
    "学习、剪辑和导出合计4小时，费用按完整费用清单累计总额核对。",
    "材料原文“房租+押金合计500元。”这里仅引用，不作为执行门槛。",
    "“教材、课程和报名费合计800元。”是未核实原文。",
  ])(
    "retains canonical references, budget facts, inquiries, quotes and pure mathematics: %s",
    (text) => {
      expect(() => assertCanonicalCostReference(text)).not.toThrow();
    },
  );

  it("checks every strategy-owned prose field while preserving the server-only gate", () => {
    const candidate = route({ complete: true, items: [item("fee", "情景费用", 100)] });
    for (const field of ["thesis", "firstAction", "failureCondition", "resources"] as const)
      expect(() =>
        normalizeCostPlan({ ...candidate, [field]: "场地费+器材费合计100元才付款" }),
      ).toThrow("费用正文格式");
    const normalized = normalizeCostPlan(candidate);
    expect(normalized.resources).toContain("合计100元");
    expect(normalizeCostPlan(normalized)).toEqual(normalized);
  });
  it.each([
    "询问总价900元是否包含检测费，未知则不执行。",
    "总费用900元是否成立？先核实完整项目。",
    "请判断总支出900元是否正确。",
    "原文写着“总价900元”，尚未核实。",
  ])("does not promote an inquiry or quotation to a declared full cost: %s", (text) => {
    const candidate = route({ complete: false, items: [item("fee", "待核实费用", null)] });
    expect(() => normalizeCostPlan({ ...candidate, firstAction: text })).not.toThrow();
  });
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

  it("uses the same plan in a revision and replaces a copied server formula", () => {
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
    const replaced = normalizeCostPlan({ ...strategy, resources: "【服务端费用门槛】总费用0元" });
    expect(replaced.resources).not.toContain("总费用0元");
    expect(replaced.resources).toContain("累计总额未知");
    expect(normalizeCostPlan(replaced)).toEqual(replaced);
  });
});

describe("quote attribution and comparison assumptions", () => {
  const quote = "方案报价600元，包含项目未知";
  const userItem = { id: "price", label: "报价", amount: 600, basis: "user" as const, quote };
  it.each(["可用本机 Node.js 24 环境", "可以使用现有设备", "计划采用开源框架", "软件免费"])(
    "keeps non-price resource text from becoming a factual zero charge and identifies its repair: %s",
    (source) => {
      const candidate = route({
        complete: true,
        items: [
          {
            id: "node-runtime",
            label: "运行环境",
            amount: 0,
            basis: "user",
            quote: source,
          },
        ],
      });
      const original = structuredClone(candidate);
      let message = "";
      try {
        normalizeCostPlan(candidate, source);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("费用事实不能补造报价或把其他项目金额移用");
      expect(message).toContain("costPlan.items[0]");
      expect(message).toContain("id=node-runtime");
      expect(message).toContain('basis=unknown、amount=null、quote=""');
      expect(message).toContain("estimatedCost=null");
      expect(message).toContain('basis=assumption、quote=""');
      expect(message).toContain("假设与核实条件");
      // Runtime repair feedback is bounded to 500 characters, including the failing item and action.
      expect(message.length).toBeLessThanOrEqual(500);
      expect(candidate).toEqual(original);
    },
  );
  it("identifies a later invalid source item and preserves the literal-quote error", () => {
    const candidate = route({
      complete: false,
      items: [
        item("preflight", "前置核验", null),
        {
          id: "node-runtime",
          label: "运行环境",
          amount: 0,
          basis: "user",
          quote: "可用本机 Node.js 24 环境",
        },
      ],
    });
    expect(() => normalizeCostPlan(candidate, "其它用户材料")).toThrow(
      "费用事实必须逐字引用当前用户原文",
    );
    expect(() => normalizeCostPlan(candidate, "其它用户材料")).toThrow(
      "costPlan.items[1]（id=node-runtime）",
    );
  });
  it("accepts an actual same-item zero-yuan quotation while retaining amount matching", () => {
    const source = "本机运行环境费用0元";
    const candidate = route({
      complete: true,
      items: [
        {
          id: "node-runtime",
          label: "运行环境",
          amount: 0,
          basis: "user",
          quote: source,
        },
      ],
    });
    expect(normalizeCostPlan(candidate, source)).toMatchObject({
      estimatedCost: 0,
      costPlan: { items: [{ amount: 0, basis: "user", quote: source }] },
    });
    expect(() => normalizeCostPlan(candidate, "本机运行环境费用1元")).toThrow("逐字引用");
    expect(() =>
      normalizeCostPlan(
        {
          ...candidate,
          costPlan: {
            complete: true,
            items: [{ ...candidate.costPlan!.items[0], quote: "本机运行环境费用1元" }],
          },
        },
        "本机运行环境费用1元",
      ),
    ).toThrow("其他项目金额");
  });
  it("reports the recorded missing-item quote and prose gate together before its only repair", () => {
    const source = "未来24周生活费每月2000元，6个月12000元";
    const candidate = route({
      complete: false,
      items: [
        {
          id: "living",
          label: "生活费",
          amount: 12000,
          basis: "user",
          quote: "每月2000元，6个月12000元",
        },
      ],
    });
    candidate.steps = [
      "先确认书面offer当前有效",
      "核实完整费用清单累计总额及是否遗漏必要支出；不以工资抵扣支出，确认累计总额不超过18000元后再作不可撤回承诺。",
    ];
    const original = structuredClone(candidate);
    let failure: unknown;
    try {
      normalizeCostPlan(candidate, source, 18000);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CostPlanValidationError);
    expect((failure as CostPlanValidationError).errors).toHaveLength(2);
    expect((failure as Error).message).toContain("costPlan.items[0]（id=living）");
    expect((failure as Error).message).toContain("steps[1] 费用正文格式");
    expect(candidate).toEqual(original);
    const quoteOnlyFixed = structuredClone(candidate);
    quoteOnlyFixed.costPlan!.items[0].quote = source;
    expect(() => normalizeCostPlan(quoteOnlyFixed, source, 18000)).toThrow("费用正文格式");
    const proseOnlyFixed = structuredClone(candidate);
    proseOnlyFixed.steps[1] = "完整费用清单累计总额已核实且不超过18000元后才可正式执行。";
    expect(() => normalizeCostPlan(proseOnlyFixed, source, 18000)).toThrow("其他项目金额");
    proseOnlyFixed.costPlan!.items[0].quote = source;
    expect(() => normalizeCostPlan(proseOnlyFixed, source, 18000)).not.toThrow();
  });
  it("accepts the recorded same-item monthly and six-month total quotation without changing its source", () => {
    const source = "未来24周生活费每月2000元，6个月12000元";
    const candidate = route({
      complete: false,
      items: [{ id: "living", label: "6个月生活费", amount: 12000, basis: "user", quote: source }],
    });
    const original = structuredClone(candidate);
    const normalized = normalizeCostPlan(candidate, `现有存款18000元，${source}。`);
    expect(normalized.costPlan?.items[0]).toEqual({
      id: "living",
      label: "未来24周生活费（6个月）",
      amount: 12000,
      basis: "user",
      quote: source,
    });
    expect(normalized.estimatedCost).toBeNull();
    expect(
      normalizeStrategyResources(
        candidate,
        ChallengeSchema.parse({
          goal: "比较学习与就业路线",
          materials: `现有存款18000元，${source}。`,
          budget: 18000,
        }),
      ).costPlan,
    ).toEqual(normalized.costPlan);
    expect(normalizeCostPlan(normalized, `现有存款18000元，${source}。`)).toEqual(normalized);
    expect(candidate).toEqual(original);
  });
  it.each([
    ["6个月每月生活费2000元总12000元", 12000],
    ["每月生活费3500元，6个月21000元", 21000],
  ])("accepts the exact recorded offer expense quotation %s", (source, amount) => {
    const candidate = route({
      complete: true,
      items: [{ id: "living", label: "模型简称不作证据", amount, basis: "user", quote: source }],
    });
    candidate.estimatedCost = amount;
    const original = structuredClone(candidate);
    const normalized = normalizeStrategyResources(
      candidate,
      ChallengeSchema.parse({
        goal: "比较应届生就业路线",
        materials: source,
        budget: 26000,
      }),
    );
    expect(normalized.costPlan?.items[0]).toMatchObject({
      amount,
      basis: "user",
      quote: source,
      label: "生活费（6个月）",
    });
    expect(normalized.estimatedCost).toBe(amount);
    expect(normalized.costPlan?.complete).toBe(true);
    expect(candidate).toEqual(original);
  });
  it("keeps the explicitly complete recorded offer expenses known without adding an unknown buffer", () => {
    const source = "每月生活费3500元，6个月21000元，搬迁费2000元，总支出23000元";
    const candidate = route({
      complete: true,
      items: [
        {
          id: "living",
          label: "异地生活费",
          amount: 21000,
          basis: "user",
          quote: "每月生活费3500元，6个月21000元",
        },
        { id: "move", label: "搬迁费", amount: 2000, basis: "user", quote: "搬迁费2000元" },
      ],
    });
    candidate.estimatedCost = 23000;
    const normalized = normalizeStrategyResources(
      candidate,
      ChallengeSchema.parse({
        goal: "比较应届生就业路线",
        materials: source,
        budget: 26000,
      }),
    );
    expect(normalized.costPlan).toMatchObject({
      complete: true,
      items: [{ amount: 21000 }, { amount: 2000 }],
    });
    expect(normalized.costPlan?.items).toHaveLength(2);
    expect(normalized.estimatedCost).toBe(23000);
    expect(normalized.resources).toContain("合计23000元");
  });
  it.each([
    ["候选A", 24000, 28000, "eligible"],
    ["候选B", 28500, 32500, "violates"],
  ] as const)(
    "keeps %s's explicitly fixed synthetic total calculable independently of real inspection",
    (name, price, total, status) => {
      const source = `${name}固定售价${price}元，合格机构静态检测费500元，过户500元，保险2000元，首轮必要保养1000元。全部必要费用明确列齐，总计${total}元。车况尚未经现实检查。`;
      const candidate = route({
        complete: true,
        items: [
          {
            id: "price",
            label: "车价",
            amount: price,
            basis: "user",
            quote: `${name}固定售价${price}元`,
          },
          {
            id: "inspect",
            label: "检测",
            amount: 500,
            basis: "user",
            quote: "合格机构静态检测费500元",
          },
          { id: "transfer", label: "过户", amount: 500, basis: "user", quote: "过户500元" },
          { id: "insurance", label: "保险", amount: 2000, basis: "user", quote: "保险2000元" },
          {
            id: "maintenance",
            label: "保养",
            amount: 1000,
            basis: "user",
            quote: "首轮必要保养1000元",
          },
        ],
      });
      candidate.estimatedCost = total;
      const normalized = normalizeStrategyResources(
        candidate,
        ChallengeSchema.parse({
          goal: "在预算内比较合成购车路线",
          materials: source,
          budget: 30000,
        }),
      );
      expect(normalized.costPlan?.complete).toBe(true);
      expect(normalized.costPlan?.items).toHaveLength(5);
      expect(normalized.estimatedCost).toBe(total);
      const input = task(normalized);
      input.challenge = ChallengeSchema.parse({
        ...input.challenge,
        materials: source,
        budget: 30000,
      });
      const decision = verdict();
      decision.comparisons[0] = {
        strategyId: "A",
        status: "eligible",
        reason: "题设费用已列齐，现实车况仍需核实",
        basis: "user",
        quote: `${name}固定售价${price}元`,
      };
      expect(validateVerdict(decision, input).comparisons[0].status).toBe(status);
    },
  );
  it.each([
    ["6个月每月生活费2000元总13000元", 13000],
    ["6个月每月生活费2000元总12000元", 2000],
    ["每月生活费3500元，6个月21000元", 3500],
    ["每月生活费3500元，6个月生活费以外21000元", 21000],
    ["6个月每月生活费2000元搬迁费总12000元", 12000],
    ["每月2000元，6个月12000元", 12000],
    ["6个月每月2000元总12000元", 12000],
    ["每月生活费3500元，6个月21000元，搬迁费2000元", 21000],
    ["每月生活费3500元，0个月0元", 0],
  ])("rejects mismatched or mixed recurring expense quotation %s", (source, amount) => {
    const candidate = route({
      complete: false,
      items: [{ id: "living", label: "生活费", amount, basis: "user", quote: source }],
    });
    expect(() => normalizeCostPlan(candidate, source)).toThrow("其他项目金额");
  });
  it.each([
    ["6个月每月生活费2000元总12000元", "生活费2000元", 12000, 2000],
    ["每月生活费3500元，6个月21000元", "生活费3500元", 21000, 3500],
  ] as const)(
    "rejects counting both the total and monthly charge in %s",
    (source, monthly, total, amount) => {
      const items: CostPlan["items"] = [
        { id: "total", label: "总生活费", amount: total, basis: "user", quote: source },
        { id: "monthly", label: "月生活费", amount, basis: "user", quote: monthly },
      ];
      expect(() => normalizeCostPlan(route({ complete: false, items }), source)).toThrow(
        "同一原文报价",
      );
      expect(() =>
        normalizeCostPlan(route({ complete: false, items: [...items].reverse() }), source),
      ).toThrow("同一原文报价");
    },
  );
  it("scopes time accounting to the user's activities and preserves explicitly known case expenses", () => {
    expect(PROMPT_VERSION).toBe("1.4.3");
    expect(SYSTEM).toContain("用户只限定工作与求职工时，就不能擅自把生活或搬迁工时加入该上限");
    expect(SYSTEM).toContain("试跑、准备与后续执行只有属于该用户范围时才计入同一额度");
    expect(SYSTEM).toContain("总小时数必须与周数乘以每周小时数一致");
    expect(SYSTEM).toContain("不得凭空添加未知缓冲或其他未要求的费用，把已知总额改成全未知");
    expect(SYSTEM).toContain(
      "costPlan.complete 表示该范围完整，与是否超预算、是否已真实验车分别判断",
    );
    expect(SYSTEM).toContain("超过预算的已知总额仍应保留并判为违反限制");
  });
  it.each([
    ["生活费每月2000元，6个月13000元", 13000],
    ["生活费每月2000元，6个月12000元", 2000],
    ["生活费每月2000元，6个月12000元", 10000],
    ["生活费每月2000元，6个月车款12000元", 12000],
    ["维修费2000元，二手车12000元", 12000],
    ["生活费每月2000元，0个月0元", 0],
  ])("rejects an unbound or wrong recurring quote %s for amount %s", (source, amount) => {
    const candidate = route({
      complete: false,
      items: [{ id: "living", label: "生活费", amount, basis: "user", quote: source }],
    });
    expect(() => normalizeCostPlan(candidate, source)).toThrow("其他项目金额");
  });
  it.each([false, true])(
    "does not count the monthly charge again beside its explicit total (reverse=%s)",
    (reverse) => {
      const source = "未来24周生活费每月2000元，6个月12000元";
      const items: CostPlan["items"] = [
        { id: "total", label: "生活费总额", amount: 12000, basis: "user", quote: source },
        {
          id: "monthly",
          label: "月生活费",
          amount: 2000,
          basis: "user",
          quote: "生活费每月2000元",
        },
      ];
      expect(() =>
        normalizeCostPlan(
          route({ complete: false, items: reverse ? items.reverse() : items }),
          source,
        ),
      ).toThrow("同一原文报价");
    },
  );
  it("accepts the explicit unknown or conditional-assumption correction without inventing user prices", () => {
    const unknown = route({
      complete: false,
      items: [
        {
          id: "node-runtime",
          label: "运行环境费用待核实",
          basis: "unknown",
          amount: null,
          quote: "",
        },
      ],
    });
    expect(normalizeCostPlan(unknown, "可用本机 Node.js 24 环境").estimatedCost).toBeNull();
    const assumed = route({
      complete: true,
      items: [
        {
          id: "node-runtime",
          label: "既有环境零额假设",
          basis: "assumption",
          amount: 0,
          quote: "",
        },
      ],
    });
    assumed.steps = ["假设既有环境不另收费，执行前核实授权、运行和服务范围"];
    expect(normalizeCostPlan(assumed, "可用本机 Node.js 24 环境")).toMatchObject({
      estimatedCost: 0,
      costPlan: { items: [{ basis: "assumption", quote: "" }] },
    });
  });
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
  it("requires the current literal quote and discards an invented display-label scope", () => {
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
    const labelled = route({ complete: false, items: [{ ...userItem, label: "裸车价" }] });
    const before = structuredClone(labelled);
    const normalized = normalizeCostPlan(labelled, quote);
    expect(normalized.costPlan?.items[0].label).toBe("方案报价，包含项目未知");
    expect(normalized.resources).not.toContain("裸车价");
    expect(normalized.costPlan?.items[0].quote).toBe(quote);
    expect(labelled).toEqual(before);
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

  it.each([
    ["维修费（口头报价）", "现有车的维修口头报价 300 元", "现有车的维修口头报价"],
    ["维修费", "现有车的维修口头报价 300 元", "现有车的维修口头报价"],
    ["租金", "房间每月租金报价 300 元", "房间每月租金报价"],
    ["全包费用（已含税）", "设备租赁费用为300元", "设备租赁费用为"],
  ])(
    "derives factual labels from a single literal quote instead of rejecting a shorthand %s",
    (label, sourceQuote, derived) => {
      const raw = route({
        complete: true,
        items: [{ id: "price", label, amount: 300, basis: "user", quote: sourceQuote }],
      });
      const normalized = normalizeCostPlan(raw, sourceQuote);
      expect(normalized.costPlan?.items[0]).toMatchObject({
        label: derived,
        amount: 300,
        quote: sourceQuote,
      });
      expect(normalized.estimatedCost).toBe(300);
      expect(normalizeCostPlan(normalized, sourceQuote)).toEqual(normalized);
      expect(raw.costPlan?.items[0].label).toBe(label);
    },
  );

  it("uses a short neutral label for a long quote while preserving the complete source", () => {
    const sourceQuote = `${"当前用户提供的费用范围说明".repeat(3)}报价300元`;
    const normalized = normalizeCostPlan(
      route({
        complete: false,
        items: [{ ...userItem, label: "免检测费全包价", amount: 300, quote: sourceQuote }],
      }),
      sourceQuote,
    );
    expect(normalized.costPlan?.items[0].label).toBe("原文报价1");
    expect(normalized.costPlan?.items[0].quote).toBe(sourceQuote);
    expect(normalized.resources).not.toContain("免检测费");
  });

  it("regenerates a copied gate after the cost plan changes without leaving two formulas", () => {
    const old = normalizeCostPlan(
      route({ complete: true, items: [item("first", "已知情景", 100)] }),
    );
    const updated = normalizeCostPlan({
      ...old,
      estimatedCost: null,
      costPlan: { complete: true, items: [item("first", "更新情景", 200)] },
    });
    expect(updated.resources).toContain("更新情景(假设)200元");
    expect(updated.resources).not.toContain("已知情景");
    expect(updated.resources.match(/【服务端费用门槛】/g)).toHaveLength(1);
    expect(normalizeCostPlan(updated)).toEqual(updated);
    expect(() => normalizeCostPlan({ ...updated, failureCondition: "总费用100元" })).toThrow(
      "正式门槛",
    );
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
