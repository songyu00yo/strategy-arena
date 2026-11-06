/** Real runtime acceptance. No environment files are loaded; no provider requests without --run. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArenaSnapshot, ModelMode } from "../src/lib/contracts";
import { ModelModeSchema } from "../src/lib/contracts";
import {
  assertResumeIdentity,
  assertResumeExecution,
  acquireOutputLock,
  FixtureSchema,
  planCases,
  resumeDecision,
  unresolvedBilling,
  sha256,
  type CasePlan,
} from "./live-acceptance-plan";

interface Options {
  run: boolean;
  out?: string;
  resume?: string;
  cases?: string[];
  exclude: string[];
  override?: ModelMode;
  help: boolean;
}
function options(args: string[]): Options {
  const result: Options = { run: false, exclude: [], help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run") result.run = true;
    else if (arg === "--dry-run") result.run = false;
    else if (arg === "--help") result.help = true;
    else {
      if (!["--out", "--resume", "--cases", "--exclude", "--model-mode"].includes(arg))
        throw new Error(`Unknown option: ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--out") result.out = value;
      if (arg === "--resume") result.resume = value;
      if (arg === "--cases") result.cases = value.split(",");
      if (arg === "--exclude") result.exclude = value.split(",");
      if (arg === "--model-mode") result.override = ModelModeSchema.parse(value);
    }
  }
  if (result.out && result.resume)
    throw new Error("Use --out for a new record or --resume for an existing record");
  return result;
}
type VersionRecord = CasePlan["versions"][number] & {
  status?: string;
  versionId?: string;
  failureCode?: string;
};
type CaseRecord = Omit<CasePlan, "versions"> & {
  owner: string;
  arenaId?: string;
  mutationPending?: boolean;
  versions: VersionRecord[];
  snapshot?: ArenaSnapshot;
};
interface RecordFile {
  kind: "real-runtime-on-synthetic-input";
  fixtureSha256: string;
  planSha256: string;
  databaseIdentity: string;
  frozenFixture: unknown;
  createdAt: string;
  updatedAt: string;
  executionOptions: { cases?: string[]; exclude: string[]; override?: ModelMode };
  provenance: {
    commit: string;
    dirty: boolean;
    sourceDiffSha256: string;
    sourceFiles: { path: string; sha256: string }[];
    node: string;
  };
  configurations?: unknown;
  billingBefore?: unknown;
  billingAfter?: unknown;
  failures: { caseId?: string; code: string; at: string }[];
  cases: CaseRecord[];
  semanticAcceptance: "not-reviewed";
  captureScope: string;
}
function safeCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,100}$/.test(code) ? code : "RUNNER_ERROR";
}
function git(args: string[]) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function sourceProvenance(): RecordFile["provenance"] {
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain"])),
    sourceDiffSha256: sha256(git(["diff", "HEAD"])),
    sourceFiles: [
      "scripts/live-acceptance.ts",
      "scripts/live-acceptance-plan.ts",
      "src/lib/server/runtime.ts",
      "src/lib/server/model.ts",
      "src/lib/server/billing.ts",
      "src/lib/server/db.ts",
      "src/lib/server/tools.ts",
      "src/lib/model-routing.ts",
      "src/lib/contracts.ts",
      "prompts/protocol.ts",
      "config/model.json",
    ].map((path) => ({ path, sha256: sha256(readFileSync(path, "utf8")) })),
    node: process.version,
  };
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Dry run: pnpm exec tsx scripts/live-acceptance.ts [--cases learning,team] [--exclude creation] [--model-mode deepseek]\nReal run: add --run --out artifacts/live-acceptance-NAME.json\nResume: --run --resume artifacts/live-acceptance-NAME.json (saved selection/override retained)\nNo .env files are loaded. Set explicit arena and shared billing database paths. Terminal/uncertain attempts are never blindly retried. All semantic review remains manual.",
    );
    return;
  }
  const fixtureText = readFileSync(resolve("evals/live-acceptance.json"), "utf8");
  const fixture = FixtureSchema.parse(JSON.parse(fixtureText));
  const previous: RecordFile | undefined = opts.resume
    ? JSON.parse(readFileSync(opts.resume, "utf8"))
    : undefined;
  if (previous && (opts.cases || opts.exclude.length || opts.override))
    throw new Error("Resume retains saved selection and override; do not supply selection options");
  const executionOptions = previous?.executionOptions ?? {
    cases: opts.cases,
    exclude: opts.exclude,
    override: opts.override,
  };
  const plan = planCases(
    fixture,
    executionOptions.cases,
    executionOptions.exclude,
    executionOptions.override,
  );
  if (!plan.length) throw new Error("No cases selected");
  const identity = {
    fixtureSha256: sha256(fixtureText),
    planSha256: sha256(JSON.stringify(plan)),
    databaseIdentity: sha256(
      JSON.stringify([process.env.ARENA_DATABASE_PATH, process.env.ARENA_BILLING_DATABASE_PATH]),
    ),
  };
  if (previous && opts.run) assertResumeIdentity(previous, identity);
  if (!opts.run) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          providerRequests: 0,
          fixtureSha256: identity.fixtureSha256,
          versions: plan.flatMap((item) =>
            item.versions.map((version) => ({
              caseId: item.id,
              version: version.name,
              plannedMode: version.plannedMode,
              plannedProvider: version.plannedRoute.provider,
              executionMode: version.executionMode,
              executionProvider: version.executionRoute.provider,
              validationLabel: version.validationLabel,
            })),
          ),
          semanticAcceptance: "not-reviewed",
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const key of ["ARENA_DATABASE_PATH", "ARENA_BILLING_DATABASE_PATH"])
    if (!process.env[key] || !isAbsolute(process.env[key]!))
      throw new Error(`Set an explicit absolute ${key}; defaults are refused`);
  const output = resolve(opts.resume ?? opts.out ?? `artifacts/live-acceptance-${Date.now()}.json`);
  const artifacts = resolve("artifacts");
  if (!output.startsWith(`${artifacts}${sep}`))
    throw new Error("Output must be private and inside artifacts/");
  if (!previous && existsSync(output))
    throw new Error("Output exists; use --resume to preserve paid attempts");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const unlock = acquireOutputLock(output);
  try {
    // Recheck while holding the lock; another completed invocation may have created it.
    if (!previous && existsSync(output)) throw new Error("Output exists; use --resume");
    if (
      previous &&
      JSON.stringify(JSON.parse(readFileSync(output, "utf8"))) !== JSON.stringify(previous)
    )
      throw new Error("Resume record changed before the output lock was acquired; reload it");
    const currentProvenance = sourceProvenance();
    if (previous) assertResumeExecution(previous.provenance, currentProvenance, "source");
    const record: RecordFile = previous ?? {
      kind: "real-runtime-on-synthetic-input",
      ...identity,
      frozenFixture: fixture,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionOptions,
      provenance: currentProvenance,
      failures: [],
      cases: plan.map((item) => ({ ...item, owner: randomUUID() })),
      semanticAcceptance: "not-reviewed",
      captureScope:
        "Snapshots retain original parsed structured outputs before server rules, validated results, rejected outputs and usage via runtime events. Raw HTTP envelopes are not exposed by the runtime and are not claimed as captured. Inputs are synthetic; no human usability acceptance is implied.",
    };
    function save() {
      record.updatedAt = new Date().toISOString();
      const temp = `${output}.tmp`;
      writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, output);
    }
    save(); // Freeze input hash and owner IDs before importing any runtime or creating arenas.
    const billing = await import("../src/lib/server/billing");
    const runtime = await import("../src/lib/server/runtime");
    const { getModelConfig } = await import("../src/lib/server/model");
    const { closeDb } = await import("../src/lib/server/db");
    try {
      const currentConfigurations = (["deepseek", "openai"] as const).map((provider) => {
        try {
          return getModelConfig(provider);
        } catch {
          return { provider, invalidConfiguration: true };
        }
      });
      if (previous)
        assertResumeExecution(record.configurations, currentConfigurations, "configuration");
      record.configurations ??= currentConfigurations;
      record.billingBefore ??= billing.getBillingSummary();
      if (unresolvedBilling(billing.getBillingSummary()))
        throw Object.assign(new Error(), { code: "UNRESOLVED_BILLING_STOP" });
      save();
      let stopBatch = false;
      for (const item of record.cases) {
        try {
          if (item.mutationPending)
            throw Object.assign(new Error(), { code: "CREATION_RECONCILIATION_REQUIRED" });
          if (item.arenaId) item.snapshot = runtime.getArena(item.arenaId, item.owner);
          for (const version of item.versions) {
            if (
              version.status === "blocked-missing-configuration" ||
              version.status === "blocked-invalid-configuration"
            )
              continue;
            let config;
            try {
              config = getModelConfig(version.executionRoute.provider);
            } catch {
              version.status = "blocked-invalid-configuration";
              save();
              continue;
            }
            if (!config.configured) {
              version.status = "blocked-missing-configuration";
              save();
              continue;
            }
            if (!version.versionId) {
              if (
                version.name === "changed" &&
                item.snapshot?.versions.some((candidate) =>
                  ["running", "ready", "uncertain"].includes(candidate.status),
                )
              ) {
                version.status = "blocked-parent-incomplete";
                save();
                break;
              }
              item.mutationPending = true;
              save();
              item.snapshot = item.arenaId
                ? runtime.newVersion(
                    item.arenaId,
                    item.owner,
                    version.challenge,
                    version.reason,
                    undefined,
                    version.executionMode,
                  )
                : runtime.createArena(version.challenge, item.owner, version.executionMode);
              item.arenaId = item.snapshot.id;
              version.versionId = item.snapshot.activeVersionId;
              item.mutationPending = false;
              save();
            }
            // The runtime owns request IDs, central reservations, repair attempts and duplicate limits.
            for (let steps = 0; steps < 40; steps++) {
              item.snapshot = runtime.getArena(item.arenaId!, item.owner);
              const current = item.snapshot.versions.find(
                (candidate) => candidate.id === version.versionId,
              );
              if (!current) throw Object.assign(new Error(), { code: "VERSION_NOT_FOUND" });
              version.status = current.status;
              save();
              const decision = resumeDecision(
                current.status,
                item.snapshot.steps
                  .filter((step) => step.versionId === current.id)
                  .map((step) => step.status),
              );
              if (decision === "manual-reconciliation" || decision === "wait-existing-request")
                throw Object.assign(new Error(), { code: "UNRESOLVED_REQUEST_STOP" });
              if (current.status === "failed")
                throw Object.assign(new Error(), { code: "FAILED_VERSION_REVIEW_REQUIRED" });
              if (decision !== "advance") break;
              if (unresolvedBilling(billing.getBillingSummary()))
                throw Object.assign(new Error(), { code: "UNRESOLVED_BILLING_STOP" });
              const before = JSON.stringify(item.snapshot);
              item.snapshot = await runtime.advanceArena(item.arenaId!, item.owner, current.id);
              version.status = item.snapshot.versions.find(
                (candidate) => candidate.id === version.versionId,
              )!.status;
              record.billingAfter = billing.getBillingSummary();
              save();
              if (unresolvedBilling(billing.getBillingSummary()))
                throw Object.assign(new Error(), { code: "UNRESOLVED_BILLING_STOP" });
              if (version.status === "uncertain")
                throw Object.assign(new Error(), { code: "UNRESOLVED_REQUEST_STOP" });
              if (JSON.stringify(item.snapshot) === before) break;
            }
          }
        } catch (error) {
          stopBatch = [
            "UNRESOLVED_BILLING_STOP",
            "UNRESOLVED_REQUEST_STOP",
            "FAILED_VERSION_REVIEW_REQUIRED",
            "RUN_BUDGET",
            "GLOBAL_BUDGET",
            "BILLING_LIMIT_REACHED",
          ].includes(safeCode(error));
          record.failures.push({
            caseId: item.id,
            code: safeCode(error),
            at: new Date().toISOString(),
          });
          if (item.arenaId) {
            try {
              item.snapshot = runtime.getArena(item.arenaId, item.owner);
            } catch {
              /* Keep the last successfully exported snapshot. */
            }
          }
          save();
        }
        if (stopBatch) break;
      }
    } catch (error) {
      record.failures.push({ code: safeCode(error), at: new Date().toISOString() });
    } finally {
      // A crash may have left the saved snapshot before dispatch. Refresh all existing arenas
      // even when the central ledger refuses every further request.
      for (const item of record.cases) {
        if (!item.arenaId) continue;
        try {
          item.snapshot = runtime.getArena(item.arenaId, item.owner);
          for (const version of item.versions) {
            const current = item.snapshot.versions.find(
              (candidate) => candidate.id === version.versionId,
            );
            if (current) version.status = current.status;
          }
        } catch {
          /* Retain the last successfully exported snapshot. */
        }
      }
      try {
        record.billingAfter = billing.getBillingSummary();
      } catch (error) {
        record.failures.push({ code: safeCode(error), at: new Date().toISOString() });
      }
      save();
      closeDb();
    }
    console.log(
      JSON.stringify(
        {
          output,
          fixtureSha256: record.fixtureSha256,
          failures: record.failures.length,
          semanticAcceptance: record.semanticAcceptance,
          versions: record.cases.flatMap((item) =>
            item.versions.map((version) => ({
              caseId: item.id,
              version: version.name,
              status: version.status ?? "not-started",
              validationLabel: version.validationLabel,
            })),
          ),
        },
        null,
        2,
      ),
    );
    if (
      record.failures.length ||
      record.cases.some((item) => item.versions.some((version) => version.status !== "completed"))
    )
      process.exitCode = 1;
  } finally {
    unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "Acceptance runner stopped. No credentials printed; inspect the private saved record if created. No automatic paid retry was performed.",
    );
    process.exitCode = 1;
  });
}
