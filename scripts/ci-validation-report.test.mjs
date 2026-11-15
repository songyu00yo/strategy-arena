/** Isolated synthetic reports and repositories. No browser, provider or application build. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "./build.mjs";
import {
  summarizePlaywright,
  summarizeJUnit,
  comparePlaywrightJUnit,
  VALIDATION_STEPS,
  writeCiValidationReceipt,
} from "./ci-validation-report.mjs";

const script = resolve("scripts/ci-validation-report.mjs");
const successEnv = Object.fromEntries(
  VALIDATION_STEPS.map((step) => [`CI_STEP_${step.toUpperCase()}`, "success"]),
);
function report(
  tests = [{ expectedStatus: "passed", status: "expected", results: [{ status: "passed" }] }],
  stats = {},
) {
  return {
    suites: [{ specs: [{ tests }] }],
    errors: [],
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, ...stats },
  };
}
function fixture(t, compile = true) {
  const root = mkdtempSync(join(tmpdir(), "arena-ci-evidence-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.name", "Synthetic CI evidence test");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, ".gitignore"), ".next/\nartifacts/\ntest-results/\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "0.0.0-fixture", packageManager: "pnpm@11.19.0" }),
  );
  writeFileSync(join(root, "source.txt"), "Explicit synthetic source\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Synthetic CI fixture only");
  if (compile)
    build({
      directory: root,
      run(directory) {
        mkdirSync(join(directory, ".next/standalone/.next/server"), { recursive: true });
        mkdirSync(join(directory, ".next/static"), { recursive: true });
        writeFileSync(join(directory, ".next/BUILD_ID"), "explicit-synthetic-build");
        writeFileSync(
          join(directory, ".next/standalone/server.js"),
          "// Synthetic build fixture only\n",
        );
        writeFileSync(
          join(directory, ".next/static/chunk.js"),
          "// Synthetic static fixture only\n",
        );
      },
    });
  mkdirSync(join(root, "test-results"));
  writeFileSync(
    join(root, "test-results/e2e.xml"),
    '<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite name="synthetic" tests="1" failures="0" errors="0" skipped="0"><testcase name="synthetic"/></testsuite></testsuites>',
  );
  const writeReport = (value) =>
    writeFileSync(
      join(root, "test-results/e2e.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  writeReport(report());
  return {
    root,
    writeReport,
    receipt: (overrides = {}) =>
      writeCiValidationReceipt({ directory: root, env: { ...successEnv, ...overrides } }),
  };
}

test("separates stable cases, final failures, flaky cases and attempts using official stats", () => {
  const value = report(
    [
      { status: "expected", expectedStatus: "passed", results: [{ status: "passed" }] },
      {
        status: "unexpected",
        expectedStatus: "passed",
        results: [{ status: "failed" }, { status: "failed" }],
      },
      {
        status: "flaky",
        expectedStatus: "passed",
        results: [{ status: "failed" }, { status: "passed" }],
      },
    ],
    { expected: 1, unexpected: 1, flaky: 1 },
  );
  assert.deepEqual(summarizePlaywright(value), {
    status: "failed",
    testsDiscovered: 3,
    casesExecuted: 3,
    attempts: 5,
    retriedCases: 2,
    failedAttempts: 3,
    stablePassed: 1,
    failed: 1,
    expectedFailures: 0,
    flaky: 1,
    skipped: 0,
    notRun: 0,
    errors: 0,
    statsMatch: true,
    caseStatusesMatch: true,
    playwrightStats: value.stats,
  });
});

for (const [name, value, expected] of [
  [
    "failed",
    report([{ status: "unexpected", results: [{ status: "failed" }] }], {
      expected: 0,
      unexpected: 1,
    }),
    "failed",
  ],
  [
    "flaky",
    report([{ status: "flaky", results: [{ status: "timedOut" }, { status: "passed" }] }], {
      expected: 0,
      flaky: 1,
    }),
    "failed",
  ],
  [
    "skipped",
    report([{ status: "skipped", expectedStatus: "skipped", results: [{ status: "skipped" }] }], {
      expected: 0,
      skipped: 1,
    }),
    "failed",
  ],
  ["unexecuted", report([{ status: "expected", results: [] }], { expected: 0 }), "incomplete"],
  ["empty", report([], { expected: 0 }), "incomplete"],
  ["stats mismatch", report(undefined, { expected: 2 }), "incomplete"],
  [
    "case status mismatch",
    report([{ status: "flaky", results: [{ status: "passed" }] }]),
    "incomplete",
  ],
  ["global error", { ...report(), errors: [{ message: "Synthetic worker error" }] }, "failed"],
  ["malformed", {}, "invalid"],
  ["invalid result", report([{ status: "expected", results: [{ status: "unknown" }] }]), "invalid"],
])
  test(`rejects ${name} Playwright evidence`, () => {
    assert.equal(summarizePlaywright(value).status, expected);
  });

test("writes functionally ready CI evidence without claiming display, model or full-release acceptance", (t) => {
  const f = fixture(t);
  const receipt = f.receipt();
  assert.equal(receipt.functionalReady, true);
  assert.equal(receipt.functional.status, "passed");
  assert.equal(receipt.releaseReady, false);
  assert.equal(receipt.displayAcceptance.status, "not_run");
  assert.equal(receipt.modelAcceptance.status, "not_run");
  assert.equal(receipt.playwright.report.sha256.length, 64);
  assert.deepEqual(receipt.source, {
    commit: receipt.build.identity.commit,
    sourceFingerprint: receipt.build.identity.sourceFingerprint,
    workingTreeDirty: false,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, "artifacts/ci-receipt.json"))), receipt);
});

for (const outcome of ["skipped", "", "cancelled", "failure"])
  test(`preserves the actual ${outcome || "missing"} E2E outcome despite an existing passing JSON`, (t) => {
    const f = fixture(t);
    const receipt = f.receipt({ CI_STEP_E2E: outcome });
    assert.equal(receipt.functionalReady, false);
    assert.equal(
      receipt.checks.e2e,
      outcome === "failure" ? "failed" : outcome === "cancelled" ? "cancelled" : "not_run",
    );
    if (!outcome || outcome === "skipped") {
      assert.equal(receipt.playwright.summary.status, "not_run");
      assert.equal(receipt.playwright.report, null);
      assert.equal(receipt.playwright.ignoredExistingReport, true);
    }
  });

for (const broken of ["missing", "malformed", "null"])
  test(`writes a failure receipt for ${broken} JSON and overwrites earlier success`, (t) => {
    const f = fixture(t);
    assert.equal(f.receipt().functionalReady, true);
    if (broken === "missing") rmSync(join(f.root, "test-results/e2e.json"));
    else f.writeReport(broken === "malformed" ? "invalid-json" : "null");
    const receipt = f.receipt();
    assert.equal(receipt.functionalReady, false);
    assert.equal(receipt.checks.e2e, "failed");
    assert.equal(
      JSON.parse(readFileSync(join(f.root, "artifacts/ci-receipt.json"))).functionalReady,
      false,
    );
  });

test("missing dependencies and an incomplete build still produce truthful files using Node builtins", (t) => {
  const f = fixture(t, false);
  const result = spawnSync(process.execPath, [script, "--assert-ready"], {
    cwd: f.root,
    env: { ...process.env, ...successEnv },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(readFileSync(join(f.root, "artifacts/ci-receipt.json")));
  assert.equal(receipt.checks.build, "failed");
  assert.equal(receipt.build.identity, null);
  assert.match(receipt.build.error, /marker/);
});

test("all independent outcomes are required even when E2E and the build passed", (t) => {
  const f = fixture(t);
  for (const step of VALIDATION_STEPS) {
    const receipt = f.receipt({ [`CI_STEP_${step.toUpperCase()}`]: "failure" });
    assert.equal(receipt.functionalReady, false, step);
    assert.equal(receipt.checks[step], "failed", step);
  }
});

test("source inspection failure still records an incomplete run", (t) => {
  const root = mkdtempSync(join(tmpdir(), "arena-ci-no-source-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = writeCiValidationReceipt({ directory: root, env: {} });
  assert.equal(receipt.source, null);
  assert.equal(receipt.sourceClean, false);
  assert.equal(receipt.functionalReady, false);
  assert.ok(receipt.sourceError);
  assert.equal(receipt.checks.e2e, "not_run");
});

test("expected failures never count as actual stable passing cases", () => {
  const summary = summarizePlaywright(
    report([{ expectedStatus: "failed", status: "expected", results: [{ status: "failed" }] }]),
  );
  assert.equal(summary.status, "failed");
  assert.equal(summary.stablePassed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.expectedFailures, 1);
  assert.equal(summary.statsMatch, true);
});
for (const status of ["interrupted", "timedOut"])
  test(`rejects a terminal ${status} attempt`, () => {
    const summary = summarizePlaywright(
      report([{ expectedStatus: "passed", status: "unexpected", results: [{ status }] }], {
        expected: 0,
        unexpected: 1,
      }),
    );
    assert.equal(summary.status, "failed");
    assert.equal(summary.casesExecuted, 1);
    assert.equal(summary.notRun, 0);
    assert.equal(summary.failedAttempts, 1);
  });

const onePassJUnit =
  '<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="synthetic"/></testsuite></testsuites>';
test("JUnit cross-check counts real cases and ignores outcome-like text in CDATA", () => {
  const xml = onePassJUnit.replace(
    '<testcase name="synthetic"/>',
    '<testcase name="synthetic"><system-out><![CDATA[<failure/><skipped/>]]></system-out></testcase>',
  );
  assert.equal(comparePlaywrightJUnit(report(), xml).status, "passed");
  assert.deepEqual(summarizeJUnit(xml), {
    status: "valid",
    tests: 1,
    failures: 0,
    errors: 0,
    skipped: 0,
    declaredCountsMatch: true,
  });
});
for (const [name, xml] of [
  ["missing case", onePassJUnit.replace('<testcase name="synthetic"/>', "")],
  ["truncated XML", onePassJUnit.slice(0, -13)],
  ["extra root", onePassJUnit + onePassJUnit],
  ["wrong suite count", onePassJUnit.replace('tests="1"', 'tests="2"')],
  ["DTD", '<!DOCTYPE testsuites SYSTEM "file:///never-read">' + onePassJUnit],
  ["duplicate attribute", onePassJUnit.replace('tests="1"', 'tests="1" tests="1"')],
])
  test(`rejects ${name} JUnit evidence`, () => {
    assert.equal(comparePlaywrightJUnit(report(), xml).status, "failed");
  });
test("a JUnit failure cannot accompany an all-passing JSON report", () => {
  const xml =
    '<testsuites tests="1" failures="1" errors="0" skipped="0"><testsuite tests="1" failures="1" errors="0" skipped="0"><testcase><failure message="synthetic"/></testcase></testsuite></testsuites>';
  assert.equal(summarizeJUnit(xml).status, "valid");
  assert.equal(comparePlaywrightJUnit(report(), xml).countsMatch, false);
});
test("missing JUnit creates a failed gate even when JSON and step outcome passed", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "test-results/e2e.xml"));
  const receipt = f.receipt();
  assert.equal(receipt.playwright.summary.status, "passed");
  assert.equal(receipt.playwright.junit.status, "invalid");
  assert.equal(receipt.checks.e2e, "failed");
  assert.equal(receipt.functionalReady, false);
});
