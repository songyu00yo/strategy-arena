/** Presentation-state safety checks using explicit fixtures, with no API or model calls. */
import { describe, expect, it } from "vitest";
import type {
  PlanningEvent,
  PlanningQuestion,
  PlanningSnapshot,
} from "../src/lib/planning-contracts";
import { PLANNING_CONTRACT_VERSION } from "../src/lib/planning-contracts";
import {
  acceptPlanningSnapshot,
  activePlanningQuestion,
  answerText,
  emptyPlanningAnswer,
  newPlanningEvents,
  planningAnswerError,
} from "../src/components/planning/client-utils";

const question: PlanningQuestion = {
  id: "entry",
  version: 2,
  itemIds: ["entry-behavior"],
  title: "什么时候进入工作台？",
  reason: "决定第一次分析等待在哪里发生。",
  type: "single",
  options: [
    {
      id: "early",
      label: "提交想法后进入",
      description: "在工作台等待第一轮分析。",
      consequences: [],
    },
    { id: "later", label: "第一轮分析后进入", description: "先等待分析。", consequences: [] },
  ],
  placeholder: "可以提出自己的方式",
  unit: "",
  minSelections: 1,
  maxSelections: 1,
  askedBy: "B",
  answerTo: "A",
  status: "active",
  allowUnknown: true,
  allowSkip: true,
};

function event(seq: number, questionVersion = 2): PlanningEvent {
  return {
    id: `event-${seq}`,
    seq,
    revision: 3,
    operationId: "fixture-operation",
    kind: "question_issued",
    actor: "B",
    from: "B",
    to: "user",
    questionId: "entry",
    questionVersion,
    answerId: null,
    itemIds: ["entry-behavior"],
    title: "请确认进入时机",
    detail: "明确标注的前端测试记录",
    createdAt: "2026-11-16T00:00:00.000Z",
  };
}

function snapshot(snapshotVersion: number, sessionId = "fixture-session"): PlanningSnapshot {
  return {
    snapshotVersion,
    session: {
      contractVersion: PLANNING_CONTRACT_VERSION,
      id: sessionId,
      revision: 3,
      goal: "保留纸面视觉并尽早进入工作台",
      modelMode: "gpt-6.1-terra",
      status: "awaiting_user",
      productScope: "analysis_and_guidance",
      progress: {
        round: 1,
        questionLimit: 8,
        questionsIssued: 1,
        questionsAnswered: 0,
        questionsRemaining: 8,
        questionSlotsRemaining: 7,
        activeQuestions: 1,
        stage: "clarifying",
        budgetExhausted: false,
        endedEarly: false,
        coverage: [],
      },
      expertResults: [],
      agents: [],
      items: [],
      sourceRecords: [],
      questions: [structuredClone(question)],
      answers: [],
      draft: null,
      review: null,
      report: null,
      capabilities: {
        canAdvance: false,
        canAnswer: true,
        canAddNote: true,
        canPreview: true,
        canConfirm: false,
        canStop: false,
        canStartRound: false,
        reason: "等待用户回答",
      },
      nextAction: "answer",
      activeOperationId: null,
      error: null,
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    },
    events: [event(7), event(8)],
    eventCursor: 8,
  };
}

describe("planning client safety with explicit fixtures", () => {
  it("does not let a late response or another session overwrite current activity", () => {
    const current = snapshot(12);
    const late = snapshot(11);
    expect(late.session.revision).toBe(current.session.revision);
    expect(late.eventCursor).toBe(current.eventCursor);
    expect(acceptPlanningSnapshot(late, current)).toBe(false);
    expect(acceptPlanningSnapshot(snapshot(13), current)).toBe(true);
    expect(acceptPlanningSnapshot(snapshot(99, "another-session"), current)).toBe(false);
    expect(acceptPlanningSnapshot(current, null)).toBe(true);
  });

  it("plays only events after the acknowledged cursor when polling repeats history", () => {
    const first = snapshot(10);
    expect(newPlanningEvents(first, 7).map((entry) => entry.id)).toEqual(["event-8"]);
    expect(newPlanningEvents(first, 8)).toEqual([]);
    const later = { ...snapshot(11), events: [event(10), event(8), event(9)], eventCursor: 10 };
    expect(newPlanningEvents(later, 8).map((entry) => entry.seq)).toEqual([9, 10]);
    expect(later.events.map((entry) => entry.seq)).toEqual([10, 8, 9]);
  });

  it("does not reopen an old question event after the question is revised or withdrawn", () => {
    const current = snapshot(12);
    expect(activePlanningQuestion(current, event(8, 1))).toBeUndefined();
    expect(activePlanningQuestion(current, event(9, 2))?.id).toBe(question.id);
    current.session.questions[0].status = "withdrawn";
    expect(activePlanningQuestion(current, event(9, 2))).toBeUndefined();
  });

  it("requires a real answer without preselecting an option, and accepts the user's own proposal", () => {
    const empty = emptyPlanningAnswer(question);
    expect(empty.optionIds).toEqual([]);
    expect(planningAnswerError(question, empty)).not.toBeNull();
    const custom = { ...empty, text: "我想直接进工作台，同时保留输入内容以便修改。" };
    expect(planningAnswerError(question, custom)).toBeNull();
    expect(answerText(question, custom)).toBe(custom.text);
  });

  it("keeps unknown and skipped answers distinct from selected options", () => {
    const empty = emptyPlanningAnswer(question);
    expect(answerText(question, { ...empty, state: "unknown" })).toBe("暂时不知道");
    expect(answerText(question, { ...empty, state: "skipped" })).toBe("暂时跳过");
    expect(planningAnswerError(question, { ...empty, state: "unknown" })).toBeNull();
    expect(
      planningAnswerError({ ...question, allowSkip: false }, { ...empty, state: "skipped" }),
    ).not.toBeNull();
  });

  it("rejects stale versions, missing options, and more than one single-choice option", () => {
    const answer = { ...emptyPlanningAnswer(question), optionIds: ["early"] };
    expect(planningAnswerError(question, answer)).toBeNull();
    expect(planningAnswerError(question, { ...answer, questionVersion: 1 })).not.toBeNull();
    expect(
      planningAnswerError(question, { ...answer, optionIds: ["unknown-option"] }),
    ).not.toBeNull();
    expect(
      planningAnswerError(question, { ...answer, optionIds: ["early", "later"] }),
    ).not.toBeNull();
  });

  it("distinguishes an actual zero from a missing or non-finite numeric answer", () => {
    const numberQuestion = { ...question, type: "number" as const, options: [], unit: "元" };
    const empty = emptyPlanningAnswer(numberQuestion);
    expect(planningAnswerError(numberQuestion, empty)).not.toBeNull();
    expect(planningAnswerError(numberQuestion, { ...empty, number: 0 })).toBeNull();
    expect(planningAnswerError(numberQuestion, { ...empty, number: Number.NaN })).not.toBeNull();
    expect(answerText(numberQuestion, { ...empty, number: 0 })).toBe("0 元");
  });
});
