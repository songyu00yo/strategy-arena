import { createHash, randomUUID } from "node:crypto";
import type {
  Attack,
  Challenge,
  Evidence,
  Revision,
  StageInput,
  Strategy,
  Verdict,
} from "../contracts";

export interface MaterialChunk {
  id: string;
  text: string;
  start: number;
  end: number;
  line: number;
}
export function chunkMaterials(materials: string): MaterialChunk[] {
  const chunks: MaterialChunk[] = [];
  const pattern = /[^\r\n]+/g;
  for (const match of materials.matchAll(pattern)) {
    for (let offset = 0; offset < match[0].length; offset += 500) {
      const text = match[0].slice(offset, offset + 500);
      if (!text.trim()) continue;
      const start = match.index! + offset;
      chunks.push({
        id: `M-${createHash("sha256").update(materials).digest("hex").slice(0, 10)}-${start}`,
        text,
        start,
        end: start + text.length,
        line: materials.slice(0, start).split("\n").length,
      });
    }
  }
  return chunks;
}
function terms(text: string): string[] {
  const segmented = [
    ...new Intl.Segmenter("zh", { granularity: "word" }).segment(text.toLowerCase()),
  ]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
  // Character bigrams also match Chinese terms across different word boundaries.
  const bigrams = [...text.toLowerCase().matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap((m) =>
    Array.from({ length: m[0].length - 1 }, (_, i) => m[0].slice(i, i + 2)),
  );
  return [...segmented, ...bigrams];
}
export function searchMaterials(materials: string, query: string): MaterialChunk[] {
  const chunks = chunkMaterials(materials);
  if (!chunks.length) return [];
  const docs = chunks.map((c) => terms(c.text));
  const queryTerms = [...new Set(terms(query))];
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const ranked = chunks.map((chunk, index) => {
    const doc = docs[index];
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.filter((t) => t === term).length;
      if (!tf) continue;
      const df = docs.filter((d) => d.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * doc.length) / avg));
    }
    return { chunk, score };
  });
  return ranked
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start)
    .slice(0, 4)
    .map((r) => r.chunk);
}

/** Tiny arithmetic grammar. No eval, Function, identifiers, networking or shell. % is remainder. */
export function calculate(expression: string): number {
  if (!expression || expression.length > 300 || !/^[\d\s.+\-*/%()]+$/.test(expression))
    throw new Error("只支持数字、括号和 + - * / %，不支持函数或代码");
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/%]/g) || [];
  let p = 0;
  let depth = 0;
  function factor(): number {
    if (++depth > 40) throw new Error("表达式嵌套过深");
    let v: number;
    const token = tokens[p++];
    if (token === "+" || token === "-") v = (token === "-" ? -1 : 1) * factor();
    else if (token === "(") {
      v = sum();
      if (tokens[p++] !== ")") throw new Error("括号不匹配");
    } else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) v = Number(token);
    else throw new Error("表达式不完整");
    depth--;
    return v;
  }
  function product(): number {
    let v = factor();
    while (["*", "/", "%"].includes(tokens[p])) {
      const op = tokens[p++];
      const rhs = factor();
      if ((op === "/" || op === "%") && rhs === 0) throw new Error("不能除以零");
      v = op === "*" ? v * rhs : op === "/" ? v / rhs : v % rhs;
    }
    return v;
  }
  function sum(): number {
    let v = product();
    while (["+", "-"].includes(tokens[p])) {
      const op = tokens[p++];
      const rhs = product();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }
  const result = sum();
  if (p !== tokens.length || !Number.isFinite(result) || Math.abs(result) > 1e15)
    throw new Error("表达式无效或结果超出计算范围");
  return Number(result.toPrecision(14));
}
function baseEvidence(
  attackId: string,
): Pick<
  Evidence,
  "id" | "attackId" | "sourceIds" | "expression" | "result" | "assumptions" | "createdAt"
