import type { Strategy } from "../contracts";

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
