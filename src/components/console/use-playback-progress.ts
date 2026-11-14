"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Beat } from "./beats";
import { createMotionLoop, motionNow } from "./motion-runtime";
import { PAPER_MOTION } from "./paper-stage";

export interface PlaybackFrame {
  stepId: string;
  progress: number;
  elapsed: number;
  duration: number;
  running: boolean;
  settled: boolean;
}

export interface PlaybackTimeline {
  read: () => PlaybackFrame;
  subscribe: (listener: (frame: PlaybackFrame) => void) => () => void;
}

/** Imperative subscribers share every animation frame without rendering the console. */
export function createPlaybackTimeline(initial: PlaybackFrame) {
  let current = initial;
  const listeners = new Set<(frame: PlaybackFrame) => void>();
  return {
    read: () => current,
    subscribe(listener: (frame: PlaybackFrame) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(frame: PlaybackFrame) {
      current = frame;
      for (const listener of [...listeners]) listener(frame);
    },
  };
}

/** These boundaries change recorded facts. Motion between them belongs to the timeline. */
const STATE_BOUNDARIES = [0.8, 1];
export function playbackStateKey(progress: number) {
  return STATE_BOUNDARIES.filter((at) => progress >= at).length;
}

/** Confirmation steps leave physical time for the paper to return after the saved action. */
export function playbackCommitAt(beat: Beat | null): number {
  const kind = beat?.replayAction?.kind;
  return kind && ["round_confirm", "summary_submit", "summary_confirm", "handoff"].includes(kind)
    ? 0.4
    : 0.8;
}

/** Keep the existing semantic confirmation boundary while changing its physical timing. */
export function playbackProgressAt(elapsed: number, duration: number, commitAt = 0.8): number {
  const progress = Math.max(0, Math.min(1, elapsed / duration));
  if (commitAt === 0.8) return progress;
  if (progress <= commitAt) return (progress / commitAt) * 0.8;
  return 0.8 + ((progress - commitAt) / (1 - commitAt)) * 0.2;
}

/** Durations describe the reconstructed demonstration, never original user input timing. */
export function playbackDuration(beat: Beat | null): number {
  const action = beat?.replayAction;
  if (!action) return 650;
  if (action.kind === "questions") {
    return Math.min(1600, 1100 + Math.max(0, (action.questions?.length ?? 0) - 1) * 100);
  }
  if (action.kind === "answer") {
    const answer = action.answers?.[0];
    if (!answer || answer.state !== "answered") return 450;
    if (Array.isArray(answer.value)) {
      const compact = Math.min(1300, 650 + answer.value.length * 160);
      // The saved clicks occupy 52% of the action. Each interval includes a
      // complete press and release before the cursor approaches the next choice.
      const clickIntervals = Math.max(0, answer.value.length - 1);
      return Math.max(compact, (clickIntervals * PAPER_MOTION.feedback * 2) / 0.52);
    }
    if (answer.question.type === "text" || answer.question.type === "number")
      return Math.min(1100, 650 + Array.from(String(answer.value)).length * 4);
    return 650;
  }
  return {
    round_confirm: 950,
    summary_submit: 800,
    summary_confirm: 250,
    handoff: 700,
  }[action.kind];
}

/** One pause-aware clock drives both the visible action and advancement to the next step. */
export function usePlaybackProgress({
  stepId,
  duration,
  commitAt = 0.8,
  speed,
  running,
  settled,
  queueRevision,
  onComplete,
}: {
  stepId: string;
  duration: number;
  commitAt?: number;
  speed: number;
  running: boolean;
  settled: boolean;
  queueRevision: string;
  onComplete: () => void;
}) {
  const clock = useRef({ id: "", elapsed: 0 });
  const complete = useRef(onComplete);
  const [timeline] = useState(() =>
    createPlaybackTimeline({
      stepId,
      progress: settled ? 1 : 0,
      elapsed: settled ? duration : 0,
      duration,
      running,
      settled,
    }),
  );
  const stateKey = useSyncExternalStore(
    timeline.subscribe,
    () => {
      const frame = timeline.read();
      return frame.stepId === stepId ? playbackStateKey(frame.progress) : 0;
    },
    () => (settled ? STATE_BOUNDARIES.length : 0),
  );
  useLayoutEffect(() => {
    complete.current = onComplete;
  }, [onComplete]);
  useLayoutEffect(() => {
    if (clock.current.id !== stepId) clock.current = { id: stepId, elapsed: 0 };
    const current = clock.current;
    if (settled) current.elapsed = duration;
    const publish = () =>
      timeline.publish({
        stepId,
        progress: playbackProgressAt(current.elapsed, duration, commitAt),
        elapsed: current.elapsed,
        duration,
        running,
        settled,
      });
    publish();
    if (settled) return;
    if (!running || !stepId) return;
    let previous = motionNow();
    const loop = createMotionLoop((time) => {
      // The shared physics loop caps dt for springs. Playback uses actual active elapsed time.
      current.elapsed = Math.min(duration, current.elapsed + Math.max(0, time - previous) * speed);
      previous = time;
      const progress = current.elapsed / duration;
      publish();
      if (progress < 1) return true;
      complete.current();
      return false;
    });
    return () => {
      loop.dispose();
      current.elapsed = Math.min(
        duration,
        current.elapsed + Math.max(0, motionNow() - previous) * speed,
      );
    };
  }, [stepId, duration, commitAt, speed, running, settled, queueRevision, timeline]);
  return {
    progress: settled ? 1 : (STATE_BOUNDARIES[stateKey - 1] ?? 0),
    timeline,
  };
}
