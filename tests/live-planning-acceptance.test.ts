/** Guard tests use explicit synthetic snapshots; this file never invokes a provider. */
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanningAgentId, PlanningSnapshot } from "../src/lib/planning-contracts";
import {
  assertPlanningBillingWindow,
  assertPlanningBillingPolicy,
  PlanningAcceptanceFixtureSchema,
  planningAcceptanceDecision,
  planningAcceptanceOptions,
  type PlanningAcceptanceCall,
} from "../scripts/live-planning-acceptance-plan";
import {
  executePlanningAcceptance,
  capturePlanningAcceptanceBilling,
  planningAcceptanceDatabasePaths,
  planningAcceptanceMain,
  savePlanningAcceptanceRecord,
  type PlanningAcceptanceCaseRecord,
} from "../scripts/live-planning-acceptance";

const imports = vi.hoisted(() => ({ billing: vi.fn(), runtime: vi.fn(), model: vi.fn() }));
vi.mock("../src/lib/server/billing", () => {
  imports.billing();
  return {};
});
vi.mock("../src/lib/server/planning", () => {
  imports.runtime();
  return {};
});
vi.mock("../src/lib/server/model", () => {
  imports.model();
  return {};
});

const fixture = PlanningAcceptanceFixtureSchema.parse(
  JSON.parse(readFileSync(new URL("../evals/planning-acceptance.json", import.meta.url), "utf8")),
);
const usage = {
  inputTokens: 20,
  outputTokens: 10,
  cachedInputTokens: 0,
  estimatedCny: 0,
  estimatedUsd: 0.001,
  currency: "USD" as const,
  provider: "openai" as const,
  model: "gpt-6.1-terra",
  responseId: "explicit-test-double",
  durationMs: 1,
};
function call(
  role: PlanningAgentId,
  operationId = `test-operation-${role}`,
): PlanningAcceptanceCall {
  return {
    id: `test-call-${role}-${operationId}`,
    operationId,
    role,
    state: "completed",
    reservation: { tokens: 100, amount: 0.01, currency: "USD" },
    usage,
    output: { synthetic: true },
    error: null,
    createdAt: 1,
    finishedAt: 2,
  };
}
function snapshot(): PlanningSnapshot {
  return {
    snapshotVersion: 1,
    eventCursor: 0,
    events: [],
    session: {
      contractVersion: "2.0.0",
      id: "synthetic-session",
      revision: 1,
      goal: fixture.cases[0].goal,
      modelMode: "gpt-6.1-terra",
      productScope: "analysis_and_guidance",
      status: "ready",
      progress: {
        round: 1,
        questionLimit: 8,
        questionsIssued: 0,
        questionsAnswered: 0,
        questionsRemaining: 8,
        questionSlotsRemaining: 8,
        activeQuestions: 0,
        stage: "understanding",
        budgetExhausted: false,
        endedEarly: false,
        coverage: [],
      },
      agents: [],
      expertResults: [],
      items: [],
      sourceRecords: [],
      questions: [],
      answers: [],
      draft: null,
      review: null,
      report: null,
      capabilities: {
        canAdvance: true,
        canAnswer: false,
        canAddNote: true,
        canPreview: true,
        canConfirm: false,
        canStop: false,
        canStartRound: false,
        reason: "",
      },
      nextAction: "advance",
      activeOperationId: null,
      error: null,
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    },
  };
}
function complete(value: PlanningSnapshot, calls: PlanningAcceptanceCall[]) {
  const result = structuredClone(value);
  Object.assign(result.session, {
    status: "review_ready",
    nextAction: "start_round",
    review: {
      id: "synthetic-review",
      basedOnRevision: 1,
      contentFingerprint: "synthetic-content",
      ready: false,
      coverage: [],
      blockers: [],
      risks: [],
      uncertainties: ["仍有未知条件"],
    },
    report: {
      id: "synthetic-report",
      basedOnRevision: 1,
      contentFingerprint: "synthetic-content",
      fingerprint: "synthetic-report-fingerprint",
      status: "draft",
      title: "合成报告",
      summary: "这是测试输出，不能代替真实模型质量证据。",
      sections: [],
      tasks: [],
      risks: [],
      unresolved: ["仍有未知条件"],
      acceptance: [],
      executionPrompt: "INTERNAL_SYNTHETIC_PROMPT",
      markdown: "INTERNAL_SYNTHETIC_MARKDOWN",
      confirmedAt: null,
    },
  });
  result.session.progress.stage = "report";
  result.session.expertResults = ["D", "E"].map((role) => ({
    id: `synthetic-expert-${role}`,
    agentId: role as "D" | "E",
    round: 1,
    basedOnRevision: 1,
    contentFingerprint: "synthetic-content",
    summary: "合成分析",
    conclusion: "insufficient_information",
    sections: [],
    risks: [],
    unknowns: ["条件待定"],
    nextSteps: [],
    minimumViableVersion: "先验证需求",
    createdAt: result.session.createdAt,
  }));
  result.events.push({
    id: "synthetic-report-event",
    seq: 1,
    revision: 1,
    operationId: calls.find((entry) => entry.role === "C")?.operationId ?? null,
    kind: "report_ready",
    actor: "C",
    from: "C",
    to: "user",
    questionId: null,
    questionVersion: null,
    answerId: null,
    itemIds: [],
    title: "合成报告",
    detail: "明确的测试数据",
    createdAt: result.session.createdAt,
  });
  return result;
}
function caseRecord(): PlanningAcceptanceCaseRecord {
  return {
    input: fixture.cases[0],
    owner: "synthetic-test-owner",
    modelMode: "gpt-6.1-terra",
    status: "not-started",
    operations: [],
    snapshots: [],
    calls: [],
    previewRequested: false,
    modelActions: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("planning acceptance CLI and files", () => {
  it("has two frozen cases, requires explicit paid scope, and never infers resume", () => {
    expect(fixture.cases.map((entry) => entry.id)).toEqual(["portfolio", "unclear-goal"]);
    expect(planningAcceptanceOptions([]).run).toBe(false);
    expect(() => planningAcceptanceOptions(["--run"])).toThrow("RUN_REQUIRES");
    expect(() => planningAcceptanceOptions(["--run", "--dry-run"])).toThrow("CONFLICTING");
    expect(() => planningAcceptanceOptions(["--resume", "old.json"])).toThrow("REVIEW_ORIGINAL");
    expect(() => planningAcceptanceOptions(["--model-mode", "auto"])).toThrow("EXPLICIT_MODEL");
    expect(() =>
      planningAcceptanceOptions(["--case", "portfolio", "--case", "unclear-goal"]),
    ).toThrow("DUPLICATE");
  });
  it("dry-runs with zero database imports/opens, writes or model requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "planning-dry-run-"));
    try {
      const business = join(directory, "business.sqlite");
      const ledger = join(directory, "ledger.sqlite");
      const outputFile = join(directory, "must-not-exist.json");
      vi.stubEnv("ARENA_DATABASE_PATH", business);
      vi.stubEnv("ARENA_BILLING_DATABASE_PATH", ledger);
      vi.stubEnv("OPENAI_API_KEY", "SYNTHETIC_SECRET_NEVER_PRINT");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      await planningAcceptanceMain(["--out", outputFile]);
      expect([business, ledger, outputFile].every((path) => !existsSync(path))).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(imports.billing).not.toHaveBeenCalled();
      expect(imports.runtime).not.toHaveBeenCalled();
      expect(imports.model).not.toHaveBeenCalled();
      const printed = output.mock.calls.flat().join(" ");
      expect(JSON.parse(printed)).toMatchObject({
        dryRun: true,
        providerRequests: 0,
        databaseOpened: false,
        recordWritten: false,
        maxModelActionsPerCase: 8,
        semanticAcceptance: "not-reviewed",
      });
      expect(printed).not.toContain("SYNTHETIC_SECRET_NEVER_PRINT");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("refuses missing paths or ledger, aliases and hard links before database initialization", () => {
    const directory = mkdtempSync(join(tmpdir(), "planning-paths-"));
    try {
      const ledger = join(directory, "ledger.sqlite");
      const business = join(directory, "business.sqlite");
      expect(() => planningAcceptanceDatabasePaths({})).toThrow("EXPLICIT_DATABASE");
      expect(() =>
        planningAcceptanceDatabasePaths({
          ARENA_DATABASE_PATH: business,
          ARENA_BILLING_DATABASE_PATH: ledger,
        }),
      ).toThrow("EXISTING_BILLING_LEDGER");
      writeFileSync(ledger, "synthetic path fixture, not a ledger");
      const env = { ARENA_DATABASE_PATH: business, ARENA_BILLING_DATABASE_PATH: ledger };
      expect(planningAcceptanceDatabasePaths(env)).toEqual({ business, ledger });
      symlinkSync(ledger, business);
      expect(() => planningAcceptanceDatabasePaths(env)).toThrow("DATABASES_MUST_BE_SEPARATE");
      rmSync(business);
      linkSync(ledger, business);
      expect(() => planningAcceptanceDatabasePaths(env)).toThrow("DATABASES_MUST_BE_SEPARATE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("writes atomic private JSON evidence with mode 0600", () => {
    const directory = mkdtempSync(join(tmpdir(), "planning-record-"));
    try {
      const path = join(directory, "record.json");
      savePlanningAcceptanceRecord(path, { synthetic: true, status: "prepared" });
      savePlanningAcceptanceRecord(path, { synthetic: true, status: "returned" });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        synthetic: true,
        status: "returned",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("planning acceptance decision and billing guards", () => {
  it.each(["reserved", "held"])("blocks every %s request without an exemption", (state) => {
    expect(() => assertPlanningBillingWindow(10, 10, [{ state }], 0)).toThrow(
      "UNRESOLVED_BILLING_STOP",
    );
  });
  it("bounds ledger growth without changing central limits or refunding unknowns", () => {
    expect(() => assertPlanningBillingWindow(10, 17, [], 1)).not.toThrow();
    expect(() => assertPlanningBillingWindow(10, 18, [], 0)).not.toThrow();
    expect(() => assertPlanningBillingWindow(10, 18, [], 1)).toThrow("REQUEST_CAP");
    expect(() => assertPlanningBillingWindow(10, 19, [], 0)).toThrow("REQUEST_CAP");
    expect(() => assertPlanningBillingWindow(10, 9, [], 0)).toThrow("REQUEST_CAP");
  });
  it("stops on limit or usage policy revision changes even when the enabled flag returns to its original value", () => {
    const before = { revision: 5, usagePolicyRevision: 1, usageLimitsEnabled: true };
    expect(() => assertPlanningBillingPolicy(before, { ...before })).not.toThrow();
    expect(() => assertPlanningBillingPolicy(before, { ...before, revision: 6 })).toThrow(
      "POLICY_CHANGED",
    );
    expect(() =>
      assertPlanningBillingPolicy(before, { ...before, usagePolicyRevision: 3 }),
    ).toThrow("POLICY_CHANGED");
    expect(() =>
      assertPlanningBillingPolicy(before, { ...before, usageLimitsEnabled: false }),
    ).toThrow("POLICY_CHANGED");
  });
  it.each(["working", "uncertain"] as const)("stops %s snapshots", (status) => {
    const value = snapshot();
    value.session.status = status;
    expect(() => planningAcceptanceDecision(value, [], 0, false)).toThrow("UNKNOWN_STOP");
  });
  it.each(["failed", "paused"] as const)("does not retry %s", (status) => {
    const value = snapshot();
    value.session.status = status;
    expect(() => planningAcceptanceDecision(value, [], 0, false)).toThrow("FAILED_STOP");
  });
  it("requires real completed five-role records and a current unconfirmed report", () => {
    const calls = (["A", "B", "D", "E", "C"] as const).map((role) => call(role));
    const value = complete(snapshot(), calls);
    expect(planningAcceptanceDecision(value, calls, 5, false)).toBe("complete");
    expect(() =>
      planningAcceptanceDecision(
        value,
        calls.filter((entry) => entry.role !== "E"),
        4,
        false,
      ),
    ).toThrow("REPORT_INCOMPLETE");
    value.session.expertResults[0].basedOnRevision = 0;
    expect(() => planningAcceptanceDecision(value, calls, 5, false)).toThrow("REPORT_INCOMPLETE");
    value.session.expertResults[0].basedOnRevision = 1;
    value.session.report!.status = "confirmed";
    expect(() => planningAcceptanceDecision(value, calls, 5, false)).toThrow("REPORT_INCOMPLETE");
  });
  it("allows the eighth completed call, but never dispatches a ninth", () => {
    const calls = (["A", "B", "A", "A", "A", "D", "E", "C"] as const).map((role, index) =>
      call(role, `test-${index}`),
    );
    expect(planningAcceptanceDecision(complete(snapshot(), calls), calls, 8, true)).toBe(
      "complete",
    );
    expect(() => planningAcceptanceDecision(snapshot(), calls, 8, true)).toThrow("REQUEST_CAP");
  });
});

describe("bounded planning execution with explicit runtime doubles", () => {
  function harness(item: PlanningAcceptanceCaseRecord, roles: PlanningAgentId[], ask = false) {
    let current = snapshot();
    const calls: PlanningAcceptanceCall[] = [];
    const checkpoints: PlanningAcceptanceCaseRecord[] = [];
    const deps = {
      create: vi.fn(() => current),
      get: vi.fn(() => current),
      calls: vi.fn(() => structuredClone(calls)),
      guard: vi.fn((next: 0 | 1) => assertPlanningBillingWindow(0, calls.length, [], next)),
      checkpoint: vi.fn(() => checkpoints.push(structuredClone(item))),
      act: vi.fn(
        async (
          _id: string,
          _owner: string,
          action: Parameters<typeof executePlanningAcceptance>[1]["act"] extends (
            ...args: infer A
          ) => unknown
            ? A[2]
            : never,
        ) => {
          expect(checkpoints.at(-1)?.operations.at(-1)).toMatchObject({
            payload: action,
            dispatchStatus: "prepared",
          });
          const role = roles[calls.length] ?? "A";
          calls.push(call(role, action.operationId));
          current = structuredClone(current);
          current.snapshotVersion++;
          if (ask && role === "B") {
            current.session.status = "awaiting_user";
            current.session.nextAction = "answer";
            current.session.progress.questionsIssued = 1;
          } else {
            current.session.status = "ready";
            current.session.nextAction = "advance";
          }
          if (action.kind === "preview") current.session.progress.endedEarly = true;
          if (role === "C") current = complete(current, calls);
          return current;
        },
      ),
    };
    return {
      deps,
      calls,
      checkpoints,
      setSnapshot: (value: PlanningSnapshot) => {
        current = value;
      },
    };
  }
  it("drives A/B, previews unanswered questions, and records D/E/C without answering or confirming", async () => {
    const item = caseRecord();
    const { deps } = harness(item, ["A", "B", "A", "D", "E", "C"], true);
    await executePlanningAcceptance(item, deps);
    expect(item.status).toBe("structurally-complete");
    expect(item.previewRequested).toBe(true);
    expect(item.modelActions).toBe(6);
    expect(item.calls.map((entry) => entry.role)).toEqual(["A", "B", "A", "D", "E", "C"]);
    expect(item.operations.map((entry) => entry.kind)).toEqual([
      "create",
      "advance",
      "advance",
      "preview",
      "advance",
      "advance",
      "advance",
    ]);
    expect(item.snapshots.at(-1)?.session.report?.status).toBe("draft");
    expect(item.snapshots.at(-1)?.events[0].operationId).toBe(item.calls.at(-1)?.operationId);
  });
  it("stops before creating a session if the shared ledger has an unresolved attempt", async () => {
    const item = caseRecord();
    const { deps } = harness(item, ["A"]);
    deps.guard.mockImplementation((next) =>
      assertPlanningBillingWindow(0, 0, [{ state: "held" }], next),
    );
    await expect(executePlanningAcceptance(item, deps)).rejects.toMatchObject({
      code: "UNRESOLVED_BILLING_STOP",
    });
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.act).not.toHaveBeenCalled();
  });
  it("stops after an uncertain response and preserves its exact dispatched payload", async () => {
    const item = caseRecord();
    const { deps, setSnapshot } = harness(item, ["A"]);
    deps.act.mockImplementationOnce(async () => {
      const unknown = snapshot();
      unknown.session.status = "uncertain";
      unknown.session.activeOperationId = item.operations.at(-1)!.payload.operationId;
      setSnapshot(unknown);
      return unknown;
    });
    await expect(executePlanningAcceptance(item, deps)).rejects.toMatchObject({
      code: "PLANNING_UNKNOWN_STOP",
    });
    expect(deps.act).toHaveBeenCalledTimes(1);
    expect(item.status).toBe("failed");
    expect(item.operations.at(-1)?.payload.operationId).toBeTruthy();
    expect(item.snapshots.at(-1)?.session.status).toBe("uncertain");
  });
  it("does not resend a thrown request or continue after a server failure", async () => {
    const item = caseRecord();
    const { deps, setSnapshot } = harness(item, ["A"]);
    deps.act.mockImplementationOnce(async () => {
      const failed = snapshot();
      failed.session.status = "failed";
      setSnapshot(failed);
      throw Object.assign(new Error("explicit synthetic failure"), { code: "SYNTHETIC_FAILED" });
    });
    await expect(executePlanningAcceptance(item, deps)).rejects.toMatchObject({
      code: "SYNTHETIC_FAILED",
    });
    expect(deps.act).toHaveBeenCalledTimes(1);
    expect(item.operations.at(-1)).toMatchObject({
      dispatchStatus: "threw",
      errorCode: "SYNTHETIC_FAILED",
    });
    expect(item.snapshots.at(-1)?.session.status).toBe("failed");
  });
  it("captures a new held request after dispatch throws instead of retaining a pre-call empty list", async () => {
    const item = caseRecord();
    const { deps, setSnapshot } = harness(item, ["A"]);
    const held: { attemptId: string; state: "held"; reservedUsdMicros: number }[] = [];
    deps.act.mockImplementationOnce(async () => {
      held.push({ attemptId: "synthetic-unknown-call", state: "held", reservedUsdMicros: 500 });
      const unknown = snapshot();
      unknown.session.status = "uncertain";
      setSnapshot(unknown);
      throw Object.assign(new Error("synthetic unknown response"), { code: "SYNTHETIC_UNKNOWN" });
    });
    await expect(executePlanningAcceptance(item, deps)).rejects.toMatchObject({
      code: "SYNTHETIC_UNKNOWN",
    });
    const captured = capturePlanningAcceptanceBilling(
      () => ({ requests: 1, heldRequests: held.length }),
      () => held,
    );
    expect(captured).toEqual({ summary: { requests: 1, heldRequests: 1 }, unresolved: held });
    expect(captured.unresolved).toHaveLength(1);
    expect(deps.act).toHaveBeenCalledTimes(1);
  });
  it("marks failed final ledger capture and never treats an unreadable list as empty", () => {
    const unresolved = vi.fn(() => []);
    const unreadable = capturePlanningAcceptanceBilling(() => {
      throw Object.assign(new Error("synthetic missing ledger"), { code: "BILLING_NOT_FOUND" });
    }, unresolved);
    expect(unresolved).not.toHaveBeenCalled();
    expect(unreadable).toEqual({ summary: undefined, errorCode: "BILLING_NOT_FOUND" });
    expect(unreadable.unresolved).toBeUndefined();
    const failedList = capturePlanningAcceptanceBilling(
      () => ({ heldRequests: 1 }),
      () => {
        throw Object.assign(new Error("synthetic read failure"), { code: "SYNTHETIC_READ_FAILED" });
      },
    );
    expect(failedList).toEqual({
      summary: { heldRequests: 1 },
      errorCode: "SYNTHETIC_READ_FAILED",
    });
    expect(failedList.unresolved).toBeUndefined();
  });
  it("terminates a non-progressing runtime at eight model actions", async () => {
    const item = caseRecord();
    const { deps } = harness(item, Array<PlanningAgentId>(9).fill("A"));
    await expect(executePlanningAcceptance(item, deps)).rejects.toMatchObject({
      code: "PLANNING_ACCEPTANCE_REQUEST_CAP",
    });
    expect(deps.act).toHaveBeenCalledTimes(8);
    expect(item.modelActions).toBe(8);
  });
});
