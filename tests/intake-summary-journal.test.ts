import { describe, expect, it } from "vitest";
import { readSummaryJournal } from "../src/components/use-intake-summary";
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
