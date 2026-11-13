import { describe, expect, it } from "vitest";
import { disclosureTargetHeight } from "../src/components/disclosure-motion";

/** Explicit layout doubles model nested resize observations without a browser. */
function child(current: number, target: string, parent: HTMLElement | null = null) {
  return {
    offsetHeight: current,
    dataset: { disclosureTargetHeight: target },
    parentElement: { closest: () => parent },
  } as unknown as HTMLElement;
}

function content(height: number, children: HTMLElement[]) {
  return {
    offsetHeight: height,
    querySelectorAll: () => children,
    contains: (node: HTMLElement) => children.includes(node),
  } as unknown as HTMLElement;
}

describe("nested disclosure height ownership", () => {
  it("uses the natural height when nested content is settled", () => {
    expect(disclosureTargetHeight(content(140, []))).toBe(140);
  });

  it("predicts a growing child's destination instead of restarting for every intermediate pixel", () => {
    const expanding = child(50, "200");
    expect(disclosureTargetHeight(content(130, [expanding]))).toBe(280);
    Object.defineProperty(expanding, "offsetHeight", { value: 90 });
    expect(disclosureTargetHeight(content(170, [expanding]))).toBe(280);
  });

  it("counts the outer active child's target once when another active child is nested inside it", () => {
    const outer = child(70, "140");
    const nested = child(10, "50", outer);
    expect(disclosureTargetHeight(content(200, [outer, nested]))).toBe(270);
  });

  it("predicts collapsing content and preserves the unrelated content height", () => {
    expect(disclosureTargetHeight(content(100, [child(60, "0")]))).toBe(40);
  });

  it("combines independent growing and collapsing branches", () => {
    expect(disclosureTargetHeight(content(180, [child(40, "100"), child(30, "0")]))).toBe(210);
  });

  it("ignores an invalid active target and clamps an inconsistent transient measurement", () => {
    expect(disclosureTargetHeight(content(120, [child(20, "unavailable")]))).toBe(120);
    expect(disclosureTargetHeight(content(100, [child(200, "0")]))).toBe(0);
  });
});