> {
  return {
    id: `E-${randomUUID()}`,
    attackId,
    sourceIds: [],
    expression: null,
    result: null,
    assumptions: "",
    createdAt: new Date().toISOString(),
  };
}
export function executeAttackTools(attack: Attack, materials: string): Evidence[] {
  if (!attack.requests.length)
    return [
      {
        ...baseEvidence(attack.id),
        tool: "search_materials",
        status: "unavailable",
        title: "未提出可执行核验",
        content: "本次质疑没有提出工具请求，不能视为已查证。",
        source: "协议检查：未调用检索工具",
      },
    ];
  return attack.requests.map((request) => {
    if (request.tool === "search_materials") {
      const results = searchMaterials(materials, request.query);
      return {
        ...baseEvidence(attack.id),
        tool: request.tool,
        status: results.length ? "found" : "unavailable",
        title: `材料检索：${request.query}`,
        content: results.length
          ? results
              .map((c) => `[${c.id}] 第 ${c.line} 行 / 字符 ${c.start}–${c.end}\n${c.text}`)
              .join("\n\n")
          : "提供的文字材料中未找到相关内容。未执行公开搜索。",
        source: "用户提供的文字材料 / BM25",
        sourceIds: results.map((c) => c.id),
        assumptions: "以下为原文命中；不能证明材料本身真实或适用于当前情景。",
      } satisfies Evidence;
    }
    try {
      const result = calculate(request.expression);
      return {
        ...baseEvidence(attack.id),
        tool: request.tool,
        status: "calculated",
        title: "确定性计算",
        content: `${request.expression} = ${result}\n输入与假设：${request.assumptions}\n只验证运算；估计或小样本不能证明未来一定如此。`,
        source: "服务端有限算术解析器 v1",
        expression: request.expression,
        result,
        assumptions: request.assumptions,
      } satisfies Evidence;
    } catch (e) {
      return {
        ...baseEvidence(attack.id),
        tool: request.tool,
        status: "error",
        title: "计算未完成",
        content: e instanceof Error ? e.message : "无法计算",
        source: "服务端有限算术解析器 v1",
        expression: request.expression,
        assumptions: request.assumptions,
      } satisfies Evidence;
    }
  });
}
export function checkConstraints(challenge: Challenge, strategies: Strategy[]): Evidence[] {
  return strategies.flatMap((strategy) => {
    const checks: Evidence[] = [];
    for (const [name, limit, estimate, unit] of [
      ["预算", challenge.budget, strategy.estimatedCost, "元"],
      ["用时", challenge.timeHours, strategy.estimatedHours, "小时"],
    ] as const) {
      if (limit === null) continue;
      checks.push({
        ...baseEvidence(`constraint-${strategy.id}`),
        tool: "constraint_check",
        status: estimate === null ? "unavailable" : "calculated",
        title: `${strategy.id} 路线${name}检查`,
        content:
          estimate === null
            ? `限制 ${limit} ${unit}，但该方案没有可比较的估计，仍待核验。`
            : `方案估计 ${estimate} ${unit}，用户限制 ${limit} ${unit}；${estimate > limit ? "按此估计超出" : "按此估计未超出"}。模型估计尚非实际测量。`,
        source: "用户限制与策略估计比较",
        expression: estimate === null ? null : `${estimate} - ${limit}`,
        result: estimate === null ? null : estimate - limit,
        assumptions: "只比较已给出的数字，不证明估计准确；其他文字限制仍需核实。",
      });
    }
    return checks;
  });
}
export function validateAttack(attack: Attack, strategies: Strategy[], allowSelf = false): Attack {
  const target = strategies.find((s) => s.id === attack.targetStrategyId);
  const claim = target?.claims.find((c) => c.id === attack.targetClaimId);
  if (!claim || claim.text !== attack.claimQuote)
    throw new Error("质疑没有精确对应原主张，已停止，未伪造关联。");
  if (!allowSelf && attack.from === attack.targetStrategyId)
    throw new Error("交叉攻击不能攻击自己的策略。");
  return { ...attack, status: "pending" };
}
function actionable(strategy: Strategy) {
  return JSON.stringify({
    steps: strategy.steps,
    resources: strategy.resources,
    firstAction: strategy.firstAction,
    failureCondition: strategy.failureCondition,
    estimatedCost: strategy.estimatedCost,
    estimatedHours: strategy.estimatedHours,
  });
}
export function validateRevision(revision: Revision, input: StageInput): Revision {
  const original = input.strategies.find((s) => s.id === revision.strategyId);
  if (!original || revision.strategy.id !== original.id || revision.strategyId !== input.role)
    throw new Error("修订策略与本轮角色不匹配。");
  const eligible = input.attacks.filter((a) => a.targetStrategyId === original.id);
  const seen = new Set<string>();
  for (const r of revision.responses) {
    if (!input.attacks.some((a) => a.id === r.attackId) || seen.has(r.attackId))
      throw new Error("修订引用了不存在或重复的攻击。");
    seen.add(r.attackId);
    if (
      r.evidenceIds.some(
        (id) => !input.evidence.some((e) => e.id === id && e.attackId === r.attackId),
      )
    )
      throw new Error("修订的证据引用与攻击不对应。");
  }
  const changed = actionable(original) !== actionable(revision.strategy);
  const successful = input.evidence.filter(
    (e) => e.status === "found" || e.status === "calculated",
  );
  const responses = revision.responses.map((r) => {
    const evidenceIds = r.evidenceIds.filter((id) => successful.some((e) => e.id === id));
    if (r.decision !== "unresolved" && !evidenceIds.length)
      return {
        ...r,
        evidenceIds,
        decision: "unresolved" as const,
        reason: `${r.reason}（缺少有效证据，暂不视为质疑已解决）`,
      };
    if (r.decision === "accept" && (!changed || !r.change.trim()))
      return {
        ...r,
        evidenceIds,
        decision: "unresolved" as const,
        change: "",
        reason: `${r.reason}（未检测到行动、资源或成立条件变化，不计为实质修订）`,
      };
    return { ...r, evidenceIds };
  });
  for (const attack of eligible.filter((a) => !seen.has(a.id)))
    responses.push({
      attackId: attack.id,
      decision: "unresolved",
      reason: "本次修订未回应这项质疑，保持未解决。",
      evidenceIds: [],
      change: "",
    });
  // A supported claim must have a real evidence/source reference.
  const sourceIds = new Set(successful.flatMap((e) => [e.id, ...e.sourceIds]));
  const claims = revision.strategy.claims.map((c) =>
    c.status === "supported" &&
    (!c.sourceIds.length || c.sourceIds.some((id) => !sourceIds.has(id)))
      ? { ...c, status: "unknown" as const, sourceIds: [] }
      : c,
  );
  return { ...revision, changed, responses, strategy: { ...revision.strategy, claims } };
}
/** Bounded text checks, not fact verification: only numeric equations and direct yuan
 * excess statements with three explicit amounts. Quotes, unsupported syntax, dates,
 * ranges and implicit Chinese calculations are deliberately not interpreted. */
