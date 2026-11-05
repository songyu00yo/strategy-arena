import type { ArenaStep } from "./contracts";

/** Steps arrive in ordinal order. A repair/retry supersedes its logical role's earlier attempt. */
export function stageProgress(steps: readonly Pick<ArenaStep, "role" | "status">[]) {
  const latest = new Map<string, Pick<ArenaStep, "role" | "status">>();
  for (const step of steps) {
    const role = step.role.split(":")[0];
    const previous = latest.get(role);
    // Cancelling a scheduled repair does not resolve the failure that caused it.
    if (step.status === "skipped" && previous?.status === "failed") continue;
    latest.set(role, step);
  }
  const attempts = [...latest.values()];
  // An unresolved paid request stays unknown even if an inconsistent snapshot adds a later attempt.
  const unknown = steps.some((step) => step.status === "uncertain");
  return {
    completed:
      !unknown &&
      attempts.length > 0 &&
      attempts.every((step) => step.status === "completed" || step.status === "skipped"),
    failed: attempts.some((step) => step.status === "failed"),
    unknown,
  };
}
