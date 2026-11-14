/** Real guided-input acceptance. Default is read-only dry-run; never loads an environment file. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MODEL_IDS } from "../src/lib/model-catalog";
import type { ArenaSnapshot } from "../src/lib/contracts";
import type { IntakeAnswer, IntakeDraft, IntakeQuestion } from "../src/lib/intake-contracts";
import {
  acquireOutputLock,
  assertBillingAttemptsReviewed,
  assertResumeExecution,
  assertResumeIdentity,
  heldAcknowledgement,
  resumeDecision,
  sha256,
  type HeldAcknowledgement,
} from "./live-acceptance-plan";

const FactSchema = z.object({
  pattern: z.string().min(1),
  text: z.string().min(1),
  number: z.string().optional(),
  numberUnits: z.array(z.string()).default([]),
  options: z.array(z.string()),
});
export const GuidedFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtureId: z.string().min(1),
    inputProvenance: z.string(),
    requestLimit: z.number().int().positive().max(70),
    answerPolicy: z.string(),
    commonGoal: z.string().min(8),
    facts: z.array(FactSchema),
    assets: z.object({
      chartLines: z.array(z.string()).min(1).max(12),
      csv: z.string(),
      docxParagraphs: z.array(z.string()).min(1),
    }),
    cases: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z-]+$/),
          modelId: z.enum(MODEL_IDS),
          scope: z.enum(["full-flow", "vision-summary", "questions-summary"]),
          goal: z.string().min(2).optional(),
          facts: z.array(FactSchema).optional(),
        }),
      )
      .min(1),
    checks: z.array(z.string()),
  })
  .superRefine((fixture, context) => {
    if (new Set(fixture.cases.map((item) => item.id)).size !== fixture.cases.length)
      context.addIssue({ code: "custom", message: "Duplicate case IDs" });
    for (const fact of [...fixture.facts, ...fixture.cases.flatMap((item) => item.facts ?? [])]) {
      try {
        new RegExp(fact.pattern, "i");
      } catch {
        context.addIssue({ code: "custom", message: "Invalid frozen fact pattern" });
      }
    }
  });
type Fixture = z.infer<typeof GuidedFixtureSchema>;
export function guidedPlan(fixture: Fixture, selected?: string[]) {
  for (const caseId of selected ?? [])
    if (!fixture.cases.some((item) => item.id === caseId)) throw new Error("Unknown guided case");
  return fixture.cases
    .filter((item) => !selected || selected.includes(item.id))
    .map((item) => ({
      ...item,
      goal: item.goal ?? fixture.commonGoal,
      facts: item.facts ?? fixture.facts,
    }));
}
type PlannedCase = ReturnType<typeof guidedPlan>[number];
export function answerFrozenQuestion(
  question: IntakeQuestion,
  facts: z.infer<typeof FactSchema>[],
): IntakeAnswer {
  const unknown: IntakeAnswer = { questionId: question.id, state: "unknown", value: "" };
  const fact = facts.find((fact) => new RegExp(fact.pattern, "i").test(question.title));
  if (!fact || /每[天周月年日次]|日均|周均|月均/.test(question.title)) return unknown;
  if (question.type === "number") {
    const unit = question.unit.trim();
    const compatible = unit
      ? fact.numberUnits.includes(unit)
      : fact.numberUnits.some((known) => question.title.includes(known));
    if (!compatible || /万元|千元|百元|美元|美金|百分|%/.test(`${question.title} ${unit}`))
      return unknown;
    return fact.number !== undefined
      ? { questionId: question.id, state: "answered", value: fact.number }
      : unknown;
  }
  if (question.type === "text")
    return { questionId: question.id, state: "answered", value: fact.text };
  const matches = question.options.filter((option) => fact.options.includes(option));
  if (!matches.length || (question.type === "single" && matches.length !== 1)) return unknown;
  return {
    questionId: question.id,
    state: "answered",
    value: question.type === "multiple" ? matches : matches[0],
  };
}
export function guidedDraftDecision(status: IntakeDraft["status"]) {
  if (["uncertain", "analyzing"].includes(status)) return "stop-unknown";
  if (status === "failed") return "terminal-failure";
  if (["summary", "submitted"].includes(status)) return "terminal-ready";
  return status === "questions" ? "answer" : "analyze";
}
interface Options {
  run: boolean;
  help: boolean;
  out?: string;
  resume?: string;
  cases?: string[];
  acknowledgeHeld?: string[];
  reason?: string;
}
export function guidedOptions(args: string[]): Options {
  const options: Options = { run: false, help: false };
  let selectedRunFlag: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run" || arg === "--dry-run") {
      if (selectedRunFlag && selectedRunFlag !== arg) throw new Error("Choose --run or --dry-run");
      selectedRunFlag = arg;
      options.run = arg === "--run";
    } else if (arg === "--help") options.help = true;
    else {
      if (
        ![
          "--out",
          "--resume",
          "--cases",
          "--acknowledge-held",
          "--acknowledgement-reason",
        ].includes(arg)
      )
        throw new Error("Unknown option");
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing option value");
      if (arg === "--out") options.out = value;
      if (arg === "--resume") options.resume = value;
      if (arg === "--cases") options.cases = value.split(",");
      if (arg === "--acknowledge-held") options.acknowledgeHeld = value.split(",");
      if (arg === "--acknowledgement-reason") options.reason = value;
    }
  }
  if (options.out && options.resume) throw new Error("Use --out or --resume");
  if (options.resume && (options.cases || options.acknowledgeHeld || options.reason))
    throw new Error("Resume retains frozen selection and acknowledgement");
  return options;
}
export async function guidedAssets(fixture: Fixture) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { pdfFixture, zipFixture } = await import("../tests/fixtures/attachments/generate");
  const canvas = createCanvas(400, 500),
    context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 400, 500);
  context.fillStyle = "#151515";
  context.font = "17px sans-serif";
  fixture.assets.chartLines.forEach((line, index) =>
    context.fillText(line, 20, 35 + index * 40, 360),
  );
  [80, 120, 200].forEach((value, index) => {
    context.fillStyle = ["#3156c9", "#317f68", "#b47a2a"][index];
    context.fillRect(30, 370 + index * 32, value * 1.4, 20);
  });
  const png = canvas.toBuffer("image/png"),
    jpeg = canvas.toBuffer("image/jpeg");
  const xml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const docx = zipFixture({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${fixture.assets.docxParagraphs.map((paragraph) => `<w:p><w:r><w:t>${xml(paragraph)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
  });
  return [
    { name: "synthetic-plan-chart.png", bytes: png },
    { name: "synthetic-scanned-plan.pdf", bytes: pdfFixture(1, false, false, false, jpeg) },
    { name: "synthetic-routes.csv", bytes: Buffer.from(fixture.assets.csv) },
    { name: "synthetic-brief.docx", bytes: docx },
  ];
}
interface CaseRecord extends PlannedCase {
  owner: string;
  status: "not-started" | "running" | "completed" | "failed" | "uncertain";
  draftId?: string;
  draft?: IntakeDraft;
  arenaId?: string;
  snapshot?: ArenaSnapshot;
  operations: { operationId: string; revision: number; finish: boolean }[];
  assets?: { name: string; sha256: string; attachmentId?: string }[];
  callRecords?: unknown[];
  failureCode?: string;
}
interface RecordFile {
  kind: "real-guided-runtime-on-synthetic-input";
  fixtureSha256: string;
  planSha256: string;
  databaseIdentity: string;
  frozenFixture: Fixture;
  createdAt: string;
  updatedAt: string;
  executionOptions: { cases?: string[]; heldAcknowledgement?: HeldAcknowledgement };
  provenance: ReturnType<typeof provenance>;
  configurations?: unknown;
  billingBefore?: { requests: number; [key: string]: unknown };
  billingAfter?: unknown;
  unresolvedBillingAfter?: unknown;
  semanticAcceptance: "not-reviewed";
  browserAcceptance: "not-run-by-this-script";
  captureScope: string;
  failures: { caseId?: string; code: string; at: string }[];
  cases: CaseRecord[];
}
function git(args: string[]) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function provenance() {
  const files = [
    "scripts/live-guided-acceptance.ts",
    "scripts/live-acceptance-plan.ts",
    "evals/guided-input.json",
    "tests/fixtures/attachments/generate.ts",
    "package.json",
    "pnpm-lock.yaml",
    ...git(["ls-files", "src", "prompts", "migrations", "config"]).split("\n").filter(Boolean),
  ];
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain"])),
    sourceDiffSha256: sha256(git(["diff", "HEAD"])),
    node: process.version,
    sourceFiles: [...new Set(files)]
      .sort()
      .map((path) => ({ path, sha256: sha256(readFileSync(path, "utf8")) })),
  };
}
function stop(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function safeCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,100}$/.test(code)
    ? code
    : "GUIDED_RUNNER_ERROR";
}
export async function guidedMain(args: string[]) {
  const options = guidedOptions(args);
  if (options.help) {
    console.log(
      "Default: --dry-run [--cases terra-full,deepseek-full]. Paid execution: --run --out artifacts/NAME.json; resume with --run --resume artifacts/NAME.json. Set explicit absolute ARENA_DATABASE_PATH and ARENA_BILLING_DATABASE_PATH. Existing held attempts require --acknowledge-held ID --acknowledgement-reason TEXT. No environment files loaded, no automatic paid retry, no semantic/browser acceptance claimed.",
    );
    return;
  }
  const fixtureText = readFileSync(resolve("evals/guided-input.json"), "utf8"),
    fixture = GuidedFixtureSchema.parse(JSON.parse(fixtureText));
  const previous: RecordFile | undefined = options.resume
    ? JSON.parse(readFileSync(options.resume, "utf8"))
    : undefined;
  if (previous && previous.kind !== "real-guided-runtime-on-synthetic-input")
    stop("WRONG_RESUME_KIND");
  const executionOptions = previous?.executionOptions ?? {
    cases: options.cases,
    heldAcknowledgement: heldAcknowledgement(options.acknowledgeHeld, options.reason),
  };
  const acknowledgement = executionOptions.heldAcknowledgement
    ? heldAcknowledgement(
        executionOptions.heldAcknowledgement.attemptIds,
        executionOptions.heldAcknowledgement.reason,
      )
    : undefined;
  const plan = guidedPlan(fixture, executionOptions.cases);
  const identity = {
    fixtureSha256: sha256(fixtureText),
    planSha256: sha256(JSON.stringify(plan)),
    databaseIdentity: sha256(
      JSON.stringify([process.env.ARENA_DATABASE_PATH, process.env.ARENA_BILLING_DATABASE_PATH]),
    ),
  };
  if (!plan.length) stop("EMPTY_PLAN");
  if (previous && options.run) assertResumeIdentity(previous, identity);
  if (!options.run) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          providerRequests: 0,
          fixtureSha256: identity.fixtureSha256,
          maxNewRequests: fixture.requestLimit,
          acknowledgedHeldCount: acknowledgement?.attemptIds.length ?? 0,
          cases: plan.map((item) => ({ id: item.id, modelId: item.modelId, scope: item.scope })),
          semanticAcceptance: "not-reviewed",
          browserAcceptance: "not-run-by-this-script",
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const name of ["ARENA_DATABASE_PATH", "ARENA_BILLING_DATABASE_PATH"])
    if (!process.env[name] || !isAbsolute(process.env[name]!))
      stop("EXPLICIT_DATABASE_PATH_REQUIRED");
  if (process.env.ARENA_DATABASE_PATH === process.env.ARENA_BILLING_DATABASE_PATH)
    stop("DATABASES_MUST_BE_SEPARATE");
  const output = resolve(
    options.resume ?? options.out ?? `artifacts/live-guided-${Date.now()}.json`,
  );
  if (!output.startsWith(`${resolve("artifacts")}${sep}`)) stop("PRIVATE_ARTIFACT_PATH_REQUIRED");
  if (!previous && existsSync(output)) stop("OUTPUT_EXISTS_USE_RESUME");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const unlock = acquireOutputLock(output);
  try {
    if (!previous && existsSync(output)) stop("OUTPUT_EXISTS_USE_RESUME");
    if (
      previous &&
      JSON.stringify(JSON.parse(readFileSync(output, "utf8"))) !== JSON.stringify(previous)
    )
      stop("RESUME_RECORD_CHANGED");
    const source = provenance();
    if (source.dirty) stop("FREEZE_CLEAN_SOURCE_BEFORE_PAID_RUN");
    if (previous) assertResumeExecution(previous.provenance, source, "source");
    const record: RecordFile = previous ?? {
      kind: "real-guided-runtime-on-synthetic-input",
      ...identity,
      frozenFixture: fixture,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionOptions,
      provenance: source,
      semanticAcceptance: "not-reviewed",
      browserAcceptance: "not-run-by-this-script",
      captureScope:
        "Intake drafts are public service DTOs with selected sources, answers and usage; call records retain local reservations and errors. Arena snapshots include runtime modelOutput events. Raw provider HTTP envelopes and private attachment base64 are not captured or claimed. Assets and all inputs are synthetic.",
      failures: [],
      cases: plan.map((item) => ({
        ...item,
        owner: `guided-${randomUUID()}`,
        status: "not-started",
        operations: [],
      })),
    };
    const save = () => {
      record.updatedAt = new Date().toISOString();
      const temp = `${output}.tmp`;
      writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, output);
    };
    save();
    const billing = await import("../src/lib/server/billing"),
      intake = await import("../src/lib/server/intakes"),
      runtime = await import("../src/lib/server/runtime"),
      model = await import("../src/lib/server/model"),
      database = await import("../src/lib/server/db");
    try {
      const configs = [...new Set(plan.map((item) => item.modelId))].map((id) =>
        model.resolveModelConfig(id),
      );
      if (previous) assertResumeExecution(record.configurations, configs, "configuration");
      record.configurations ??= configs;
      record.billingBefore ??=
        billing.getBillingSummary() as unknown as RecordFile["billingBefore"];
      assertBillingAttemptsReviewed(
        billing.getUnresolvedBillingAttempts(),
        acknowledgement,
        !previous,
      );
      save();
      const guard = (upperRequests = 1) => {
        assertBillingAttemptsReviewed(billing.getUnresolvedBillingAttempts(), acknowledgement);
        if (
          billing.getBillingSummary().requests - record.billingBefore!.requests + upperRequests >
          fixture.requestLimit
        )
          stop("GUIDED_REQUEST_CAP_REACHED");
      };
      const refresh = (item: CaseRecord) => {
        if (item.draftId) {
          item.draft = intake.getIntake(item.draftId, item.owner);
          item.callRecords = database
            .db()
            .prepare(
              "SELECT c.id,c.kind,c.state,c.usage,c.error,c.created_at FROM intake_calls c JOIN intake_operations o ON o.id=c.operation_id WHERE o.draft_id=? ORDER BY c.created_at,c.rowid",
            )
            .all(item.draftId);
        }
        if (item.arenaId) item.snapshot = runtime.getArena(item.arenaId, item.owner);
        record.billingAfter = billing.getBillingSummary();
        record.unresolvedBillingAfter = billing.getUnresolvedBillingAttempts();
        save();
      };
      for (const item of record.cases) {
        if (item.status === "completed" || item.status === "failed") continue;
        try {
          guard(0);
          const registryKey = `guided:${record.fixtureSha256}:${record.provenance.commit}:${item.id}`;
          const registry = database
            .db()
            .prepare("SELECT value FROM metadata WHERE key=?")
            .get(registryKey) as { value: string } | undefined;
          if (registry && registry.value !== output) stop("EXISTING_GUIDED_RECORD_USE_RESUME");
          if (!registry)
            database
              .db()
              .prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
              .run(registryKey, output);
          if (!item.draftId) {
            // Recover local creation without duplicating a draft if the process died before saving its ID.
            const existing = database
              .db()
              .prepare("SELECT id FROM intake_drafts WHERE owner=? ORDER BY updated_at")
              .all(item.owner) as { id: string }[];
            if (existing.length > 1) stop("DRAFT_CREATION_RECONCILIATION_REQUIRED");
            item.draftId =
              existing[0]?.id ??
              intake.createIntake(item.owner, { goal: item.goal, modelMode: item.modelId }).id;
          }
          item.status = "running";
          refresh(item);
          if (guidedDraftDecision(item.draft!.status) === "stop-unknown")
            stop("UNRESOLVED_REQUEST_STOP");
          if (item.scope === "vision-summary" && item.draft!.status === "input") {
            const assets = await guidedAssets(fixture);
            const assetHashes = assets.map((asset) => ({
              name: asset.name,
              sha256: sha256(asset.bytes.toString("base64")),
            }));
            if (item.assets)
              assertResumeExecution(
                item.assets.map(({ name, sha256 }) => ({ name, sha256 })),
                assetHashes,
                "configuration",
              );
            else {
              item.assets = assetHashes;
              save();
            }
            for (const asset of assets) {
              const current = intake.getIntake(item.draftId!, item.owner);
              const existing = current.attachments.find(
                (attachment) => attachment.name === asset.name,
              );
              if (existing) {
                if (
                  !intake
                    .getIntakeAttachment(item.draftId!, item.owner, existing.id)
                    .bytes.equals(asset.bytes)
                )
                  stop("ASSET_CONTENT_DRIFT");
              } else
                await intake.addIntakeAttachment(
                  item.draftId!,
                  item.owner,
                  asset.bytes,
                  asset.name,
                );
              refresh(item);
              const metadata = item.draft!.attachments.find(
                (attachment) => attachment.name === asset.name,
              )!;
              item.assets!.find((entry) => entry.name === asset.name)!.attachmentId = metadata.id;
              if (metadata.state !== "ready") stop("ATTACHMENT_REVIEW_REQUIRED");
              save();
            }
          }
          for (let iteration = 0; iteration < 8; iteration++) {
            refresh(item);
            const current = item.draft!;
            const decision = guidedDraftDecision(current.status);
            if (decision === "stop-unknown") stop("UNRESOLVED_REQUEST_STOP");
            if (decision === "terminal-failure") stop("FAILED_INTAKE_REVIEW_REQUIRED");
            if (decision === "terminal-ready") break;
            if (decision === "answer") {
              intake.updateIntake(current.id, item.owner, {
                revision: current.revision,
                answers: current.questions.map((question) =>
                  answerFrozenQuestion(question, item.facts),
                ),
              });
              refresh(item);
              continue;
            }
            const saved = item.operations.at(-1);
            const opRow = saved
              ? (database
                  .db()
                  .prepare("SELECT state FROM intake_operations WHERE id=?")
                  .get(saved.operationId) as { state: string } | undefined)
              : undefined;
            if (opRow && ["pending", "uncertain"].includes(opRow.state))
              stop("UNRESOLVED_REQUEST_STOP");
            const operation =
              saved && !opRow
                ? saved
                : {
                    operationId: randomUUID(),
                    revision: current.revision,
                    finish: item.scope === "vision-summary" || current.round >= 2,
                  };
            if (!saved || operation !== saved) {
              item.operations.push(operation);
              save();
            }
            if (operation.revision !== current.revision) stop("PENDING_OPERATION_REVISION_DRIFT");
            // A vision prepare can make at most two image calls plus one analysis call for these fixtures.
            guard(item.scope === "vision-summary" ? 3 : 1);
            await intake.analyzeIntake(current.id, item.owner, operation);
            refresh(item);
            guard(0);
          }
          refresh(item);
          if (guidedDraftDecision(item.draft!.status) === "stop-unknown")
            stop("UNRESOLVED_REQUEST_STOP");
          if (!["summary", "submitted"].includes(item.draft!.status) || !item.draft!.challenge)
            stop("SUMMARY_NOT_COMPLETED");
          if (item.scope === "full-flow") {
            if (!item.arenaId) {
              item.snapshot = intake.submitIntake(item.draftId!, item.owner, {
                revision: item.draft!.revision,
                challenge: item.draft!.challenge!,
                assumptions: item.draft!.assumptions,
              });
              item.arenaId = item.snapshot.id;
              refresh(item);
            }
            for (let step = 0; step < 40; step++) {
              refresh(item);
              const version = item.snapshot!.versions.find(
                (version) => version.id === item.snapshot!.activeVersionId,
              )!;
              const decision = resumeDecision(
                version.status,
                item
                  .snapshot!.steps.filter((step) => step.versionId === version.id)
                  .map((step) => step.status),
              );
              if (["manual-reconciliation", "wait-existing-request"].includes(decision))
                stop("UNRESOLVED_REQUEST_STOP");
              if (version.status === "failed") stop("FAILED_ARENA_REVIEW_REQUIRED");
              if (decision !== "advance") break;
              guard();
              await runtime.advanceArena(item.arenaId!, item.owner, version.id);
              refresh(item);
              guard(0);
            }
            if (
              item.snapshot!.versions.find(
                (version) => version.id === item.snapshot!.activeVersionId,
              )?.status !== "completed"
            )
              stop("ARENA_NOT_COMPLETED");
          }
          item.status = "completed";
          refresh(item);
          console.log(
            JSON.stringify({
              caseId: item.id,
              modelId: item.modelId,
              scope: item.scope,
              status: item.status,
              intakeCallRecords: item.callRecords?.length ?? 0,
            }),
          );
        } catch (error) {
          const code = safeCode(error);
          item.failureCode = code;
          item.status = ["UNRESOLVED_REQUEST_STOP", "UNRESOLVED_BILLING_STOP"].includes(code)
            ? "uncertain"
            : "failed";
          record.failures.push({ caseId: item.id, code, at: new Date().toISOString() });
          refresh(item);
          console.log(JSON.stringify({ caseId: item.id, status: item.status, code }));
          if (
            [
              "UNRESOLVED_REQUEST_STOP",
              "UNRESOLVED_BILLING_STOP",
              "GUIDED_REQUEST_CAP_REACHED",
              "EXISTING_GUIDED_RECORD_USE_RESUME",
            ].includes(code)
          )
            break;
        }
      }
    } catch (error) {
      record.failures.push({ code: safeCode(error), at: new Date().toISOString() });
    } finally {
      for (const item of record.cases) {
        try {
          if (item.draftId) item.draft = intake.getIntake(item.draftId, item.owner);
          if (item.arenaId) item.snapshot = runtime.getArena(item.arenaId, item.owner);
        } catch {
          /* Preserve last successful exports. */
        }
      }
      try {
        record.billingAfter = billing.getBillingSummary();
        record.unresolvedBillingAfter = billing.getUnresolvedBillingAttempts();
      } catch {
        /* Keep the last ledger metadata. */
      }
      save();
      database.closeDb();
    }
    console.log(
      JSON.stringify({
        output,
        fixtureSha256: record.fixtureSha256,
        failures: record.failures.length,
        completed: record.cases.filter((item) => item.status === "completed").length,
        semanticAcceptance: record.semanticAcceptance,
        browserAcceptance: record.browserAcceptance,
      }),
    );
    if (record.failures.length || record.cases.some((item) => item.status !== "completed"))
      process.exitCode = 1;
  } finally {
    unlock();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  guidedMain(process.argv.slice(2)).catch(() => {
    console.error(
      "Guided acceptance stopped; no response body or credentials printed. Inspect the private record. No automatic paid retry was performed.",
    );
    process.exitCode = 1;
  });
