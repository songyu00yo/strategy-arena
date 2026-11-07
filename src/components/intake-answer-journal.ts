import { z } from "zod";
import { AnswerSchema, type IntakeAnswer, type IntakeDraft } from "@/lib/intake-contracts";

// One current round in this tab only. It never starts analysis or overwrites a server draft.
export const ANSWER_JOURNAL_KEY = "strategy-arena:intake-answers";
const JournalSchema = z.object({
  scope: z.string(),
  answers: z.array(AnswerSchema).max(3),
});

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
