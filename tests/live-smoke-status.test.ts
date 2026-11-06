/** Synthetic status regression only; no provider requests or actual billing records. */
import { describe, expect, it } from "vitest";
import {
  firstCallShouldPause,
  smokeHasFailure,
  firstCallHasUsableProposal,
} from "../scripts/live-smoke-status";

describe("single-call smoke preserves failure and unknown results", () => {
  it.each(["failed", "uncertain", "completed", "paused", "superseded"])(
    "does not overwrite %s with a pause",
    (status) => {
      expect(
        firstCallShouldPause({ activeVersionId: "active", versions: [{ id: "active", status }] }),
      ).toBe(false);
    },
  );
  it.each(["ready", "running"])(
    "pauses only active %s after the requested first call",
    (status) => {
      expect(
        firstCallShouldPause({ activeVersionId: "active", versions: [{ id: "active", status }] }),
      ).toBe(true);
    },
  );
  it("reports failure for uncertain steps even if a version was previously marked paused", () => {
    expect(
      smokeHasFailure({ versions: [{ status: "paused" }], steps: [{ status: "uncertain" }] }),
    ).toBe(true);
    expect(smokeHasFailure({ versions: [{ status: "uncertain" }], steps: [] })).toBe(true);
    expect(smokeHasFailure({ versions: [{ status: "failed" }], steps: [] })).toBe(true);
    expect(
      smokeHasFailure({
        versions: [{ status: "paused" }],
        steps: [{ status: "completed" }, { status: "skipped" }],
      }),
    ).toBe(false);
  });
  it("does not report first-call success when a failed proposal only queued a repair", () => {
    const snapshot = {
      activeVersionId: "active",
      versions: [{ id: "active", strategies: [] as unknown[] }],
      steps: [
        { versionId: "active", stage: "propose", status: "failed" },
        { versionId: "active", stage: "propose", status: "pending" },
      ],
    };
    expect(firstCallHasUsableProposal(snapshot)).toBe(false);
    snapshot.steps[0].status = "completed";
    expect(firstCallHasUsableProposal(snapshot)).toBe(false);
    snapshot.versions[0].strategies.push({ id: "A" });
    expect(firstCallHasUsableProposal(snapshot)).toBe(true);
    snapshot.steps[0].versionId = "older-version";
    expect(firstCallHasUsableProposal(snapshot)).toBe(false);
  });
});
