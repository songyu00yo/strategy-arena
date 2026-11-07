import type { CostPlan, Strategy } from "../contracts";

const COST_GATE = "【服务端费用门槛】";

/** Protocol-format check only. Cost item names are never used to infer coverage. */
export function assertCanonicalCostReference(text: string, budget?: number | null): void {
  const financialContext =
    /费|预算|成本|支出|报价|价款|租金|押金|定金|总投入|\d+(?:\.\d+)?\s*元|[¥￥]/;
  const additiveItems =
    /[\p{L}_][\p{L}\p{N}_（）()· \t]{0,31}[+＋][ \t]*[\p{L}_][\p{L}\p{N}_（）()· \t]{0,31}/u;
  const listedTotal =
    /[\p{L}_]{1,24}(?:、|以及|及|与|和)[\p{L}_、 \t]{1,32}(?:合计|加总|相加|汇总)/u;
  const totalName =
    "(?:总费用|总支出|总价|总额|总投入|总成本|合计|总计|共计|累计支出|累计总额|全程费用)";
  const amount = String.raw`\d+(?:\.\d+)?\s*元`;
  const declaredTotal = new RegExp(`${totalName}[^，,。；;！？?\\n]{0,20}${amount}`);
  const monetaryFormula =
    /\d+(?:\.\d+)?\s*(?:元)?\s*[+＋\-−*/×÷=＝≤≥<>]\s*[^，,。；;！？?\n]{0,24}\d+(?:\.\d+)?\s*元/;
  const executionGate =
    /(?:才|方可|则|否则|即|就)(?!不|暂不|先不|未)[^。；;\n]{0,24}(?:执行|实施|付款|支付|成交|签约|启动|开始|退出|停止|交付)|(?:满足|符合|确认|核实)[^。；;\n]{0,12}后[^。；;\n]{0,8}(?:执行|实施|付款|支付|成交|签约|启动|开始)/;
  const canonicalName = "完整费用清单累计总额";
  const confirmed = "(?:(?:已核实|核实|已确认|确认)(?:且|并且|并)?\\s*)?";
  const comparison =
    "(?:不(?:得)?超过|不超出?|未超(?:过|出)?|超过|超出|超|低于|高于|小于|大于|少于|多于|不高于|不低于|至多|至少|<=|>=|[≤≥<>])";
  const budgetLabel = "(?:(?:当前|原|用户)(?:的)?)?(?:总预算|预算(?:上限)?|上限|限额)";
  const budgetAmount = `(?:${budgetLabel}\\s*)?(${amount})(?:的?${budgetLabel})?`;
  const budgetComparisons = [
    new RegExp(`${canonicalName}\\s*${confirmed}${comparison}\\s*${budgetAmount}`, "g"),
    new RegExp(`${canonicalName}\\s*与\\s*${budgetAmount}(?:作|进行)?(?:比较|对比|核对)`, "g"),
  ];
  // Mask complete quotes first so punctuation inside a quotation cannot split its boundary.
  for (const sentence of unquoted(text).matchAll(/[^。；;\n]+/g)) {
    const own = sentence[0];
    const gated = executionGate.test(own);
    // A quoted formula used as an execution condition is still a second gate.
    const inspected = gated ? text.slice(sentence.index, sentence.index! + own.length) : own;
    for (let clause of inspected.split(/[，,]/)) {
      for (const pattern of budgetComparisons) {
        clause = clause.replace(pattern, (reference: string, limit: string) => {
          if (budget === null || (budget !== undefined && Number.parseFloat(limit) !== budget))
            throw new Error(
              "完整费用清单的数字比较必须使用当前用户预算。当前上限未知时不写数字门槛，先核实；已知时原样使用当前上限，不改成另一金额。",
            );
          // Preserve the amount so an adjacent extra operation cannot hide behind this reference.
          return " ".repeat(reference.length - limit.length) + limit;
        });
      }
      if (!financialContext.test(clause)) continue;
      if (!gated && (question(clause) || /数学|算术|加法|减法|练习|讨论等式/.test(clause)))
        continue;
      if (
        additiveItems.test(clause) ||
        listedTotal.test(clause) ||
        declaredTotal.test(clause) ||
        monetaryFormula.test(clause)
      )
        throw new Error(
          "费用正文格式不符合单一门槛规则。正文正式门槛仅引用“完整费用清单累计总额”，不得另写分项合计或金额公式，即使算术正确。费用项与金额只在费用清单维护，服务端展示公式。这是格式限制，不是否定用户提供的预算事实。",
        );
    }
  }
}

