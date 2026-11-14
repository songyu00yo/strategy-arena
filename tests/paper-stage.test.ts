/** Saved examples and synthetic geometry. No browser, provider call or recording mutation. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beatsOf } from "../src/components/console/beats";
import { RouteStage } from "../src/components/console/RouteStage";
import {
  adjacentPaperTransfer,
  initialPaperFrames,
  initialPaperReceiverReady,
  CLARIFICATION_SEAL_FRAMES,
  nextRecordedRole,
  paperBackgroundIndex,
  paperSealPosition,
  paperTransferPath,
  PAPER_MOTION,
} from "../src/components/console/paper-stage";
import type { RecordedExamplePayload } from "../src/lib/recorded-examples";
import { RECORDED_EXAMPLES } from "../src/lib/recorded-examples";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

function recording(slug: string) {
  const payload = JSON.parse(
    readFileSync(`public/recorded-examples/${slug}.json`, "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.find(
    (entry) => entry.id === payload.arena.activeVersionId,
  )!;
  return { version, beats: beatsOf(version, payload.replayActions) };
}

describe("paper theatre handoffs", () => {
  it("uses the approved feedback, transfer and final seal durations", () => {
    expect(PAPER_MOTION).toEqual({
      feedback: 120,
      settle: 140,
      open: 280,
      fold: 300,
      transfer: 420,
      seal: 220,
    });
  });

  it("waits for a real first A output and fully visible ancestors before folding the input", () => {
    const ancestor = { parentElement: null };
    let complete = false;
    const body = {
      parentElement: ancestor,
      querySelector: (selector: string) =>
        complete ? (selector === ".est" ? { textContent: "第 1 轮 · 依据修订 1" } : {}) : null,
    };
    const target = {
      querySelector: () => body,
      getBoundingClientRect: () => ({ width: 300, height: 240 }),
    } as unknown as HTMLElement;
    let opacity = "0";
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible", opacity }));
    const first = { getAttribute: () => "第 1 步" } as unknown as Element;
    expect(initialPaperReceiverReady(target, first)).toBe(false);
    complete = true;
    expect(initialPaperReceiverReady(target, first)).toBe(false);
    opacity = "0.5";
    expect(initialPaperReceiverReady(target, first)).toBe(false);
    opacity = "1";
    expect(initialPaperReceiverReady(target, first)).toBe(true);
    expect(
      initialPaperReceiverReady(target, { getAttribute: () => "第 2 步" } as unknown as Element),
    ).toBe(false);
    expect(initialPaperReceiverReady(null, first)).toBe(false);
  });

  it("keeps the short clarification seal opaque after landing", () => {
    expect(CLARIFICATION_SEAL_FRAMES[0].transform).toContain("scale(1.6)");
    expect(CLARIFICATION_SEAL_FRAMES[1]).toMatchObject({ opacity: 1, offset: 0.45 });
    expect(CLARIFICATION_SEAL_FRAMES[1].transform).toContain("scale(.98)");
    expect(CLARIFICATION_SEAL_FRAMES.at(-1)).toMatchObject({ opacity: 1 });
    expect(CLARIFICATION_SEAL_FRAMES.at(-1)?.transform).toContain("scale(1)");
  });

  it("keeps the largest rotated seal inside the mobile viewport", () => {
    const size = { width: 164, height: 52 };
    const viewport = { width: 390, height: 844 };
    const angle = (10 * Math.PI) / 180;
    const halfWidth = (size.width * Math.cos(angle) + size.height * Math.sin(angle)) * 0.8;
    const halfHeight = (size.height * Math.cos(angle) + size.width * Math.sin(angle)) * 0.8;
    for (const anchor of [
      { x: 235, y: 26 },
      { x: 390, y: 844 },
    ]) {
      const position = paperSealPosition(anchor, size, viewport);
      expect(position.x - halfWidth).toBeGreaterThanOrEqual(12);
      expect(position.y - halfHeight).toBeGreaterThanOrEqual(12);
      expect(position.x + halfWidth).toBeLessThanOrEqual(viewport.width - 12);
      expect(position.y + halfHeight).toBeLessThanOrEqual(viewport.height - 12);
    }
    expect(paperSealPosition({ x: 720, y: 450 }, size, { width: 1440, height: 900 })).toEqual({
      x: 720,
      y: 450,
    });
  });

  it("follows actual role calls and waits for user actions between B and a later model", () => {
    for (const example of RECORDED_EXAMPLES) {
      const { beats } = recording(example.slug);
      for (const [index, beat] of beats.entries()) {
        const expected = beats.slice(index + 1).find((step) => step.clarificationRun)
          ?.clarificationRun?.role;
        expect(nextRecordedRole(beats, index)).toBe(expected);
        if (beat.replayAction || beats[index + 1]?.replayAction)
          expect(adjacentPaperTransfer(beats, index)).toBeNull();
      }
      for (const [index, beat] of beats.entries())
        if (beat.replayAction?.kind === "summary_submit")
          expect(nextRecordedRole(beats, index)).toBe("A");
    }
  });

  it("returns C's recorded gap to the actual next B call", () => {
    const { beats } = recording("personal-website");
    const gap = beats.findIndex(
      (beat, index) =>
        beat.clarificationRun?.role === "C" &&
        "gaps" in beat.clarificationRun.output &&
        beat.clarificationRun.output.gaps.length > 0 &&
        beats[index + 1]?.clarificationRun?.role === "B",
    );
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(adjacentPaperTransfer(beats, gap)).toEqual({ from: "C", to: "B" });
  });

  it("holds the background at the preceding model while retaining the full history for its next handoff", () => {
    const { beats } = recording("personal-website");
    const firstQuestion = beats.findIndex((beat) => beat.replayAction?.kind === "questions");
    const confirmation = beats.findIndex((beat) => beat.replayAction?.kind === "round_confirm");
    const held = paperBackgroundIndex(beats, firstQuestion, true);
    expect(beats[held].clarificationRun?.role).toBe("B");
    expect(paperBackgroundIndex(beats, confirmation, true)).toBe(held);
    const nextCall = beats.findIndex(
      (beat, index) => index > confirmation && !!beat.clarificationRun,
    );
    expect(paperBackgroundIndex(beats, nextCall, false)).toBe(nextCall);
    expect(
      beats.slice(0, nextCall).some((beat) => beat.replayAction?.kind === "round_confirm"),
    ).toBe(true);
  });

  it("derives ink paths and the initial paper landing from actual measured rectangles", () => {
    const source = { left: 100, right: 300, top: 100, width: 200, height: 240 };
    const target = { left: 500, right: 740, top: 130, width: 240, height: 260 };
    expect(paperTransferPath(source, target, { left: 40, top: 50 })).toBe(
      "M260,78 C350,78 370,108 460,108",
    );
    expect(paperTransferPath(target, source, { left: 40, top: 50 })).toBe(
      "M460,108 C370,108 350,78 260,78",
    );
    const frames = initialPaperFrames(source, target)!;
    expect(frames).toEqual([
      { transform: "none", opacity: 1 },
      { transform: "translate3d(420px,-62px,0) scale(0.55)", opacity: 0 },
    ]);
    expect(initialPaperFrames(source, { ...target, left: 650 })?.at(-1)?.transform).not.toEqual(
      frames.at(-1)?.transform,
    );
    expect(initialPaperFrames(source, { ...target, width: 0 })).toBeNull();
  });

  it("keeps the original three role boards behind the foreground paper", () => {
    const { version, beats } = recording("personal-website");
    const index = beats.findIndex((beat) => beat.replayAction?.kind === "questions");
    const html = renderToStaticMarkup(
      React.createElement(RouteStage, {
        version,
        beats,
        index,
        demo: false,
        speed: 1,
        directed: false,
        camera: false,
        lead: 0,
        reviewing: true,
        entering: false,
        readOnly: true,
        replayProgress: 1,
        onStep: () => {},
        onEvidence: () => {},
        onClaim: () => {},
      }),
    );
    expect(html.match(/data-board="[ABC]"/g)).toHaveLength(3);
    expect(html).toContain('data-background-held="true"');
    expect(html).toContain("paper-role-transfer");
    expect(html).toContain(`aria-label="查看第 ${index + 1} 步"`);
    expect(html).toContain("需求拆解");
    expect(html).toContain("选项与执行审查");
    expect(html).toContain("验收与遗漏审查");
  });
});
