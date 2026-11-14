/** Synthetic clock samples. No browser, model call or persisted task. */
import { describe, expect, it } from "vitest";
import type { Beat } from "../src/components/console/beats";
import type { IntakeQuestion, RecordedAnswer } from "../src/lib/intake-contracts";
import type { ReplayAction } from "../src/lib/replay-contracts";
import {
  createPlaybackTimeline,
  playbackCommitAt,
  playbackDuration,
  playbackProgressAt,
  playbackStateKey,
  type PlaybackFrame,
} from "../src/components/console/use-playback-progress";

const frame = (progress: number): PlaybackFrame => ({
  stepId: "synthetic-question-step",
  progress,
  elapsed: progress * 14000,
  duration: 14000,
  running: true,
  settled: false,
});

const question: IntakeQuestion = {
  id: "synthetic_choice",
  title: "Synthetic question",
  reason: "Unit test input",
  placeholder: "",
  type: "single",
  options: ["one", "two"],
  unit: "",
};

const beat = (action?: Partial<ReplayAction>): Beat => ({
  id: "synthetic-step",
  stage: "revise",
  agent: "B",
  title: "Synthetic playback step",
  plain: "Unit test input",
  replayAction: action
    ? { id: "synthetic-action", kind: "answer", round: 1, revision: 1, ...action }
    : undefined,
});

const answerBeat = (answer: Partial<RecordedAnswer>) =>
  beat({
    kind: "answer",
    answers: [{ questionId: question.id, question, state: "answered", value: "one", ...answer }],
  });

describe("compact recorded playback timing", () => {
  it("keeps model and question steps brief without charging reading time by character", () => {
    expect(playbackDuration(null)).toBe(650);
    expect(playbackDuration(beat())).toBe(650);
    expect(playbackDuration(beat({ kind: "questions", questions: [question] }))).toBe(1100);
    expect(
      playbackDuration(beat({ kind: "questions", questions: [question, question, question] })),
    ).toBe(1300);
    expect(playbackDuration(beat({ kind: "questions", questions: Array(12).fill(question) }))).toBe(
      1600,
    );
    expect(
      playbackDuration(
        beat({ kind: "questions", questions: [{ ...question, title: "long".repeat(1000) }] }),
      ),
    ).toBe(1100);
  });

  it("keeps ordinary actions compact and gives dense choices time to release and travel", () => {
    expect(playbackDuration(answerBeat({}))).toBe(650);
    expect(playbackDuration(answerBeat({ state: "unknown", value: "" }))).toBe(450);
    expect(playbackDuration(answerBeat({ state: "skipped", value: "" }))).toBe(450);
    expect(
      playbackDuration(
        answerBeat({ question: { ...question, type: "multiple" }, value: ["one", "two"] }),
      ),
    ).toBe(970);
    expect(
      playbackDuration(
        answerBeat({ question: { ...question, type: "multiple" }, value: Array(6).fill("choice") }),
      ),
    ).toBeCloseTo((5 * 240) / 0.52);
    expect(
      playbackDuration(answerBeat({ question: { ...question, type: "text" }, value: "hello" })),
    ).toBe(670);
    expect(
      playbackDuration(
        answerBeat({ question: { ...question, type: "text" }, value: "word".repeat(200) }),
      ),
    ).toBe(1100);
    expect(
      playbackDuration(answerBeat({ question: { ...question, type: "number" }, value: "123" })),
    ).toBe(662);
  });

  it("reserves a full press and approach between each dense saved choice", () => {
    for (const count of [4, 6, 12]) {
      const duration = playbackDuration(
        answerBeat({
          question: { ...question, type: "multiple" },
          value: Array.from({ length: count }, (_, index) => `choice-${index}`),
        }),
      );
      expect((duration * 0.52) / (count - 1)).toBeGreaterThanOrEqual(240 - 0.000001);
    }
  });

  it.each([
    ["round_confirm", 950],
    ["summary_submit", 800],
    ["handoff", 700],
  ] as const)("leaves return time after %s is confirmed", (kind, duration) => {
    const step = beat({ kind });
    expect(playbackDuration(step)).toBe(duration);
    expect(playbackCommitAt(step)).toBe(0.4);
    expect(duration * (1 - playbackCommitAt(step))).toBeGreaterThanOrEqual(300);
  });

  it("briefly acknowledges the saved summary confirmation without another paper return", () => {
    const step = beat({ kind: "summary_confirm" });
    expect(playbackDuration(step)).toBe(250);
    expect(playbackCommitAt(step)).toBe(0.4);
  });
});

