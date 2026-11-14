import { describe, expect, it } from "vitest";
import { disclosureHeightRange, disclosureTargetHeight } from "../src/components/disclosure-motion";

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

/** Explicit layout doubles reproduce a capped paper around an existing scroll body. */
function cappedPaper(from: number, natural: number, base: number, limit: number) {
  const style = { height: `${from}px` };
  const paper = {
    dataset: {},
    parentElement: null,
    scrollTop: 18,
    scrollLeft: 2,
    getBoundingClientRect: () => ({
      height: Math.min(
        limit,
        base + (style.height === "auto" ? natural : parseFloat(style.height)),
      ),
    }),
  } as unknown as HTMLElement;
  const scrollBody = {
    parentElement: paper,
    scrollTop: 64,
    scrollLeft: 0,
  } as unknown as HTMLElement;
  const host = {
    style,
    parentElement: scrollBody,
    closest: () => paper,
    getBoundingClientRect: () => ({
      height: style.height === "auto" ? natural : parseFloat(style.height),
    }),
  } as unknown as HTMLElement;
  return { host, paper, scrollBody };
}

describe("scroll-limited paper disclosure height", () => {
  it("spends the full height animation on the visible expansion instead of racing to its cap", () => {
    const { host } = cappedPaper(0, 1800, 450, 795);
    expect(disclosureHeightRange(host, 1800)).toEqual({ from: 0, to: 345 });
    expect(host.style.height).toBe("0px");
  });

  it("starts a reverse fold at its visible contribution instead of waiting for offscreen content", () => {
    const { host } = cappedPaper(1800, 1800, 450, 795);
    host.style.height = "auto";
    expect(disclosureHeightRange(host, 0)).toEqual({ from: 345, to: 0 });
    expect(host.style.height).toBe("auto");
  });

  it("keeps fractional bounds for an interrupted change", () => {
    const { host } = cappedPaper(125.25, 1800, 450.25, 795);
    expect(disclosureHeightRange(host, 1800)).toEqual({ from: 125.25, to: 344.75 });
  });

  it("retains the natural range when the paper has enough room", () => {
    const { host } = cappedPaper(60, 180, 450, 795);
    expect(disclosureHeightRange(host, 180)).toEqual({ from: 60, to: 180 });
  });

  it("does not constrain a disclosure wholly inside an already full scroll region", () => {
    const { host } = cappedPaper(60, 1800, 900, 795);
    expect(disclosureHeightRange(host, 1800)).toEqual({ from: 60, to: 1800 });
  });

  it("keeps the existing overlay height owner and restores all measured scroll positions", () => {
    const { host, paper, scrollBody } = cappedPaper(0, 1800, 450, 795);
    disclosureHeightRange(host, 1800);
    expect([paper.scrollTop, paper.scrollLeft, scrollBody.scrollTop]).toEqual([18, 2, 64]);
    paper.dataset.overlayMotionActive = "true";
    expect(disclosureHeightRange(host, 1800)).toEqual({ from: 0, to: 1800 });
  });
});
