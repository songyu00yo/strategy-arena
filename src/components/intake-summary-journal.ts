import { z } from "zod";
import { ChallengeSchema } from "@/lib/contracts";

export const SUMMARY_JOURNAL_KEY = "strategy-arena:intake-summary";
export const SUMMARY_TAB_JOURNAL_KEY = "strategy-arena:intake-tab-summary";
const JournalSchema = z.object({
  draftId: z.string(),
  baseRevision: z.number().int().nonnegative(),
  challenge: ChallengeSchema.extend({
    goal: z.string().max(3000),
    options: z.array(z.string().max(300)).max(3),
    budget: z.number().finite().nullable(),
    timeHours: z.number().finite().nullable(),
  }),
  assumptions: z.array(z.string().max(500)).max(6),
  updatedAt: z.string(),
});
export type SummaryJournal = z.infer<typeof JournalSchema>;

export function readSummaryJournal(raw: string | null, draftId: string): SummaryJournal | null {
  if (!raw) return null;
  try {
    const result = JournalSchema.safeParse(JSON.parse(raw));
    return result.success && result.data.draftId === draftId ? result.data : null;
  } catch {
    return null;
  }
}

export function writeStoredSummaryJournal(entry: SummaryJournal) {
  // Throw on failure so the form can truthfully report that only its in-memory tail remains.
  sessionStorage.setItem(SUMMARY_TAB_JOURNAL_KEY, JSON.stringify(entry));
}

export function readStoredSummaryJournal(draftId: string): SummaryJournal | null {
  try {
    const tab = readSummaryJournal(sessionStorage.getItem(SUMMARY_TAB_JOURNAL_KEY), draftId);
    if (tab) return tab;
  } catch {}
  try {
    const raw = localStorage.getItem(SUMMARY_JOURNAL_KEY);
    const legacy = readSummaryJournal(raw, draftId);
    if (!legacy) return null;
    try {
      writeStoredSummaryJournal(legacy);
      // A different tab may have replaced the legacy journal while this one was migrating.
      if (localStorage.getItem(SUMMARY_JOURNAL_KEY) === raw)
        localStorage.removeItem(SUMMARY_JOURNAL_KEY);
    } catch {
      /* Keep the matching legacy recovery record if tab storage cannot accept it. */
    }
    return legacy;
  } catch {
    return null;
  }
}

export function clearStoredSummaryJournal(draftId: string) {
  for (const [storage, key] of [
    [() => sessionStorage, SUMMARY_TAB_JOURNAL_KEY],
    [() => localStorage, SUMMARY_JOURNAL_KEY],
  ] as const) {
    try {
      const target = storage();
      const raw = target.getItem(key);
      if (readSummaryJournal(raw, draftId) && target.getItem(key) === raw) target.removeItem(key);
    } catch {}
  }
}