export function assertExplicitArithmetic(text: string): void {
  const ownText = text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g,
    (quoted) => " ".repeat(quoted.length),
  );
  const mismatch = (statement: string, expected: number) => {
    throw new Error(
      `明确算术不一致：${statement}；正确计算结果为 ${expected}。请修正该式或差额，并使该字段内使用同一口径的差额在全文保持一致；不要改写输入金额或伪造依据。`,
    );
  };
  const equations = /([\d.()+*/\-×÷− \t]+)=\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/g;
  for (const match of ownText.matchAll(equations)) {
    const expression = match[1]
      .trim()
      .replaceAll("×", "*")
      .replaceAll("÷", "/")
      .replaceAll("−", "-");
    const before = ownText.slice(0, match.index).trimEnd().at(-1) ?? "";
    const after = ownText.slice(match.index! + match[0].length).trimStart();
    if (
      !/[\d)]\s*[+*/-]/.test(expression) ||
      /[A-Za-z0-9_.$,%^]/.test(before) ||
      /^[\d.eE+*/%=^-]/.test(after) ||
      /^\d{4}-\d{1,2}-\d{1,2}$/.test(expression)
    )
      continue;
    let actual: number;
    try {
      actual = calculate(expression);
    } catch {
      continue;
    } // Unsupported/ambiguous arithmetic is not promoted to a factual claim.
    if (Math.abs(actual - Number(match[2])) > 1e-8) mismatch(match[0].trim(), actual);
  }
  const amount = "(\\d+(?:\\.\\d+)?)\\s*元";
  const excess = new RegExp(
    `${amount}\\s*(?:已\\s*)?(?:超出|超过|超|高出)\\s*(?:(?:预算|上限|限额)\\s*)?${amount}\\s*(?:的\\s*)?(?:预算|上限|限额)?\\s*(?:[，,：:]\\s*(?:差额|超额|超出金额)(?:为|是)?\\s*|(?:达|了|为|差额(?:为|是)?)?\\s*)${amount}`,
    "g",
  );
  for (const match of ownText.matchAll(excess)) {
    const before = ownText.slice(0, match.index).trimEnd().at(-1) ?? "";
    if (/[\d.,+\-eE]/.test(before)) continue; // Do not parse tails of ranges or grouped amounts.
    let actual: number;
    try {
      actual = calculate(`${match[1]}-${match[2]}`);
    } catch {
      continue;
    }
    if (Math.abs(actual - Number(match[3])) > 1e-8) mismatch(match[0], actual);
  }
}
export function validateVerdict(verdict: Verdict, input: StageInput): Verdict {
  for (const field of [
    verdict.headline,
    verdict.rationale,
    ...verdict.comparisons.map((comparison) => comparison.reason),
    ...verdict.nextActions,
    ...verdict.conditions,
    verdict.exitCondition,
  ])
    assertExplicitArithmetic(field);
  const strategies = input.strategies.map(
    (s) => input.revisions.find((r) => r.strategyId === s.id)?.strategy || s,
  );
  const successful = new Set(
    input.evidence
      .filter((e) => e.status === "found" || e.status === "calculated")
      .map((e) => e.id),
  );
  if (verdict.evidenceIds.some((id) => !input.evidence.some((e) => e.id === id)))
    throw new Error("裁决引用了不存在的证据。请原样复制 Evidence.id，不要使用材料 sourceId。");
  const findings = input.attacks.map((a) => {
    const finding = verdict.attackFindings.find((f) => f.attackId === a.id);
    const ids =
      finding?.evidenceIds.filter(
        (id) =>
          successful.has(id) && input.evidence.some((e) => e.id === id && e.attackId === a.id),
      ) || [];
    return {
      attackId: a.id,
      status: ids.length ? finding!.status : ("unresolved" as const),
      reason: ids.length ? finding!.reason : "未提供与此攻击对应的有效证据，尚未解决。",
      evidenceIds: ids,
    };
  });
  const comparisons = strategies.map((s) => {
    const existing = verdict.comparisons.find((c) => c.strategyId === s.id);
    if (
      (input.challenge.budget !== null &&
        s.estimatedCost !== null &&
        s.estimatedCost > input.challenge.budget) ||
      (input.challenge.timeHours !== null &&
        s.estimatedHours !== null &&
        s.estimatedHours > input.challenge.timeHours)
    )
      return {
        strategyId: s.id,
        status: "violates" as const,
        reason: "按当前方案自己的估计超出明确限制；估计的准确性仍需验证。",
      };
    // A separate unknown must not erase an already identified conflict.
    if (existing?.status === "violates") return existing;
    if (
      (input.challenge.budget !== null && s.estimatedCost === null) ||
      (input.challenge.timeHours !== null && s.estimatedHours === null)
    )
      return {
        strategyId: s.id,
        status: "unknown" as const,
        reason: "关键限制缺少可核验的资源估计，尚不能确认满足。",
      };
    if (existing?.status === "eligible" && input.challenge.constraints.trim())
      return {
        strategyId: s.id,
        status: "unknown" as const,
        reason: `${existing.reason}（文字限制尚无逐项确定性证明；这是一条有条件建议）`,
      };
    return (
      existing || {
        strategyId: s.id,
        status: "unknown" as const,
        reason: "裁决未完成该路线的限制检查。",
      }
    );
  });
  let result = { ...verdict, comparisons, attackFindings: findings };
  if (result.preferred && !strategies.some((s) => s.id === result.preferred))
    throw new Error("裁决选择了不存在的策略。");
  if (strategies.length < 2 || !successful.size)
    result = {
      ...result,
      preferred: null,
      outcome: "insufficient",
      headline: "目前不足以判定优选",
      uncertainties: [
        ...result.uncertainties,
        strategies.length < 2
          ? "不足两条独立策略，尚未形成有效比较。"
          : "没有有效工具证据，不能声称完成了核验。",
      ],
    };
  if (
    result.preferred &&
    comparisons.find((c) => c.strategyId === result.preferred)?.status === "violates"
  )
    result = {
      ...result,
      preferred: null,
      outcome: "insufficient",
      headline: "当前优选违反限制，需要重新核实或修改路线",
      rationale: `协议检查撤销了优选：${result.rationale}`,
      uncertainties: [...result.uncertainties, "不能将超出明确限制的路线判为优选。"],
    };
  if (result.outcome !== "recommendation") result.preferred = null;
  return result;
}
export function strategiesDuplicate(a: Strategy, b: Strategy): boolean {
  const ta = new Set(terms(`${a.steps.join(" ")} ${a.resources}`));
  const tb = new Set(terms(`${b.steps.join(" ")} ${b.resources}`));
  const union = new Set([...ta, ...tb]);
  const similarity = [...ta].filter((x) => tb.has(x)).length / (union.size || 1);
  return actionable(a) === actionable(b) || similarity > 0.82;
}
