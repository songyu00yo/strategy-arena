import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ChallengeSchema, ModelModeSchema, type ModelMode } from "../src/lib/contracts";
import { routeModel } from "../src/lib/model-routing";

const CaseSchema = z.object({
  id: z.string().regex(/^[a-z-]+$/),
  category: z.string(),
  plannedMode: ModelModeSchema,
  initial: ChallengeSchema,
  changed: z
    .object({
      // Avoid Zod partial defaults resetting inherited budget, hours, options and materials.
      patch: z
        .record(z.string(), z.unknown())
        .refine(
          (patch) => Object.keys(patch).every((key) => key in ChallengeSchema.shape),
          "Unknown challenge patch field",
        ),
      reason: z.string().min(1),
    })
    .optional(),
  checks: z.array(z.string()).min(1),
});
export const FixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtureId: z.string(),
    inputProvenance: z.string(),
    rubric: z.array(z.object({ id: z.string(), requirement: z.string() })),
    cases: z.array(CaseSchema).min(1),
  })
  .superRefine((fixture, context) => {
    if (new Set(fixture.cases.map((item) => item.id)).size !== fixture.cases.length)
      context.addIssue({ code: "custom", message: "Duplicate case IDs" });
  });
export type Fixture = z.infer<typeof FixtureSchema>;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function planCases(
  fixture: Fixture,
  selected?: string[],
  excluded: string[] = [],
  override?: ModelMode,
) {
  for (const id of [...(selected ?? []), ...excluded])
    if (!fixture.cases.some((item) => item.id === id)) throw new Error(`Unknown case: ${id}`);
  return fixture.cases
    .filter((item) => (!selected || selected.includes(item.id)) && !excluded.includes(item.id))
    .map((item) => ({
      id: item.id,
      category: item.category,
      checks: item.checks,
      versions: [
        { name: "initial", challenge: item.initial, reason: "Initial frozen acceptance input" },
        ...(item.changed
          ? [
              {
                name: "changed",
                challenge: ChallengeSchema.parse({ ...item.initial, ...item.changed.patch }),
                reason: item.changed.reason,
              },
            ]
          : []),
      ].map((version) => {
        const executionMode = override ?? item.plannedMode;
        return {
          ...version,
          plannedMode: item.plannedMode,
          plannedRoute: routeModel(version.challenge, item.plannedMode),
          executionMode,
          executionRoute: routeModel(version.challenge, executionMode),
          validationLabel: override
            ? "supplemental-explicit-override-not-planned-mode-validation"
            : "planned-mode-validation",
          semanticReview: { status: "not-reviewed", findings: [] as string[] },
        };
      }),
    }));
}
export type CasePlan = ReturnType<typeof planCases>[number];

/** Terminal versions are never retried. A running lease is inspected, never dispatched again. */
export function resumeDecision(status: string, stepStatuses: string[]) {
  if (status === "uncertain" || stepStatuses.includes("uncertain")) return "manual-reconciliation";
  if (stepStatuses.includes("running")) return "wait-existing-request";
  if (status === "ready" || status === "running") return "advance";
  return "terminal";
}

const HeldAcknowledgementSchema = z
  .object({
    attemptIds: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/)).min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .refine(
    (value) => new Set(value.attemptIds).size === value.attemptIds.length,
    "Duplicate held IDs",
  );
export type HeldAcknowledgement = z.infer<typeof HeldAcknowledgementSchema>;
export interface UnresolvedBillingAttempt {
  attemptId: string;
  state: "reserved" | "held";
  reservedUsdMicros: number;
}

export function heldAcknowledgement(
  attemptIds?: string[],
  reason?: string,
): HeldAcknowledgement | undefined {
  if (attemptIds === undefined && reason === undefined) return undefined;
  const value = HeldAcknowledgementSchema.parse({ attemptIds, reason });
  return { ...value, attemptIds: [...value.attemptIds].sort() };
}

/** New runs require an exact reviewed set; later checks allow old holds to settle.
 * A new held identity always stops dispatch, even if another hold settled and counts match.
 * Reserved attempts are never acknowledged, released, settled or retried here. */
export function assertBillingAttemptsReviewed(
  attempts: UnresolvedBillingAttempt[],
  acknowledgement?: HeldAcknowledgement,
  exactStartupSet = false,
) {
  const approved = new Set(acknowledgement?.attemptIds ?? []);
  const actual = new Set(attempts.map((attempt) => attempt.attemptId));
  if (
    attempts.some((attempt) => attempt.state !== "held" || !approved.has(attempt.attemptId)) ||
    (exactStartupSet &&
      (approved.size !== actual.size || [...approved].some((id) => !actual.has(id))))
  )
    throw Object.assign(new Error("Unreviewed or reserved billing attempt; batch stopped"), {
      code: "UNRESOLVED_BILLING_STOP",
    });
}

export function assertResumeIdentity(
  record: { fixtureSha256: string; planSha256: string; databaseIdentity: string },
  expected: { fixtureSha256: string; planSha256: string; databaseIdentity: string },
) {
  if (record.fixtureSha256 !== expected.fixtureSha256)
    throw new Error("Frozen fixture changed; resume refused");
  if (record.planSha256 !== expected.planSha256)
    throw new Error("Selected cases or execution override changed; resume refused");
  if (record.databaseIdentity !== expected.databaseIdentity)
    throw new Error("Database identity changed; resume refused");
}

export function assertResumeExecution(
  saved: unknown,
  current: unknown,
  kind: "source" | "configuration",
) {
  if (JSON.stringify(saved) !== JSON.stringify(current))
    throw Object.assign(new Error(`Resume ${kind} drift; no paid requests allowed`), {
      code: kind === "source" ? "RESUME_SOURCE_DRIFT" : "RESUME_CONFIGURATION_DRIFT",
    });
}

/** An existing lock is never treated as stale automatically, including after a crash. */
export function acquireOutputLock(output: string) {
  const path = `${output}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, token);
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return () => {
    if (released) return;
    if (readFileSync(path, "utf8") !== token)
      throw new Error("Output lock ownership changed; not removed");
    unlinkSync(path);
    released = true;
  };
}
