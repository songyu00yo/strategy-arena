import type { StageInput } from "../contracts";

type Schema = Record<string, unknown>;
export type OutputKind = "propose" | "attack" | "revise" | "judge";
const nullableFields = new Set(["estimatedCost", "estimatedHours", "preferred"]);
const omitted = new Set(["$schema", "default", "minLength", "maxLength", "minItems", "maxItems"]);

/** DeepSeek strict-tool subset. Public validation still uses the unchanged Zod schema. */
export function toStrictToolSchema(value: unknown, field?: string): Schema {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid structured output schema");
  const source = value as Schema;
  if (source.type === "null") {
    if (!field || !nullableFields.has(field))
      throw new Error("Unsupported nullable structured output field");
    return { type: "string", enum: ["unknown"] };
  }
  const result: Schema = {};
  for (const [key, item] of Object.entries(source)) {
    if (omitted.has(key)) continue;
    if (key === "properties") {
      result.properties = Object.fromEntries(
        Object.entries(item as Schema).map(([name, child]) => [
          name,
          toStrictToolSchema(child, name),
        ]),
      );
    } else if (key === "oneOf" || key === "anyOf") {
      result.anyOf = (item as unknown[]).map((child) => toStrictToolSchema(child, field));
    } else if (key === "items") result.items = toStrictToolSchema(item);
    else if (key === "const" && typeof item === "string") result.enum = [item];
    else if (key === "type" && Array.isArray(item))
      result.anyOf = item.map((type) => toStrictToolSchema({ ...source, type }, field));
    else result[key] = item;
  }
  if (
    source.type === "string" &&
    !source.pattern &&
    (typeof source.minLength === "number" || typeof source.maxLength === "number")
  ) {
    result.pattern = `^[\\s\\S]{${source.minLength ?? 0},${source.maxLength ?? ""}}$`;
  }
  if (source.type === "object" || source.properties) {
    result.required = Object.keys((result.properties || {}) as Schema);
    result.additionalProperties = false;
  }
  return result;
}

/** OpenAI's constrained decoder can fail on enum/pattern intersections. Remove only
 * redundant patterns after checking every finite string value; public Zod checks stay intact. */
