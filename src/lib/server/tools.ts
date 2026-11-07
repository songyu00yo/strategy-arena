import { createHash, randomUUID } from "node:crypto";
import type { MaterialSource } from "../intake-contracts";
import { normalizedRevisionSummary } from "./revision-summary";
import {
  assertDeclaredResourceArithmetic,
  assertStrategyResourceTotals,
  costPlanGate,
  costPlanTotal,
  normalizeCostPlan,
} from "./resource-totals";
import {
  materialSpans,
  materialSpanAt,
  originalUserText,
  type MaterialSpan,
} from "./material-provenance";
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
  provenance?: MaterialSpan;
}
export function chunkMaterials(materials: string, sources: MaterialSource[] = []): MaterialChunk[] {
  const chunks: MaterialChunk[] = [];
  const spans = materialSpans(materials, sources);
  const pattern = /[^\r\n]+/g;
  for (const match of materials.matchAll(pattern)) {
    const lineStart = match.index!;
    const lineEnd = lineStart + match[0].length;
    const boundaries = [
      ...new Set([
        lineStart,
        lineEnd,
        ...spans
          .flatMap((span) => [span.start, span.end])
          .filter((position) => position > lineStart && position < lineEnd),
      ]),
    ].sort((a, b) => a - b);
    for (let segment = 0; segment < boundaries.length - 1; segment++) {
      for (let start = boundaries[segment]; start < boundaries[segment + 1]; start += 500) {
        const text = materials.slice(start, Math.min(start + 500, boundaries[segment + 1]));
        if (!text.trim()) continue;
        chunks.push({
          id: `M-${createHash("sha256").update(materials).digest("hex").slice(0, 10)}-${start}`,
          text,
          start,
          end: start + text.length,
          line: materials.slice(0, start).split("\n").length,
          provenance: materialSpanAt(spans, start, start + text.length),
        });
      }
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
export function searchMaterials(
  materials: string,
  query: string,
  sources: MaterialSource[] = [],
): MaterialChunk[] {
  const chunks = chunkMaterials(materials, sources);
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
const materialLabels = {
  user_text: "用户填写的材料",
  document: "文件正文",
  model_transcription: "模型转录，待核对原文件",
  model_interpretation: "模型解读，非原文",
  unknown: "旧材料片段，来源方式未记录",
} as const;

/** Retrieval confirms that text exists, not that an interpretation is independently verified. */
function usableEvidence(evidence: Evidence) {
  return (
    (evidence.status === "found" || evidence.status === "calculated") &&
    !["model_transcription", "model_interpretation", "unknown"].includes(evidence.provenance ?? "")
  );
}

export function executeAttackTools(
  attack: Attack,
  materials: string,
  sources: MaterialSource[] = [],
): Evidence[] {
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
  return attack.requests.flatMap<Evidence>((request) => {
    if (request.tool === "search_materials") {
      const results = searchMaterials(materials, request.query, sources);
      if (!results.length)
        return {
          ...baseEvidence(attack.id),
          tool: request.tool,
          status: "unavailable",
          title: `材料检索：${request.query}`,
          content: "提供的材料中未找到相关内容。未执行公开搜索。",
          source: "本次提供的材料",
        } satisfies Evidence;
      const groups = new Map<NonNullable<Evidence["provenance"]>, MaterialChunk[]>();
      for (const chunk of results) {
        const origin = chunk.provenance?.origin ?? "user_text";
        groups.set(origin, [...(groups.get(origin) ?? []), chunk]);
      }
      return [...groups].map(
        ([origin, chunks]) =>
          ({
            ...baseEvidence(attack.id),
            tool: request.tool,
            status: "found",
            provenance: origin,
            title: `材料检索：${request.query} · ${materialLabels[origin]}`,
            content: chunks
              .map((chunk) => {
                const ref = chunk.provenance;
                const location = ref?.filename
                  ? `文件：${ref.filename}；位置：${ref.location ?? "未记录"}\n`
                  : "";
                return `[${chunk.id}] ${materialLabels[origin]}\n${location}第 ${chunk.line} 行 / 字符 ${chunk.start}–${chunk.end}\n${chunk.text}`;
              })
              .join("\n\n")
              .slice(0, 6000),
            source: materialLabels[origin],
            sourceIds: [
              ...new Set(
                chunks.flatMap((chunk) => [
                  chunk.id,
                  ...(chunk.provenance?.sourceId ? [chunk.provenance.sourceId] : []),
                ]),
              ),
            ],
            assumptions:
              origin === "document" || origin === "user_text"
                ? "只确认材料中存在这些文字，不能证明材料本身真实或适用于当前情景。"
                : "保留此片段供核对；模型读取和解读、来源方式未记录的文字，都不是独立的原文或事实核验，不能据此把观点标为已证实。",
          }) satisfies Evidence,
      );
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
export function checkConstraints(
  challenge: Challenge,
  strategies: Strategy[],
  scope: "proposal" | "final" = "proposal",
): Evidence[] {
  return strategies.flatMap((candidate) => {
    const strategy = normalizeCostPlan(candidate);
    const checks: Evidence[] = [];
    for (const [name, limit, estimate, unit] of [
      ["预算", challenge.budget, strategy.estimatedCost, "元"],
      ["用时", challenge.timeHours, strategy.estimatedHours, "小时"],
    ] as const) {
      if (limit === null) continue;
      checks.push({
        ...baseEvidence(
          scope === "final" ? `constraint-final-${strategy.id}` : `constraint-${strategy.id}`,
        ),
        tool: "constraint_check",
        estimateScope: scope,
        status: estimate === null ? "unavailable" : "calculated",
        title: `${strategy.id} 路线${name}检查 · ${scope === "final" ? "裁决前最终方案" : "初始提案"}`,
        content:
          estimate === null
            ? `限制 ${limit} ${unit}，但该方案没有可比较的估计，仍待核验。`
            : `方案估计 ${estimate} ${unit}，用户限制 ${limit} ${unit}；${estimate > limit ? "按此估计超出" : "按此估计未超出"}。模型估计尚非实际测量。`,
        source: `${scope === "final" ? "裁决前最终方案" : "初始提案"}估计与用户限制比较`,
        expression: estimate === null ? null : `${estimate} - ${limit}`,
        result: estimate === null ? null : estimate - limit,
        assumptions: `仅适用于${scope === "final" ? "当前最终方案" : "初始提案，不能代替最终修订核验"}。只比较已给出的数字，不证明估计准确或覆盖全程；文字限制仍需核实。${name === "预算" && strategy.costPlan ? costPlanGate(strategy.costPlan) : ""}`,
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
    costPlan: strategy.costPlan,
  });
}
function userText(challenge: Challenge, sources: MaterialSource[]) {
  return [
    challenge.goal,
    challenge.constraints,
    challenge.preferences,
    originalUserText(challenge.materials, sources),
    ...challenge.options,
  ].join("\n");
}
export function proposedClaims(
  strategy: Strategy,
  challenge: Challenge,
  sources: MaterialSource[] = [],
) {
  const provided = userText(challenge, sources);
  return strategy.claims.map((claim, index) => ({
    ...claim,
    id: `${strategy.id}-claim-${index + 1}`,
    status:
      claim.status === "estimate"
        ? ("estimate" as const)
        : claim.status === "user" && provided.includes(claim.text)
          ? ("user" as const)
          : ("unknown" as const),
    sourceIds: [],
  }));
}
export function normalizeStrategyResources(
  strategy: Strategy,
  challenge: Challenge,
  sources: MaterialSource[] = [],
): Strategy {
  assertStrategyArithmetic(strategy);
  const normalized = normalizeCostPlan(strategy, userText(challenge, sources));
  if (!normalized.costPlan) return normalized;
  const prefix = "待验证的方案假设，";
  const thesis = normalized.thesis.startsWith(prefix)
    ? normalized.thesis
    : prefix + normalized.thesis;
  if (thesis.length > 500) throw new Error("方案假设说明超过500字，请保留成立条件并精简表述。");
  return { ...normalized, thesis };
}
export function validateRevision(
  revision: Revision,
  input: StageInput,
  sources: MaterialSource[] = [],
): Revision {
  const original = input.strategies.find((s) => s.id === revision.strategyId);
  if (!original || revision.strategy.id !== original.id || revision.strategyId !== input.role)
    throw new Error("修订策略与本轮角色不匹配。");
  const strategy = normalizeStrategyResources(revision.strategy, input.challenge, sources);
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
  const changed = actionable(original) !== actionable(strategy);
  const successful = input.evidence.filter(usableEvidence);
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
  const provided = userText(input.challenge, sources);
  const claims = revision.strategy.claims.map((claim) => {
    if (claim.status === "user")
      return {
        ...claim,
        status: provided.includes(claim.text) ? ("user" as const) : ("unknown" as const),
        sourceIds: [],
      };
    if (
      claim.status === "supported" &&
      (!claim.sourceIds.length || claim.sourceIds.some((id) => !sourceIds.has(id)))
    )
      return { ...claim, status: "unknown" as const, sourceIds: [] };
    return { ...claim, sourceIds: claim.sourceIds.filter((id) => sourceIds.has(id)) };
  });
  return {
    ...revision,
    summary: normalizedRevisionSummary(revision.summary, revision.responses, responses, changed),
    changed,
    responses,
    strategy: { ...strategy, claims },
  };
}
/** Bounded text checks, not fact verification: explicit numeric equations, same-unit
 * total declarations and yuan excess statements. Quotes, unsupported syntax, dates,
 * ranges and implicit Chinese calculations are deliberately not interpreted. */
export function assertExplicitArithmetic(text: string): void {
  assertDeclaredResourceArithmetic(text, calculate);
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
/** Only explicit same-action cycles with a positive post-action check and a first-execution
 * gate. This does not establish safety, sequence correctness or semantic completeness. */
export function assertNoCircularPreconditions(text: string): void {
  const ownText = text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g,
    (quote) => " ".repeat(quote.length),
  );
  const action = String.raw`([\p{Script=Han}]{2,8})`;
  const clauseText = String.raw`[^。；;！？?!\n]`;
  const postActionCheck = `(?:完成|完毕|结束)?(?:之)?后(?=${clauseText}{0,45}(?:复检|验收|检查|检测|核验))${clauseText}{0,60}?`;
  const passedCondition = `(?:通过|达标|合格)${clauseText}{0,8}?`;
  const sameActionGate = String.raw`(?:才|方可)(?:能|可)?(?:(?:允许|执行|进行|开始|安排|启动)(?:进行|执行)?\1|\1(?=$|[，,。；;]))`;
  const cycle = new RegExp(action + postActionCheck + passedCondition + sameActionGate, "gu");
  for (const sentence of ownText.split(/[。；;\n]/)) {
    if (/[?？]|是否|能否/.test(sentence)) continue;
    for (const match of sentence.matchAll(cycle)) {
      const prefix = sentence.slice(0, match.index);
      const after = sentence.slice(match.index! + match[0].length);
      if (
        /(?:不应|不得|不能|不要|避免|并非|不是)[^，,。；;]{0,12}$/.test(prefix) ||
        /讨论|解释|原文|示例|错误句/.test(prefix) ||
        /未(?:能)?通过|没通过|未达标|不达标|不合格|未合格|不通过/.test(match[0]) ||
        /^(?:下一|另一|其他|新一|第[二三四五六七八九十\d]|后续)/.test(after)
      )
        continue;
      throw new Error(
        `执行前置条件存在循环：${match[0]}。执行后的复检或验收不能作为同一动作首次执行的前提；先核对执行前检查，允许的封顶诊断费与正式执行费分开，执行后再验收。`,
      );
    }
  }
}
/** Check standalone resource equations and declared totals of completely labelled serial
 * allocations. A learning plan may discuss an incorrect equation without asserting it;
 * questions, quoted sources and ambiguous or partial allocations stay untouched. */
export function assertStrategyArithmetic(strategy: Strategy): void {
  normalizeCostPlan(strategy);
  assertStrategyResourceTotals(strategy);
  const resourceEquation =
    /^(?:(?:预算|费用|成本|支出|投入|工时|用时|时间)(?:总计|合计|小计|累计)?|总计|合计|小计|累计)\s*(?:为|是|[:：])?\s*[()\d\s.+\-*/%×÷]+\s*=\s*[+\-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:元|小时)\.?$/;
  for (const field of [
    strategy.thesis,
    ...strategy.steps,
    strategy.resources,
    strategy.firstAction,
    strategy.failureCondition,
  ]) {
    assertNoCircularPreconditions(field);
    const ownText = field.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g, "");
    for (const sentence of ownText.split(/[。；;\n]/)) {
      const calculation = sentence.trim();
      if (resourceEquation.test(calculation)) assertExplicitArithmetic(calculation);
    }
  }
}
export function validateVerdict(
  verdict: Verdict,
  input: StageInput,
  sources: MaterialSource[] = [],
): Verdict {
  for (const field of [
    verdict.headline,
    verdict.rationale,
    ...verdict.comparisons.map((comparison) => comparison.reason),
    ...verdict.nextActions,
    ...verdict.conditions,
    verdict.exitCondition,
  ]) {
    assertNoCircularPreconditions(field);
    assertExplicitArithmetic(field);
  }
  const strategies = input.strategies.map((s) =>
    normalizeCostPlan(input.revisions.find((r) => r.strategyId === s.id)?.strategy || s),
  );
  const successful = new Set(input.evidence.filter(usableEvidence).map((e) => e.id));
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
    const candidate = verdict.comparisons.find((c) => c.strategyId === s.id);
    let existing = candidate;
    if (candidate?.basis === "user") {
      if (!candidate.quote?.trim() || !userText(input.challenge, sources).includes(candidate.quote))
        throw new Error("比较事实必须逐字引用当前用户原文，不能以片段证明额外排序或报价范围。");
      // Only the literal quote is retained as a fact. Any ranking or inference needs an assumption.
      existing = { ...candidate, reason: `用户原文为“${candidate.quote}”，保留原有条件与范围。` };
    } else if (candidate?.basis) {
      if (candidate.quote) throw new Error("假设与未知比较不得伪造事实引用。");
      const prefix = candidate.basis === "assumption" ? "按假设比较，" : "尚待核实，";
      existing = {
        ...candidate,
        reason: candidate.reason.startsWith(prefix) ? candidate.reason : prefix + candidate.reason,
      };
    }
    const cost = s.costPlan ? costPlanTotal(s.costPlan) : s.estimatedCost;
    const knownCost = s.costPlan
      ? s.costPlan.items.reduce((sum, item) => sum + (item.amount ?? 0), 0)
      : cost;
    if (
      (input.challenge.budget !== null &&
        knownCost !== null &&
        knownCost > input.challenge.budget) ||
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
    const missingResources: string[] = [];
    if (input.challenge.budget !== null && cost === null)
      missingResources.push("缺少完整支出估算，尚不能确认满足预算上限。");
    if (input.challenge.budget !== null && s.costPlan?.items.some((item) => item.basis !== "user"))
      missingResources.push("费用清单含假设或未知，算术不能证明实际支出满足上限。");
    if (input.challenge.timeHours !== null && s.estimatedHours === null)
      missingResources.push("缺少全程工时估算，尚不能确认满足总工时上限。");
    if (missingResources.length)
      return {
        strategyId: s.id,
        status: "unknown" as const,
        reason: [
          existing?.reason,
          ...missingResources.filter((reason) => !existing?.reason.includes(reason)),
        ]
          .filter(Boolean)
          .join(" "),
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
  if (
    strategies.some((strategy) => strategy.costPlan) ||
    verdict.comparisons.some((comparison) => comparison.basis)
  ) {
    // Whole-field attribution also covers ranking prose outside the structured comparisons.
    // It does not certify that the model's premises or inference are sound.
    const prefix = "待验证的比较假设，以所列条件为前提，";
    const rationale = result.rationale.startsWith(prefix)
      ? result.rationale
      : prefix + result.rationale;
    const headlinePrefix = "条件性判断，";
    const headline = result.headline.startsWith(headlinePrefix)
      ? result.headline
      : headlinePrefix + result.headline;
    if (rationale.length > 500 || headline.length > 500)
      throw new Error("条件性比较说明超过500字，请保留成立条件并精简表述。");
    result = { ...result, rationale, headline };
  }
  if (result.preferred && !strategies.some((s) => s.id === result.preferred))
    throw new Error("裁决选择了不存在的策略。");
  if (strategies.length < 2 && !["infeasible", "partial"].includes(result.outcome))
    result = {
      ...result,
      preferred: null,
      outcome: "insufficient",
      headline: "目前不足以判定优选",
      uncertainties: [...result.uncertainties, "不足两条独立策略，尚未形成有效比较。"],
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
  if (result.outcome === "recommendation" && !successful.size) {
    result = {
      ...result,
      conditions: [
        "本建议依据用户提供的条件与明确假设；尚无有效工具证据支持外部事实。",
        ...result.conditions,
      ].slice(0, 5),
      uncertainties: [
        ...result.uncertainties,
        "尚未完成外部事实核实；材料检索无命中不代表路线不可行。",
      ].slice(0, 6),
    };
  }
  if (
    result.outcome !== "partial" &&
    comparisons.length &&
    comparisons.every((comparison) => comparison.status === "violates")
  )
    result = {
      ...result,
      preferred: null,
      outcome: "infeasible",
      headline: "当前各条路线均违反明确限制",
      uncertainties: [
        ...result.uncertainties,
        "需获得用户明确同意变更相关条件，或提出符合原限制的新路线。",
      ].slice(0, 6),
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
