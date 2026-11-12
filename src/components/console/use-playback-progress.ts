"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Beat } from "./beats";
import { createMotionLoop, motionNow } from "./motion-runtime";

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
const STATE_BOUNDARIES = [0.15, 0.2, 0.32, 0.45, 0.75, 0.8, 0.94, 1];
export function playbackStateKey(progress: number) {
  return STATE_BOUNDARIES.filter((at) => progress >= at).length;
}

/** Durations describe the reconstructed demonstration, never original user input timing. */
export function playbackDuration(beat: Beat | null): number {
  const action = beat?.replayAction;
  if (!action) return beat?.stage === "attack" ? 3760 : 3560;
  if (action.kind === "questions") {
    const characters = (action.questions ?? []).reduce(
      (total, question) =>
        total + question.title.length + question.reason.length + question.options.join("").length,
      0,
    );
    return Math.min(14000, Math.max(5000, 2000 + characters * 28));
  }
  if (action.kind === "answer") {
    const answer = action.answers?.[0];
    if (!answer || answer.state !== "answered") return 1900;
    if (Array.isArray(answer.value)) return 1500 + answer.value.length * 600;
    if (answer.question.type === "text" || answer.question.type === "number")
      return Math.min(10000, Math.max(2200, String(answer.value).length * 22 + 1100));
    return 2300;
  }
  return action.kind === "handoff" ? 1900 : 2500;
}

/** One pause-aware clock drives both the visible action and advancement to the next step. */
export function usePlaybackProgress({
  stepId,
  duration,
  speed,
  running,
  settled,
  queueRevision,
  onComplete,
}: {
  stepId: string;
  duration: number;
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
        progress: current.elapsed / duration,
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
  }, [stepId, duration, speed, running, settled, queueRevision, timeline]);
  return {
    progress: settled ? 1 : (STATE_BOUNDARIES[stateKey - 1] ?? 0),
    timeline,
  };
}
