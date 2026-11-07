import { describe, expect, it } from "vitest";
import { answerJournalScope, readAnswerJournal } from "../src/components/intake-answer-journal";
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
