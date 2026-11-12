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
  nextRecordedRole,
  paperBackgroundIndex,
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
      feedback: 160,
      settle: 200,
      open: 420,
      fold: 360,
      transfer: 600,
      seal: 280,
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
    expect(frames.at(-1)?.transform).toContain("translate(420px,-62px)");
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
