/** Explicit synthetic replay records. These tests make no provider request or user-data write. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ArenaEvent, ModelUsage } from "../src/lib/contracts";
import type { ClarificationRun, DecisionItem } from "../src/lib/clarification-contracts";
import type { IntakeQuestion, RecordedAnswer } from "../src/lib/intake-contracts";
import type { ReplayAction } from "../src/lib/replay-contracts";
import { buildClarificationReplay, projectReplay } from "../src/lib/replay";
import { beatsOf } from "../src/components/console/beats";
import { replaySummaryLines, stepContext } from "../src/lib/step-context";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../src/lib/recorded-examples";
import { fixtureSnapshot } from "./e2e/ui.fixture";

const question: IntakeQuestion = {
  id: "purpose",
  decisionId: "purpose",
  title: "选择实际用途",
  reason: "合成测试输入",
  placeholder: "按实际情况填写",
  type: "single",
  options: ["真实收集", "界面演示"],
  unit: "",
};
const answered: RecordedAnswer = {
  questionId: question.id,
  question,
  state: "answered",
  value: "界面演示",
  confirmation: "confirmed",
  confirmedRevision: 3,
  confirmedAt: "2026-11-12T00:00:10.000Z",
};
const usage: ModelUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  estimatedCny: 0,
  model: "explicit-test-double",
  responseId: "test-response",
  durationMs: 1,
};
const decision: DecisionItem = {
  id: question.id,
  topic: "scope",
  title: question.title,
  description: "合成待确认事项",
  dependsOn: [],
  required: true,
  acceptance: [],
  sourceRefs: [],
};

function run(id: string, role: ClarificationRun["role"], round: number): ClarificationRun {
  return {
    id,
    role,
    round,
    operationId: `operation-${id}`,
    basedOnRevision: round,
    status: "completed",
    summary: `合成${role}输出`,
    usage: [usage],
    callIds: [`call-${id}`],
    createdAt: "2026-11-12T00:00:00.000Z",
    output:
      role === "A"
        ? { summary: "合成拆解", items: [decision], retired: [], suggestions: [] }
        : role === "B"
          ? {
              summary: "合成提问",
              questions: round === 1 ? [{ ...question, decisionId: question.id }] : [],
              conflicts: [],
            }
          : { summary: "合成查漏", ready: true, coverage: [], gaps: [], conflicts: [] },
  };
}

function version() {
  const value = fixtureSnapshot().versions[0];
  const runs = [
    run("a1", "A", 1),
    run("b1", "B", 1),
    run("a2", "A", 2),
    run("b2", "B", 2),
    run("c2", "C", 2),
  ];
  value.workflow = "clarification";
  value.status = "completed";
  value.clarification = {
    protocol: "clarification-1",
    items: [decision],
    retiredIds: [],
    runs,
    rounds: [
      {
        round: 1,
        revision: 1,
        questions: [{ ...question, decisionId: question.id }],
        answers: [],
        changes: { added: [question.id], changed: [], retired: [], triggerAnswerIds: [] },
        runIds: ["a1", "b1"],
        createdAt: runs[1].createdAt,
      },
      {
        round: 2,
        revision: 4,
        questions: [],
        answers: [structuredClone(answered)],
        changes: { added: [], changed: [], retired: [], triggerAnswerIds: [question.id] },
        runIds: ["a2", "b2", "c2"],
        createdAt: "2026-11-12T00:00:20.000Z",
      },
    ],
    suggestions: [],
    conflicts: [],
    review: {
      summary: "合成最终查漏",
      ready: true,
      coverage: [],
      gaps: [],
      conflicts: [],
      fingerprint: "synthetic-test-fingerprint",
      basedOnRevision: 2,
    },
    next: "completed",
    draftOnly: false,
    specification: "合成需求说明",
    executionPrompt: "合成执行提示词",
  };
  value.intake = {
    id: "test-intake",
    originalGoal: value.challenge.goal,
    answers: [answered],
    assumptions: [],
    usedSources: [],
    usage: runs.flatMap((entry) => entry.usage),
    confirmation: {
      history: [],
      pendingSummaryFields: [],
      summary: {
        revision: 5,
        confirmedAt: "2026-11-12T00:00:30.000Z",
        challenge: structuredClone(value.challenge),
      },
    },
  };
  return value;
}

function actions(): ReplayAction[] {
  const base = {
    round: 1,
    revision: 3,
    sourceRunId: "b1",
    questions: [question],
    source: {
      kind: "api_request" as const,
      reference: "raw/patch-response.json",
      sha256: "a".repeat(64),
    },
  };
  return [
    { ...base, id: "questions", kind: "questions" },
    { ...base, id: "selection", kind: "answer", answers: [answered] },
    { ...base, id: "round-confirm", kind: "round_confirm", answers: [answered] },
    { ...base, id: "summary-submit", kind: "summary_submit", round: 2, sourceRunId: "a2" },
    { ...base, id: "summary-confirm", kind: "summary_confirm", round: 2, sourceRunId: "c2" },
    { ...base, id: "handoff", kind: "handoff", round: 2, sourceRunId: "c2" },
  ];
}

describe("saved clarification replay ordering and prefix projection", () => {
  it("preserves independent calls and inserts stable grouped actions without attaching future answers to B", () => {
    const current = version();
    const input = actions();
    const steps = beatsOf(current, [input[2], input[1], input[0], ...input.slice(3)]);
    expect(steps.map((step) => step.replayAction?.kind ?? step.clarificationRun?.id)).toEqual([
      "a1",
      "b1",
      "questions",
      "answer",
      "round_confirm",
      "summary_submit",
      "a2",
      "b2",
      "c2",
      "summary_confirm",
      "handoff",
    ]);
    expect(
      steps.filter((step) => step.clarificationRun).map((step) => step.clarificationRun?.id),
    ).toEqual(current.clarification!.runs.map((entry) => entry.id));
    expect(steps.filter((step) => step.replayAction).every((step) => !step.clarificationRun)).toBe(
      true,
    );
    expect(
      steps.find((step) => step.clarificationRun?.id === "b1")?.clarificationAnswers,
    ).toBeUndefined();
    expect(
      steps
        .filter((step) => step.replayAction?.round === 1)
        .map((step) => step.replayAction!.questions),
    ).toEqual([[question], [question], [question]]);
    expect(projectReplay(current, steps, 2).answers).toEqual([]);
  });

  it("shows saved values pending and commits accepted confirmation only at its own phase boundary", () => {
    const current = version();
    const steps = buildClarificationReplay(current, actions());
    const selected = projectReplay(current, steps, 3).answers[0];
    expect(selected).toMatchObject({ value: "界面演示", confirmation: "pending" });
    expect(selected.confirmedRevision).toBeUndefined();
    expect(selected.confirmedAt).toBeUndefined();
    expect(projectReplay(current, steps, 4, [], 0.79).answers[0].confirmation).toBe("pending");
    expect(projectReplay(current, steps, 4, [], 0.8).answers[0]).toEqual(answered);
    expect(current.intake!.answers[0]).toEqual(answered);
  });

  it.each(["unknown", "skipped"] as const)(
    "keeps a recorded %s answer unresolved through round confirmation",
    (state) => {
      const current = version();
      const unknown = {
        ...answered,
        state,
        value: "",
        confirmation: undefined,
        confirmedRevision: undefined,
        confirmedAt: undefined,
      };
      const input = actions();
      input[1].answers = [unknown];
      input[2].answers = [unknown];
      const steps = buildClarificationReplay(current, input);
      const result = projectReplay(current, steps, 4).answers[0];
      expect(result.state).toBe(state);
      expect(result.value).toBe("");
      expect(result.confirmation).not.toBe("confirmed");
    },
  );

  it("does not inherit confirmation when the same question is changed and invalidates only dependent answers", () => {
    const current = version();
    const dependent = {
      ...answered,
      questionId: "detail",
      question: { ...question, id: "detail", dependsOn: [question.id] },
      value: "旧细节",
    };
    const independent = {
      ...answered,
      questionId: "style",
      question: { ...question, id: "style" },
      value: "朴素",
    };
    const changed = { ...answered, value: "真实收集", confirmedRevision: 6 };
    const input = actions();
    input[2].answers = [answered, dependent, independent];
    input.splice(3, 0, {
      ...input[1],
      id: "revised-selection",
      sourceRunId: "b2",
      round: 2,
      answers: [changed],
    });
    const steps = buildClarificationReplay(current, input);
    const at = steps.findIndex((step) => step.replayAction?.id === "revised-selection");
    const projected = projectReplay(current, steps, at).answers;
    expect(projected.find((answer) => answer.questionId === question.id)).toMatchObject({
      value: "真实收集",
      confirmation: "pending",
    });
    expect(projected.find((answer) => answer.questionId === "detail")).toMatchObject({
      value: "旧细节",
      confirmation: "pending",
      needsReconfirmation: true,
    });
    expect(projected.find((answer) => answer.questionId === "style")?.confirmation).toBe(
      "confirmed",
    );
    expect(
      projectReplay(current, steps, at - 1).answers.find(
        (answer) => answer.questionId === question.id,
      )?.value,
    ).toBe("界面演示");
  });

  it.each([
    { changed: "title", question: { ...question, title: "确认新的用途说明" } },
    { changed: "options", question: { ...question, options: ["界面演示", "仅提供设计稿"] } },
    { changed: "authorization", question: { ...question, authorization: "只授权本机内存暂存" } },
  ])(
    "rechecks dependents when $changed changes while the selected value stays the same",
    ({ question: changedQuestion }) => {
      const current = version();
      const dependent = {
        ...answered,
        questionId: "detail",
        value: "旧细节",
        question: { ...question, id: "detail", decisionId: "detail", dependsOn: [question.id] },
      };
      const input = actions();
      input[2].answers = [answered, dependent];
      input.splice(3, 0, {
        ...input[1],
        id: "same-value-new-question",
        round: 2,
        sourceRunId: "b2",
        questions: [changedQuestion],
        answers: [{ ...answered, question: changedQuestion }],
      });
      const steps = buildClarificationReplay(current, input);
      const index = steps.findIndex((step) => step.replayAction?.id === "same-value-new-question");
      const projection = projectReplay(current, steps, index);
      expect(projection.answers.find((answer) => answer.questionId === "detail")).toMatchObject({
        confirmation: "pending",
        needsReconfirmation: true,
      });
      expect(projection.unresolved).toContain(dependent.question.title);
    },
  );

  it.each(["unknown", "skipped"] as const)(
    "keeps a C gap and presented %s question pending across B outputs until actual confirmation",
    (state) => {
      const current = version();
      current.requirements = {
        confirmed: [],
        unresolved: ["FINAL_REQUIREMENT_MUST_NOT_LEAK"],
        suggestions: [],
        missingMaterials: [],
        executionPrompt: "合成执行提示词",
      };
      const gap = { ...decision, title: "需要补齐授权范围" };
      const gapRun = run("gap-c", "C", 1);
      if (!("gaps" in gapRun.output)) throw new Error("Expected synthetic C output");
      gapRun.output.gaps = [gap];
      gapRun.output.ready = false;
      const b = run("gap-b", "B", 2);
      const shownQuestion = { ...question, title: "本次允许使用哪些资料？" };
      const unknown = {
        ...answered,
        question: shownQuestion,
        state,
        value: "",
        confirmation: undefined,
      };
      const accepted = { ...answered, question: shownQuestion };
      const action = { ...actions()[0], questions: [shownQuestion] };
      const steps = [
        { id: "gap-c", clarificationRun: gapRun },
        { id: "gap-b", clarificationRun: b },
        { id: "show", replayAction: { ...action, kind: "questions" as const } },
        { id: "unknown", replayAction: { ...action, kind: "answer" as const, answers: [unknown] } },
        {
          id: "confirm-unknown",
          replayAction: { ...action, kind: "round_confirm" as const, answers: [unknown] },
        },
        { id: "answer", replayAction: { ...action, kind: "answer" as const, answers: [accepted] } },
        {
          id: "confirm",
          replayAction: { ...action, kind: "round_confirm" as const, answers: [accepted] },
        },
      ];
      expect(projectReplay(current, steps, 0).unresolved).toEqual([gap.title]);
      expect(projectReplay(current, steps, 1).unresolved).toEqual([gap.title]);
      expect(projectReplay(current, steps, 4).unresolved).toEqual([shownQuestion.title]);
      expect(projectReplay(current, steps, 6, [], 0.79).unresolved).toEqual([shownQuestion.title]);
      expect(projectReplay(current, steps, 6, [], 0.8).unresolved).toEqual([]);
      expect(projectReplay(current, steps, 1).conflicts).toEqual([]);
      expect(projectReplay(current, steps, 1).unresolved).not.toContain(
        "FINAL_REQUIREMENT_MUST_NOT_LEAK",
      );
    },
  );

  it("clears a prior C gap only when a later C actually reviews that decision or accepts the full handoff", () => {
    const current = version();
    const original = run("gap-c", "C", 1);
    const unrelated = run("unrelated-c", "C", 2);
    const cleared = run("cleared-c", "C", 3);
    if (
      !("gaps" in original.output) ||
      !("gaps" in unrelated.output) ||
      !("gaps" in cleared.output)
    )
      throw new Error("Expected synthetic C outputs");
    original.output.gaps = [decision];
    original.output.ready = false;
    unrelated.output.ready = false;
    cleared.output.ready = false;
    cleared.output.coverage = [
      {
        topic: "scope",
        applicable: true,
        reason: "已核对该事项不再缺失",
        decisionIds: [decision.id],
      },
    ];
    const steps = [original, unrelated, cleared].map((clarificationRun) => ({
      id: clarificationRun.id,
      clarificationRun,
    }));
    expect(projectReplay(current, steps, 1).unresolved).toEqual([decision.title]);
    expect(projectReplay(current, steps, 2).unresolved).toEqual([]);
  });

  it("projects only prefix usage and explicitly linked logs, regardless of event position", () => {
    const current = version();
    const event = (seq: number, data: unknown): ArenaEvent => ({
      seq,
      arenaId: "test-arena",
      versionId: current.id,
      type: "test-recorded",
      stage: null,
      actor: null,
      message: "合成日志",
      data,
      createdAt: "2026-11-12T00:01:00.000Z",
    });
    const events = [
      event(1, { id: "c2" }),
      event(2, { id: "a1" }),
      event(3, { callId: "call-b1" }),
      event(4, { id: "not-shown" }),
    ];
    const steps = buildClarificationReplay(current, actions());
    expect(projectReplay(current, steps, -1, events)).toMatchObject({
      calls: 0,
      tokens: 0,
      logs: [],
      answers: [],
      items: [],
    });
    const first = projectReplay(current, steps, 0, events);
    expect(first.calls).toBe(1);
    expect(first.tokens).toBe(15);
    expect(first.logs.map((entry) => entry.seq)).toEqual([2]);
    expect(projectReplay(current, steps, 1, events).logs.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(first.items.map((entry) => entry.id)).toEqual([question.id]);
  });

  it("gates summary acceptance and handoff independently of a model's raw ready claim", () => {
    const current = version();
    const steps = buildClarificationReplay(current, actions());
    const summary = steps.findIndex((step) => step.replayAction?.kind === "summary_confirm");
    const final = steps.length - 1;
    expect(projectReplay(current, steps, summary - 1)).toMatchObject({
      summaryConfirmed: false,
      handoffComplete: false,
    });
    expect(projectReplay(current, steps, summary, [], 0.79).summaryConfirmed).toBe(false);
    expect(projectReplay(current, steps, summary, [], 0.8).summaryConfirmed).toBe(true);
    expect(projectReplay(current, steps, final, [], 0.79).handoffComplete).toBe(false);
    expect(projectReplay(current, steps, final, [], 0.8).handoffComplete).toBe(true);
    current.clarification!.review!.basedOnRevision = 999;
    expect(projectReplay(current, steps, final).handoffComplete).toBe(false);
  });

  it("retains the exact submitted summary and never substitutes a later final challenge", () => {
    const current = version();
    const input = actions();
    const early = {
      challenge: {
        ...current.challenge,
        goal: "FIRST_SUBMISSION_RECORDED",
        budget: 0,
        timeHours: 0,
      },
      assumptions: ["EARLY_AI_ASSUMPTION_PENDING"],
    };
    current.challenge.goal = "LATER_FINAL_GOAL";
    input[3].summary = early;
    input[4].summary = { challenge: structuredClone(current.challenge), assumptions: [] };
    const steps = buildClarificationReplay(current, input);
    const submitted = steps.findIndex((step) => step.replayAction?.kind === "summary_submit");
    const accepted = steps.findIndex((step) => step.replayAction?.kind === "summary_confirm");
    expect(projectReplay(current, steps, submitted).summary).toEqual(early);
    expect(projectReplay(current, steps, accepted, [], 0.79).summary).toEqual(early);
    expect(projectReplay(current, steps, accepted, [], 0.8).summary?.challenge.goal).toBe(
      "LATER_FINAL_GOAL",
    );
    const context = stepContext(current, steps[submitted].id, input)!;
    expect(context.quote).toContain("FIRST_SUBMISSION_RECORDED");
    expect(context.quote).not.toContain("LATER_FINAL_GOAL");
    expect(context.quote).toContain("预算上限 — 0 元");
    expect(context.quote).toContain("时间上限 — 0 小时");
    expect(context.quote).toContain("暂定假设（待核对） — EARLY_AI_ASSUMPTION_PENDING");
    delete input[3].summary;
    const missing = stepContext(current, steps[submitted].id, input)!;
    expect(missing.quote).toContain("未记录完整摘要");
    expect(missing.quote).not.toContain("LATER_FINAL_GOAL");
    expect(replaySummaryLines(undefined)).toEqual(["本次操作未记录完整摘要，保留现有来源记录。"]);
  });

  it("rebuilds saved states with snapshot provenance and never fabricates missing confirmation or handoff", () => {
    const current = version();
    const steps = buildClarificationReplay(current);
    expect(
      steps
        .filter((step) => step.replayAction)
        .every((step) => step.replayAction!.source?.kind === "snapshot"),
    ).toBe(true);
    expect(steps.some((step) => step.replayAction?.kind === "summary_submit")).toBe(false);
    expect(projectReplay(current, steps, steps.length - 1).handoffComplete).toBe(true);
    delete current.clarification!.rounds[1].answers[0].confirmation;
    delete current.intake!.confirmation!.summary;
    const pending = buildClarificationReplay(current);
    expect(
      pending.some((step) =>
        ["round_confirm", "summary_confirm", "handoff"].includes(step.replayAction?.kind ?? ""),
      ),
    ).toBe(false);
    expect(projectReplay(current, pending, pending.length - 1).answers[0].confirmation).toBe(
      "pending",
    );
  });

  it.each(["waiting", "pending-summary", "stale-summary", "failed-review"] as const)(
    "keeps a %s snapshot from acquiring a handoff action",
    (reason) => {
      const current = version();
      if (reason === "waiting") current.status = "paused";
      if (reason === "pending-summary")
        current.intake!.confirmation!.pendingSummaryFields = ["constraints"];
      if (reason === "stale-summary") current.challenge.constraints = "尚未确认的新要求";
      if (reason === "failed-review") current.clarification!.runs.at(-1)!.status = "failed";
      const steps = buildClarificationReplay(current);
      expect(steps.some((step) => step.replayAction?.kind === "handoff")).toBe(false);
      expect(projectReplay(current, steps, steps.length - 1).handoffComplete).toBe(false);
    },
  );

  it("delivers only an explicitly requested draft without promoting it to a confirmed summary", () => {
    const current = version();
    current.status = "paused";
    current.clarification!.draftOnly = true;
    current.clarification!.requestedDraft = true;
    current.clarification!.review!.ready = false;
    delete current.intake!.confirmation!.summary;
    const steps = buildClarificationReplay(current);
    expect(steps.at(-1)?.replayAction?.kind).toBe("handoff");
    expect(steps.some((step) => step.replayAction?.kind === "summary_confirm")).toBe(false);
    expect(projectReplay(current, steps, steps.length - 1, [], 0.79).handoffComplete).toBe(false);
    expect(projectReplay(current, steps, steps.length - 1)).toMatchObject({
      summaryConfirmed: false,
      handoffComplete: true,
    });
    current.waitingForIntake = { id: "new-unanswered-draft", versionId: current.id };
    expect(
      buildClarificationReplay(current).some((step) => step.replayAction?.kind === "handoff"),
    ).toBe(false);
  });

  it("filters other versions and broken action anchors while retaining a recoverable action source", () => {
    const current = version();
    const input = actions();
    input.push(
      { ...input[1], id: "other-version", versionId: "different-version" },
      { ...input[1], id: "bad-anchor", sourceRunId: "missing-run" },
    );
    const steps = buildClarificationReplay(current, input);
    expect(
      steps.some(
        (step) =>
          step.replayAction?.id === "other-version" || step.replayAction?.id === "bad-anchor",
      ),
    ).toBe(false);
    const action = steps.find((step) => step.replayAction?.id === "selection")!;
    const source = stepContext(current, action.id, input);
    expect(source?.quote).toContain(question.title);
    expect(source?.quote).toContain("界面演示（待确认）");
    expect(source?.quote).toContain("raw/patch-response.json");
    expect(source?.quote).toContain("a".repeat(64));
    expect(stepContext(current, "clarification:b1")?.quote).not.toContain("界面演示（已确认）");
    const older = buildClarificationReplay(current, [
      { ...input[0], versionId: "different-version" },
    ]);
    expect(older.some((step) => step.replayAction?.source?.kind === "snapshot")).toBe(true);
  });

  it("keeps all four saved examples at zero facts initially and reproduces their accepted final calls and answers", () => {
    for (const metadata of RECORDED_EXAMPLES) {
      const payload = JSON.parse(
        readFileSync(`public/recorded-examples/${metadata.slug}.json`, "utf8"),
      ) as RecordedExamplePayload;
      const current = payload.arena.versions.find(
        (entry) => entry.id === payload.arena.activeVersionId,
      )!;
      for (const actions of [payload.replayActions, undefined]) {
        const steps = buildClarificationReplay(current, actions);
        expect(projectReplay(current, steps, -1, payload.arena.events)).toMatchObject({
          answers: [],
          calls: 0,
          tokens: 0,
          summaryConfirmed: false,
          handoffComplete: false,
        });
        const final = projectReplay(current, steps, steps.length - 1, payload.arena.events);
        expect(final.handoffComplete).toBe(true);
        expect(final.calls).toBe(
          new Set(current.clarification!.runs.flatMap((run) => run.callIds ?? [])).size,
        );
        expect(final.tokens).toBe(
          current
            .clarification!.runs.flatMap((run) => run.usage)
            .reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0),
        );
        expect(final.answers).toEqual(current.intake!.answers);
      }
    }
  });
});
