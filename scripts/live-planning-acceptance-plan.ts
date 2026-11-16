import { z } from "zod";
import { ModelModeSchema, type ModelMode } from "../src/lib/contracts";
import {
  PLANNING_AGENT_IDS,
  type PlanningAgentId,
  type PlanningSnapshot,
} from "../src/lib/planning-contracts";
import type { ModelUsage } from "../src/lib/contracts";

export const PLANNING_ACCEPTANCE_MAX_CALLS = 8;
export const PLANNING_ACCEPTANCE_MAX_STEPS = 10;
export const PlanningAcceptanceFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtureId: z.string().min(1),
    inputProvenance: z.literal("synthetic-frozen-input-not-a-user-project"),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z-]+$/),
            goal: z.string().trim().min(2).max(6000),
            checks: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine((value) => new Set(value.cases.map((item) => item.id)).size === value.cases.length, {
    message: "Duplicate planning acceptance case IDs",
  });
export type PlanningAcceptanceFixture = z.infer<typeof PlanningAcceptanceFixtureSchema>;

export function planningAcceptanceStop(code: string): never {
  throw Object.assign(new Error(code), { code });
}
export function planningAcceptanceErrorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,100}$/.test(code)
    ? code
    : "PLANNING_ACCEPTANCE_ERROR";
}

export interface PlanningAcceptanceOptions {
  run: boolean;
  help: boolean;
  caseId?: string;
  modelMode?: ModelMode;
  out?: string;
}
export function planningAcceptanceOptions(args: string[]): PlanningAcceptanceOptions {
  const options: PlanningAcceptanceOptions = { run: false, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--resume") planningAcceptanceStop("RESUME_UNSUPPORTED_REVIEW_ORIGINAL_RECORD");
    if (seen.has(flag)) planningAcceptanceStop("DUPLICATE_OPTION");
    seen.add(flag);
    if (flag === "--run") options.run = true;
    else if (flag === "--dry-run") options.run = false;
    else if (flag === "--help") options.help = true;
    else {
      if (!["--case", "--model-mode", "--out"].includes(flag))
        planningAcceptanceStop("UNKNOWN_OPTION");
      const value = args[++index];
      if (!value || value.startsWith("--")) planningAcceptanceStop("MISSING_OPTION_VALUE");
      if (flag === "--case") options.caseId = value;
      if (flag === "--out") options.out = value;
      if (flag === "--model-mode") {
        options.modelMode = ModelModeSchema.parse(value);
        if (options.modelMode === "auto") planningAcceptanceStop("EXPLICIT_MODEL_MODE_REQUIRED");
      }
    }
  }
  if (seen.has("--run") && seen.has("--dry-run")) planningAcceptanceStop("CONFLICTING_RUN_FLAGS");
  if (options.run && !options.help && (!options.caseId || !options.modelMode || !options.out))
    planningAcceptanceStop("RUN_REQUIRES_CASE_MODEL_MODE_AND_OUT");
  return options;
}

