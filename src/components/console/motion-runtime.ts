"use client";
import { useSyncExternalStore } from "react";

const owners = new Set<symbol>();
const listeners = new Set<() => void>();
let listening = false;
let pausedAt: number | null = null;
let pausedTotal = 0;
const now = () => (typeof performance === "undefined" ? 0 : performance.now());
export const motionPaused = () =>
  owners.size > 0 || (typeof document !== "undefined" && document.hidden);

function publish() {
  const paused = motionPaused();
  if (paused && pausedAt === null) pausedAt = now();
  if (!paused && pausedAt !== null) {
    pausedTotal += now() - pausedAt;
    pausedAt = null;
  }
  document.querySelectorAll(".c-root").forEach((root) => root.classList.toggle("held", paused));
  listeners.forEach((listener) => listener());
}
function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", publish);
  publish();
}
/** One reader cannot release another reader's hold. Release is idempotent. */
export function acquireMotionHold() {
  listen();
  const owner = Symbol();
  owners.add(owner);
  publish();
  return () => {
    if (owners.delete(owner)) publish();
  };
}
export function subscribeMotionPause(listener: () => void) {
  listen();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useMotionPaused() {
  return useSyncExternalStore(subscribeMotionPause, motionPaused, () => false);
}
/** A clock that excludes time spent reading overlays or in a hidden tab. */
export function motionNow() {
  listen();
  return (pausedAt ?? now()) - pausedTotal;
}

/** Owns one step's delayed work and animation, including work already started. */
export function createMotionScope() {
  let disposed = false;
  const animations = new Set<Animation>();
  const nodes = new Set<Element>();
  const timers = new Set<{ due: number; run: () => void; id?: ReturnType<typeof setTimeout> }>();
  const arm = () => {
    for (const timer of timers) {
      clearTimeout(timer.id);
      if (disposed || motionPaused()) continue;
      timer.id = setTimeout(
        () => {
          timers.delete(timer);
          if (!disposed) timer.run();
        },
        Math.max(0, timer.due - motionNow()),
      );
    }
    for (const animation of animations) {
      if (animation.playState === "finished" || animation.playState === "idle") continue;
      if (motionPaused()) animation.pause();
      else animation.play();
    }
  };
  const unsubscribe = subscribeMotionPause(arm);
  return {
    later(ms: number, run: () => void) {
      if (disposed) return;
      timers.add({ due: motionNow() + ms, run });
      arm();
    },
    own<T extends Element>(node: T): T {
      nodes.add(node);
      return node;
    },
    animate(node: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = node.animate(frames, options);
      if (disposed) {
        animation.cancel();
        return animation;
      }
      animations.add(animation);
      animation.addEventListener(
        "finish",
        () => {
          // Finished fill effects still own a visual pose until their step is disposed.
          if (options.fill !== "both" && options.fill !== "forwards") animations.delete(animation);
        },
        { once: true },
      );
      if (motionPaused()) animation.pause();
      animation.addEventListener("cancel", () => animations.delete(animation), { once: true });
      return animation;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      timers.forEach((timer) => clearTimeout(timer.id));
      timers.clear();
      animations.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      animations.clear();
      nodes.forEach((node) => node.remove());
      nodes.clear();
    },
  };
}

/** A frame loop sleeps while held and when its callback reports no remaining work. */
export function createMotionLoop(tick: (time: number, dt: number) => boolean) {
  let frame = 0;
  let disposed = false;
  let active = true;
  let running = false;
  let last = motionNow();
  const run = () => {
    frame = 0;
    if (disposed || motionPaused()) return;
    const time = motionNow();
    const dt = Math.min(0.033, Math.max(0, time - last) / 1000);
    last = time;
    running = true;
    active = tick(time, dt);
    running = false;
    if (active) frame = requestAnimationFrame(run);
  };
  const wake = () => {
    active = true;
    if (!frame && !running && !disposed && !motionPaused()) {
      last = motionNow();
      frame = requestAnimationFrame(run);
    }
  };
  const unsubscribe = subscribeMotionPause(() => {
    if (motionPaused()) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else if (active) wake();
  });
  wake();
  return {
    wake,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe();
    },
  };
}
