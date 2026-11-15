/** Real isolated SQLite with explicit model/orchestration doubles for intake projections and commits. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AnalyzeIntakeSchema,
  type IntakeAttachment,
  type IntakeDraft,
  type IntakeQuestion,
} from "../src/lib/intake-contracts";
import { ChallengeSchema } from "../src/lib/contracts";
import { ArenaError, closeDb, db } from "../src/lib/server/db";
import type { ClarificationContext } from "../src/lib/server/clarification";
import type { ParsedAttachment } from "../src/lib/server/attachment-parser";

const fixture = vi.hoisted(() => ({ generate: vi.fn(), clarify: vi.fn(), hold: vi.fn() }));
vi.mock("../src/lib/server/model", async (original) => ({
  ...(await original<typeof import("../src/lib/server/model")>()),
  generateStructured: fixture.generate,
}));
vi.mock("../src/lib/server/billing", async (original) => ({
  ...(await original<typeof import("../src/lib/server/billing")>()),
  holdBilling: fixture.hold,
}));
vi.mock("../src/lib/server/clarification", async (original) => ({
  ...(await original<typeof import("../src/lib/server/clarification")>()),
  runClarification: fixture.clarify,
}));
import { emptyClarification } from "../src/lib/server/clarification";
import {
  analyzeIntake,
  createIntake,
  getIntake,
  submitClarificationIntake,
  updateIntake,
} from "../src/lib/server/intakes";

const owner = "explicit-intake-activity-fixture";
const goal = "为纸本读书会整理实际活动与交付计划";
function modelResult(
  value: unknown = {
    ready: true,
    goal,
    constraints: "",
    preferences: "",
    options: [],
    domain: "general",
    budget: -1,
    budgetQuote: "",
    timeHours: -1,
    timeQuote: "",
    assumptions: [],
    questions: [],
  },
) {
  return {
    value,
    usage: {
      inputTokens: 20,
      outputTokens: 10,
      cachedInputTokens: 0,
      estimatedCny: 0,
      estimatedUsd: 0.001,
      provider: "openai",
      currency: "USD",
      model: "gpt-6.1-terra",
      responseId: "explicit-intake-projection-test-double",
      durationMs: 1,
    },
  };
}
function stored(draftId: string): IntakeDraft {
  return JSON.parse(
    (db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draftId) as { body: string })
      .body,
  );
}
function seedDraft(draftId: string, update: (draft: IntakeDraft) => void) {
  const draft = stored(draftId);
  update(draft);
  db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(JSON.stringify(draft), draftId);
  return draft;
}
function seedOperation(
  draft: IntakeDraft,
  state = "pending",
  updatedAt = Date.now(),
  revision = draft.revision,
) {
  const operationId = randomUUID();
  db()
    .prepare(
      "INSERT INTO intake_operations(id,draft_id,revision,body,state,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(operationId, draft.id, revision, "{}", state, updatedAt);
  return operationId;
}
function seedCall(operationId: string, kind: string, state: string, createdAt = Date.now()) {
  const callId = randomUUID();
  db()
    .prepare(
      "INSERT INTO intake_calls(id,operation_id,kind,state,usage,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(callId, operationId, kind, state, "{}", createdAt);
  return callId;
}
function question(id: string): IntakeQuestion {
  return {
    id,
    title: `显式测试问题 ${id}`,
    reason: "验证未答事项保存",
    type: "text",
    options: [],
    placeholder: "",
    unit: "",
  };
}
function previewDraft() {
  const created = createIntake(owner, {
    goal,
    modelMode: "gpt-6.1-terra",
    workflow: "clarification",
  });
  seedDraft(created.id, (draft) => {
    draft.status = "questions";
    draft.round = 7;
    draft.questions = [question("current")];
    draft.queuedQuestions = [question("queued")];
    draft.answers = [
      {
        questionId: "current",
        question: draft.questions[0],
        state: "answered",
        value: "尚未正式确认",
        confirmation: "pending",
      },
    ];
    draft.challenge = ChallengeSchema.parse({ goal });
    draft.confirmation = { history: [], pendingSummaryFields: ["constraints"] };
    draft.clarification = emptyClarification();
    draft.clarification.rounds = [
      {
        round: draft.round,
        revision: draft.revision,
        questions: [],
        answers: structuredClone(draft.answers),
        changes: { added: [], retired: [], changed: [], triggerAnswerIds: [] },
        runIds: [],
        createdAt: draft.createdAt,
      },
    ];
    draft.clarification.runs = [
      {
        id: randomUUID(),
        operationId: randomUUID(),
        role: "C",
        round: draft.round,
        basedOnRevision: draft.revision,
        status: "failed",
        summary: "Explicit historical failed-run test fixture",
        output: { error: "Explicit historical failure test fixture" },
        usage: [],
        createdAt: draft.createdAt,
      },
    ];
  });
  return getIntake(created.id, owner);
}
function syntheticPreview(draft: IntakeDraft) {
  return {
    state: structuredClone(draft.clarification!),
    questions: [],
    challenge: structuredClone(draft.challenge!),
    assumptions: [...draft.assumptions],
    status: "summary" as const,
  };
}
function useCOnlyOrchestrationDouble() {
  fixture.clarify.mockImplementation(async (draft: IntakeDraft, context: ClarificationContext) => {
    expect(context.intent).toBe("preview");
    await context.call("C", {
      name: "explicit_preview_boundary_fixture",
      schema: z.object({ summary: z.string() }),
      system: "Explicit isolated test double",
      input: {},
      config: context.config,
    });
    const result = syntheticPreview(draft);
    context.record(result.state);
    return result;
  });
}
async function useOptionalPlanningProtocol() {
  const actual = await vi.importActual<typeof import("../src/lib/server/clarification")>(
    "../src/lib/server/clarification",
  );
  fixture.clarify.mockImplementation(actual.runClarification);
  const scope = {
    id: "known_scope",
    topic: "scope",
    title: "既有纸本活动目标",
    description: "显式模型测试替身事项",
    required: true,
    dependsOn: [],
    acceptance: [],
    sourceRefs: ["original_goal"],
    provided: { sourceRef: "original_goal", quote: goal },
  };
  const optional = {
    id: "optional_style",
    topic: "style",
    title: "可以以后调整的纸张样式",
    description: "显式非阻塞测试事项",
    required: false,
    dependsOn: [scope.id],
    acceptance: [],
    sourceRefs: [],
  };
  const items = [scope, optional];
  fixture.generate.mockImplementation(async (request) => {
    if (request.name === "clarification_decompose")
      return modelResult({
        summary: "Explicit A test double",
        items,
        retired: [],
        suggestions: [],
      });
    if (request.name === "clarification_options")
      return modelResult({
        summary: "Explicit B test double",
        questions: request.input.questionableItems.map((item: { id: string; topic: string }) => ({
          ...question(item.id),
          decisionId: item.id,
          ...(item.topic === "authorization"
            ? { authorization: "仅在本人明确同意后公开活动报名信息" }
            : {}),
        })),
        conflicts: [],
      });
    if (request.name === "clarification_review")
      return modelResult({
        summary: "Explicit C test double",
        ready: true,
        coverage: [
          "scope",
          "function",
          "content",
          "flow",
          "style",
          "acceptance",
          "materials",
          "authorization",
        ].map((topic) => ({
          topic,
          applicable: topic === "scope" || topic === "style",
          reason: "Explicit coverage test fixture",
          decisionIds: topic === "scope" ? [scope.id] : topic === "style" ? [optional.id] : [],
        })),
        gaps: [optional],
        conflicts: [],
      });
    throw new Error("Unexpected provider request in explicit optional-planning fixture.");
  });
  return { scope, optional, items };
}
beforeEach(() => {
  closeDb();
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    ARENA_DATABASE_PATH: ":memory:",
    OPENAI_API_KEY: "synthetic-unit-test-only",
    DEEPSEEK_API_KEY: "synthetic-unit-test-only",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL_ID: "gpt-6.1-terra",
    OPENAI_STRUCTURED_OUTPUT: "strict-tool",
    OPENAI_MAX_OUTPUT_TOKENS: "2200",
    OPENAI_REASONING_EFFORT: "low",
    ARENA_INTAKE_EXPIRY_ENABLED: "false",
    ARENA_USAGE_LIMITS_ENABLED: "false",
  }))
    vi.stubEnv(key, value);
  fixture.generate.mockResolvedValue(modelResult());
  fixture.clarify.mockRejectedValue(new Error("No orchestration test double was requested."));
});
afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps old analyze input defaults and rejects preview plus finish", () => {
  const input = { revision: 0, operationId: randomUUID() };
  expect(AnalyzeIntakeSchema.parse(input)).toMatchObject({ intent: "continue", finish: false });
  expect(AnalyzeIntakeSchema.parse({ ...input, finish: true })).toMatchObject({
    intent: "continue",
    finish: true,
  });
  expect(AnalyzeIntakeSchema.safeParse({ ...input, intent: "preview", finish: true }).success).toBe(
    false,
  );
});
it("projects actual calls despite the claimed draft revision changing and excludes unknown roles", () => {
  const created = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
  const draft = seedDraft(created.id, (value) => {
    value.status = "analyzing";
    value.revision++;
  });
  const operationId = seedOperation(draft, "pending", Date.now(), created.revision);
  const callId = seedCall(operationId, "clarification_A", "pending", 10);
  seedCall(operationId, "clarification_B", "completed", 11);
  const failed = seedCall(operationId, "clarification_C", "failed", 12);
  const uncertain = seedCall(operationId, "clarification_B", "uncertain", 13);
  for (const kind of ["analysis", "vision", "clarification_A_other", "__proto__"])
    seedCall(operationId, kind, "pending");
  expect(getIntake(created.id, owner).activity).toEqual({
    operationId,
    calls: [
      { callId, operationId, role: "A", state: "running", startedAt: 10 },
      { callId: failed, operationId, role: "C", state: "failed", startedAt: 12 },
      { callId: uncertain, operationId, role: "B", state: "uncertain", startedAt: 13 },
    ],
  });
  expect(fixture.generate).not.toHaveBeenCalled();
});
it("chooses the latest eligible operation by updated time then row identity and maps uncertainty", () => {
  const draft = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
  const at = Date.now();
  const old = seedOperation(draft, "pending", at);
  seedCall(old, "clarification_A", "pending");
  const operationId = seedOperation(draft, "uncertain", at);
  const callId = seedCall(operationId, "clarification_C", "pending", 20);
  expect(getIntake(draft.id, owner).activity).toEqual({
    operationId,
    calls: [{ callId, operationId, role: "C", state: "uncertain", startedAt: 20 }],
  });
});
it.each(["completed", "failed"])(
  "does not present pending calls of a %s operation as running",
  (state) => {
    const draft = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
    seedCall(seedOperation(draft, state), "clarification_A", "pending");
    expect(getIntake(draft.id, owner).activity).toEqual({ operationId: null, calls: [] });
  },
);
it("keeps projection reads independent from stored draft state and removes legacy projections on save", () => {
  const draft = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
  expect(stored(draft.id)).not.toHaveProperty("activity");
  expect(stored(draft.id)).not.toHaveProperty("readiness");
  const before = stored(draft.id);
  expect(getIntake(draft.id, owner).readiness).toBe("not_ready");
  expect(stored(draft.id)).toEqual(before);
  seedDraft(draft.id, (value) =>
    Object.assign(value, {
      activity: { operationId: "untrusted", calls: [] },
      readiness: "handoff_ready",
    }),
  );
  const saved = updateIntake(draft.id, owner, { revision: draft.revision, goal: goal + "更新" });
  expect(saved.activity).toEqual({ operationId: null, calls: [] });
  expect(saved.readiness).toBe("not_ready");
  expect(stored(draft.id)).not.toHaveProperty("activity");
  expect(stored(draft.id)).not.toHaveProperty("readiness");
});
it("retains GET timeout recovery and uncertain reservations without restarting calls", () => {
  const created = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
  const draft = seedDraft(created.id, (value) => {
    value.status = "analyzing";
    value.reservedUsd = 0.2;
    value.revision++;
  });
  const operationId = seedOperation(draft, "pending", Date.now() - 600000, created.revision);
  const callId = seedCall(operationId, "clarification_A", "pending", 30);
  const recovered = getIntake(draft.id, owner);
  expect(recovered.status).toBe("uncertain");
  expect(recovered.reservedUsd).toBe(0.2);
  expect(recovered.activity).toEqual({
    operationId,
    calls: [{ callId, operationId, role: "A", state: "uncertain", startedAt: 30 }],
  });
  expect(getIntake(draft.id, owner).revision).toBe(recovered.revision);
  expect(fixture.hold).toHaveBeenCalledWith(callId);
  expect(fixture.generate).not.toHaveBeenCalled();
});
it("validates the owner before exposing any activity", () => {
  const draft = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
  seedCall(seedOperation(draft), "clarification_C", "pending");
  expect(() => getIntake(draft.id, "another-owner")).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
});
it("includes normalized intent in new payloads while replaying old payloads without intent", async () => {
  const draft = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
  const input = { revision: draft.revision, operationId: randomUUID(), finish: false };
  await analyzeIntake(draft.id, owner, input);
  const row = db()
    .prepare("SELECT body FROM intake_operations WHERE id=?")
    .get(input.operationId) as { body: string };
  expect(JSON.parse(row.body)).toEqual({
    draftId: draft.id,
    revision: draft.revision,
    finish: false,
    intent: "continue",
  });
  db()
    .prepare("UPDATE intake_operations SET body=? WHERE id=?")
    .run(
      JSON.stringify({ draftId: draft.id, revision: draft.revision, finish: false }),
      input.operationId,
    );
  await analyzeIntake(draft.id, owner, input);
  await analyzeIntake(draft.id, owner, { ...input, intent: "continue" });
  await expect(
    analyzeIntake(draft.id, owner, { ...input, intent: "preview" }),
  ).rejects.toMatchObject({ code: "OPERATION_REUSED" });
  expect(fixture.generate).toHaveBeenCalledTimes(1);
});
it("commits a C-only preview without changing queued questions, round, draft answers or confirmations", async () => {
  const draft = previewDraft();
  useCOnlyOrchestrationDouble();
  const response = Promise.withResolvers<ReturnType<typeof modelResult>>();
  fixture.generate.mockReturnValueOnce(response.promise);
  const input = {
    revision: draft.revision,
    operationId: randomUUID(),
    finish: false,
    intent: "preview" as const,
  };
  const pending = analyzeIntake(draft.id, owner, input);
  await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledTimes(1));
  const running = getIntake(draft.id, owner);
  expect(running.activity.operationId).toBe(input.operationId);
  expect(running.activity.calls).toHaveLength(1);
  expect(running.activity.calls[0]).toMatchObject({ role: "C", state: "running" });
  response.resolve(modelResult({ summary: "Explicit synthetic preview model output" }));
  const result = await pending;
  for (const key of ["questions", "queuedQuestions", "round", "answers", "confirmation"] as const)
    expect(result[key]).toEqual(draft[key]);
  expect(result.status).toBe("questions");
  expect(result.activity).toEqual({ operationId: null, calls: [] });
  expect(result.clarification?.rounds).toEqual(draft.clarification?.rounds);
  expect(result.clarification?.runs).toEqual(draft.clarification?.runs);
  expect(db().prepare("SELECT kind FROM intake_calls").all()).toEqual([
    { kind: "clarification_C" },
  ]);
  expect(db().prepare("SELECT count(*) AS count FROM versions").get()).toMatchObject({ count: 0 });
  await analyzeIntake(draft.id, owner, input);
  await expect(
    analyzeIntake(draft.id, owner, { ...input, intent: "continue" }),
  ).rejects.toMatchObject({ code: "OPERATION_REUSED" });
  expect(fixture.generate).toHaveBeenCalledTimes(1);
});
it.each(["CLARIFICATION_ANALYSIS_STALE", "CLARIFICATION_MATERIALS_PENDING"])(
  "preserves unconfirmed input when the preview guard rejects %s without another call",
  async (code) => {
    const draft = previewDraft();
    const attachment: IntakeAttachment & { parsed: ParsedAttachment } = {
      id: randomUUID(),
      name: "explicit-fixture.png",
      size: 8,
      state: "ready",
      imageCount: 1,
      interpreted: false,
      locations: ["page1"],
      warnings: [],
      parsed: {
        kind: "image",
        chunks: [],
        images: [
          { location: "page1", dataUrl: "data:image/png;base64,Zml4dHVyZQ==", width: 1, height: 1 },
        ],
        warnings: [],
      },
    };
    db()
      .prepare(
        "INSERT INTO intake_attachments(id,draft_id,name,size,bytes,body) VALUES(?,?,?,?,?,?)",
      )
      .run(
        attachment.id,
        draft.id,
        attachment.name,
        attachment.size,
        Buffer.from("fixture"),
        JSON.stringify(attachment),
      );
    fixture.clarify.mockRejectedValueOnce(
      new ArenaError("Explicit fixture: material reading must finish before preview.", 409, code),
    );
    const input = {
      revision: draft.revision,
      operationId: randomUUID(),
      intent: "preview" as const,
    };
    const result = await analyzeIntake(draft.id, owner, input);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("material reading must finish");
    for (const key of ["questions", "queuedQuestions", "round", "answers", "confirmation"] as const)
      expect(result[key]).toEqual(draft[key]);
    await analyzeIntake(draft.id, owner, input);
    expect(fixture.clarify).toHaveBeenCalledTimes(1);
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(db().prepare("SELECT count(*) AS count FROM intake_calls").get()).toMatchObject({
      count: 0,
    });
  },
);
it("does not let a late preview overwrite the recovered operation epoch", async () => {
  const draft = previewDraft();
  useCOnlyOrchestrationDouble();
  const response = Promise.withResolvers<ReturnType<typeof modelResult>>();
  fixture.generate.mockReturnValueOnce(response.promise);
  const operationId = randomUUID();
  const pending = analyzeIntake(draft.id, owner, {
    revision: draft.revision,
    operationId,
    intent: "preview",
  });
  await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledTimes(1));
  db()
    .prepare("UPDATE intake_operations SET updated_at=? WHERE id=?")
    .run(Date.now() - 600000, operationId);
  const recovered = getIntake(draft.id, owner);
  expect(recovered.status).toBe("uncertain");
  expect(recovered.reservedUsd).toBeGreaterThan(0);
  response.resolve(modelResult({ summary: "Late explicit synthetic preview result" }));
  const late = await pending;
  expect(late.status).toBe("uncertain");
  expect(late.revision).toBe(recovered.revision);
  expect(late.questions).toEqual(draft.questions);
  expect(late.queuedQuestions).toEqual(draft.queuedQuestions);
  expect(
    db().prepare("SELECT state FROM intake_operations WHERE id=?").get(operationId),
  ).toMatchObject({ state: "uncertain" });
  expect(fixture.generate).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "hands off optional unanswered items without skipped answers, with prior confirmed context %s",
  async (priorConfirmedContext) => {
    const { optional } = await useOptionalPlanningProtocol();
    let draft = createIntake(owner, {
      goal,
      modelMode: "gpt-6.1-terra",
      workflow: "clarification",
    });
    if (priorConfirmedContext) {
      seedDraft(draft.id, (value) => {
        value.status = "questions";
        value.challenge = ChallengeSchema.parse({ goal });
      });
      draft = updateIntake(draft.id, owner, {
        revision: draft.revision,
        summary: {
          challenge: ChallengeSchema.parse({ goal, domain: "creation" }),
          assumptions: [],
        },
      });
      seedDraft(draft.id, (value) => {
        value.confirmation = {
          history: [],
          summary: {
            revision: value.revision,
            confirmedAt: value.createdAt,
            challenge: structuredClone(value.challenge!),
          },
          pendingSummaryFields: [],
        };
      });
    }
    draft = await analyzeIntake(draft.id, owner, {
      revision: draft.revision,
      operationId: randomUUID(),
    });
    const questions = structuredClone(draft.questions);
    const beforePreview = fixture.generate.mock.calls.length;
    draft = await analyzeIntake(draft.id, owner, {
      revision: draft.revision,
      operationId: randomUUID(),
      intent: "preview",
    });
    expect(draft.status).toBe("questions");
    expect(draft.readiness).toBe("requirement_ready");
    expect(draft.questions).toEqual(questions);
    expect(fixture.generate).toHaveBeenCalledTimes(beforePreview);
    const storedBeforeNoOp = stored(draft.id);
    const noOp = updateIntake(draft.id, owner, {
      revision: draft.revision,
      summary: { challenge: draft.challenge!, assumptions: draft.assumptions },
    });
    expect(noOp.revision).toBe(draft.revision);
    expect(noOp.clarification).toEqual(draft.clarification);
    expect(noOp.confirmation).toEqual(draft.confirmation);
    expect(noOp.readiness).toBe("requirement_ready");
    expect(stored(draft.id)).toEqual(storedBeforeNoOp);
    expect(fixture.generate).toHaveBeenCalledTimes(beforePreview);
    const beforeSubmit = fixture.generate.mock.calls.length;
    const submitted = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    if (!("versions" in submitted))
      throw new Error(`Explicit handoff fixture failed: ${submitted.error}`);
    const version = submitted.versions.find((value) => value.id === submitted.activeVersionId)!;
    expect(version.status).toBe("completed");
    expect(version.clarification?.draftOnly).toBe(false);
    expect(version.clarification?.review?.ready).toBe(true);
    expect(version.clarification?.review?.gaps.some((gap) => gap.id === optional.id)).toBe(true);
    expect(version.intake?.answers).toEqual([]);
    expect(getIntake(draft.id, owner).answers).toEqual([]);
    if (priorConfirmedContext) expect(fixture.generate).toHaveBeenCalledTimes(beforeSubmit);
  },
);

it("confirms an edited summary with the necessary C review before one formal handoff", async () => {
  const { scope } = await useOptionalPlanningProtocol();
  let draft = createIntake(owner, {
    goal,
    modelMode: "gpt-6.1-terra",
    workflow: "clarification",
  });
  draft = await analyzeIntake(draft.id, owner, {
    revision: draft.revision,
    operationId: randomUUID(),
  });
  const originalChallenge = structuredClone(draft.challenge!);
  seedDraft(draft.id, (value) => {
    value.confirmation = {
      history: [],
      summary: {
        revision: value.revision,
        confirmedAt: value.createdAt,
        challenge: structuredClone(value.challenge!),
      },
      pendingSummaryFields: [],
    };
  });
  draft = await analyzeIntake(draft.id, owner, {
    revision: draft.revision,
    operationId: randomUUID(),
    intent: "preview",
  });
  draft = updateIntake(draft.id, owner, {
    revision: draft.revision,
    summary: {
      challenge: { ...draft.challenge!, constraints: "活动最多五人" },
      assumptions: draft.assumptions,
    },
  });
  expect(draft.confirmation?.pendingSummaryFields).toContain("constraints");
  expect(draft.clarification?.review).toBeNull();
  scope.sourceRefs = ["confirmed_summary"];
  scope.provided = { sourceRef: "confirmed_summary", quote: "活动最多五人" };
  draft = await analyzeIntake(draft.id, owner, {
    revision: draft.revision,
    operationId: randomUUID(),
  });
  expect(draft.status).toBe("questions");
  expect(draft.questions.some((value) => value.decisionId === scope.id)).toBe(true);
  draft = await analyzeIntake(draft.id, owner, {
    revision: draft.revision,
    operationId: randomUUID(),
    intent: "preview",
  });
  expect(draft.readiness).toBe("previewable");
  expect(draft.clarification?.review?.ready).toBe(false);
  const beforeSubmit = fixture.generate.mock.calls.length;
  const previousRoundCount = draft.clarification!.rounds.length;
  const submitted = await submitClarificationIntake(draft.id, owner, {
    revision: draft.revision,
    challenge: draft.challenge!,
    assumptions: draft.assumptions,
  });
  if (!("versions" in submitted))
    throw new Error(`Explicit summary confirmation fixture failed: ${submitted.error}`);
  const version = submitted.versions.find((value) => value.id === submitted.activeVersionId)!;
  expect(version.status).toBe("completed");
  expect(version.challenge.constraints).toBe("活动最多五人");
  expect(version.challenge.budget).toBeNull();
  expect(version.challenge.timeHours).toBeNull();
  expect(version.clarification?.draftOnly).toBe(false);
  expect(version.clarification?.review?.ready).toBe(true);
  expect(version.clarification?.rounds).toHaveLength(previousRoundCount);
  expect(version.intake?.answers).toEqual([]);
  expect(fixture.generate.mock.calls.slice(beforeSubmit).map(([request]) => request.name)).toEqual([
    "clarification_review",
  ]);
  const saved = getIntake(draft.id, owner);
  expect(saved.confirmation?.pendingSummaryFields).toEqual([]);
  expect(
    saved.confirmation?.history.some(
      (entry) => entry.summary?.challenge.constraints === originalChallenge.constraints,
    ),
  ).toBe(true);
  expect(saved.clarification?.items.find((item) => item.id === scope.id)?.provided).toEqual({
    sourceRef: "confirmed_summary",
    quote: "活动最多五人",
  });
  const aOutputs = saved
    .clarification!.runs.filter((run) => run.role === "A")
    .map((run) => run.output);
  expect(aOutputs[0]).toMatchObject({
    items: [
      expect.objectContaining({
        provided: { sourceRef: "original_goal", quote: goal },
      }),
      expect.anything(),
    ],
  });
});

it("keeps direct summary submission available when no prior answer or authorization is invalidated", async () => {
  await useOptionalPlanningProtocol();
  let draft = createIntake(owner, {
    goal,
    modelMode: "gpt-6.1-terra",
    workflow: "clarification",
  });
  draft = await analyzeIntake(draft.id, owner, {
    revision: draft.revision,
    operationId: randomUUID(),
  });
  const result = await submitClarificationIntake(draft.id, owner, {
    revision: draft.revision,
    challenge: { ...draft.challenge!, constraints: "本人确认活动最多五人" },
    assumptions: draft.assumptions,
  });
  if (!("versions" in result))
    throw new Error(`Explicit direct summary fixture failed: ${result.error}`);
  const version = result.versions.find((entry) => entry.id === result.activeVersionId)!;
  expect(version.status).toBe("completed");
  expect(version.challenge.constraints).toBe("本人确认活动最多五人");
  expect(version.challenge.materials).toContain("本人确认活动最多五人");
  expect(version.clarification?.review?.ready).toBe(true);
  expect(version.intake?.answers).toEqual([]);
});

it.each(["constraints", "preferences"] as const)(
  "invalidates affected answers and dependent authorization when submit directly changes %s",
  async (field) => {
    const { scope, items } = await useOptionalPlanningProtocol();
    items.push({
      id: "permission",
      topic: "authorization",
      title: "活动报名信息的公开授权",
      description: "显式关联授权测试替身事项",
      required: false,
      dependsOn: [scope.id],
      acceptance: [],
      sourceRefs: [],
    });
    let draft = createIntake(owner, {
      goal,
      modelMode: "gpt-6.1-terra",
      workflow: "clarification",
    });
    draft = await analyzeIntake(draft.id, owner, {
      revision: draft.revision,
      operationId: randomUUID(),
    });
    const existing = { ...question(scope.id), decisionId: scope.id, affects: [field] };
    const authorization = draft.questions.find((entry) => entry.decisionId === "permission")!;
    expect(authorization.authorization).toBeTruthy();
    seedDraft(draft.id, (value) => {
      value.challenge = { ...value.challenge!, [field]: "原条件最多十人且仅内部使用" };
      value.answers = [existing, authorization].map((entry) => ({
        questionId: entry.id,
        question: entry,
        state: "answered",
        value: entry.id === existing.id ? "原条件最多十人且仅内部使用" : "同意",
        confirmation: "confirmed",
        confirmedRevision: value.revision,
        confirmedAt: value.createdAt,
      }));
      value.confirmation = {
        history: [],
        summary: {
          revision: value.revision,
          confirmedAt: value.createdAt,
          challenge: structuredClone(value.challenge),
        },
        pendingSummaryFields: [],
      };
    });
    draft = getIntake(draft.id, owner);
    const result = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: { ...draft.challenge!, [field]: "新条件最多五人并公开报名信息" },
      assumptions: draft.assumptions,
    });
    expect("versions" in result).toBe(false);
    if ("versions" in result) throw new Error("Dependent authorization was incorrectly reused.");
    expect(result.status).toBe("questions");
    expect(result.challenge![field]).toBe("新条件最多五人并公开报名信息");
    expect(result.challenge!.materials).toContain("新条件最多五人并公开报名信息");
    expect(result.challenge!.budget).toBeNull();
    expect(result.challenge!.timeHours).toBeNull();
    expect(result.answers).toHaveLength(2);
    expect(
      result.answers.every(
        (answer) => answer.confirmation === "pending" && answer.needsReconfirmation,
      ),
    ).toBe(true);
    expect(
      result.confirmation!.history.some((entry) =>
        entry.answers.every((answer) => answer.confirmation === "confirmed"),
      ),
    ).toBe(true);
    expect(result.clarification!.runs.findLast((run) => run.role === "C")?.output).toMatchObject({
      ready: true,
    });
    expect(result.clarification!.review?.ready).toBe(false);
    expect(result.clarification!.draftOnly).toBe(true);
    expect(result.readiness).toBe("previewable");
    expect(db().prepare("SELECT count(*) AS count FROM arenas").get()).toMatchObject({ count: 0 });
    const retry = await submitClarificationIntake(result.id, owner, {
      revision: result.revision,
      challenge: result.challenge!,
      assumptions: result.assumptions,
    });
    expect("versions" in retry).toBe(false);
    expect(getIntake(result.id, owner).answers).toEqual(result.answers);
    expect(db().prepare("SELECT count(*) AS count FROM arenas").get()).toMatchObject({ count: 0 });
  },
);

it("keeps questions and queue through continuous summary edits while invalidating dependent confirmations", () => {
  const draft = previewDraft();
  seedDraft(draft.id, (value) => {
    const existing = question("confirmed_fact");
    existing.affects = ["constraints"];
    const authorization = {
      ...question("permission"),
      dependsOn: [existing.id],
      authorization: "仅在本人明确同意后公开活动报名信息",
    };
    value.answers = [
      {
        questionId: existing.id,
        question: existing,
        state: "answered",
        value: "活动最多十人",
        confirmation: "confirmed",
        confirmedAt: value.createdAt,
        confirmedRevision: value.revision,
      },
      {
        questionId: authorization.id,
        question: authorization,
        state: "answered",
        value: "同意",
        confirmation: "confirmed",
        confirmedAt: value.createdAt,
        confirmedRevision: value.revision,
      },
    ];
    value.confirmation = {
      history: [],
      summary: {
        revision: value.revision,
        confirmedAt: value.createdAt,
        challenge: structuredClone(value.challenge!),
      },
    };
  });
  const before = getIntake(draft.id, owner);
  const first = updateIntake(draft.id, owner, {
    revision: before.revision,
    summary: {
      challenge: { ...before.challenge!, constraints: "活动最多五人" },
      assumptions: before.assumptions,
    },
  });
  expect(first.status).toBe("questions");
  expect(first.questions).toEqual(before.questions);
  expect(first.queuedQuestions).toEqual(before.queuedQuestions);
  expect(first.confirmation?.pendingSummaryFields).toContain("constraints");
  expect(
    first.answers.every(
      (answer) => answer.confirmation === "pending" && answer.needsReconfirmation,
    ),
  ).toBe(true);
  expect(
    first.confirmation?.history
      .at(-1)
      ?.answers.every((answer) => answer.confirmation === "confirmed"),
  ).toBe(true);
  const second = updateIntake(draft.id, owner, {
    revision: first.revision,
    summary: {
      challenge: { ...first.challenge!, preferences: "优先使用已有纸张" },
      assumptions: first.assumptions,
    },
  });
  expect(second.status).toBe("questions");
  expect(second.questions).toEqual(before.questions);
  expect(second.queuedQuestions).toEqual(before.queuedQuestions);
  expect(second.answers).toEqual(first.answers);
  expect(second.clarification?.review).toBeNull();
  expect(fixture.generate).not.toHaveBeenCalled();
});