/** A declared scope is not proof of completeness. Unknown amounts never become zero. */
export function costPlanTotal(plan: CostPlan): number | null {
  if (!plan.complete || !plan.items.length || plan.items.some((item) => item.amount === null))
    return null;
  const total = plan.items.reduce((sum, item) => sum + Math.round(item.amount! * 100), 0);
  return total / 100;
}

export function costPlanGate(plan: CostPlan): string {
  const terms = plan.items.map(
    (item) =>
      `${item.label}(${item.basis === "user" ? "用户提供" : item.basis === "assumption" ? "假设" : "未知"})${item.amount === null ? "待核实" : `${item.amount}元`}`,
  );
  const total = costPlanTotal(plan);
  return `${COST_GATE}${terms.join(" + ") || "必要费用清单缺失"}。${total === null ? "累计总额未知，补齐范围与金额后才可判断正式执行是否满足原总预算" : `含已花投入的累计支出估计合计${total}元，正式执行前与原总预算比较，已花投入只计一次`}。清单范围是方案声明，未由算术验证。`;
}

/** This validates a declaration and literal provenance, not the real-world quote's truth. */
export function normalizeCostPlan(
  strategy: Strategy,
  provided?: string,
  budget?: number | null,
): Strategy {
  const declaredPlan = strategy.costPlan;
  if (!declaredPlan) return strategy; // Historical data stays readable without manufacturing a breakdown.
  const plan = { ...declaredPlan, items: declaredPlan.items.map((item) => ({ ...item })) };
  const ids = new Set<string>();
  const labels = new Set<string>();
  const quotedCharges: { quote: string; amount: number | null }[] = [];
  for (const [index, item] of plan.items.entries()) {
    if (ids.has(item.id)) throw new Error("必要费用清单存在重复编号，不能重复计算同一支出。");
    ids.add(item.id);
    if (item.amount !== null && Math.abs(item.amount * 100 - Math.round(item.amount * 100)) > 1e-6)
      throw new Error("必要费用金额最多保留两位小数，未知金额填写 null。");
    if (item.basis === "unknown" && item.amount !== null)
      throw new Error("未知费用不得填写确定金额或零，情景估计须明确标为假设。");
    if (item.basis === "user") {
      if (!item.quote.trim() || (provided !== undefined && !provided.includes(item.quote)))
        throw new Error(
          "费用事实必须逐字引用当前用户原文；quote复制同一项目及金额的原文短句，label可取金额前原文短片段，不添加报价范围。",
        );
      const prices = [...item.quote.matchAll(/\d+(?:\.\d+)?\s*元/g)];
      if (item.amount !== null) {
        if (prices.length !== 1 || Number.parseFloat(prices[0][0]) !== item.amount)
          throw new Error(
            "费用事实不能补造报价或把其他项目金额移用；quote只复制同一项目及金额的原文短句，一条只含一个元金额，label可取该句金额前原文短片段。",
          );
      }
      if (item.amount !== null && /假设|如果|若|可能|预计|大约|约\d|是否/.test(item.quote))
        throw new Error("带假设、条件或估计的报价不得当作已确定费用，保留未知或标为假设。");
      if (plan.complete && /(?:包含|范围|含项).{0,12}(?:未知|未确认|待核实)/.test(item.quote))
        throw new Error("报价包含范围仍未知，必要费用范围不得声明完整。");
      if (
        quotedCharges.some(
          (charge) =>
            charge.amount === item.amount &&
            (charge.quote.includes(item.quote) || item.quote.includes(charge.quote)),
        )
      )
        throw new Error("同一原文报价被重复列入费用清单，须先核实包含关系再计算。");
      quotedCharges.push({ quote: item.quote, amount: item.amount });
      // The model's display label is not evidence. Keep only wording derived from the quote.
      const sourceLabel = (prices.length === 1 ? item.quote.replace(prices[0][0], "") : item.quote)
        .trim()
        .replace(/[，,。；;：:\s]+$/u, "");
      item.label = sourceLabel && sourceLabel.length <= 24 ? sourceLabel : `原文报价${index + 1}`;
    } else if (item.quote)
      throw new Error("假设和未知费用不填写事实引用，成立条件写入项目名称或步骤。");
    if (labels.has(item.label)) throw new Error("必要费用清单存在重复项目，不能重复计算同一支出。");
    labels.add(item.label);
  }
  const total = costPlanTotal(plan);
  if (
    strategy.estimatedCost !== null &&
    (total === null || Math.abs(strategy.estimatedCost - total) > 1e-8)
  )
    throw new Error(
      "全程费用估计与必要费用清单不一致，未知项、未闭合范围或空清单不得推出完整总额。",
    );
  const gate = costPlanGate(plan);
  // Copied revisions can carry an older server gate. Always regenerate this reserved suffix.
  const resources = strategy.resources.split(COST_GATE)[0].trim();
  const ownFields = [
    strategy.thesis,
    ...strategy.steps,
    resources,
    strategy.firstAction,
    strategy.failureCondition,
    ...strategy.claims.map((claim) => claim.text),
  ];
  for (const field of ownFields) {
    assertCanonicalCostReference(field, budget);
  }
  const canonicalResources = `${resources}\n${gate}`;
  if (canonicalResources.length > 500)
    throw new Error("资源说明与完整费用清单超过500字，请精简非费用说明和项目名称，保留必要项目。");
  return { ...strategy, costPlan: plan, resources: canonicalResources, estimatedCost: total };
}

