import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const script = resolve("scripts/prepare-eval-records.mjs");
function fixture(scored) {
  const directory = mkdtempSync(join(tmpdir(), "arena-human-label-test-"));
  mkdirSync(join(directory, "raw"));
  mkdirSync(join(directory, "private"));
  writeFileSync(
    join(directory, "metadata.json"),
    JSON.stringify({
      protocolVersion: "synthetic-fixture",
      model: { id: "fixture-model" },
      modelConfigHash: "a".repeat(64),
      toolPolicyHash: "b".repeat(64),
      promptVersion: "fixture",
    }),
  );
  writeFileSync(
    join(directory, "private/blind-mapping.json"),
    JSON.stringify({
      cards: [
        {
          label: "anonymous-fixture",
          caseId: "synthetic-case",
          arm: "arena",
          trajectoryId: "trajectory-fixture",
          artifactPath: "raw/trajectory-fixture.json",
        },
      ],
    }),
  );
  writeFileSync(
    join(directory, "raw/trajectory-fixture.json"),
    JSON.stringify({
      id: "trajectory-fixture",
      arm: "arena",
      caseId: "synthetic-case",
      caps: { maxTokens: 250000, maxToolCalls: 12, maxCny: 1.5 },
      conditions: [
        { condition: "initial", status: "uncertain", durationMs: 1, evidence: [], attacks: [] },
        { condition: "changed", status: "skipped", durationMs: 0, evidence: [], attacks: [] },
      ],
      attempts: [
        {
          condition: "initial",
          status: "uncertain",
          reservedCny: 0.05,
          reservedTokens: 100,
          usage: null,
        },
      ],
    }),
  );
  const labels = {
    records: ["initial", "changed"].map((condition) => ({
      label: "anonymous-fixture",
      condition,
      raterId: "synthetic-rater",
      reason: "Explicit synthetic human-label test, not a real evaluation.",
      evidenceLocations: ["conditions[0]"],
      scores: {
        constraintCompliance: scored ? 0 : null,
        claimTraceability: scored ? 0 : null,
        actionability: scored ? 0 : null,
        adaptation: scored ? 0 : null,
      },
    })),
  };
  const labelsFile = join(directory, "labels.json");
  writeFileSync(labelsFile, JSON.stringify(labels));
  const output = join(directory, "prepared.json");
  return {
    directory,
    output,
    run: () =>
      spawnSync(process.execPath, [script, directory, labelsFile, output], { encoding: "utf8" }),
  };
}
test("blank blind scorecards cannot turn into quality results", () => {
  const f = fixture(false);
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /blank templates cannot be summarized/);
    assert.equal(existsSync(f.output), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("rejoining explicit synthetic labels preserves unknown holds and skipped observations", () => {
  const f = fixture(true);
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const prepared = JSON.parse(readFileSync(f.output, "utf8"));
    assert.equal(prepared.records.length, 2);
    assert.equal(prepared.records[0].originalStatus, "uncertain");
    assert.equal(prepared.records[0].heldCny, 0.05);
    assert.equal(prepared.records[1].originalStatus, "skipped");
    assert.equal(prepared.records[1].usage.costCny, 0);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
