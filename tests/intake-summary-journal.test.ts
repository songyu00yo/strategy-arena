import { afterEach, describe, expect, it, vi } from "vitest";
import { readSummaryJournal } from "../src/components/use-intake-summary";
import {
  SUMMARY_JOURNAL_KEY,
  SUMMARY_TAB_JOURNAL_KEY,
  clearStoredSummaryJournal,
  readStoredSummaryJournal,
  writeStoredSummaryJournal,
} from "../src/components/intake-summary-journal";
import { fixtureChallenge } from "./e2e/ui.fixture";

const entry = {
  draftId: "current-draft",
  baseRevision: 7,
  challenge: { ...fixtureChallenge, constraints: "保留当前收入", budget: 123 },
  assumptions: [],
  updatedAt: "2026-11-06T10:00:00.000Z",
};
describe("summary edit recovery journal", () => {
  it("preserves resource edits and deleted assumptions with their canonical base revision", () => {
    expect(readSummaryJournal(JSON.stringify(entry), "current-draft")).toEqual(entry);
  });
  it("never applies another draft's local edits", () => {
    expect(readSummaryJournal(JSON.stringify(entry), "other-draft")).toBeNull();
  });
  it("retains an incomplete goal for user recovery without pretending it is server-valid", () => {
    expect(
      readSummaryJournal(
        JSON.stringify({ ...entry, challenge: { ...entry.challenge, goal: "未写完" } }),
        "current-draft",
      )?.challenge.goal,
    ).toBe("未写完");
  });
  it.each([
    "{broken",
    JSON.stringify({ ...entry, baseRevision: -1 }),
    JSON.stringify({ ...entry, assumptions: Array(7).fill("extra") }),
  ])("rejects malformed local recovery content", (raw) => {
    expect(readSummaryJournal(raw, "current-draft")).toBeNull();
  });
});

function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("summary journals across tabs and legacy recovery", () => {
  it("keeps both unsaved tails recoverable and never lets an A reset delete B's journal", () => {
    const shared = storage(),
      tabA = storage(),
      tabB = storage();
    const second = {
      ...entry,
      draftId: "other-draft",
      challenge: { ...entry.challenge, budget: 456 },
    };
    vi.stubGlobal("localStorage", shared);
    vi.stubGlobal("sessionStorage", tabA);
    writeStoredSummaryJournal(entry);
    vi.stubGlobal("sessionStorage", tabB);
    writeStoredSummaryJournal(second);
    // An older client may still keep B's recovery tail in the legacy shared slot.
    shared.setItem(SUMMARY_JOURNAL_KEY, JSON.stringify(second));
    vi.stubGlobal("sessionStorage", tabA);
    expect(readStoredSummaryJournal(entry.draftId)).toEqual(entry);
    clearStoredSummaryJournal(entry.draftId);
    expect(tabA.getItem(SUMMARY_TAB_JOURNAL_KEY)).toBeNull();
    expect(shared.getItem(SUMMARY_JOURNAL_KEY)).toBe(JSON.stringify(second));
    vi.stubGlobal("sessionStorage", tabB);
    expect(readStoredSummaryJournal(second.draftId)).toEqual(second);
  });
  it("migrates only a matching legacy draft and gives this tab's newer edits precedence", () => {
    const shared = storage(),
      tab = storage();
    vi.stubGlobal("localStorage", shared);
    vi.stubGlobal("sessionStorage", tab);
    shared.setItem(SUMMARY_JOURNAL_KEY, JSON.stringify(entry));
    expect(readStoredSummaryJournal("other-draft")).toBeNull();
    expect(shared.getItem(SUMMARY_JOURNAL_KEY)).not.toBeNull();
    expect(readStoredSummaryJournal(entry.draftId)).toEqual(entry);
    expect(tab.getItem(SUMMARY_TAB_JOURNAL_KEY)).toBe(JSON.stringify(entry));
    expect(shared.getItem(SUMMARY_JOURNAL_KEY)).toBeNull();
    const newer = { ...entry, challenge: { ...entry.challenge, budget: 789 } };
    writeStoredSummaryJournal(newer);
    shared.setItem(SUMMARY_JOURNAL_KEY, JSON.stringify(entry));
    expect(readStoredSummaryJournal(entry.draftId)).toEqual(newer);
  });
  it("retains the matching legacy journal if session migration cannot be saved", () => {
    const shared = storage();
    vi.stubGlobal("localStorage", shared);
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem() {
        throw new Error("blocked");
      },
    });
    shared.setItem(SUMMARY_JOURNAL_KEY, JSON.stringify(entry));
    expect(readStoredSummaryJournal(entry.draftId)).toEqual(entry);
    expect(shared.getItem(SUMMARY_JOURNAL_KEY)).toBe(JSON.stringify(entry));
    expect(() => writeStoredSummaryJournal(entry)).toThrow("blocked");
  });
  it("does not delete a different legacy tail written during migration", () => {
    const shared = storage(),
      tab = storage();
    const other = JSON.stringify({ ...entry, draftId: "other-draft" });
    shared.setItem(SUMMARY_JOURNAL_KEY, JSON.stringify(entry));
    vi.stubGlobal("localStorage", shared);
    vi.stubGlobal("sessionStorage", {
      ...tab,
      setItem(key: string, raw: string) {
        tab.setItem(key, raw);
        shared.setItem(SUMMARY_JOURNAL_KEY, other);
      },
    });
    expect(readStoredSummaryJournal(entry.draftId)).toEqual(entry);
    expect(shared.getItem(SUMMARY_JOURNAL_KEY)).toBe(other);
  });
});