type TimeUnit = "分钟" | "小时";
type ResourceUnit = TimeUnit | "元";
type Declaration = {
  statement: string;
  amount: number;
  unit: ResourceUnit;
  approximate: boolean;
  precision: number;
};
export type DeclaredResourceArithmetic = Declaration & { expression: string };

function unquoted(text: string) {
  return text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (quote) => quote.replace(/[^\r\n]/g, " "),
  );
}

function clauseAt(text: string, start: number, end: number) {
  const before =
    text
      .slice(0, start)
      .split(/[。；;！!\n]/)
      .at(-1) ?? "";
  const after = text.slice(end).split(/[。；;！!\n]/)[0];
  return before + text.slice(start, end) + after;
}

function question(clause: string) {
  return /[?？]|是否|能否|对不对|会不会|请(?:计算|判断|求)|例如|举例|练习题|错误等式/.test(clause);
}

function tolerates(actual: number, declared: Declaration) {
  const tolerance = declared.approximate ? 0.5 * 10 ** -declared.precision : 0;
  return Math.abs(actual - declared.amount) <= tolerance + 1e-8;
}

/** Only numeric, same-unit total declarations. Subtraction is omitted because it can be a range. */
export function extractDeclaredResourceArithmetic(text: string): DeclaredResourceArithmetic[] {
  const own = unquoted(text);
  const pattern =
    /([\d.()+*/%×÷−\- \t]+)(分钟|小时|元)\s*(?:合计|总计|共计)\s*(约)?\s*(\d+(?:\.\d+)?)\s*(分钟|小时|元)/g;
  const totals: DeclaredResourceArithmetic[] = [];
  for (const match of own.matchAll(pattern)) {
    const expression = match[1].trim().replaceAll("×", "*").replaceAll("÷", "/");
    if (match[2] !== match[5] || !/[+*/]/.test(expression) || /[-−–—%]/.test(expression)) continue;
    if (/\b\d{4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,2}\b/.test(expression)) continue;
    const before = own.slice(0, match.index).trimEnd();
    const previous = before.at(-1) ?? "";
    // Never parse the numeric tail of an identifier, unsupported operation, date or interval.
    if (
      /[\p{L}\d_.$,%^~～–—-]/u.test(previous) &&
      !/(?:分项|步骤|费用|预算|用时|耗时|时间)$/.test(before)
    )
      continue;
    if (/^[\d.eE+*/%=^~～–—-]/.test(own.slice(match.index! + match[0].length).trimStart()))
      continue;
    if (question(clauseAt(own, match.index!, match.index! + match[0].length))) continue;
    if (!Number.isFinite(Number(match[4]))) continue;
    totals.push({
      statement: text.slice(match.index, match.index! + match[0].length).trim(),
      expression,
      amount: Number(match[4]),
      unit: match[2] as ResourceUnit,
      approximate: !!match[3],
      precision: match[4].split(".")[1]?.length ?? 0,
    });
  }
  return totals;
}

export function assertDeclaredResourceArithmetic(
  text: string,
  calculate: (expression: string) => number,
) {
  for (const declared of extractDeclaredResourceArithmetic(text)) {
    let actual: number;
    try {
      actual = calculate(declared.expression);
    } catch {
      continue; // Unsupported syntax is not a claim this bounded check can interpret.
    }
    if (!Number.isFinite(actual)) continue;
    if (!tolerates(actual, declared))
      throw new Error(
        `明确分项算术不一致：${declared.statement}；按所列数字应为 ${actual} ${declared.unit}。保留用户输入，不得虚构额外工作或改写输入来凑数。`,
      );
  }
}

