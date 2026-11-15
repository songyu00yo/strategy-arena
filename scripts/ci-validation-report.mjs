import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceIdentity, assertBuildMatchesSource } from "./build.mjs";

export const VALIDATION_STEPS = [
  "secrets",
  "typecheck",
  "lint",
  "unit",
  "scripts",
  "evals",
  "build",
  "e2e",
];
const failedAttemptStatuses = new Set(["failed", "timedOut", "interrupted"]);
const resultStatuses = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);
const outcomeStatuses = {
  success: "passed",
  failure: "failed",
  cancelled: "cancelled",
  skipped: "not_run",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Count cases and attempts separately, cross-checking the official reporter's statistics. */
export function summarizePlaywright(report) {
  if (
    !report ||
    !report.stats ||
    !Array.isArray(report.suites) ||
    (report.errors !== undefined && !Array.isArray(report.errors))
  )
    return {
      status: "invalid",
      reason: "Missing or malformed Playwright JSON suites, stats or errors.",
    };
  const tests = [];
  function collect(suites) {
    for (const suite of suites) {
      if (
        !suite ||
        (suite.specs !== undefined && !Array.isArray(suite.specs)) ||
        (suite.suites !== undefined && !Array.isArray(suite.suites))
      )
        throw new Error("Malformed Playwright suite.");
      for (const spec of suite.specs ?? []) {
        if (!Array.isArray(spec.tests)) throw new Error("Malformed Playwright test list.");
        tests.push(...spec.tests);
      }
      collect(suite.suites ?? []);
    }
  }
  try {
    collect(report.suites);
  } catch (error) {
    return { status: "invalid", reason: error.message };
  }
  let stablePassed = 0;
  let failed = 0;
  let expectedFailures = 0;
  let flaky = 0;
  let skipped = 0;
  let notRun = 0;
  let attempts = 0;
  let retriedCases = 0;
  let failedAttempts = 0;
  let caseStatusesMatch = true;
  for (const item of tests) {
    if (!item || !Array.isArray(item.results))
      return { status: "invalid", reason: "Missing Playwright attempt list." };
    const results = item.results;
    if (results.some((result) => !result || !resultStatuses.has(result.status)))
      return { status: "invalid", reason: "Unknown Playwright attempt status." };
    attempts += results.length;
    if (results.length > 1) retriedCases++;
    failedAttempts += results.filter((result) => failedAttemptStatuses.has(result.status)).length;
    if (!results.length) {
      notRun++;
      continue;
    }
    const last = results.at(-1);
    const expected = item.expectedStatus ?? "passed";
    if (!resultStatuses.has(expected))
      return { status: "invalid", reason: "Unknown Playwright expected status." };
    let reportedStatus;
    if (expected === "skipped" || last.status === "skipped") {
      skipped++;
      reportedStatus = "skipped";
    } else if (last.status !== expected) {
      failed++;
      reportedStatus = "unexpected";
    } else if (last.status !== "passed") {
      failed++;
      expectedFailures++;
      reportedStatus = "expected";
    } else if (results.slice(0, -1).some((result) => failedAttemptStatuses.has(result.status))) {
      flaky++;
      reportedStatus = "flaky";
    } else {
      stablePassed++;
      reportedStatus = "expected";
    }
    if (item.status !== reportedStatus) caseStatusesMatch = false;
  }
  const stats = report.stats;
  const statsValid = ["expected", "unexpected", "flaky", "skipped"].every(
    (key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0,
  );
  const statsMatch =
    statsValid &&
    stats.expected === stablePassed + expectedFailures &&
    stats.unexpected === failed - expectedFailures &&
    stats.flaky === flaky &&
    stats.skipped === skipped;
  const errors = report.errors?.length ?? 0;
  const complete = tests.length > 0 && notRun === 0 && statsMatch && caseStatusesMatch;
  return {
    status: errors || failed || flaky || skipped ? "failed" : complete ? "passed" : "incomplete",
    testsDiscovered: tests.length,
    casesExecuted: tests.length - notRun,
    attempts,
    retriedCases,
    failedAttempts,
    stablePassed,
    failed,
    expectedFailures,
    flaky,
    skipped,
    notRun,
    errors,
    statsMatch,
    caseStatusesMatch,
    playwrightStats: stats,
  };
}

/** Read the generated JUnit structure without evaluating DTDs or embedded document content. */
export function summarizeJUnit(xml) {
  try {
    const content = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, "");
    if (/<!|<\?/.test(content)) throw new Error("Unsupported or incomplete JUnit XML declaration.");
    const tags = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
    const stack = [];
    const suites = [];
    const cases = [];
    let root = null;
    let end = 0;
    for (const match of content.matchAll(tags)) {
      const between = content.slice(end, match.index);
      if (between.includes("<") || (!stack.length && between.trim()))
        throw new Error("Malformed JUnit XML content.");
      end = match.index + match[0].length;
      const [, closing, name, rawAttributes, selfClosing] = match;
      if (closing) {
        if (selfClosing || rawAttributes.trim() || stack.pop()?.name !== name)
          throw new Error("Unbalanced JUnit XML tags.");
        continue;
      }
      const attributes = {};
      for (const attribute of rawAttributes.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (Object.hasOwn(attributes, attribute[1])) throw new Error("Duplicate JUnit attribute.");
        attributes[attribute[1]] = attribute[2] ?? attribute[3];
      }
      const node = { name, attributes, cases: [] };
      if (!stack.length) {
        if (root || !["testsuites", "testsuite"].includes(name))
          throw new Error("Missing single JUnit suite root.");
        root = node;
      }
      if (name === "testsuite") suites.push(node);
      if (name === "testcase") {
        const entry = { failed: false, error: false, skipped: false };
        node.testCase = entry;
        cases.push(entry);
        for (const parent of stack) parent.cases.push(entry);
      }
      if (["failure", "error", "skipped"].includes(name)) {
        const testCase = stack.findLast((parent) => parent.testCase)?.testCase;
        if (!testCase) throw new Error("JUnit outcome has no test case.");
        if (name === "failure") testCase.failed = true;
        else if (name === "error") testCase.error = true;
        else testCase.skipped = true;
      }
      if (!selfClosing) stack.push(node);
    }
    if (!root || stack.length || content.slice(end).trim())
      throw new Error("Incomplete JUnit XML document.");
    const counts = (entries) => ({
      tests: entries.length,
      failures: entries.filter((entry) => entry.failed).length,
      errors: entries.filter((entry) => entry.error).length,
      skipped: entries.filter((entry) => entry.skipped).length,
    });
    let declaredCountsMatch = true;
    for (const suite of new Set([root, ...suites])) {
      const measured = counts(suite.cases);
      for (const key of ["tests", "failures", "errors", "skipped"]) {
        const raw = suite.attributes[key];
        if (!/^\d+$/.test(raw ?? "") || Number(raw) !== measured[key]) declaredCountsMatch = false;
      }
    }
    return {
      status: declaredCountsMatch ? "valid" : "invalid",
      ...counts(cases),
      declaredCountsMatch,
    };
  } catch (error) {
    return { status: "invalid", reason: error.message };
  }
}

export function comparePlaywrightJUnit(report, xml) {
  const summary = summarizePlaywright(report);
  const junit = summarizeJUnit(xml);
  const countsMatch =
    junit.status === "valid" &&
    junit.tests === summary.testsDiscovered &&
    junit.failures === summary.failed - summary.expectedFailures &&
    junit.skipped === summary.skipped &&
    junit.errors === summary.errors;
  return {
    status: countsMatch && summary.status === "passed" ? "passed" : "failed",
    countsMatch,
    summary: junit,
  };
}

export function writeCiValidationReceipt({ directory = process.cwd(), env = process.env } = {}) {
  const root = resolve(directory);
  const steps = Object.fromEntries(
    VALIDATION_STEPS.map((name) => {
      const supplied = env[`CI_STEP_${name.toUpperCase()}`] || "skipped";
      const outcome = Object.hasOwn(outcomeStatuses, supplied) ? supplied : "unknown";
      return [name, { outcome, status: outcomeStatuses[outcome] ?? "not_run" }];
    }),
  );
  let source = null;
  let sourceError = null;
  try {
    source = sourceIdentity(root);
  } catch (error) {
    sourceError = error.message;
  }
  let buildIdentity = null;
  let buildError = null;
  if (steps.build.outcome === "success") {
    try {
      buildIdentity = assertBuildMatchesSource(root);
    } catch (error) {
      buildError = error.message;
    }
  } else buildError = "Build step did not complete successfully in this invocation.";
  const reportPath = "test-results/e2e.json";
  let reportEvidence = null;
  let playwrightError = null;
  let playwright;
  let junit;
  let rawReport = null;
  const reportPresent = existsSync(join(root, reportPath));
  if (["success", "failure", "cancelled"].includes(steps.e2e.outcome)) {
    try {
      const bytes = readFileSync(join(root, reportPath));
      reportEvidence = { path: reportPath, sha256: hash(bytes) };
      rawReport = JSON.parse(bytes);
      playwright = summarizePlaywright(rawReport);
    } catch (error) {
      playwrightError = error.message;
      playwright = {
        status: "invalid",
        reason: "Playwright JSON report is missing or unreadable.",
      };
    }
  } else {
    playwright = { status: "not_run", reason: "E2E was not executed in this invocation." };
  }
  if (["success", "failure", "cancelled"].includes(steps.e2e.outcome)) {
    try {
      const path = "test-results/e2e.xml";
      const bytes = readFileSync(join(root, path));
      junit = {
        ...comparePlaywrightJUnit(rawReport, bytes.toString("utf8")),
        report: { path, sha256: hash(bytes) },
      };
    } catch (error) {
      junit = { status: "invalid", report: null, reason: error.message };
    }
  } else junit = { status: "not_run", report: null };
  const checks = Object.fromEntries(
    Object.entries(steps).map(([name, step]) => [name, step.status]),
  );
  if (steps.build.outcome === "success" && !buildIdentity) checks.build = "failed";
  if (
    steps.e2e.outcome === "success" &&
    (playwright.status !== "passed" || junit.status !== "passed")
  )
    checks.e2e = "failed";
  const sourceClean = source?.workingTreeDirty === false;
  const functionalReady =
    sourceClean && !!buildIdentity && Object.values(checks).every((status) => status === "passed");
  const receipt = {
    receiptVersion: 1,
    generatedAt: new Date().toISOString(),
    workflow: {
      runId: env.GITHUB_RUN_ID ?? null,
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
      repository: env.GITHUB_REPOSITORY ?? null,
      ref: env.GITHUB_REF ?? null,
    },
    source,
    sourceScope: "full-repository",
    sourceClean,
    sourceError,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      runnerOs: env.RUNNER_OS ?? null,
      runnerArch: env.RUNNER_ARCH ?? null,
    },
    steps,
    checks,
    build: { identity: buildIdentity, error: buildError, scope: "full-repository-ci-build" },
    playwright: {
      outcome: steps.e2e.outcome,
      summary: playwright,
      junit,
      report: reportEvidence,
      ignoredExistingReport: reportPresent && steps.e2e.status === "not_run",
      error: playwrightError,
    },
    functional: { status: functionalReady ? "passed" : "incomplete", scope: "functional-ci" },
    functionalReady,
    displayAcceptance: {
      status: "not_run",
      reason: "CI has no validated physical-display session.",
    },
    modelAcceptance: { status: "not_run", reason: "Provider acceptance is executed separately." },
    releaseReady: false,
    releaseReadinessScope: "Full release also requires independent display and model acceptance.",
  };
  if (
    Object.values(checks).some((status) => ["failed", "cancelled"].includes(status)) ||
    !sourceClean
  )
    receipt.functional.status = "failed";
  const output = join(root, "artifacts/ci-receipt.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(
    join(root, "artifacts/checks.json"),
    JSON.stringify(
      {
        ...checks,
        source,
        buildIdentity,
        playwright,
        playwrightReport: reportEvidence,
        junit,
        receiptVersion: 1,
      },
      null,
      2,
    ) + "\n",
  );
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const receipt = writeCiValidationReceipt();
  console.log(`Functional CI evidence: ${receipt.functionalReady ? "PASSED" : "NOT_READY"}`);
  if (process.argv.includes("--assert-ready") && !receipt.functionalReady) process.exitCode = 1;
}