describe("physical time and semantic playback progress", () => {
  it("keeps default and non-confirmation playback linear", () => {
    expect(playbackCommitAt(null)).toBe(0.8);
    expect(playbackCommitAt(beat())).toBe(0.8);
    expect(playbackCommitAt(beat({ kind: "questions" }))).toBe(0.8);
    expect(playbackCommitAt(answerBeat({}))).toBe(0.8);
    for (let elapsed = 0; elapsed <= 1000; elapsed += 10) {
      expect(playbackProgressAt(elapsed, 1000)).toBe(elapsed / 1000);
    }
  });

  it("maps physical confirmation to the existing logical boundary without moving completion", () => {
    expect(playbackProgressAt(0, 1000, 0.4)).toBe(0);
    expect(playbackProgressAt(200, 1000, 0.4)).toBeCloseTo(0.4);
    expect(playbackProgressAt(399.9, 1000, 0.4)).toBeLessThan(0.8);
    expect(playbackProgressAt(400, 1000, 0.4)).toBe(0.8);
    expect(playbackProgressAt(400.1, 1000, 0.4)).toBeGreaterThan(0.8);
    expect(playbackProgressAt(700, 1000, 0.4)).toBeCloseTo(0.9);
    expect(playbackProgressAt(1000, 1000, 0.4)).toBe(1);
    expect(playbackProgressAt(-1, 1000, 0.4)).toBe(0);
    expect(playbackProgressAt(1001, 1000, 0.4)).toBe(1);
  });

  it("moves monotonically through every semantic boundary", () => {
    const samples = Array.from({ length: 1001 }, (_, elapsed) =>
      playbackProgressAt(elapsed, 1000, 0.4),
    );
    expect(new Set(samples.map(playbackStateKey)).size).toBe(3);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeGreaterThan(samples[index - 1]);
    }
  });

  it("preserves physical elapsed time and the mapped pose across pause and resume", () => {
    const elapsed = 447;
    const duration = 950;
    const progress = playbackProgressAt(elapsed, duration, 0.4);
    const timeline = createPlaybackTimeline({ ...frame(progress), elapsed, duration });
    timeline.publish({ ...timeline.read(), running: false });
    expect(timeline.read()).toMatchObject({ elapsed, progress, running: false });
    timeline.publish({ ...timeline.read(), running: true });
    expect(timeline.read()).toMatchObject({ elapsed, progress, running: true });
    const resumedElapsed = elapsed + 16;
    timeline.publish({
      ...timeline.read(),
      elapsed: resumedElapsed,
      progress: playbackProgressAt(resumedElapsed, duration, 0.4),
    });
    expect(timeline.read().elapsed).toBe(resumedElapsed);
    expect(timeline.read().progress).toBeGreaterThan(progress);
    expect(timeline.read().progress).toBeLessThan(1);
  });
});

describe("continuous playback timeline", () => {
  it("delivers every visual sample while semantic snapshots change only at meaningful boundaries", () => {
    const timeline = createPlaybackTimeline(frame(0));
    const samples: number[] = [];
    const states = new Set<number>();
    const unsubscribe = timeline.subscribe((value) => {
      samples.push(value.progress);
      states.add(playbackStateKey(value.progress));
    });
    for (let sample = 0; sample <= 840; sample++) timeline.publish(frame(sample / 840));
    expect(samples).toHaveLength(841);
    expect(states.size).toBe(3);
    expect(timeline.read().progress).toBe(1);
    unsubscribe();
    timeline.publish(frame(0));
    expect(samples).toHaveLength(841);
  });

  it("keeps confirmation and completion on separate boundaries", () => {
    expect(playbackStateKey(0.7999)).toBe(playbackStateKey(0.75));
    expect(playbackStateKey(0.8)).toBeGreaterThan(playbackStateKey(0.7999));
    expect(playbackStateKey(1)).toBeGreaterThan(playbackStateKey(0.9999));
  });

  it("starts a replacement subscription on the next frame", () => {
    const timeline = createPlaybackTimeline(frame(0));
    const received: string[] = [];
    const stop = timeline.subscribe(() => {
      received.push("original");
      stop();
      timeline.subscribe(() => received.push("replacement"));
    });
    timeline.publish(frame(0.1));
    expect(received).toEqual(["original"]);
    timeline.publish(frame(0.2));
    expect(received).toEqual(["original", "replacement"]);
  });

  it("preserves the current pose when publishing a paused control change", () => {
    const timeline = createPlaybackTimeline(frame(0.617));
    timeline.publish({ ...timeline.read(), running: false });
    expect(timeline.read()).toMatchObject({ progress: 0.617, elapsed: 8638, running: false });
  });
});
