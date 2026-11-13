"use client";

import { useCallback, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { acquireMotionHold } from "./console/motion-runtime";
import { reducedMotion } from "./console/effects";
import { currentMotionOrigin, readMotionOrigin } from "./motion-origin";
import {
  acquireOverlayScrollLock,
  deferOverlayHandoffCleanup,
  handoffOverlay,
  takeOverlayHandoff,
  type OverlayHandoff,
} from "./overlay-handoff";
import {
  corners,
  project,
  inverse,
  multiply,
  cssMatrix,
  overlayPath,
  translate,
  type Quad,
} from "./overlay-geometry";

export type OverlayMotionHandle = {
  close: (after?: () => void) => boolean;
  replace: (after: () => void) => boolean;
};

const SAMPLES = 40;
const ENTER_MS = 360;
const EXIT_MS = 240;
const TRANSFER_MS = 420;
type Phase = "opening" | "handoff" | "resizing" | "closing";
type Flight = { driver: Animation; path: (t: number) => Quad; duration: number };
type SavedStyle = {
  transform: string;
  transformOrigin: string;
  opacity: string;
  willChange: string;
};

function lockDrawerBackground(panel: HTMLElement) {
  const changed: { element: HTMLElement; inert: boolean }[] = [];
  let branch: HTMLElement = panel;
  while (branch.parentElement && branch.parentElement !== document.body) {
    for (const sibling of branch.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling !== branch) {
        changed.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
    }
    branch = branch.parentElement;
  }
  return () =>
    changed.forEach(({ element, inert }) => {
      element.inert = inert;
    });
}

function tangent(flight: Flight | null): Quad | undefined {
  const elapsed = flight?.driver.currentTime;
  if (!flight || typeof elapsed !== "number" || elapsed <= 0 || elapsed >= flight.duration) return;
  const interval = Math.min(8, elapsed);
  const at = flight.path(elapsed / flight.duration);
  const before = flight.path((elapsed - interval) / flight.duration);
  return at.map((point, index) => ({
    x: (point.x - before[index].x) / interval,
    y: (point.y - before[index].y) / interval,
  })) as Quad;
}

function shifted(quad: Quad, x: number, y: number): Quad {
  return quad.map((point) => ({ x: point.x + x, y: point.y + y })) as Quad;
}

const FOCUSABLE =
  'button:not(:disabled),a[href],input:not([type="hidden"]):not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

function usableReturnTarget(candidate: HTMLElement | null | undefined, panel: HTMLElement) {
  if (!candidate?.isConnected || panel.contains(candidate) || candidate.closest("[inert]"))
    return null;
  return candidate.matches(FOCUSABLE) ? candidate : null;
}

/** One paper owns its geometry, content, backdrop and interruption until the next overlay accepts it. */
export function useOverlayMotion<T extends HTMLElement>(
  kind: "modal" | "drawer",
  onClose: () => void,
  handle?: Ref<OverlayMotionHandle>,
  trigger?: HTMLElement | null,
) {
  const panel = useRef<T>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);
  const closeAction = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  const closing = useRef(false);
  const generation = useRef(0);
  const animations = useRef<Animation[]>([]);
  const flight = useRef<Flight | null>(null);
  const naturalQuad = useRef<Quad | null>(null);
  const transition = useRef<OverlayHandoff | null>(null);
  const sourceRelease = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openingOrigin = useRef(readMotionOrigin(trigger));
  const savedContent = useRef(new Map<HTMLElement, SavedStyle>());
  const animatePaper = useRef<(from: Quad, phase: Phase, velocity?: Quad) => void>(() => {});

  useLayoutEffect(() => {
    latestClose.current = onClose;
  });

  const close = useCallback((after?: () => void) => {
    const element = panel.current;
    if (!element || !mounted.current) return false;
    closeAction.current = after ?? latestClose.current;
    if (closing.current) return true;
    closing.current = true;
    if (reducedMotion()) closeAction.current();
    else animatePaper.current(corners(element), "closing", tangent(flight.current));
    return true;
  }, []);

  const replace = useCallback((after: () => void) => {
    const element = panel.current;
    if (!element || !mounted.current) return false;
    handoffOverlay(element, after);
    return true;
  }, []);
  useImperativeHandle(handle, () => ({ close, replace }), [close, replace]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    mounted.current = true;
    closing.current = false;
    const active = document.activeElement as HTMLElement | null;
    // A projected source can be a non-focusable card shell. Return to the real
    // control inside it, keeping the geometric source separate from keyboard focus.
    returnFocus.current =
      usableReturnTarget(readMotionOrigin()?.element, element) ??
      usableReturnTarget(openingOrigin.current?.element, element) ??
      usableReturnTarget(
        openingOrigin.current?.element.querySelector<HTMLElement>(FOCUSABLE),
        element,
      ) ??
      usableReturnTarget(active, element) ??
      returnFocus.current;
    const previousFocus = returnFocus.current;
    const releaseScroll = acquireOverlayScrollLock();
    const releaseMotion = acquireMotionHold();
    const releaseBackground = kind === "drawer" ? lockDrawerBackground(element) : () => {};
    const backgroundAnimations = [...document.querySelectorAll<HTMLElement>(".c-stage3, .c-wall")]
      .flatMap((stage) => stage.getAnimations({ subtree: true }))
      .filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return (
          animation.playState === "running" &&
          target instanceof Element &&
          !target.closest('dialog, [aria-modal="true"], .replay-question-scene')
        );
      });
    backgroundAnimations.forEach((animation) => animation.pause());
    const original = {
      transform: element.style.transform,
      transformOrigin: element.style.transformOrigin,
      opacity: element.style.opacity,
      overflow: element.style.overflow,
      height: element.style.height,
    };
    transition.current ??= takeOverlayHandoff();
    sourceRelease.current ??= transition.current?.releaseSource ?? null;
    if (element instanceof HTMLDialogElement) element.showModal();
    element.querySelector<HTMLElement>("[data-overlay-autofocus]")?.focus({ preventScroll: true });
    let snapshot: HTMLElement | null = null;
    let snapshotQuad: Quad | null = null;
    let previousSize = { width: element.offsetWidth, height: element.offsetHeight };
    let previousViewport = { width: innerWidth, height: innerHeight };
    let disposed = false;
    const veil = kind === "modal" ? element : backdrop.current;
    const pseudo = kind === "modal" ? "::backdrop" : "::before";
    const backdropTarget = veil ? getComputedStyle(veil, pseudo) : null;
    const backdropColor = backdropTarget?.backgroundColor ?? "transparent";
    const backdropOpacity = backdropTarget?.opacity ?? "1";

    const content = () =>
      [...element.children].filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node !== snapshot &&
          !node.hasAttribute("data-overlay-corner"),
      );
    const remember = (node: HTMLElement) => {
      if (!savedContent.current.has(node))
        savedContent.current.set(node, {
          transform: node.style.transform,
          transformOrigin: node.style.transformOrigin,
          opacity: node.style.opacity,
          willChange: node.style.willChange,
        });
    };
    const stop = (preserve: boolean) => {
      if (preserve) {
        const pose = getComputedStyle(element);
        element.style.transform = pose.transform;
        element.style.opacity = pose.opacity;
        for (const node of [...content(), ...(snapshot ? [snapshot] : [])]) {
          const style = getComputedStyle(node);
          node.style.transform = style.transform;
          node.style.opacity = style.opacity;
        }
      }
      animations.current.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      animations.current = [];
      flight.current = null;
    };
    const restoreContent = () => {
      savedContent.current.forEach((style, node) => Object.assign(node.style, style));
      savedContent.current.clear();
    };
    const finish = () => {
      stop(false);
      snapshot?.remove();
      snapshot = null;
      snapshotQuad = null;
      restoreContent();
      Object.assign(element.style, original);
      delete element.dataset.overlayMotionActive;
      delete element.dataset.overlayMotionPhase;
      transition.current?.accept();
      transition.current = null;
      naturalQuad.current = corners(element);
      previousSize = { width: element.offsetWidth, height: element.offsetHeight };
    };

    const start = (from: Quad, phase: Phase, inheritedVelocity?: Quad) => {
      const currentGeneration = ++generation.current;
      const isClosing = phase === "closing";
      const oldOpacity = Number(getComputedStyle(element).opacity);
      const nodeStarts = new Map(
        content().map((node) => [node, Number(getComputedStyle(node).opacity)]),
      );
      const carriedQuad = snapshot
        ? phase === "handoff"
          ? snapshotQuad
          : corners(snapshot)
        : null;
      const veilStart = veil
        ? {
            opacity: getComputedStyle(veil, pseudo).opacity,
            color: getComputedStyle(veil, pseudo).backgroundColor,
          }
        : null;
      stop(true);
      restoreContent();
      element.style.transform = "none";
      element.style.transformOrigin = "0 0";
      if (isClosing) element.style.height = element.offsetHeight + "px";
      const destination = corners(element);
      naturalQuad.current = destination;
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const base = project(width, height, destination);
      const baseInverse = inverse(base);
      const center = {
        x: from.reduce((sum, point) => sum + point.x, 0) / 4,
        y: from.reduce((sum, point) => sum + point.y, 0) / 4,
      };
      const to = isClosing
        ? (from.map((point) => ({
            x: center.x + (point.x - center.x) * 0.985,
            y: center.y + (point.y - center.y) * 0.985 + 8,
          })) as Quad)
        : destination;
      const duration = isClosing
        ? EXIT_MS
        : phase === "handoff"
          ? TRANSFER_MS
          : phase === "resizing"
            ? 220
            : ENTER_MS;
      const path = overlayPath(from, to, duration, inheritedVelocity);
      const quads = Array.from({ length: SAMPLES + 1 }, (_, index) => path(index / SAMPLES));
      const projections = quads.map((quad) => project(width, height, quad));
      const timing = { duration, easing: "linear", fill: "both" } as const;
      const add = (node: Element, frames: Keyframe[], options: KeyframeAnimationOptions = {}) => {
        const animation = new Animation(
          new KeyframeEffect(node, frames, { ...timing, ...options }),
          document.timeline,
        );
        animations.current.push(animation);
        return animation;
      };
      const driver = add(
        element,
        projections.map((projection) => ({
          transform: cssMatrix(multiply(baseInverse, projection)),
        })),
      );
      add(
        element,
        [
          {
            opacity:
              isClosing || phase === "resizing"
                ? oldOpacity
                : phase === "handoff"
                  ? (transition.current?.opacity ?? 1)
                  : 0,
          },
          { opacity: isClosing ? 0 : 1 },
        ],
        { easing: isClosing ? "cubic-bezier(.4,0,.2,1)" : "cubic-bezier(.16,1,.3,1)" },
      );
      element.style.overflow = "clip";
      element.dataset.overlayMotionActive = "true";
      element.dataset.overlayMotionPhase = phase;
      element.dataset.overlayMotionDuration = String(duration);
      if (veil)
        add(
          veil,
          [
            {
              opacity:
                phase === "opening"
                  ? 0
                  : phase === "handoff"
                    ? (transition.current?.backdropOpacity ?? backdropOpacity)
                    : (veilStart?.opacity ?? backdropOpacity),
              backgroundColor:
                phase === "handoff"
                  ? (transition.current?.backdropColor ?? backdropColor)
                  : (veilStart?.color ?? backdropColor),
            },
            { opacity: isClosing ? 0 : backdropOpacity, backgroundColor: backdropColor },
          ],
          { pseudoElement: pseudo, easing: "cubic-bezier(.16,1,.3,1)" },
        );
      content().forEach((node, index) => {
        remember(node);
        const box = node.getBoundingClientRect();
        const localMatrix = translate(box.left - destination[0].x, box.top - destination[0].y);
        const localInverse = inverse(localMatrix);
        node.style.transformOrigin = "0 0";
        node.style.willChange = "transform, opacity";
        add(
          node,
          projections.map((projection, at) => {
            const quad = quads[at];
            const desired = multiply(translate(quad[0].x, quad[0].y), localMatrix);
            return {
              transform: cssMatrix(multiply(localInverse, multiply(inverse(projection), desired))),
            };
          }),
        );
        const arriving = phase === "opening" || phase === "handoff";
        const begin = arriving ? 0 : (nodeStarts.get(node) ?? 1);
        add(
          node,
          arriving
            ? [
                { opacity: begin, offset: 0 },
                { opacity: begin, offset: Math.min(0.2, 0.12 + index * 0.025) },
                { opacity: 1, offset: 0.56 },
                { opacity: 1 },
              ]
            : [{ opacity: begin }, { opacity: isClosing ? 0 : 1 }],
        );
      });
      if (snapshot && (carriedQuad || snapshotQuad)) {
        const source = carriedQuad ?? snapshotQuad!;
        const plane = project(snapshot.offsetWidth, snapshot.offsetHeight, source);
        snapshot.style.left = -element.clientLeft + "px";
        snapshot.style.top = -element.clientTop + "px";
        add(
          snapshot,
          projections.map((projection, index) => {
            const quad = quads[index];
            const delta = translate(quad[0].x - from[0].x, quad[0].y - from[0].y);
            return { transform: cssMatrix(multiply(inverse(projection), multiply(delta, plane))) };
          }),
        );
        const snapshotOpacity = Number(getComputedStyle(snapshot).opacity);
        add(snapshot, [
          { opacity: Number.isFinite(snapshotOpacity) ? snapshotOpacity : 1, offset: 0 },
          { opacity: 0, offset: phase === "handoff" ? 0.32 : 1 },
          { opacity: 0 },
        ]);
      }
      const time = document.timeline.currentTime;
      animations.current.forEach((animation) => {
        animation.currentTime = 0;
        animation.play();
        if (typeof time === "number") animation.startTime = time;
      });
      flight.current = { driver, path, duration };
      driver.onfinish = () => {
        if (disposed || generation.current !== currentGeneration) return;
        if (isClosing) closeAction.current?.();
        else finish();
      };
    };
    animatePaper.current = start;

    const incoming = transition.current;
    if (incoming && !reducedMotion()) {
      snapshot = incoming.snapshot;
      snapshotQuad = incoming.quad;
      element.dataset.overlayHandoffId = String(incoming.id);
      element.append(snapshot);
      incoming.scroll.forEach(({ node, left, top }) => {
        node.scrollLeft = left;
        node.scrollTop = top;
      });
      start(incoming.quad, "handoff", incoming.velocity);
      incoming.accept();
    } else if (!reducedMotion()) {
      const destination = corners(element);
      const source = currentMotionOrigin(openingOrigin.current);
      const deltaX =
        kind === "drawer"
          ? 24
          : source
            ? Math.max(-24, Math.min(24, (source.x - destination[0].x) * 0.04))
            : 0;
      start(shifted(destination, deltaX, 16), "opening");
    } else incoming?.accept();

    const resize = () => {
      if (disposed) return;
      const next = { width: element.offsetWidth, height: element.offsetHeight };
      const same =
        Math.abs(next.width - previousSize.width) < 0.5 &&
        Math.abs(next.height - previousSize.height) < 0.5;
      const viewportChanged =
        previousViewport.width !== innerWidth || previousViewport.height !== innerHeight;
      previousViewport = { width: innerWidth, height: innerHeight };
      if (same && !viewportChanged) return;
      const active = flight.current;
      const time = active?.driver.currentTime;
      const from =
        active && typeof time === "number"
          ? active.path(Math.min(1, time / active.duration))
          : naturalQuad.current;
      const ownsHeight = element.querySelector("[data-disclosure-motion-active='height']");
      const directResize =
        !active &&
        !viewportChanged &&
        Math.abs(next.width - previousSize.width) < 8 &&
        Math.abs(next.height - previousSize.height) < 8;
      previousSize = next;
      if ((ownsHeight && !active) || directResize || !from || reducedMotion()) {
        naturalQuad.current = corners(element);
        return;
      }
      start(from, closing.current ? "closing" : "resizing", tangent(active));
    };
    // RO runs after layout and before paint. Redirect now so a changed natural
    // box cannot display one frame with the previous relative transform.
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    addEventListener("resize", resize, { passive: true });
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const onPreference = () => {
      if (!media.matches) return;
      finish();
      if (closing.current) closeAction.current?.();
    };
    media.addEventListener("change", onPreference);
    return () => {
      disposed = true;
      mounted.current = false;
      closeAction.current = null;
      observer.disconnect();
      removeEventListener("resize", resize);
      media.removeEventListener("change", onPreference);
      stop(false);
      snapshot?.remove();
      restoreContent();
      Object.assign(element.style, original);
      delete element.dataset.overlayMotionActive;
      delete element.dataset.overlayMotionPhase;
      delete element.dataset.overlayHandoffId;
      if (element instanceof HTMLDialogElement) element.close();
      releaseScroll();
      releaseMotion();
      releaseBackground();
      transition.current?.accept();
      const releaseSource = sourceRelease.current;
      if (releaseSource)
        queueMicrotask(() => {
          // Strict Mode replays this effect before paint; its second setup still owns the lease.
          if (mounted.current) return;
          sourceRelease.current = null;
          if (!deferOverlayHandoffCleanup(element, releaseSource)) releaseSource();
        });
      backgroundAnimations.forEach((animation) => {
        if (animation.playState === "paused") animation.play();
      });
      queueMicrotask(() => {
        if (
          !previousFocus?.isConnected ||
          document.querySelector('dialog[open], [aria-modal="true"]')
        )
          return;
        previousFocus.focus({ preventScroll: true });
      });
    };
  }, [kind]);

  return { panel, backdrop, close };
}
