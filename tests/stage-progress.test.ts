import { describe, expect, it } from "vitest";
import type { ArenaStep } from "../src/lib/contracts";
import { stageProgress } from "../src/lib/stage-progress";
const attempt = (role: string, status: ArenaStep["status"]) => ({ role, status });

describe("stage progress across ordered logical role attempts", () => {
  it("does not mark an absent stage as complete", () => {
    expect(stageProgress([])).toEqual({ completed: false, failed: false, unknown: false });
  });
  it.each(["pending", "running"] as const)(
    "shows a scheduled %s repair without a permanent failure",
    (status) => {
      expect(stageProgress([attempt("A", "failed"), attempt("A:repair", status)])).toEqual({
        completed: false,
        failed: false,
        unknown: false,
      });
    },
  );
  it("marks successful repairs and retries complete while retaining separate roles", () => {
    expect(
      stageProgress([
        attempt("A", "failed"),
        attempt("A:repair", "completed"),
        attempt("B", "completed"),
        attempt("B:retry", "completed"),
        attempt("C", "completed"),
      ]),
    ).toEqual({ completed: true, failed: false, unknown: false });
  });
  it("keeps the role incomplete while its retry is pending", () => {
    expect(stageProgress([attempt("A", "completed"), attempt("A:retry", "pending")])).toEqual({
      completed: false,
      failed: false,
      unknown: false,
    });
  });
  it("reports unrecovered failures, including a failed retry", () => {
    for (const attempts of [
      [attempt("A", "failed")],
      [attempt("A", "failed"), attempt("A:repair", "failed")],
      [attempt("A", "completed"), attempt("A:retry", "failed")],
      [attempt("A", "failed"), attempt("B", "completed")],
    ])
      expect(stageProgress(attempts)).toEqual({ completed: false, failed: true, unknown: false });
  });
  it("does not treat a cancelled recovery as resolving the original failure", () => {
    expect(stageProgress([attempt("A", "failed"), attempt("A:repair", "skipped")])).toEqual({
      completed: false,
      failed: true,
      unknown: false,
    });
  });
  it("retains an unknown paid request despite any later attempt", () => {
    for (const status of ["pending", "completed", "skipped"] as const)
      expect(stageProgress([attempt("A", "uncertain"), attempt("A:repair", status)])).toEqual({
        completed: false,
        failed: false,
        unknown: true,
      });
  });
  it("allows explicitly skipped roles to finish without fabricating a failure", () => {
    expect(stageProgress([attempt("A", "completed"), attempt("B", "skipped")])).toEqual({
      completed: true,
      failed: false,
      unknown: false,
    });
  });
});
