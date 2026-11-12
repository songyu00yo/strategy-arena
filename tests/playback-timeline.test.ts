/** Synthetic clock samples. No browser, model call or persisted task. */
import { describe, expect, it } from "vitest";
import {
  createPlaybackTimeline,
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
    expect(states.size).toBe(9);
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
