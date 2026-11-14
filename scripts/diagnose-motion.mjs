import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, hostname, loadavg, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertBuildMatchesSource, sourceIdentity } from "./build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = require.resolve("@playwright/test/cli");
const files = [
  "tests/e2e/automatic-board-continuity.spec.ts",
  "tests/e2e/replay-click-continuity.spec.ts",
  "tests/e2e/overlay-continuity.spec.ts",
  "tests/e2e/paper-theater.spec.ts",
];
export const selectedTitles = [
  "automatic A body preserves paper and following board at 1440px 快速",
  "automatic A body preserves paper and following board at 390px 常速",
  "normal click continuity: event-registration multiple at 1440px 快速",
  "normal interaction: one paper hands detail to supplement and conditions at 1440px, round 3",
  "paper theater: handoff returns in one continuous motion at 1440px",
];
const grep = `(?:${selectedTitles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
const selection = [
  "test",
  ...files,
  "--project=chromium",
  "--workers=1",
  "--retries=0",
  "--max-failures=0",
  "--repeat-each=3",
  "--grep",
  grep,
];
const phases = [
  { name: "a1", trace: "retain-on-failure" },
  { name: "b", trace: "off" },
  { name: "a2", trace: "retain-on-failure" },
];
const environment = {
  ...process.env,
  CI: "1",
  E2E_PORT: "3100",
  E2E_WEBKIT: "",
  PLAYWRIGHT_CHANNEL: "",
  PLAYWRIGHT_HTML_OPEN: "never",
  MODEL_API_KEY: "",
  DEEPSEEK_API_KEY: "",
  OPENAI_API_KEY: "",
  TAVILY_API_KEY: "",
  ARENA_BILLING_DATABASE_PATH: "",
  ARENA_WORKER_ENABLED: "false",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const failure = (error) => ({ name: error.name, message: error.message });

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function assertSourceAndBuild(sha, directory = root) {
  const source = sourceIdentity(directory);
  assert.equal(source.commit, sha, "Diagnostic checkout differs from the requested exact SHA.");
  assert.equal(source.workingTreeDirty, false, "Diagnostic source must be committed and clean.");
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: directory,
      encoding: "utf8",
    }).trim(),
    "",
    "Diagnostic checkout must be clean.",
  );
  const build = assertBuildMatchesSource(directory);
  assert.equal(build.commit, sha, "Diagnostic build belongs to another commit.");
  assert.equal(build.workingTreeDirty, false, "Diagnostic build contains uncommitted source.");
  return { source, build };
}

async function identity(sha) {
  const fixed = assertSourceAndBuild(sha);
  const playwrightRequire = createRequire(require.resolve("@playwright/test/package.json"));
  const packagePath = playwrightRequire.resolve("playwright/package.json");
  const coreRequire = createRequire(packagePath);
  const coreRoot = dirname(coreRequire.resolve("playwright-core/package.json"));
  const { registry } = coreRequire(join(coreRoot, "lib/coreBundle.js")).registry;
  const executables = [];
  for (const name of ["chromium", "chromium-headless-shell"]) {
    const path = await realpath(registry.findExecutable(name).executablePath());
    executables.push({
      name,
      path,
      sha256: await hashFile(path),
      version: execFileSync(path, ["--version"], { encoding: "utf8", env: environment }).trim(),
    });
  }
  const fonts = execFileSync("fc-list", ["--format", "%{file}|%{family}|%{style}\n"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort()
    .join("\n");
  assert(fonts.length, "Font inventory must be available for the controlled comparison.");
  return {
    ...fixed,
    browser: {
      playwrightVersion: JSON.parse(await readFile(packagePath, "utf8")).version,
      executables,
    },
    fonts: { sha256: digest(fonts), inventory: fonts },
  };
}

function casesOf(report) {
  const cases = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) cases.push({ title: spec.title, test });
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return cases;
}

function assertSelection(report) {
  const cases = casesOf(report);
  assert.equal(
    cases.length,
    15,
    "Each phase must discover five selected cases repeated three times.",
  );
  for (const title of selectedTitles)
    assert.equal(
      cases.filter((item) => item.title === title).length,
      3,
      `Selected case coverage changed: ${title}`,
    );
  return cases;
}

async function retainAttachments(report, directory) {
  const output = join(directory, "raw-json-attachments");
  await mkdir(output);
  const index = [];
  for (const { title, test } of casesOf(report))
    for (const result of test.results ?? [])
      for (const attachment of result.attachments ?? []) {
        if (attachment.contentType !== "application/json") continue;
        const bytes =
          attachment.body !== undefined
            ? Buffer.from(attachment.body, "base64")
            : await readFile(attachment.path);
        const name = `${String(index.length + 1).padStart(3, "0")}-${digest(bytes).slice(0, 16)}.json`;
        await writeFile(join(output, name), bytes, { flag: "wx", mode: 0o600 });
        index.push({
          title,
          retry: result.retry,
          status: result.status,
          attachment: attachment.name,
          originalPath: attachment.path ?? null,
          file: name,
          sha256: digest(bytes),
          bytes: bytes.length,
        });
      }
  await json(join(output, "index.json"), index);
  return index.length;
}

async function run(args, env, logPath, onChild) {
  const log = openSync(logPath, "wx", 0o600);
  try {
    return await new Promise((accept) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", log, log],
      });
      onChild(child);
      let error = null;
      child.once("error", (value) => {
        error = failure(value);
      });
      child.once("close", (exitCode, signal) => accept({ exitCode, signal, error }));
    });
  } finally {
    closeSync(log);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      sha: { type: "string" },
      output: { type: "string" },
      groups: { type: "string", default: "3" },
      preflight: { type: "boolean" },
    },
  });
  assert(
    /^[a-f0-9]{40}$/.test(values.sha ?? ""),
    "Supply --sha with the exact 40-character commit SHA.",
  );
  const groups = Number(values.groups);
  assert([1, 3].includes(groups), "Use one or three complete A/B/A groups.");
  // Check source and build before launching any diagnostic browser process.
  assertSourceAndBuild(values.sha);
  assert.equal(process.version, "v24.19.0", "Use Node.js 24.19.0.");
  assert.equal(
    platform(),
    "linux",
    "This controlled experiment runs on the Linux workflow runner.",
  );
  assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), "11.19.0");
  const initial = await identity(values.sha);
  const listEnvironment = { ...environment };
  delete listEnvironment.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete listEnvironment.PLAYWRIGHT_JSON_OUTPUT_DIR;
  delete listEnvironment.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const listing = JSON.parse(
    execFileSync(process.execPath, [cli, ...selection, "--list", "--reporter=json"], {
      cwd: root,
      env: listEnvironment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  assertSelection(listing);
  if (values.preflight) {
    console.log(
      JSON.stringify({
        status: "preflight-passed",
        selectedTitles,
        casesPerPhase: 15,
        phases: groups * 3,
        totalCases: groups * 45,
        identity: initial,
      }),
    );
    return;
  }
  const output = resolve(values.output ?? join(root, "artifacts/motion-diagnostics"));
  assert(
    ["artifacts", "work"].includes(relative(root, output).split("/")[0]),
    "Use a new generated artifacts/ or work/ output directory.",
  );
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  await json(join(output, "selection.json"), listing);
  const record = {
    kind: "serial-trace-a-b-a-functional-motion-diagnostic",
    status: "running",
    expectedSha: values.sha,
    selectedTitles,
    repeatsPerCase: 3,
    groups,
    casesPerPhase: 15,
    physicalAcceptance: "not_run",
    startedAt: new Date().toISOString(),
    runnerSha256: await hashFile(fileURLToPath(import.meta.url)),
    host: {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      release: release(),
      node: process.version,
      cpuCount: cpus().length,
      cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    },
    initialIdentity: initial,
    phases: [],
  };
  await json(join(output, "record.json"), record);
  let activeChild = null;
  let interrupted = null;
  const interrupt = (signal) => {
    interrupted = signal;
    if (activeChild?.pid) {
      try {
        process.kill(-activeChild.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    for (let group = 1; group <= groups && !interrupted; group++)
      for (const configuration of phases) {
        if (interrupted) break;
        const directory = join(output, `group-${group}-${configuration.name}`);
        await mkdir(directory);
        const phase = {
          group,
          ...configuration,
          status: "running",
          exitCode: null,
          signal: null,
          executed: false,
          startedAt: new Date().toISOString(),
          loadAverageBefore: loadavg(),
          errors: [],
        };
        record.phases.push(phase);
        try {
          phase.identityBefore = await identity(values.sha);
          assert.deepEqual(
            phase.identityBefore,
            initial,
            "Source, build, browser or font identity changed before the phase.",
          );
          const args = [
            ...selection,
            `--trace=${configuration.trace}`,
            `--output=${join(directory, "test-results")}`,
            "--reporter=list,json,html",
          ];
          phase.command = [process.execPath, cli, ...args];
          await json(join(directory, "invocation.json"), phase);
          await json(join(output, "record.json"), record);
          assert(!interrupted, "Diagnostic interrupted before launching this phase.");
          console.log(
            `Motion diagnostic group ${group} ${configuration.name}, trace ${configuration.trace}, 15 functional cases.`,
          );
          Object.assign(
            phase,
            await run(
              args,
              {
                ...environment,
                DEBUG: "pw:browser",
                PW_TRACE_MODE: configuration.trace === "off" ? "off" : "retain",
                PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, "report.json"),
                PLAYWRIGHT_HTML_OUTPUT_DIR: join(directory, "html"),
              },
              join(directory, "stdout-stderr.log"),
              (child) => {
                activeChild = child;
                phase.executed = Boolean(child.pid);
              },
            ),
          );
          activeChild = null;
          const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
          phase.reportSha256 = await hashFile(join(directory, "report.json"));
          phase.logSha256 = await hashFile(join(directory, "stdout-stderr.log"));
          phase.reportStats = report.stats;
          phase.rawJsonAttachments = await retainAttachments(report, directory);
          const cases = assertSelection(report);
          assert(
            cases.every(
              ({ test }) => test.expectedStatus === "passed" && test.results?.length === 1,
            ),
            "Every selected case must execute once without skips or retries.",
          );
          assert.equal(
            report.stats.expected +
              report.stats.unexpected +
              report.stats.flaky +
              report.stats.skipped,
            15,
            "Official report totals are incomplete.",
          );
          assert.equal(
            report.stats.skipped + report.stats.flaky,
            0,
            "Diagnostic cases cannot be skipped or retried.",
          );
          phase.executionOrder = cases
            .map(({ title, test }) => ({ title, startedAt: test.results[0].startTime }))
            .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
            .map(({ title }) => title);
          record.executionOrder ??= phase.executionOrder;
          assert.deepEqual(
            phase.executionOrder,
            record.executionOrder,
            "Case execution order changed between diagnostic phases.",
          );
          const browserLog = await readFile(join(directory, "stdout-stderr.log"), "utf8");
          const launches = [...browserLog.matchAll(/<launching> (.+?) --/g)];
          phase.actualBrowserPaths = [...new Set(launches.map((match) => match[1]))];
          assert(
            phase.actualBrowserPaths.length > 0,
            "Actual browser launches are missing from the diagnostic log.",
          );
          const headlessPath = initial.browser.executables.find(
            (item) => item.name === "chromium-headless-shell",
          ).path;
          for (const path of phase.actualBrowserPaths)
            assert.equal(
              await realpath(path),
              headlessPath,
              "The actual launched browser differs from the fixed headless-shell binary.",
            );
          phase.status =
            phase.exitCode === 0 &&
            report.stats.unexpected === 0 &&
            !report.errors?.length &&
            cases.every(({ test }) => test.results[0].status === "passed")
              ? "diagnostic-functional-passed"
              : "observed-functional-test-failure";
        } catch (error) {
          phase.errors.push(failure(error));
          phase.status = "infrastructure-or-identity-failure";
        } finally {
          try {
            phase.identityAfter = await identity(values.sha);
            assert.deepEqual(
              phase.identityAfter,
              initial,
              "Source, build, browser or font identity changed during the phase.",
            );
          } catch (error) {
            phase.errors.push(failure(error));
            phase.status = "infrastructure-or-identity-failure";
          }
          phase.finishedAt = new Date().toISOString();
          phase.loadAverageAfter = loadavg();
          await json(join(directory, "result.json"), phase);
          await json(join(output, "record.json"), record);
        }
      }
    record.status = interrupted
      ? "interrupted"
      : record.phases.every((phase) => phase.status === "diagnostic-functional-passed")
        ? "completed-functional-diagnostic"
        : "completed-with-failures";
    process.exitCode =
      interrupted === "SIGINT"
        ? 130
        : interrupted === "SIGTERM"
          ? 143
          : record.phases.some((phase) => phase.status === "infrastructure-or-identity-failure")
            ? 2
            : record.phases.some((phase) => phase.status !== "diagnostic-functional-passed")
              ? 1
              : 0;
  } catch (error) {
    record.status = "infrastructure-or-identity-failure";
    record.error = failure(error);
    process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    record.finishedAt = new Date().toISOString();
    await json(join(output, "record.json"), record);
    console.log(
      JSON.stringify({
        output,
        status: record.status,
        physicalAcceptance: "not_run",
        phases: record.phases.map(({ group, name, status, exitCode, signal }) => ({
          group,
          name,
          status,
          exitCode,
          signal,
        })),
      }),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Motion diagnostic failed. ${error.message}`);
    process.exitCode = 2;
  });
}
