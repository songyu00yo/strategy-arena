/** Private real-model acceptance evidence. No environment files or paid calls without --run. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMode } from "../src/lib/contracts";
import type {
  CreatePlanningInput,
  PlanningAction,
  PlanningSnapshot,
} from "../src/lib/planning-contracts";
import { PLANNING_PROMPT_VERSION, PLANNING_SCHEMA_VERSION } from "../prompts/planning";
import { acquireOutputLock, sha256 } from "./live-acceptance-plan";
import {
  assertPlanningBillingWindow,
  assertPlanningBillingPolicy,
  PLANNING_ACCEPTANCE_MAX_CALLS,
  PLANNING_ACCEPTANCE_MAX_STEPS,
  PlanningAcceptanceFixtureSchema,
  planningAcceptanceDecision,
  planningAcceptanceErrorCode,
  planningAcceptanceOptions,
  planningAcceptanceStop as stop,
  type PlanningAcceptanceCall,
  type PlanningAcceptanceFixture,
} from "./live-planning-acceptance-plan";

type BillingSummary = ReturnType<typeof import("../src/lib/server/billing").getBillingSummary>;
type Unresolved = ReturnType<
  typeof import("../src/lib/server/billing").getUnresolvedBillingAttempts
>;
type Configuration = ReturnType<typeof import("../src/lib/server/model").resolveModelConfig>;
type FrozenCase = PlanningAcceptanceFixture["cases"][number];
interface OperationRecord {
  kind: "create" | "advance" | "preview";
  payload: CreatePlanningInput | PlanningAction;
  dispatchStatus: "prepared" | "returned" | "threw";
  preparedAt: string;
  errorCode?: string;
}
export interface PlanningAcceptanceCaseRecord {
  input: FrozenCase;
  owner: string;
  modelMode: ModelMode;
  status: "not-started" | "running" | "structurally-complete" | "failed";
  sessionId?: string;
  operations: OperationRecord[];
  snapshots: PlanningSnapshot[];
  calls: PlanningAcceptanceCall[];
  previewRequested: boolean;
  modelActions: number;
  failureCode?: string;
  captureFailureCode?: string;
}
interface ExecutionDependencies {
  create: (owner: string, input: CreatePlanningInput) => PlanningSnapshot;
  get: (id: string, owner: string) => PlanningSnapshot;
  act: (id: string, owner: string, action: PlanningAction) => Promise<PlanningSnapshot>;
  calls: (id: string) => PlanningAcceptanceCall[];
  guard: (nextRequests: 0 | 1) => void;
  checkpoint: () => void;
}

/** Dependency injection is for deterministic, explicitly synthetic guard tests only. */
export async function executePlanningAcceptance(
  item: PlanningAcceptanceCaseRecord,
  deps: ExecutionDependencies,
) {
  if (item.operations.length || item.sessionId) stop("RESUME_UNSUPPORTED_REVIEW_ORIGINAL_RECORD");
  const capture = (snapshot: PlanningSnapshot) => {
    item.sessionId = snapshot.session.id;
    item.snapshots.push(structuredClone(snapshot));
    item.calls = deps.calls(item.sessionId);
    deps.checkpoint();
    return snapshot;
  };
  const prepare = (kind: OperationRecord["kind"], payload: OperationRecord["payload"]) => {
    const operation: OperationRecord = {
      kind,
      payload,
      dispatchStatus: "prepared",
      preparedAt: new Date().toISOString(),
    };
    item.operations.push(operation);
    deps.checkpoint(); // Persist the exact ID, revision and payload before any dispatch.
    return operation;
  };
  let pending: OperationRecord | undefined;
  try {
    deps.guard(0);
    item.status = "running";
    const input: CreatePlanningInput = {
      operationId: randomUUID(),
      goal: item.input.goal,
      modelMode: item.modelMode,
    };
    pending = prepare("create", input);
    const created = deps.create(item.owner, input);
    pending.dispatchStatus = "returned";
    pending = undefined;
    let snapshot = capture(created);
    for (let step = 0; step < PLANNING_ACCEPTANCE_MAX_STEPS; step++) {
      deps.guard(0);
      const decision = planningAcceptanceDecision(
        snapshot,
        item.calls,
        item.modelActions,
        item.previewRequested,
      );
      if (decision === "complete") {
        item.status = "structurally-complete";
        deps.checkpoint();
        return;
      }
      deps.guard(1);
      const action: PlanningAction = {
        kind: decision,
        operationId: randomUUID(),
        revision: snapshot.session.revision,
      };
      item.modelActions++;
      if (decision === "preview") item.previewRequested = true;
      pending = prepare(decision, action);
      const result = await deps.act(snapshot.session.id, item.owner, action);
      pending.dispatchStatus = "returned";
      pending = undefined;
      snapshot = capture(result);
    }
    stop("PLANNING_ACCEPTANCE_STEP_CAP");
  } catch (error) {
    if (pending) {
      pending.dispatchStatus = "threw";
      pending.errorCode = planningAcceptanceErrorCode(error);
    }
    item.status = "failed";
    item.failureCode = planningAcceptanceErrorCode(error);
    if (item.sessionId) {
      try {
        capture(deps.get(item.sessionId, item.owner));
      } catch (captureError) {
        item.captureFailureCode = planningAcceptanceErrorCode(captureError);
      }
    }
    deps.checkpoint();
    throw error;
  }
}