export function normalizeOpenAISchema(schema: Schema): Schema {
  const result = structuredClone(schema);
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Schema;
    if (
      typeof node.pattern === "string" &&
      Array.isArray(node.enum) &&
      node.enum.length > 0 &&
      node.enum.every((item) => typeof item === "string")
    ) {
      try {
        const pattern = new RegExp(node.pattern);
        if (node.enum.every((item) => pattern.test(item as string))) delete node.pattern;
      } catch {
        /* Unsupported patterns remain unchanged rather than weakening the schema. */
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(result);
  return result;
}

function atPath(schema: Schema, path: string[]): Schema | undefined {
  let current: unknown = schema;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    current = (current as Schema)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Schema)
    : undefined;
}
function enumerated(schema: Schema, path: string[], values: string[]) {
  const target = atPath(schema, path);
  if (target && values.length) {
    target.type = "string";
    target.enum = [...new Set(values)];
  }
}
export function allowedAttackIds(input: StageInput) {
  return [
    ...new Set(
      input.attacks.map((attack) => attack.id).filter((id) => !id.startsWith("constraint-")),
    ),
  ];
}
function bindAttackEvidenceItems(schema: Schema, path: string[], input: StageInput) {
  const array = atPath(schema, path);
  const template = atPath(schema, [...path, "items"]);
  const attacks = allowedAttackIds(input);
  if (!array || !template || !attacks.length) return;
  array.items = {
    anyOf: attacks.map((attackId) => {
      const variant = structuredClone(template);
      enumerated(variant, ["properties", "attackId"], [attackId]);
      const evidence = input.evidence
        .filter((item) => item.attackId === attackId)
        .map((item) => item.id);
      const evidenceItems = atPath(variant, ["properties", "evidenceIds", "items"]);
      if (evidenceItems) delete evidenceItems.enum;
      enumerated(variant, ["properties", "evidenceIds", "items"], evidence);
      if (!evidence.length) {
        const ids = atPath(variant, ["properties", "evidenceIds"]);
        if (ids) ids.description = `攻击 ${attackId} 没有对应证据，evidenceIds 必须为 []。`;
      }
      return variant;
    }),
  };
}
/** Bind references before asking the provider; the server still checks same-attack and quote coherence. */
export function bindStrictReferences(schema: Schema, kind: OutputKind, input: StageInput): Schema {
  const result = structuredClone(schema);
  const role = ["A", "B", "C"].includes(input.role) ? [input.role] : [];
  const strategies = input.strategies.map((strategy) => strategy.id);
  const attacks = allowedAttackIds(input);
  const evidence = input.evidence.map((item) => item.id);
  if (kind === "propose") enumerated(result, ["properties", "id"], role);
  if (kind === "attack") {
    const self = input.evaluationMode === "strong-single" || input.evaluationMode === "independent";
    const targets = input.strategies.filter((strategy) =>
      self ? strategy.id === input.role : strategy.id !== input.role,
    );
    enumerated(result, ["properties", "from"], role);
    enumerated(
      result,
      ["properties", "targetStrategyId"],
      targets.map((strategy) => strategy.id),
    );
    enumerated(
      result,
      ["properties", "targetClaimId"],
      targets.flatMap((strategy) => strategy.claims.map((claim) => claim.id)),
    );
    enumerated(
      result,
      ["properties", "claimQuote"],
      targets.flatMap((strategy) => strategy.claims.map((claim) => claim.text)),
    );
  }
  if (kind === "revise") {
    enumerated(result, ["properties", "strategyId"], role);
    enumerated(result, ["properties", "strategy", "properties", "id"], role);
    enumerated(result, ["properties", "responses", "items", "properties", "attackId"], attacks);
    enumerated(
      result,
      ["properties", "responses", "items", "properties", "evidenceIds", "items"],
      evidence,
    );
    bindAttackEvidenceItems(result, ["properties", "responses"], input);
  }
  if (kind === "judge") {
    const preferred = atPath(result, ["properties", "preferred"]);
    if (preferred) {
      delete preferred.anyOf;
      preferred.type = "string";
      preferred.enum = [...new Set([...strategies, "unknown"])];
    }
    enumerated(
      result,
      ["properties", "comparisons", "items", "properties", "strategyId"],
      strategies,
    );
    enumerated(
      result,
      ["properties", "attackFindings", "items", "properties", "attackId"],
      attacks,
    );
    enumerated(result, ["properties", "evidenceIds", "items"], evidence);
    enumerated(
      result,
      ["properties", "attackFindings", "items", "properties", "evidenceIds", "items"],
      evidence,
    );
    bindAttackEvidenceItems(result, ["properties", "attackFindings"], input);
  }
  return result;
}
export function referenceInstructions(kind: OutputKind, input: StageInput): string {
  if (kind === "propose") return `输出方案编号必须是 ${input.role}。`;
  const attacks = allowedAttackIds(input),
    evidence = input.evidence.map((item) => item.id);
  const missing = attacks.filter((id) => !input.evidence.some((item) => item.attackId === id));
  return `本轮允许的 strategyId=${JSON.stringify(input.strategies.map((strategy) => strategy.id))}；attackId=${JSON.stringify(attacks)}；evidenceIds=${JSON.stringify(evidence)}。constraint-* 是自动约束检查，不是攻击，不得为它生成 responses 项。${attacks.length ? "" : "没有攻击，responses 和 attackFindings 必须为 []。"}${evidence.length ? "" : "没有证据，所有 evidenceIds 必须为 []。"}${missing.length ? `这些攻击没有对应证据：${JSON.stringify(missing)}，其 evidenceIds 必须为 []。` : ""}只使用这些引用；证据必须对应所回应的同一条攻击。`;
}

/** Restore sentinels only in protocol fields whose public contract explicitly permits null. */
export function restoreStrictNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreStrictNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      nullableFields.has(key) && item === "unknown" ? null : restoreStrictNulls(item),
    ]),
  );
}

export function jsonRepairFeedback(error: unknown, output: string): string {
  const message = error instanceof Error ? error.message : "JSON syntax error";
  const position = /position\s+(\d+)/i.exec(message)?.[1];
  const offset = position ? Number(position) : Math.max(0, output.length - 1);
  const snippet = output.slice(Math.max(0, offset - 70), Math.min(output.length, offset + 70));
  // This diagnostic is stored only in the owner's private repair journal, never the public error text.
  return `不是有效的 JSON。解析器诊断：${message.slice(0, 400)}。位置附近：${JSON.stringify(snippet)}。只输出一个完整 JSON 对象，不带围栏或注释。`;
}
