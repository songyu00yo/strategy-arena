/** Offline revalidation of retained model outputs. Never calls a model or rewrites old records. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { StageInput, Verdict } from "../src/lib/contracts";
import { validateVerdict } from "../src/lib/server/tools";

const [directory, output] = process.argv.slice(2);
if (!directory || !output)
  throw new Error("Usage: tsx scripts/audit-verdict-records.ts <run-directory> <new-output.json>");
const source = resolve(directory, "checkpoint.jsonl");
const bytes = readFileSync(source);
const metadata = JSON.parse(readFileSync(resolve(directory, "metadata.json"), "utf8"));
const inputs = new Map<string, StageInput>();
const checks: unknown[] = [];
for (const line of bytes.toString("utf8").trim().split("\n")) {
  const row = JSON.parse(line);
  if (row.stage !== "judge") continue;
  const key = JSON.stringify([row.id, row.condition, row.stage, row.role, row.attempt]);
  if (row.type === "call_started") inputs.set(key, row.input as StageInput);
  if (row.type !== "call_completed") continue;
  const input = inputs.get(key);
  if (!input || !row.rawOutput || !row.normalizedOutput)
    throw new Error("Unpaired judge record; refusing to infer missing inputs or outputs.");
  const before = row.normalizedOutput as Verdict;
  const after = validateVerdict(row.rawOutput as Verdict, input);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  checks.push({
    trajectoryId: row.id,
    condition: row.condition,
    attempt: row.attempt,
    changed,
    before: {
      preferred: before.preferred,
      outcome: before.outcome,
      comparisons: before.comparisons,
    },
    after: { preferred: after.preferred, outcome: after.outcome, comparisons: after.comparisons },
  });
}
const record = {
  kind: "offline-verdict-revalidation-not-a-model-rerun",
  sourceCommit: metadata.commit,
  auditCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  auditWorkingTreeDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  checkpointSha256: createHash("sha256").update(bytes).digest("hex"),
  toolSourceSha256: createHash("sha256")
    .update(readFileSync("src/lib/server/tools.ts"))
    .digest("hex"),
  verdictsChecked: checks.length,
  changedVerdicts: checks.filter((item) => (item as { changed: boolean }).changed).length,
  limitation:
    "Only existing parsed verdicts are revalidated. No model calls, new trajectories, human scores, or corrected historical run results are produced. A changed initial verdict could affect later model context, which this audit cannot simulate.",
  checks,
};
writeFileSync(output, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify({
    verdictsChecked: record.verdictsChecked,
    changedVerdicts: record.changedVerdicts,
    output,
  }),
);