function sourceIdentity() {
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const paths = [
    ...new Set([
      "scripts/live-planning-acceptance.ts",
      "scripts/live-planning-acceptance-plan.ts",
      "scripts/live-acceptance-plan.ts",
      "evals/planning-acceptance.json",
      "package.json",
      "pnpm-lock.yaml",
      ...git(["ls-files", "src", "prompts", "migrations", "config"]).split("\n").filter(Boolean),
    ]),
  ].sort();
  const sourceFiles = paths.map((path) => ({ path, sha256: sha256(readFileSync(path, "utf8")) }));
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain"])),
    sourceSha256: sha256(JSON.stringify(sourceFiles)),
    node: process.version,
    sourceFiles,
  };
}

/** Resolve aliases and hard links before a billing/runtime module can open a database. */
export function planningAcceptanceDatabasePaths(env: Readonly<Record<string, string | undefined>>) {
  const business = env.ARENA_DATABASE_PATH;
  const ledger = env.ARENA_BILLING_DATABASE_PATH;
  if (!business || !ledger || !isAbsolute(business) || !isAbsolute(ledger))
    stop("EXPLICIT_DATABASE_PATH_REQUIRED");
  if (!existsSync(ledger) || !statSync(ledger).isFile()) stop("EXISTING_BILLING_LEDGER_REQUIRED");
  const ledgerPath = realpathSync(ledger);
  const businessPath = existsSync(business)
    ? realpathSync(business)
    : resolve(realpathSync(dirname(business)), basename(business));
  const ledgerStat = statSync(ledgerPath);
  const businessStat = existsSync(businessPath) ? statSync(businessPath) : undefined;
  if (
    businessPath === ledgerPath ||
    (businessStat && businessStat.dev === ledgerStat.dev && businessStat.ino === ledgerStat.ino)
  )
    stop("DATABASES_MUST_BE_SEPARATE");
  if (businessStat && !businessStat.isFile()) stop("INVALID_BUSINESS_DATABASE_PATH");
  return { business: businessPath, ledger: ledgerPath };
}

function existsEvenIfBrokenLink(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function savePlanningAcceptanceRecord(output: string, value: unknown) {
  const temporary = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, output);
}

/** Read-only validation must succeed before the shared ledger accessor is allowed to open it. */
export function capturePlanningAcceptanceBilling<T>(
  readStatus: () => T,
  unresolved: () => Unresolved,
): { summary?: T; unresolved?: Unresolved; errorCode?: string } {
  let summary: T | undefined;
  try {
    summary = readStatus();
    return { summary, unresolved: unresolved() };
  } catch (error) {
    return { summary, errorCode: planningAcceptanceErrorCode(error) };
  }
}

interface RecordFile {
  kind: "real-planning-runtime-on-synthetic-input";
  audience: "private-acceptance-evidence-not-a-user-report";
  captureScope: string;
  semanticAcceptance: "not-reviewed";
  browserAcceptance: "not-run-by-this-script";
  humanAnswering: "not-covered-preview-unanswered-questions";
  confirmation: "not-performed";
  resumeSupported: false;
  fixtureSha256: string;
  inputSha256: string;
  provenance: ReturnType<typeof sourceIdentity>;
  databaseIdentity: string;
  createdAt: string;
  updatedAt: string;
  configuration?: Configuration;
  transportStructuredOutput: "strict-tool";
  ledgerBefore?: BillingSummary;
  billingBefore?: BillingSummary;
  billingAfter?: BillingSummary;
  unresolvedBillingAfter?: Unresolved;
  billingCaptureFailureCode?: string;
  failures: string[];
  case: PlanningAcceptanceCaseRecord;
}