export interface PlanningAcceptanceCall {
  id: string;
  operationId: string;
  role: PlanningAgentId;
  state: string;
  reservation: unknown;
  usage: ModelUsage | null;
  output: unknown;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** The shared ledger remains authoritative; this only tightens the batch request cap. */
export function assertPlanningBillingWindow(
  baselineRequests: number,
  currentRequests: number,
  unresolved: readonly unknown[],
  nextRequests: 0 | 1,
) {
  if (unresolved.length) planningAcceptanceStop("UNRESOLVED_BILLING_STOP");
  if (
    !Number.isSafeInteger(baselineRequests) ||
    !Number.isSafeInteger(currentRequests) ||
    baselineRequests < 0 ||
    currentRequests < baselineRequests ||
    currentRequests - baselineRequests + nextRequests > PLANNING_ACCEPTANCE_MAX_CALLS
  )
    planningAcceptanceStop("PLANNING_ACCEPTANCE_REQUEST_CAP");
}

interface BillingPolicyIdentity {
  revision: number;
  usagePolicyRevision: number;
  usageLimitsEnabled: boolean;
}
export function assertPlanningBillingPolicy(
  before: BillingPolicyIdentity,
  after: BillingPolicyIdentity,
) {
  if (
    before.revision !== after.revision ||
    before.usagePolicyRevision !== after.usagePolicyRevision ||
    before.usageLimitsEnabled !== after.usageLimitsEnabled
  )
    planningAcceptanceStop("BILLING_POLICY_CHANGED_STOP");
}

/** This runner never answers, adopts a report, starts a second round, or retries a failure. */
export function planningAcceptanceDecision(
  snapshot: PlanningSnapshot,
  calls: PlanningAcceptanceCall[],
  dispatchedActions: number,
  previewRequested: boolean,
): "advance" | "preview" | "complete" {
  const s = snapshot.session;
  if (
    s.activeOperationId ||
    ["working", "uncertain"].includes(s.status) ||
    calls.some((call) => ["pending", "uncertain"].includes(call.state))
  )
    planningAcceptanceStop("PLANNING_UNKNOWN_STOP");
  if (
    ["failed", "paused"].includes(s.status) ||
    s.error ||
    calls.some((call) => call.state !== "completed")
  )
    planningAcceptanceStop("PLANNING_FAILED_STOP");
  if (
    s.productScope !== "analysis_and_guidance" ||
    s.progress.round !== 1 ||
    s.progress.questionLimit !== 8 ||
    s.progress.questionsIssued > 8 ||
    s.progress.questionsAnswered !== 0 ||
    s.answers.length ||
    calls.length > PLANNING_ACCEPTANCE_MAX_CALLS ||
    dispatchedActions > PLANNING_ACCEPTANCE_MAX_CALLS
  )
    planningAcceptanceStop("PLANNING_ACCEPTANCE_SCOPE_CHANGED");
  if (s.report) {
    const report = s.report;
    const roles = new Set(calls.map((call) => call.role));
    if (
      s.status !== "review_ready" ||
      report.status !== "draft" ||
      !report.title.trim() ||
      !report.summary.trim() ||
      !report.fingerprint ||
      !report.contentFingerprint ||
      report.basedOnRevision !== s.revision ||
      s.review?.basedOnRevision !== s.revision ||
      s.review.contentFingerprint !== report.contentFingerprint ||
      s.questions.some((question) => question.status === "active") ||
      !PLANNING_AGENT_IDS.every((role) => roles.has(role)) ||
      calls.some((call) => !call.usage) ||
      !["D", "E"].every((role) =>
        s.expertResults.some(
          (expert) =>
            expert.agentId === role &&
            expert.round === 1 &&
            expert.basedOnRevision === s.revision &&
            expert.contentFingerprint === report.contentFingerprint,
        ),
      ) ||
      !snapshot.events.some(
        (event) =>
          event.kind === "report_ready" &&
          event.actor === "C" &&
          event.revision === s.revision &&
          calls.some((call) => call.role === "C" && call.operationId === event.operationId),
      )
    )
      planningAcceptanceStop("PLANNING_REPORT_INCOMPLETE");
    return "complete";
  }
  if (
    calls.length >= PLANNING_ACCEPTANCE_MAX_CALLS ||
    dispatchedActions >= PLANNING_ACCEPTANCE_MAX_CALLS
  )
    planningAcceptanceStop("PLANNING_ACCEPTANCE_REQUEST_CAP");
  if (
    s.status === "awaiting_user" ||
    s.questions.some((question) => question.status === "active")
  ) {
    if (
      previewRequested ||
      !s.capabilities.canPreview ||
      !["A", "B"].every((role) => calls.some((call) => call.role === role))
    )
      planningAcceptanceStop("PLANNING_PREVIEW_UNAVAILABLE");
    return "preview";
  }
  if (s.status === "ready" && s.nextAction === "advance" && s.capabilities.canAdvance)
    return "advance";
  planningAcceptanceStop("PLANNING_UNEXPECTED_STATE");
}
