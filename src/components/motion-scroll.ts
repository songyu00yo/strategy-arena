"use client";

import { createMotionLoop, motionNow, type MotionOrigin } from "./console/motion-runtime";

type ScrollHost = Window | HTMLElement;
type ScrollRun = { cancel: () => void; velocity: { x: number; y: number } };
const runs = new WeakMap<ScrollHost, ScrollRun>();

/** Starts and ends at rest, while preserving an interrupted move's incoming velocity. */
export function scrollPositionAt(
  from: number,
  to: number,
  velocity: number,
  duration: number,
  t: number,
) {
  const p = Math.max(0, Math.min(1, t));
  const eased = p ** 3 * (p * (p * 6 - 15) + 10);
  const momentum = p * (1 - p) ** 3;
  return from + (to - from) * eased + velocity * duration * momentum;
}

/** User scrolling takes control immediately. Callers can also cancel their own pending move. */
export function moveScroll(
  host: ScrollHost,
  target: { top?: number; left?: number },
  options: {
    duration?: number;
    origin?: MotionOrigin;
    onFinish?: () => void;
    onInterrupt?: () => void;
  } = {},
) {
  const page = host === window;
  const element = page ? document.documentElement : (host as HTMLElement);
  const start = { x: page ? scrollX : element.scrollLeft, y: page ? scrollY : element.scrollTop };
  const end = {
    x: Math.max(
      0,
      Math.min(
        target.left ?? start.x,
        element.scrollWidth - (page ? innerWidth : element.clientWidth),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        target.top ?? start.y,
        element.scrollHeight - (page ? innerHeight : element.clientHeight),
      ),
    ),
  };
  const previous = runs.get(host);
  const incoming = previous ? { ...previous.velocity } : { x: 0, y: 0 };
  previous?.cancel();
  const write = (x: number, y: number) => host.scrollTo({ left: x, top: y, behavior: "instant" });
  if (
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    Math.hypot(end.x - start.x, end.y - start.y) < 0.5
  ) {
    write(end.x, end.y);
    options.onFinish?.();
    return () => {};
  }
  const duration =
    options.duration ??
    Math.min(420, Math.max(220, Math.hypot(end.x - start.x, end.y - start.y) * 0.25));
  const origin = options.origin ?? "interaction";
  const began = origin === "story" ? motionNow() : performance.now();
  let last = { ...start, at: began };
  let cancelled = false;
  const run: ScrollRun = { cancel, velocity: incoming };
  const interrupt = (event: Event) => {
    if (!page && event.target instanceof Node && !element.contains(event.target)) return;
    if (
      event instanceof KeyboardEvent &&
      !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
    )
      return;
    cancel();
    options.onInterrupt?.();
  };
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    loop.dispose();
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
      window.removeEventListener(event, interrupt, true);
    if (runs.get(host) === run) runs.delete(host);
  }
  runs.set(host, run);
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
    window.addEventListener(event, interrupt, { capture: true, passive: true });
  const loop = createMotionLoop((time) => {
    const progress = Math.min(1, (time - began) / duration);
    const x = scrollPositionAt(start.x, end.x, incoming.x, duration, progress);
    const y = scrollPositionAt(start.y, end.y, incoming.y, duration, progress);
    const dt = Math.max(1, time - last.at);
    run.velocity = { x: (x - last.x) / dt, y: (y - last.y) / dt };
    last = { x, y, at: time };
    write(x, y);
    if (progress < 1) return true;
    cancel();
    options.onFinish?.();
    return false;
  }, origin);
  return cancel;
}

export function revealInWindow(
  element: HTMLElement,
  options: {
    block?: "start" | "center" | "nearest";
    margin?: number;
    duration?: number;
    origin?: MotionOrigin;
    onFinish?: () => void;
    onInterrupt?: () => void;
  } = {},
) {
  const box = element.getBoundingClientRect();
  const margin = options.margin ?? 12;
  const block = options.block ?? "nearest";
  let top = scrollY;
  if (block === "start") top += box.top - margin;
  else if (block === "center")
    top += box.top + Math.min(box.height, innerHeight - margin * 2) / 2 - innerHeight / 2;
  else if (box.top < margin) top += box.top - margin;
  else if (box.bottom > innerHeight - margin)
    top +=
      box.height > innerHeight - margin * 2 ? box.top - margin : box.bottom - innerHeight + margin;
  return moveScroll(window, { top }, options);
}
