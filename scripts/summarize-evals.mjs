import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
if (!args.includes("--input") || !args.includes("--output")) throw new Error("Usage: node scripts/summarize-evals.mjs --input records.json --output report.json [--partition development|holdout]");
const partition = args.includes("--partition") ? option("--partition") : "holdout";
if (!["development", "holdout"].includes(partition)) throw new Error("Unknown partition.");
const suite = JSON.parse(readFileSync("evals/cases.json", "utf8"));
const cases = suite.cases.filter((item) => item.partition === partition);
const inputPath = option("--input");
const data = JSON.parse(readFileSync(inputPath, "utf8"));
const arms = ["single", "reflection", "arena"];
const metrics = ["constraintCompliance", "claimTraceability", "actionability", "adaptation"];
if (!Array.isArray(data.records)) throw new Error("records must be an array.");
const records = data.records;
const groups = [];
for (const item of cases) for (const condition of ["initial", "changed"]) {
  const group = records.filter((record) => record.caseId === item.id && record.condition === condition);
  if (group.length !== 3 || new Set(group.map((record) => record.arm)).size !== 3 || group.some((record) => !arms.includes(record.arm))) throw new Error(`Need exactly one record per arm: ${item.id}/${condition}`);
  const fingerprint = (record) => JSON.stringify([record.model, record.modelConfigHash, record.toolPolicyHash, record.budget?.maxTokens, record.budget?.maxToolCalls, record.budget?.maxCny]);
  if (new Set(group.map(fingerprint)).size !== 1) throw new Error(`Model, tools or budget differ within ${item.id}/${condition}`);
  for (const record of group) {
    if (!record.model || !record.modelConfigHash || !record.toolPolicyHash || !record.promptVersion || !record.scoreReason || !record.artifactPath) throw new Error("Missing identity, evidence, or scoring reason.");
    if (![record.modelConfigHash, record.toolPolicyHash].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("Configuration hashes must be SHA-256 values.");
    if (!record.budget || !["maxTokens", "maxToolCalls", "maxCny"].every((key) => Number.isFinite(record.budget[key]) && record.budget[key] >= 0)) throw new Error("Invalid budget.");
    for (const key of metrics) if (!Number.isInteger(record.scores?.[key]) || record.scores[key] < 0 || record.scores[key] > 2) throw new Error(`Invalid score: ${key}`);
    for (const key of ["inputTokens", "outputTokens", "toolCalls", "costCny"]) if (!Number.isFinite(record.usage?.[key]) || record.usage[key] < 0) throw new Error(`Invalid usage: ${key}`);
    if (!Number.isFinite(record.durationMs) || record.durationMs < 0 || !["completed", "failed", "budget_exhausted"].includes(record.status)) throw new Error("Invalid duration or status.");
    if (record.usage.inputTokens + record.usage.outputTokens > record.budget.maxTokens || record.usage.toolCalls > record.budget.maxToolCalls || record.usage.costCny > record.budget.maxCny) throw new Error(`Budget exceeded: ${item.id}/${record.arm}`);
    // Evidence is hashed locally; raw user/model content is not copied into the report.
    record.artifactSha256 = createHash("sha256").update(readFileSync(record.artifactPath)).digest("hex");
  }
  groups.push({ caseId: item.id, condition, records: group });
}
if (records.length !== cases.length * 6) throw new Error("Unexpected extra records; use one partition and one repetition per input file.");
const aggregates = arms.map((arm) => {
  const entries = records.filter((record) => record.arm === arm);
  return { arm, count: entries.length, completed: entries.filter((record) => record.status === "completed").length,
    meanScores: Object.fromEntries(metrics.map((key) => [key, entries.reduce((sum, record) => sum + record.scores[key], 0) / entries.length])),
    totalCostCny: entries.reduce((sum, record) => sum + record.usage.costCny, 0),
    meanDurationMs: entries.reduce((sum, record) => sum + record.durationMs, 0) / entries.length };
});
const report = { status: "recorded-results-not-independently-verified", partition, caseDefinitionSha256: createHash("sha256").update(readFileSync("evals/cases.json")).digest("hex"),
  inputSha256: createHash("sha256").update(readFileSync(inputPath)).digest("hex"), createdAt: new Date().toISOString(), aggregates,
  pairedDifferences: ["single", "reflection"].map((baseline) => ({ baseline, differences: groups.map((group) => ({ caseId: group.caseId, condition: group.condition,
    scores: Object.fromEntries(metrics.map((key) => [key, group.records.find((record) => record.arm === "arena").scores[key] - group.records.find((record) => record.arm === baseline).scores[key]])) })) })),
  evidence: records.map(({ caseId, condition, arm, artifactPath, artifactSha256, scoreReason, status }) => ({ caseId, condition, arm, artifactPath, artifactSha256, scoreReasonSha256: createHash("sha256").update(scoreReason).digest("hex"), status })),
  limitations: "Descriptive paired summaries only. Human scores, supplied usage and source artifacts require independent audit. Small samples do not establish statistical significance or general superiority. Provider aliases are not immutable snapshots." };
const output = resolve(option("--output"));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Recorded ${records.length} results in ${output}; no model calls were made.`);
