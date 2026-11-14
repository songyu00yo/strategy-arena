import { z } from "zod";
import { AnswerSchema, type IntakeAnswer, type IntakeDraft } from "@/lib/intake-contracts";

// One current round in this tab only. It never starts analysis or overwrites a server draft.
export const ANSWER_JOURNAL_KEY = "strategy-arena:intake-answers";
const JournalSchema = z.object({
  scope: z.string(),
  answers: z.array(AnswerSchema).max(3),
  historicalDraftId: z.string().optional(),
  historicalRevision: z.number().int().nonnegative().optional(),
  historicalAnswer: AnswerSchema.optional(),
});

export function historyAnswerJournalScope(draft: IntakeDraft, questionId: string) {
  const question = draft.answers.find((answer) => answer.questionId === questionId)?.question;
  return JSON.stringify(["history", draft.id, draft.goal, draft.modelMode, questionId, question]);
}

export function readHistoricalAnswerJournal(raw: string | null, draft: IntakeDraft) {
  const entry = readHistoricalAnswerConflict(raw, draft);
  if (
    !entry ||
    draft.status === "submitted" ||
    draft.status === "analyzing" ||
    draft.status === "uncertain" ||
    entry.historicalRevision !== draft.revision ||
    !draft.answers.some((answer) => answer.questionId === entry.historicalAnswer.questionId) ||
    entry.scope !== historyAnswerJournalScope(draft, entry.historicalAnswer.questionId)
  )
    return null;
  return entry.historicalAnswer;
}

/** An authorized draft read may expose a conflict for explicit review, never silently rebase it. */
export function readHistoricalAnswerConflict(raw: string | null, draft: IntakeDraft) {
  if (!raw || draft.workflow !== "clarification") return null;
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.historicalDraftId !== draft.id ||
      parsed.data.historicalRevision === undefined ||
      !parsed.data.historicalAnswer
    )
      return null;
    return {
      scope: parsed.data.scope,
      historicalRevision: parsed.data.historicalRevision,
      historicalAnswer: parsed.data.historicalAnswer,
    };
  } catch {
    return null;
  }
}

export function answerJournalScope(draft: IntakeDraft) {
  return JSON.stringify([draft.id, draft.goal, draft.modelMode, draft.round, draft.questions]);
}

export function readAnswerJournal(raw: string | null, draft: IntakeDraft): IntakeAnswer[] | null {
  if (!raw || draft.status !== "questions") return null;
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.scope !== answerJournalScope(draft)) return null;
    const ids = parsed.data.answers.map((answer) => answer.questionId);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !draft.questions.some((question) => question.id === id))
    )
      return null;
    return parsed.data.answers;
  } catch {
    return null;
  }
}
