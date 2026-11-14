import { describe, expect, it } from "vitest";
import {
  answerJournalScope,
  readAnswerJournal,
  historyAnswerJournalScope,
  readHistoricalAnswerJournal,
  readHistoricalAnswerConflict,
} from "../src/components/intake-answer-journal";
import { fixtureIntake } from "./e2e/intake.fixture";

const draft = fixtureIntake({
  status: "questions",
  round: 1,
  questions: [
    {
      id: "limits",
      title: "限制是什么？",
      reason: "需确认",
      placeholder: "",
      type: "text",
      options: [],
      unit: "",
    },
  ],
});
const answers = [{ questionId: "limits", state: "answered", value: "尚未点击继续的回答" }];
const raw = JSON.stringify({ scope: answerJournalScope(draft), answers });

describe("tab-local intake answer journal", () => {
  it("recovers the unsent round, including incomplete answers, after refresh", () => {
    expect(readAnswerJournal(raw, { ...draft, revision: draft.revision + 1 })).toEqual(answers);
    expect(
      readAnswerJournal(
        JSON.stringify({
          scope: answerJournalScope(draft),
          answers: [{ ...answers[0], value: "" }],
        }),
        draft,
      )?.[0].value,
    ).toBe("");
  });
  it("never reuses answers for another draft, goal, model, round or question wording", () => {
    for (const changed of [
      { ...draft, id: "other" },
      { ...draft, goal: "另一目标" },
      { ...draft, modelMode: "deepseek" as const },
      { ...draft, round: 2 },
      { ...draft, questions: [{ ...draft.questions[0], title: "不同问题" }] },
      { ...draft, status: "summary" as const },
    ])
      expect(readAnswerJournal(raw, changed)).toBeNull();
  });
  it("rejects malformed, duplicate and foreign answer entries", () => {
    for (const invalid of [
      "{broken",
      JSON.stringify({ scope: answerJournalScope(draft), answers: [...answers, ...answers] }),
      JSON.stringify({
        scope: answerJournalScope(draft),
        answers: [{ ...answers[0], questionId: "other" }],
      }),
    ])
      expect(readAnswerJournal(invalid, draft)).toBeNull();
  });
});

describe("tab-local historical answer journal", () => {
  const historical = fixtureIntake({
    ...draft,
    workflow: "clarification",
    status: "summary",
    revision: 4,
    answers: [
      {
        questionId: "limits",
        question: draft.questions[0],
        state: "answered",
        value: "服务器回答",
        confirmation: "confirmed",
      },
    ],
  });
  const edit = { questionId: "limits", state: "answered" as const, value: "本机未保存的修改" };
  const entry = {
    scope: historyAnswerJournalScope(historical, edit.questionId),
    answers: [],
    historicalDraftId: historical.id,
    historicalRevision: historical.revision,
    historicalAnswer: edit,
  };
  const journal = JSON.stringify(entry);
  it("restores only the authorized question and exact canonical revision", () => {
    expect(readHistoricalAnswerJournal(journal, historical)).toEqual(edit);
    expect(readAnswerJournal(journal, historical)).toBeNull();
    for (const changed of [
      { ...historical, revision: 5 },
      { ...historical, id: "other" },
      { ...historical, modelMode: "deepseek" as const },
      { ...historical, goal: "另一目标" },
      { ...historical, status: "uncertain" as const },
      { ...historical, status: "analyzing" as const },
      { ...historical, status: "submitted" as const },
      { ...historical, answers: [] },
      {
        ...historical,
        answers: historical.answers.map((answer) => ({
          ...answer,
          question: { ...answer.question, title: "问题已修改" },
        })),
      },
    ])
      expect(readHistoricalAnswerJournal(journal, changed)).toBeNull();
  });
  it("keeps a revision conflict available for explicit review without cross-draft recovery", () => {
    const newer = { ...historical, revision: 5 };
    expect(readHistoricalAnswerJournal(journal, newer)).toBeNull();
    expect(readHistoricalAnswerConflict(journal, newer)?.historicalAnswer).toEqual(edit);
    expect(
      readHistoricalAnswerConflict(journal, { ...newer, id: "another-owner-draft" }),
    ).toBeNull();
    expect(readHistoricalAnswerConflict(journal, { ...newer, workflow: undefined })).toBeNull();
  });
  it("rejects malformed historical entries while preserving the original round journal format", () => {
    for (const invalid of [
      "{broken",
      JSON.stringify({ ...entry, historicalRevision: -1 }),
      JSON.stringify({ ...entry, historicalAnswer: { ...edit, questionId: "foreign" } }),
      JSON.stringify({ ...entry, historicalDraftId: undefined }),
    ])
      expect(readHistoricalAnswerJournal(invalid, historical)).toBeNull();
    expect(readAnswerJournal(raw, draft)).toEqual(answers);
    expect(readHistoricalAnswerJournal(raw, historical)).toBeNull();
  });
});
