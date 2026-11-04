import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const script = resolve("scripts/summarize-evals.mjs");
const definitions = JSON.parse(readFileSync("evals/cases.json", "utf8")).cases.filter(
  (item) => item.partition === "development",
);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "arena-eval-record-test-"));
  const artifact = join(dir, "synthetic-evidence.txt");
  const input = join(dir, "synthetic-records.json");
  const output = join(dir, "synthetic-summary.json");
  writeFileSync(artifact, "Explicit unit-test fixture. No model was called.");
  const records = definitions.flatMap((item) =>
    ["initial", "changed"].flatMap((condition) =>
      ["strong-single", "independent", "arena"].map((arm) => ({
        caseId: item.id,
        condition,
        arm,
        model: "fixture-not-a-real-model",
        modelConfigHash: "a".repeat(64),
        toolPolicyHash: "b".repeat(64),
        promptVersion: "fixture",
        budget: { maxTokens: 100, maxToolCalls: 2, maxCny: 1 },
        usage: { inputTokens: 10, outputTokens: 5, toolCalls: 0, costCny: 0 },
        durationMs: 1,
        status: "completed",
        scores: { constraintCompliance: 1, claimTraceability: 1, actionability: 1, adaptation: 1 },
        scoreReason: "private-fixture-score-reason-must-not-be-copied",
        artifactPath: artifact,
      })),
    ),
  );
  return {
    dir,
    records,
    input,
    output,
    run() {
      writeFileSync(input, JSON.stringify({ records }));
      return spawnSync(
        process.execPath,
        [script, "--input", input, "--output", output, "--partition", "development"],
        { encoding: "utf8" },
      );
    },
  };
}
test("summarizes complete paired synthetic records without copying raw scoring text", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(f.output, "utf8");
    const report = JSON.parse(text);
    assert.equal(report.aggregates.length, 3);
    assert.equal(report.aggregates[0].count, 8);
    assert.equal(text.includes("private-fixture-score-reason-must-not-be-copied"), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("rejects unequal comparison budgets", () => {
  const f = fixture();
  try {
    f.records[0].budget.maxTokens = 200;
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /budget differ/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("rejects missing comparison arms rather than dropping failed observations", () => {
  const f = fixture();
  try {
    f.records.pop();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one record per arm/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
