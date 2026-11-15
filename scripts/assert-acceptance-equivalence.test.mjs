/** Explicit synthetic Git histories and receipts. No model calls or release evidence. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertModelEvidenceEquivalent,
  modelEvidenceComponents,
  verifyModelAcceptanceLineage,
} from "./assert-acceptance-equivalence.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "arena-model-lineage-fixture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, stdio: "pipe" }).toString().trim();
  const write = (path, contents) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  };
  git("init", "--quiet");
  git("config", "user.name", "Synthetic lineage test");
  git("config", "user.email", "fixture@example.invalid");
  write(".gitignore", "artifacts/\n");
  write("package.json", '{"dependencies":{}}');
  write("pnpm-lock.yaml", "synthetic locked dependency\n");
  write("pnpm-workspace.yaml", "packages: []\n");
  write(
    "prompts/clarification.ts",
    'export const CLARIFICATION_PROTOCOL = "fixture" as const; export const CLARIFICATION_SYSTEM = `fixture`; export const CLARIFICATION_ROLES = { A: "A", B: "B", C: "C" };',
  );
  for (const file of [
    "clarification-contracts.ts",
    "intake-contracts.ts",
    "contracts.ts",
    "server/strict-schema.ts",
  ])
    write("src/lib/" + file, "// synthetic schema\n");
  write(
    "src/lib/server/clarification.ts",
    'export function formatClarification(input: unknown) { return "old report"; }\nexport function requestModel() { return "stable model input"; }\n',
  );
  write("src/lib/server/model.ts", "// stable synthetic provider adapter\n");
  write("src/app/api/intakes/route.ts", "// stable synthetic API\n");
  write("config/model.json", '{"model":"synthetic"}');
  const commit = (label) => {
    git("add", ".");
    git("commit", "--quiet", "-m", label);
    return git("rev-parse", "HEAD");
  };
  const previous = commit("Synthetic original model runtime");
  const identity = (sha) => modelEvidenceComponents(sha, { directory });
  const raw = (sha) => {
    const components = identity(sha);
    const path = "artifacts/raw-" + sha + ".json";
    write(
      path,
      JSON.stringify({
        source: { commit: sha, workingTreeDirty: false },
        promptHashes: [components.protocolHash],
      }),
    );
    return {
      testedRuntimeCommit: sha,
      protocolHash: components.protocolHash,
      schemaFingerprint: components.schemaFingerprint,
      dependencyFingerprint: components.dependencyFingerprint,
      evidence: { path, sha256: digest(readFileSync(join(directory, path))) },
    };
  };
  const bundle = (final) => {
    const formatting = {
      source: { commit: final, workingTreeDirty: false },
      inputDraftSha256: "a".repeat(64),
      originalCReviewSha256: "b".repeat(64),
      reportSha256: "c".repeat(64),
      executionPromptSha256: "d".repeat(64),
      validation: {
        status: "passed",
        rawRunsAndUsageUnchanged: true,
        unknownResourcesPreserved: true,
      },
    };
    write("artifacts/formatting.json", JSON.stringify(formatting));
    return {
      source: { commit: final, workingTreeDirty: false },
      status: "passed",
      humanAcceptance: "not_claimed",
      simulationOnly: true,
      publicCasePublished: false,
      scenarios: [
        { id: "negative-conflict", status: "passed", rawModelCalls: raw(previous) },
        {
          id: "paper-story-circle",
          status: "passed",
          rawModelCalls: raw(previous),
          reportFormatting: {
            ...formatting,
            evidence: {
              path: "artifacts/formatting.json",
              sha256: digest(readFileSync(join(directory, "artifacts/formatting.json"))),
            },
          },
        },
        { id: "reading-club", status: "passed", rawModelCalls: raw(final) },
      ],
    };
  };
  const updateFormatter = () => {
    write(
      "src/lib/server/clarification.ts",
      'export function formatClarification(input: unknown) { return "neutral paper implementation path"; }\nexport function requestModel() { return "stable model input"; }\n',
    );
    return commit("Synthetic report-formatting-only change");
  };
  return {
    directory,
    git,
    write,
    commit,
    previous,
    identity,
    raw,
    bundle,
    updateFormatter,
    verify: (receipt) =>
      verifyModelAcceptanceLineage(receipt, { directory, finalCommit: receipt.source.commit }),
  };
}

test("pure strict equivalence rejects changed application scope while model-input scope labels it honestly", () => {
  const previous = {
    commit: "a".repeat(40),
    applicationSelectionFingerprint: "a".repeat(64),
    protocolHash: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
    dependencyFingerprint: "d".repeat(64),
    modelPipelineFingerprint: "e".repeat(64),
    workingTreeDirty: false,
    status: "passed",
    humanAcceptance: "not_claimed",
  };
  const current = {
    ...previous,
    commit: "b".repeat(40),
    applicationSelectionFingerprint: "f".repeat(64),
  };
  assert.throws(
    () => assertModelEvidenceEquivalent(previous, current),
    /Application selection changed/,
  );
  assert.equal(
    assertModelEvidenceEquivalent(previous, current, { scope: "model-inputs" })
      .wholeApplicationEquivalent,
    false,
  );
  assert.throws(
    () =>
      assertModelEvidenceEquivalent(
        previous,
        { ...current, protocolHash: "c".repeat(64) },
        { scope: "model-inputs" },
      ),
    /protocolHash changed/,
  );
});

test("historical paid calls retain their runtime while final formatting has a separate commit and proof", (t) => {
  const f = fixture(t);
  const final = f.updateFormatter();
  const proof = f.verify(f.bundle(final));
  const paper = proof.find((entry) => entry.id === "paper-story-circle");
  assert.equal(paper.kind, "historical-model-inputs-with-final-report-formatting");
  assert.equal(paper.testedRuntimeCommit, f.previous);
  assert.equal(paper.finalSourceCommit, final);
  assert.equal(paper.wholeApplicationEquivalent, false);
  assert.notEqual(
    paper.previousApplicationSelectionFingerprint,
    paper.finalApplicationSelectionFingerprint,
  );
  assert.equal(
    proof.find((entry) => entry.id === "negative-conflict").kind,
    "historical-model-inputs",
  );
  assert.equal(proof.find((entry) => entry.id === "reading-club").kind, "fresh-model-calls");
});

test("QA-only descendants can inherit actual model evidence with full application equality", (t) => {
  const f = fixture(t);
  f.write("tests/qa.test.ts", "// synthetic test-only change\n");
  const final = f.commit("Synthetic QA-only descendant");
  const bundle = f.bundle(final);
  bundle.scenarios[2].rawModelCalls = f.raw(f.previous);
  assert(f.verify(bundle).every((entry) => entry.wholeApplicationEquivalent));
});

for (const [path, contents] of [
  [
    "prompts/clarification.ts",
    'export const CLARIFICATION_PROTOCOL = "fixture"; export const CLARIFICATION_SYSTEM = "changed"; export const CLARIFICATION_ROLES = { A: "A", B: "B", C: "C" };',
  ],
  ["src/lib/server/model.ts", "// changed provider input adapter\n"],
  ["src/app/api/intakes/route.ts", "// changed API semantics\n"],
  ["src/lib/clarification-contracts.ts", "// changed model schema\n"],
  ["pnpm-lock.yaml", "changed dependency\n"],
  ["config/model.json", '{"model":"changed"}'],
  [
    "src/lib/server/clarification.ts",
    'export function formatClarification(input: unknown) { return "old report"; }\nexport function requestModel() { return "changed model input"; }\n',
  ],
])
  test(`historical model lineage rejects changed ${path}`, (t) => {
    const f = fixture(t);
    f.write(path, contents);
    const final = f.commit("Synthetic changed model component");
    assert.throws(() => f.verify(f.bundle(final)));
  });

test("raw evidence corruption is rejected", (t) => {
  const f = fixture(t);
  const final = f.updateFormatter();
  const bundle = f.bundle(final);
  f.write(bundle.scenarios[0].rawModelCalls.evidence.path, "{}");
  assert.throws(() => f.verify(bundle), /evidence hash changed/);
});

test("unrelated histories cannot reuse model calls even when their files match", (t) => {
  const f = fixture(t);
  const tree = f.git("rev-parse", f.previous + "^{tree}");
  const orphan = f.git("commit-tree", tree, "-m", "Synthetic unrelated history");
  assert.throws(() => f.verify(f.bundle(orphan)));
});

for (const name of [
  "stale formatter",
  "dirty formatter",
  "changed C review",
  "changed raw runs",
  "unknown resources lost",
  "historical positive",
])
  test(`rejects ${name} evidence`, (t) => {
    const f = fixture(t);
    const final = f.updateFormatter();
    const bundle = f.bundle(final);
    const paper = bundle.scenarios[1];
    if (name === "stale formatter") paper.reportFormatting.source.commit = f.previous;
    if (name === "dirty formatter") paper.reportFormatting.source.workingTreeDirty = true;
    if (name === "changed C review") paper.reportFormatting.originalCReviewSha256 = "e".repeat(64);
    if (name === "changed raw runs")
      paper.reportFormatting.validation.rawRunsAndUsageUnchanged = false;
    if (name === "unknown resources lost")
      paper.reportFormatting.validation.unknownResourcesPreserved = false;
    if (name === "historical positive") bundle.scenarios[2].rawModelCalls = f.raw(f.previous);
    assert.throws(() => f.verify(bundle));
  });
