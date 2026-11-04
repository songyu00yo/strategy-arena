/** Rejoin completed HUMAN blind labels with private run identities; never invent scores. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
const [directoryArgument, labelsArgument, outputArgument] = process.argv.slice(2);
if (!directoryArgument || !labelsArgument || !outputArgument)
  throw new Error(
    "Usage: node scripts/prepare-eval-records.mjs <run-directory> <human-labels.json> <output-records.json>",
  );
const directory = resolve(directoryArgument);
const metadata = JSON.parse(readFileSync(resolve(directory, "metadata.json"), "utf8"));
const mapping = JSON.parse(readFileSync(resolve(directory, "private/blind-mapping.json"), "utf8"));
const labels = JSON.parse(readFileSync(labelsArgument, "utf8"));
const metrics = ["constraintCompliance", "claimTraceability", "actionability", "adaptation"];
if (!Array.isArray(labels.records) || labels.records.length !== mapping.cards.length * 2)
  throw new Error(
    "Provide one human label for every card and condition, including incomplete outputs.",
  );
const records = [];
const seen = new Set();
const raters = new Set();
for (const label of labels.records) {
  const key = `${label.label}/${label.condition}`;
  if (seen.has(key) || !["initial", "changed"].includes(label.condition))
    throw new Error("Duplicate or invalid card/condition.");
  seen.add(key);
  const card = mapping.cards.find((card) => card.label === label.label);
  if (
    !card ||
    !label.raterId?.trim() ||
    !label.reason?.trim() ||
    !Array.isArray(label.evidenceLocations) ||
    !label.evidenceLocations.length
  )
    throw new Error("Missing human identity, reason, evidence location or known blind label.");
  raters.add(label.raterId.trim());
  if (
    metrics.some(
      (metric) =>
        !Number.isInteger(label.scores?.[metric]) ||
        label.scores[metric] < 0 ||
        label.scores[metric] > 2,
    )
  )
    throw new Error(
      "Every human score must be an integer from zero to two; blank templates cannot be summarized.",
    );
  const artifactPath = resolve(directory, card.artifactPath);
  if (!artifactPath.startsWith(resolve(directory, "raw") + sep))
    throw new Error("Raw evidence path escapes this run.");
  const trajectory = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (
    trajectory.id !== card.trajectoryId ||
    trajectory.arm !== card.arm ||
    trajectory.caseId !== card.caseId
  )
    throw new Error("Private mapping differs from raw trajectory identity.");
  const condition = trajectory.conditions.find(
    (condition) => condition.condition === label.condition,
  );
  if (!condition) throw new Error("Raw condition is missing.");
  const attempts = trajectory.attempts.filter((attempt) => attempt.condition === label.condition);
  const usage = attempts.reduce(
    (sum, attempt) => ({
      inputTokens: sum.inputTokens + (attempt.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (attempt.usage?.outputTokens ?? 0),
      costCny: sum.costCny + (attempt.usage?.estimatedCny ?? 0),
      toolCalls: 0,
    }),
    { inputTokens: 0, outputTokens: 0, costCny: 0, toolCalls: 0 },
  );
  usage.toolCalls = condition.evidence.length
    ? condition.attacks.reduce((sum, attack) => sum + attack.requests.length, 0)
    : 0;
  records.push({
    caseId: card.caseId,
    condition: label.condition,
    arm: card.arm,
    model: metadata.model.id,
    providerModels: [
      ...new Set(attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage.model] : []))),
    ],
    modelConfigHash: metadata.modelConfigHash,
    toolPolicyHash: metadata.toolPolicyHash,
    promptVersion: metadata.promptVersion,
    budget: {
      maxTokens: trajectory.caps.maxTokens,
      maxToolCalls: trajectory.caps.maxToolCalls,
      maxCny: trajectory.caps.maxCny,
    },
    usage,
    heldCny: attempts
      .filter((attempt) => attempt.status === "uncertain")
      .reduce((sum, attempt) => sum + attempt.reservedCny, 0),
    heldTokens: attempts
      .filter((attempt) => attempt.status === "uncertain")
      .reduce((sum, attempt) => sum + attempt.reservedTokens, 0),
    durationMs: condition.durationMs,
    status:
      condition.status === "completed"
        ? "completed"
        : condition.status === "budget_exhausted"
          ? "budget_exhausted"
          : "failed",
    originalStatus: condition.status,
    scores: label.scores,
    scoreReason: `${label.reason}\nEvidence: ${label.evidenceLocations.join("; ")}`,
    raterId: label.raterId.trim(),
    artifactPath,
  });
}
if (raters.size !== 1)
  throw new Error(
    "Use one rater per file; independently summarize each rater before adjudication.",
  );
const output = resolve(outputArgument);
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(
  output,
  JSON.stringify(
    {
      protocolVersion: metadata.protocolVersion,
      caseDefinitionSha256: metadata.caseDefinitionSha256,
      sourceRun: directory,
      raterId: [...raters][0],
      records,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Prepared ${records.length} human-labeled records. Raw scoring reasons remain private.`,
);
