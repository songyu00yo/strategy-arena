/** Synthetic temporary repositories and archives only. No deployable application is built. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "./build.mjs";
import { VALIDATION_STEPS, writeCiValidationReceipt } from "./ci-validation-report.mjs";

const manifestScript = resolve("scripts/release-manifest.mjs");
const packageScript = resolve("scripts/package-release.mjs");
const verifyScript = resolve("scripts/verify-release.mjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "arena-manifest-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.name", "Synthetic manifest test");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, ".gitignore"), ".next/\nartifacts/\ntest-results/\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "0.0.0-fixture", packageManager: "pnpm@11.19.0" }),
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "explicit-synthetic-lock\n");
  mkdirSync(join(root, "config"));
  writeFileSync(
    join(root, "config/model.json"),
    JSON.stringify({ model: "synthetic-fixture-only" }),
  );
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "migrations/001_fixture.sql"), "-- explicit synthetic migration\n");
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app/source.txt"), "explicit original fixture source\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Synthetic manifest fixture only");
  const info = build({
    directory: root,
    run(directory) {
      mkdirSync(join(directory, ".next/standalone/.next/server"), { recursive: true });
      mkdirSync(join(directory, ".next/static"), { recursive: true });
      writeFileSync(join(directory, ".next/BUILD_ID"), "synthetic-build");
      writeFileSync(
        join(directory, ".next/standalone/server.js"),
        "// Explicit synthetic build fixture only\n",
      );
      writeFileSync(
        join(directory, ".next/static/chunk.js"),
        "// Explicit synthetic static fixture\n",
      );
    },
  });
  mkdirSync(join(root, "test-results"));
  const report = {
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [],
    suites: [
      {
        specs: [
          {
            tests: [
              { expectedStatus: "passed", status: "expected", results: [{ status: "passed" }] },
            ],
          },
        ],
      },
    ],
  };
  writeFileSync(join(root, "test-results/e2e.json"), JSON.stringify(report));
  const receipt = writeCiValidationReceipt({
    directory: root,
    env: Object.fromEntries(
      VALIDATION_STEPS.map((name) => [`CI_STEP_${name.toUpperCase()}`, "success"]),
    ),
  });
  const archive = join(root, "artifacts/fixture.tar.gz");
  execFileSync(process.execPath, [packageScript, archive], { cwd: root, stdio: "pipe" });
  const output = join(root, "artifacts/manifest.json");
  const receiptFile = join(root, "artifacts/ci-receipt.json");
  const checksFile = join(root, "artifacts/checks.json");
  const displayFile = join(root, "artifacts/display-receipt.json");
  const modelFile = join(root, "artifacts/model-receipt.json");
  const display = { status: "passed", source: { commit: info.commit, workingTreeDirty: false } };
  const model = {
    ...display,
    humanAcceptance: "not_claimed",
    publicCasePublished: false,
    simulationOnly: true,
  };
  const write = (file, value) => writeFileSync(file, JSON.stringify(value));
  write(displayFile, display);
  write(modelFile, model);
  const run = (kind = "ci", extra = [], omit = []) => {
    const fields = {
      "--kind": kind,
      "--checks": checksFile,
      "--receipt": receiptFile,
      "--output": output,
    };
    if (kind !== "ci")
      Object.assign(fields, { "--display-receipt": displayFile, "--model-receipt": modelFile });
    const args = Object.entries(fields)
      .filter(([key]) => !omit.includes(key))
      .flat();
    args.push("--artifact", archive, "--artifact", join(root, "test-results/e2e.json"), ...extra);
    return spawnSync(process.execPath, [manifestScript, ...args], { cwd: root, encoding: "utf8" });
  };
  const repack = (overrides) => {
    const staging = join(root, "artifacts/repack");
    mkdirSync(staging, { recursive: true });
    write(join(staging, "release-info.json"), { ...info, ...overrides });
    execFileSync("tar", ["-czf", archive, "-C", staging, "."]);
  };
  return {
    root,
    git,
    info,
    receipt,
    report,
    receiptFile,
    checksFile,
    archive,
    output,
    displayFile,
    modelFile,
    display,
    model,
    write,
    run,
    repack,
  };
}

test("CI manifest binds source, compiled output, raw JSON and truthful receipt while preserving v1 fields", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(f.output));
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.kind, "ci");
  assert.equal(manifest.commit, f.info.commit);
  assert.equal(manifest.validation.receipt.sha256, digest(readFileSync(f.receiptFile)));
  assert.equal(manifest.validation.evidence.sha256, digest(readFileSync(f.checksFile)));
  assert.equal(manifest.buildIdentities.ci.identity.outputFingerprint, f.info.outputFingerprint);
  assert.equal(manifest.buildIdentities.archive.outputFingerprint, f.info.outputFingerprint);
  assert.equal(manifest.validation.displayAcceptance.status, "not_run");
  assert.equal(manifest.validation.modelAcceptance.status, "not_run");
  assert.equal(manifest.releaseReady, false);
  const verified = spawnSync(process.execPath, [verifyScript, f.output, f.archive, f.info.commit], {
    cwd: f.root,
    encoding: "utf8",
  });
  assert.equal(verified.status, 0, verified.stderr);
});

for (const missing of ["--receipt", "--display-receipt", "--model-receipt"])
  test(`candidate refuses missing ${missing}`, (t) => {
    const f = fixture(t);
    assert.notEqual(f.run("candidate", [], [missing]).status, 0);
  });

test("CI refuses a missing functional receipt", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run("ci", [], ["--receipt"]).status, 0);
});

test("candidate/deployed preserve independent build identities at the same clean source", (t) => {
  const f = fixture(t);
  f.repack({ outputFingerprint: "b".repeat(64) });
  assert.notEqual(f.run("ci").status, 0);
  for (const kind of ["candidate", "deployed"]) {
    const result = f.run(
      kind,
      kind === "deployed" ? ["--deploy-url", "https://example.invalid"] : [],
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(f.output));
    assert.equal(manifest.releaseReady, true);
    assert.equal(manifest.buildIdentities.ci.identity.outputFingerprint, f.info.outputFingerprint);
    assert.equal(manifest.buildIdentities.archive.outputFingerprint, "b".repeat(64));
    assert.equal(manifest.validation.displayAcceptance.sha256, digest(readFileSync(f.displayFile)));
    assert.equal(manifest.validation.modelAcceptance.sha256, digest(readFileSync(f.modelFile)));
  }
});

for (const [name, modify] of [
  [
    "failed independent check",
    (f) => {
      f.receipt.checks.scripts = "failed";
      f.write(f.receiptFile, f.receipt);
    },
  ],
  [
    "unexecuted check",
    (f) => {
      f.receipt.steps.evals.outcome = "skipped";
      f.write(f.receiptFile, f.receipt);
    },
  ],
  [
    "source commit mismatch",
    (f) => {
      f.receipt.source.commit = "a".repeat(40);
      f.write(f.receiptFile, f.receipt);
    },
  ],
  [
    "source fingerprint mismatch",
    (f) => {
      f.receipt.source.sourceFingerprint = "a".repeat(64);
      f.write(f.receiptFile, f.receipt);
    },
  ],
  [
    "dirty receipt",
    (f) => {
      f.receipt.source.workingTreeDirty = true;
      f.write(f.receiptFile, f.receipt);
    },
  ],
  [
    "incomplete build",
    (f) => {
      f.receipt.build.identity.outputFingerprint = null;
      f.write(f.receiptFile, f.receipt);
    },
  ],
  [
    "raw JSON hash mismatch",
    (f) => {
      f.write(join(f.root, "test-results/e2e.json"), {
        ...f.report,
        errors: [{ message: "Explicit synthetic error" }],
      });
    },
  ],
  [
    "summary mismatch",
    (f) => {
      f.receipt.playwright.summary.attempts++;
      f.write(f.receiptFile, f.receipt);
    },
  ],
  [
    "forged passing checks",
    (f) => {
      const checks = JSON.parse(readFileSync(f.checksFile));
      checks.playwright.flaky = 1;
      f.write(f.checksFile, checks);
    },
  ],
  ["archive source mismatch", (f) => f.repack({ sourceFingerprint: "a".repeat(64) })],
  ["archive commit mismatch", (f) => f.repack({ commit: "a".repeat(40) })],
])
  test(`manifest rejects ${name}`, (t) => {
    const f = fixture(t);
    modify(f);
    assert.notEqual(f.run().status, 0);
  });

for (const [name, file, change] of [
  ["wrong display commit", "displayFile", { source: { commit: "a".repeat(40) } }],
  ["unsupported display", "displayFile", { status: "unsupported" }],
  ["dirty display", "displayFile", { source: { workingTreeDirty: true } }],
  ["wrong model commit", "modelFile", { source: { commit: "a".repeat(40) } }],
  ["human participation claim", "modelFile", { humanAcceptance: "passed" }],
  ["published model case", "modelFile", { publicCasePublished: true }],
  ["missing simulation declaration", "modelFile", { simulationOnly: false }],
])
  test(`candidate refuses ${name}`, (t) => {
    const f = fixture(t);
    const prior = JSON.parse(readFileSync(f[file]));
    f.write(f[file], {
      ...prior,
      ...change,
      ...(change.source ? { source: { ...prior.source, ...change.source } } : {}),
    });
    assert.notEqual(f.run("candidate").status, 0);
  });

test("application-selection archive requires Git-object proof and retains separate fingerprint scopes", (t) => {
  const f = fixture(t);
  const selection = { completeRoots: ["app"], explicitFiles: ["package.json"] };
  const files = ["app/source.txt", "package.json"].map((path) => ({
    path,
    sha256: digest(f.git("show", f.info.commit + ":" + path)),
    executable: false,
  }));
  const fingerprint = digest(JSON.stringify(files));
  const sourceFile = join(f.root, "artifacts/source-manifest.json");
  const source = {
    commit: f.info.commit,
    workingTreeDirty: false,
    exportedSnapshotClean: true,
    sourceFingerprint: fingerprint,
    selection,
    files,
  };
  f.write(sourceFile, source);
  f.repack({
    sourceFingerprint: fingerprint,
    outputFingerprint: "c".repeat(64),
    sourceSelection: selection,
  });
  assert.notEqual(f.run("candidate").status, 0);
  const result = f.run("candidate", ["--source-manifest", sourceFile]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(f.output));
  assert.equal(manifest.buildIdentities.archive.scope, "git-commit-application-selection-build");
  assert.equal(manifest.buildIdentities.archive.sourceFingerprint, fingerprint);
  assert.equal(manifest.buildIdentities.ci.source.sourceFingerprint, f.info.sourceFingerprint);
  assert.equal(
    manifest.buildIdentities.archive.sourceSelectionProof.evidence.sha256,
    digest(readFileSync(sourceFile)),
  );
  source.files[0].sha256 = "d".repeat(64);
  f.write(sourceFile, source);
  assert.notEqual(f.run("candidate", ["--source-manifest", sourceFile]).status, 0);
});

for (const [name, report] of [
  [
    "flaky",
    {
      stats: { expected: 0, unexpected: 0, flaky: 1, skipped: 0 },
      errors: [],
      suites: [
        {
          specs: [
            { tests: [{ status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }] },
          ],
        },
      ],
    },
  ],
  [
    "failed",
    {
      stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
      errors: [],
      suites: [{ specs: [{ tests: [{ status: "unexpected", results: [{ status: "failed" }] }] }] }],
    },
  ],
  [
    "skipped",
    {
      stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 1 },
      errors: [],
      suites: [{ specs: [{ tests: [{ status: "skipped", results: [{ status: "skipped" }] }] }] }],
    },
  ],
  [
    "empty",
    { stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }, errors: [], suites: [] },
  ],
  [
    "unexecuted",
    {
      stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
      errors: [],
      suites: [{ specs: [{ tests: [{ status: "expected", results: [] }] }] }],
    },
  ],
])
  test(`recomputes ${name} raw JSON instead of accepting a forged passing summary`, (t) => {
    const f = fixture(t);
    const raw = join(f.root, "test-results/e2e.json");
    f.write(raw, report);
    const evidence = { path: "test-results/e2e.json", sha256: digest(readFileSync(raw)) };
    f.receipt.playwright.report = evidence;
    f.write(f.receiptFile, f.receipt);
    const checks = JSON.parse(readFileSync(f.checksFile));
    checks.playwrightReport = evidence;
    f.write(f.checksFile, checks);
    assert.notEqual(f.run().status, 0);
  });

for (const receiptFile of ["displayFile", "modelFile"]) {
  for (const dirty of [undefined, null, "false", true]) {
    test(`candidate rejects ${receiptFile} without boolean clean-source evidence (${String(dirty)})`, (t) => {
      const f = fixture(t);
      const accepted = JSON.parse(readFileSync(f[receiptFile]));
      if (dirty === undefined) delete accepted.source.workingTreeDirty;
      else accepted.source.workingTreeDirty = dirty;
      f.write(f[receiptFile], accepted);
      const result = f.run("candidate");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /acceptance is missing or belongs to another clean commit/);
    });
  }
}
