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

export function unresolvedBilling(summary: { heldRequests: number; reservedUsdMicros: number }) {
  return summary.heldRequests > 0 || summary.reservedUsdMicros > 0;
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