export async function planningAcceptanceMain(args: string[]) {
  const options = planningAcceptanceOptions(args);
  if (options.help) {
    console.log(
      "Default: --dry-run [--case portfolio|unclear-goal] [--model-mode MODEL]. Paid execution requires --run --case CASE --model-mode MODEL --out artifacts/NAME.json, clean source, absolute separate ARENA_DATABASE_PATH and ARENA_BILLING_DATABASE_PATH, and an existing shared ledger with no reserved/held attempts. No environment files loaded, no resume or automatic retry. Review the original private record before any later run. This validates runtime structure only; human answers, report adoption, browser behavior and semantic quality are not accepted by this script.",
    );
    return;
  }
  const fixtureText = readFileSync(resolve("evals/planning-acceptance.json"), "utf8");
  const fixture = PlanningAcceptanceFixtureSchema.parse(JSON.parse(fixtureText));
  const cases = options.caseId
    ? fixture.cases.filter((item) => item.id === options.caseId)
    : fixture.cases;
  if (!cases.length) stop("UNKNOWN_PLANNING_CASE");
  if (!options.run) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          providerRequests: 0,
          databaseOpened: false,
          recordWritten: false,
          fixtureSha256: sha256(fixtureText),
          cases,
          modelMode: options.modelMode ?? null,
          maxModelActionsPerCase: PLANNING_ACCEPTANCE_MAX_CALLS,
          maxStepsPerCase: PLANNING_ACCEPTANCE_MAX_STEPS,
          answeringPolicy:
            "Do not answer; preview if A/B requests clarification, then finish D/E/C.",
          semanticAcceptance: "not-reviewed",
          browserAcceptance: "not-run-by-this-script",
        },
        null,
        2,
      ),
    );
    return;
  }
  const paths = planningAcceptanceDatabasePaths(process.env);
  const output = resolve(options.out!);
  const artifactDirectory = resolve("artifacts");
  if (
    dirname(output) !== artifactDirectory ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(basename(output))
  )
    stop("PRIVATE_ARTIFACT_PATH_REQUIRED");
  if (
    existsEvenIfBrokenLink(artifactDirectory) &&
    (!lstatSync(artifactDirectory).isDirectory() || lstatSync(artifactDirectory).isSymbolicLink())
  )
    stop("PRIVATE_ARTIFACT_DIRECTORY_REQUIRED");
  if (existsEvenIfBrokenLink(output)) stop("OUTPUT_EXISTS_REVIEW_ORIGINAL_RECORD");
  const provenance = sourceIdentity();
  if (provenance.dirty) stop("FREEZE_CLEAN_SOURCE_BEFORE_PAID_RUN");
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const unlock = acquireOutputLock(output);
  try {
    if (existsEvenIfBrokenLink(output)) stop("OUTPUT_EXISTS_REVIEW_ORIGINAL_RECORD");
    const record: RecordFile = {
      kind: "real-planning-runtime-on-synthetic-input",
      audience: "private-acceptance-evidence-not-a-user-report",
      captureScope:
        "Authoritative public planning snapshots, event IDs and operation payloads; local planning_calls retain structured model outputs, reservations, actual usage and errors. Internal executionPrompt/markdown fields may be present only as private evidence. No user Markdown is exported. Raw provider HTTP envelopes are not captured. Synthetic inputs; no human answers or report adoption.",
      semanticAcceptance: "not-reviewed",
      browserAcceptance: "not-run-by-this-script",
      humanAnswering: "not-covered-preview-unanswered-questions",
      confirmation: "not-performed",
      resumeSupported: false,
      fixtureSha256: sha256(fixtureText),
      inputSha256: sha256(JSON.stringify(cases[0])),
      provenance,
      databaseIdentity: sha256(JSON.stringify(paths)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      transportStructuredOutput: "strict-tool",
      failures: [],
      case: {
        input: cases[0],
        owner: `planning-acceptance-${randomUUID()}`,
        modelMode: options.modelMode!,
        status: "not-started",
        operations: [],
        snapshots: [],
        calls: [],
        previewRequested: false,
        modelActions: 0,
      },
    };
    const save = () => {
      record.updatedAt = new Date().toISOString();
      savePlanningAcceptanceRecord(output, record);
    };
    save();
    // Dynamic imports remain below the no-I/O dry-run return and path/source checks.
    let billing: typeof import("../src/lib/server/billing") | undefined;
    let database: typeof import("../src/lib/server/db") | undefined;
    try {
      billing = await import("../src/lib/server/billing");
      // A mere existing empty file is not a valid ledger: read-only validation comes first.
      record.ledgerBefore = billing.readBillingStatus(paths.ledger);
      record.billingBefore = billing.getBillingSummary();
      record.unresolvedBillingAfter = billing.getUnresolvedBillingAttempts();
      assertPlanningBillingWindow(
        record.billingBefore.requests,
        record.billingBefore.requests,
        record.unresolvedBillingAfter,
        0,
      );
      const model = await import("../src/lib/server/model");
      const configuration = () => ({
        ...model.resolveModelConfig(options.modelMode!),
        promptVersion: PLANNING_PROMPT_VERSION,
        schemaVersion: PLANNING_SCHEMA_VERSION,
      });
      record.configuration = configuration();
      if (!record.configuration.configured) stop("MODEL_NOT_CONFIGURED");
      const runtime = await import("../src/lib/server/planning");
      database = await import("../src/lib/server/db");
      const guard = (next: 0 | 1) => {
        if (JSON.stringify(sourceIdentity()) !== JSON.stringify(record.provenance))
          stop("SOURCE_CHANGED_STOP");
        if (JSON.stringify(configuration()) !== JSON.stringify(record.configuration))
          stop("CONFIGURATION_CHANGED_STOP");
        if (JSON.stringify(planningAcceptanceDatabasePaths(process.env)) !== JSON.stringify(paths))
          stop("DATABASE_CHANGED_STOP");
        record.billingAfter = billing!.getBillingSummary();
        record.unresolvedBillingAfter = billing!.getUnresolvedBillingAttempts();
        assertPlanningBillingPolicy(record.billingBefore!, record.billingAfter);
        assertPlanningBillingWindow(
          record.billingBefore!.requests,
          record.billingAfter.requests,
          record.unresolvedBillingAfter,
          next,
        );
      };
      await executePlanningAcceptance(record.case, {
        create: runtime.createPlanning,
        get: runtime.getPlanning,
        act: runtime.actPlanning,
        guard,
        checkpoint: save,
        calls: (id) => {
          const rows = database!
            .db()
            .prepare(
              "SELECT c.id,c.operation_id,c.role,c.state,c.reservation,c.usage,c.output,c.error,c.created_at,c.finished_at FROM planning_calls c JOIN planning_operations o ON o.id=c.operation_id WHERE o.session_id=? ORDER BY c.created_at,c.rowid",
            )
            .all(id) as unknown as {
            id: string;
            operation_id: string;
            role: PlanningAcceptanceCall["role"];
            state: string;
            reservation: string;
            usage: string | null;
            output: string | null;
            error: string | null;
            created_at: number;
            finished_at: number | null;
          }[];
          return rows.map((row) => ({
            id: row.id,
            operationId: row.operation_id,
            role: row.role,
            state: row.state,
            reservation: JSON.parse(row.reservation),
            usage: row.usage === null ? null : JSON.parse(row.usage),
            output: row.output === null ? null : JSON.parse(row.output),
            error: row.error,
            createdAt: row.created_at,
            finishedAt: row.finished_at,
          }));
        },
      });
    } catch (error) {
      record.case.status = "failed";
      record.failures.push(planningAcceptanceErrorCode(error));
    } finally {
      const finalBilling = capturePlanningAcceptanceBilling(
        () => {
          if (!billing) stop("BILLING_MODULE_UNAVAILABLE");
          return billing.readBillingStatus(paths.ledger);
        },
        () => {
          if (
            JSON.stringify(planningAcceptanceDatabasePaths(process.env)) !== JSON.stringify(paths)
          )
            stop("DATABASE_CHANGED_STOP");
          return billing!.getUnresolvedBillingAttempts();
        },
      );
      record.billingAfter = finalBilling.summary;
      // Undefined means capture failed; never retain an earlier [] as a final observation.
      record.unresolvedBillingAfter = finalBilling.unresolved;
      if (finalBilling.errorCode) {
        record.billingCaptureFailureCode = finalBilling.errorCode;
        record.failures.push("FINAL_BILLING_CAPTURE_FAILED");
        record.case.status = "failed";
      }
      database?.closeDb();
      save();
    }
    console.log(
      JSON.stringify({
        output,
        status: record.case.status,
        modelActions: record.case.modelActions,
        actualCallRecords: record.case.calls.length,
        previewRequested: record.case.previewRequested,
        failures: record.failures,
        semanticAcceptance: record.semanticAcceptance,
        browserAcceptance: record.browserAcceptance,
      }),
    );
    if (record.case.status !== "structurally-complete")
      stop(record.failures[0] ?? "PLANNING_ACCEPTANCE_INCOMPLETE");
  } finally {
    unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  planningAcceptanceMain(process.argv.slice(2)).catch((error) => {
    console.error(
      `Planning acceptance stopped (${planningAcceptanceErrorCode(error)}). Review the original private record and shared ledger before any further run. No resume, automatic retry, or credentials printed.`,
    );
    process.exitCode = 1;
  });
