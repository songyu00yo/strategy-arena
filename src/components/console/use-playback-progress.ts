"use client";

import { useEffect, useRef, useState } from "react";
import type { Beat } from "./beats";
import { createMotionLoop } from "./motion-runtime";

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
  const [sample, setSample] = useState({ id: "", progress: 0 });
  useEffect(() => {
    complete.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    if (clock.current.id !== stepId) clock.current = { id: stepId, elapsed: 0 };
    const current = clock.current;
    if (settled) {
      current.elapsed = duration;
      return;
    }
    if (!running || !stepId) return;
    let published = -1;
    const loop = createMotionLoop((_time, dt) => {
      current.elapsed = Math.min(duration, current.elapsed + dt * 1000 * speed);
      const progress = current.elapsed / duration;
      if (progress - published >= 0.01 || progress === 1) {
        published = progress;
        setSample({ id: stepId, progress });
      }
      if (progress < 1) return true;
      complete.current();
      return false;
    });
    return () => loop.dispose();
  }, [stepId, duration, speed, running, settled, queueRevision]);
  return settled ? 1 : sample.id === stepId ? sample.progress : 0;
}
