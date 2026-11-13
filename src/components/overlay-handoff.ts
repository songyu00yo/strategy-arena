"use client";

import { acquireMotionHold } from "./console/motion-runtime";
import { corners, type Quad } from "./overlay-geometry";

export interface OverlayHandoff {
  id: number;
  source: HTMLElement;
  snapshot: HTMLElement;
  quad: Quad;
  width: number;
  height: number;
  opacity: number;
  backdropOpacity: string;
  backdropColor: string;
  velocity?: Quad;
  scroll: { node: HTMLElement; left: number; top: number }[];
  accept: () => void;
  abort: () => void;
  releaseSource: () => void;
}

let lockCount = 0;
let originalOverflow = "";
let originalGutter = "";
let sequence = 0;
let pending: OverlayHandoff | null = null;
const sourceOwners = new WeakMap<HTMLElement, { cleanups: (() => void)[] }>();
let deadline: ReturnType<typeof setTimeout> | undefined;

/** A transfer owns its lock until the receiving overlay has acquired its own. */
export function acquireOverlayScrollLock() {
  if (lockCount++ === 0) {
    originalOverflow = document.body.style.overflow;
    originalGutter = document.documentElement.style.scrollbarGutter;
    if (innerWidth > document.documentElement.clientWidth)
      document.documentElement.style.scrollbarGutter = "stable";
    document.body.style.overflow = "hidden";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lockCount === 0) {
      document.body.style.overflow = originalOverflow;
      document.documentElement.style.scrollbarGutter = originalGutter;
    }
  };
}

function visibleSnapshot(source: HTMLElement) {
  const snapshot = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copies = [snapshot, ...snapshot.querySelectorAll<HTMLElement>("*")];
  const animated = new Set(
    source
      .getAnimations({ subtree: true })
      .map((animation) => (animation.effect as KeyframeEffect | null)?.target),
  );
  const scroll: OverlayHandoff["scroll"] = [];
  for (let index = 0; index < copies.length; index++) {
    const original = originals[index];
    const copy = copies[index];
    copy.removeAttribute("id");
    copy.removeAttribute("autofocus");
    copy.removeAttribute("data-step-source");
    copy.style.animation = "none";
    copy.style.transition = "none";
    if (original.scrollTop || original.scrollLeft)
      scroll.push({ node: copy, left: original.scrollLeft, top: original.scrollTop });
    if (animated.has(original) && original !== source) {
      const pose = getComputedStyle(original);
      copy.style.transform = pose.transform;
      copy.style.translate = pose.translate;
      copy.style.rotate = pose.rotate;
      copy.style.scale = pose.scale;
      copy.style.opacity = pose.opacity;
    }
    if (original instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.value = original.value;
      copy.textContent = original.value;
    }
    if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      copy.value = original.value;
      copy.checked = original.checked;
    }
    if (original instanceof HTMLSelectElement && copy instanceof HTMLSelectElement)
      copy.value = original.value;
  }
  const style = getComputedStyle(source);
  for (const property of [
    "display",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "color",
    "background",
    "border",
    "border-radius",
    "box-shadow",
    "padding",
    "gap",
    "flex-direction",
    "align-items",
    "justify-content",
    "box-sizing",
    "overflow",
  ])
    snapshot.style.setProperty(property, style.getPropertyValue(property));
  snapshot.removeAttribute("open");
  snapshot.classList.add("overlay-handoff-snapshot");
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.inert = true;
  Object.assign(snapshot.style, {
    position: "absolute",
    inset: "auto",
    margin: "0",
    maxWidth: "none",
    maxHeight: "none",
    minWidth: "0",
    minHeight: "0",
    width: source.offsetWidth + "px",
    height: source.offsetHeight + "px",
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    transformOrigin: "0 0",
    opacity: "1",
    visibility: "visible",
    pointerEvents: "none",
    willChange: "transform, opacity",
    zIndex: "3",
  });
  return { snapshot, scroll };
}

/** Retire source-only visual state when the whole replacement chain has finished. */
export function deferOverlayHandoffCleanup(source: HTMLElement, cleanup: () => void) {
  const owner = sourceOwners.get(source);
  if (!owner) return false;
  owner.cleanups.push(cleanup);
  return true;
}

/** Capture before React replaces either dialog, including an interrupted projected entrance. */
export function handoffOverlay(source: HTMLElement | null, replace: () => void) {
  if (source && pending?.source === source) {
    replace();
    return;
  }
  if (
    !source ||
    !source.isConnected ||
    source.offsetWidth <= 0 ||
    source.offsetHeight <= 0 ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    replace();
    return;
  }
  const frozen = source.getAnimations({ subtree: true }).map((animation) => ({
    animation,
    running: animation.playState === "running",
    time: animation.currentTime,
  }));
  const driver = frozen.find(
    ({ animation, time, running }) =>
      running &&
      typeof time === "number" &&
      !animation.pending &&
      animation.effect instanceof KeyframeEffect &&
      animation.effect.target === source &&
      animation.effect.getKeyframes().some((frame) => typeof frame.transform === "string"),
  );
  for (const entry of frozen) {
    if (!entry.running) continue;
    entry.animation.pause();
    entry.animation.currentTime = entry.time;
  }
  const quad = corners(source);
  let velocity: Quad | undefined;
  if (driver && typeof driver.time === "number" && driver.time > 1) {
    const interval = Math.min(8, driver.time);
    driver.animation.currentTime = driver.time - interval;
    const before = corners(source);
    driver.animation.currentTime = driver.time;
    velocity = quad.map((point, index) => ({
      x: (point.x - before[index].x) / interval,
      y: (point.y - before[index].y) / interval,
    })) as Quad;
  }
  const captured = visibleSnapshot(source);
  const style = getComputedStyle(source);
  const veil =
    source instanceof HTMLDialogElement
      ? getComputedStyle(source, "::backdrop")
      : getComputedStyle(source.closest(".drawer-backdrop") ?? source, "::before");
  const releaseMotion = acquireMotionHold();
  const releaseScroll = acquireOverlayScrollLock();
  let released = false;
  const release = (accepted: boolean) => {
    if (released) return;
    released = true;
    frozen.forEach(({ animation, running }) => {
      if (accepted || !source.isConnected) animation.cancel();
      else if (running && animation.playState !== "idle") animation.play();
    });
    releaseScroll();
    releaseMotion();
  };
  const cleanups: (() => void)[] = [];
  let sourceReleased = false;
  const releaseSource = () => {
    if (sourceReleased) return;
    sourceReleased = true;
    sourceOwners.delete(source);
    cleanups.splice(0).forEach((cleanup) => cleanup());
  };
  const handoff: OverlayHandoff = {
    id: ++sequence,
    source,
    ...captured,
    quad,
    width: source.offsetWidth,
    height: source.offsetHeight,
    opacity: Number(style.opacity),
    backdropOpacity: veil.opacity,
    backdropColor: veil.backgroundColor,
    velocity,
    accept: () => release(true),
    abort: () => {
      release(false);
      releaseSource();
    },
    releaseSource,
  };
  const previous = pending;
  sourceOwners.set(source, { cleanups });
  pending = handoff;
  clearTimeout(deadline);
  previous?.abort();
  deadline = setTimeout(() => {
    if (pending !== handoff) return;
    pending = null;
    handoff.abort();
  }, 1500);
  try {
    replace();
  } catch (cause) {
    if (pending === handoff) {
      pending = null;
      clearTimeout(deadline);
      handoff.abort();
    }
    throw cause;
  }
}

export function takeOverlayHandoff() {
  const handoff = pending;
  pending = null;
  clearTimeout(deadline);
  return handoff;
}
