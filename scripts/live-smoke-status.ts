import type { ArenaSnapshot } from "../src/lib/contracts";

export function firstCallShouldPause(
  snapshot: Pick<ArenaSnapshot, "activeVersionId"> & {
    versions: { id: string; status: string }[];
  },
) {
  const active = snapshot.versions.find((version) => version.id === snapshot.activeVersionId);
  return active !== undefined && ["ready", "running"].includes(active.status);
}

export function smokeHasFailure(snapshot: {
  versions: { status: string }[];
  steps: { status: string }[];
}) {
  return (
    snapshot.versions.some((version) => ["failed", "uncertain"].includes(version.status)) ||
    snapshot.steps.some((step) => step.status === "uncertain")
  );
}

export function firstCallHasUsableProposal(snapshot: {
  activeVersionId: string;
  versions: { id: string; strategies: unknown[] }[];
  steps: { versionId: string; stage: string; status: string }[];
}) {
  const active = snapshot.versions.find((version) => version.id === snapshot.activeVersionId);
  return (
    Boolean(active?.strategies.length) &&
    snapshot.steps.some(
      (step) =>
        step.versionId === snapshot.activeVersionId &&
        step.stage === "propose" &&
        step.status === "completed",
    )
  );
}