export type SerialStepAllocation = {
  minutes: number;
  parts: { step: number; amount: number; unit: TimeUnit }[];
};

/** Nominal allocations only: every listed step must have an unambiguous serial time header. */
export function extractSerialStepAllocation(steps: readonly string[]): SerialStepAllocation | null {
  if (steps.length < 2) return null;
  const parts: SerialStepAllocation["parts"] = [];
  for (const step of steps) {
    const own = unquoted(step);
    if (
      /并行|并发|重叠|同步(?:执行|进行)|同时(?:执行|进行)|可同时|不另计|包含前\d*步|已含第\d+步/.test(
        own,
      )
    )
      return null;
    const header =
      /^\s*第\s*(\d+)\s*步\s*[（(]\s*(?:约\s*)?(\d+(?:\.\d+)?)\s*(分钟|小时)([^()（）]*)[）)]\s*[：:]/.exec(
        own,
      );
    if (!header || /累计|合计|总计|截至|至少|至多|不超过|不少于|[~～–—-]|至|到/.test(header[4]))
      return null;
    const number = Number(header[1]);
    const amount = Number(header[2]);
    if (!Number.isFinite(number) || !Number.isFinite(amount)) return null;
    if (parts.length && number !== parts.at(-1)!.step + 1) return null;
    parts.push({ step: number, amount, unit: header[3] as TimeUnit });
  }
  const minutes = parts.reduce(
    (sum, part) => sum + part.amount * (part.unit === "小时" ? 60 : 1),
    0,
  );
  if (!Number.isFinite(minutes)) return null;
  return {
    minutes,
    parts,
  };
}

/** Do not compare estimatedHours: it may include unlisted learning, waiting or other work. */
export function assertStrategyResourceTotals(
  strategy: Pick<
    Strategy,
    "steps" | "thesis" | "resources" | "claims" | "firstAction" | "failureCondition"
  >,
) {
  const allocation = extractSerialStepAllocation(strategy.steps);
  if (!allocation) return;
  const fields = [
    strategy.thesis,
    strategy.resources,
    ...strategy.claims.map((claim) => claim.text),
    strategy.firstAction,
    strategy.failureCondition,
  ];
  // Other fields can explicitly describe overlapping work even when individual headers do not.
  if (
    fields.some((field) =>
      /并行|并发|重叠|同步(?:执行|进行)|同时(?:执行|进行)|可同时/.test(unquoted(field)),
    )
  )
    return;
  for (const field of fields) {
    const own = unquoted(field);
    const pattern =
      /(?:分项|(?:全部|所有|上述|以上)?步骤)\s*(?:合计|总计|共计)\s*(约)?\s*(\d+(?:\.\d+)?)\s*(分钟|小时)/g;
    for (const match of own.matchAll(pattern)) {
      const clause = clauseAt(own, match.index!, match.index! + match[0].length);
      if (question(clause)) continue;
      if (
        /仅(?:指|覆盖)[^。；;！!\n]{0,60}(?:验证|窗口|样片|小样|前置|第[一二两三四五六七八九十\d]+步)/.test(
          clause,
        )
      )
        continue;
      const prefix =
        own
          .slice(0, match.index)
          .split(/[，,。；;！!\n]/)
          .at(-1) ?? "";
      if (
        /验证|核实|样片|小样|阶段|窗口|前置|局部|部分|其中|前[一二两三四五六七八九十\d]+$/.test(
          prefix,
        )
      )
        continue;
      if (!Number.isFinite(Number(match[2]))) continue;
      const declared: Declaration = {
        statement: field.slice(match.index, match.index! + match[0].length),
        amount: Number(match[2]),
        unit: match[3] as TimeUnit,
        approximate: !!match[1],
        precision: match[2].split(".")[1]?.length ?? 0,
      };
      const actual = declared.unit === "小时" ? allocation.minutes / 60 : allocation.minutes;
      if (!tolerates(actual, declared)) {
        const terms = allocation.parts.map((part) => `${part.amount}${part.unit}`).join(" + ");
        throw new Error(
          `已列步骤分项与声明不一致：${declared.statement}；已列 ${terms}，合计 ${allocation.minutes} 分钟。保留用户输入，不得虚构额外工作或改写输入来凑数；未知全程投入仍保持未知。`,
        );
      }
    }
  }
}
