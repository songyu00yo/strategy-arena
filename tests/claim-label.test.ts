import { describe, expect, it } from "vitest";
import { claimLabel, readableClaimText } from "../src/components/claim-label";
import { advanceFixture, fixtureSnapshot } from "./e2e/ui.fixture";

function completedVersion() {
  const snapshot = fixtureSnapshot();
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  return snapshot.versions[0];
}

describe("human-readable claim references", () => {
  it("keeps original numbering when a revision adds or reorders claims", () => {
    const version = completedVersion();
    const original = version.strategies[0].claims[0];
    version.revisions[0].strategy.claims = [
      { ...original, id: "A-claim-2", text: "Synthetic added claim" },
      original,
    ];
    expect(claimLabel(version, "A", "A-claim")).toBe("路线 A 的判断 1");
    expect(claimLabel(version, "A", "A-claim-2")).toBe("路线 A 的判断 2");
    expect(claimLabel(version, "A", "missing")).toBe("路线 A 的这条判断");
  });

  it("replaces known legacy IDs in display prose without changing stored links or overlapping identifiers", () => {
    const version = completedVersion();
    const original = JSON.stringify(version);
    const prose = "已回应A-claim，但 A-claim-long 和其他原文保持不变。";
    expect(readableClaimText(version, prose)).toBe(
      "已回应路线 A 的判断 1，但 A-claim-long 和其他原文保持不变。",
    );
    expect(readableClaimText(version, "路线成本和不确定性")).toBe("路线成本和不确定性");
    expect(JSON.stringify(version)).toBe(original);
  });

  it("matches claim IDs containing regular-expression punctuation literally", () => {
    const version = completedVersion();
    version.strategies[0].claims[0].id = "A.claim[1]";
    expect(readableClaimText(version, "参考 A.claim[1]，保留 A0claim1。")).toBe(
      "参考 路线 A 的判断 1，保留 A0claim1。",
    );
  });
});
