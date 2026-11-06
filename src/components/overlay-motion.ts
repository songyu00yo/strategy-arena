"use client";

import { useCallback, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { acquireMotionHold } from "./console/motion-runtime";
import { reducedMotion } from "./console/effects";
import { currentMotionOrigin, readMotionOrigin } from "./motion-origin";

export type OverlayMotionHandle = { close: (after?: () => void) => boolean };

let scrollLocks = 0;
let originalOverflow = "";

function lockScroll() {
  if (scrollLocks++ === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--scrollLocks === 0) document.body.style.overflow = originalOverflow;
  };
}

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

/** Keep the real overlay, focus trap and playback hold alive until its exit has finished. */
export function useOverlayMotion<T extends HTMLElement>(
  kind: "modal" | "drawer",
  onClose: () => void,
  handle?: Ref<OverlayMotionHandle>,
  trigger?: HTMLElement | null,
) {
  const panel = useRef<T>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);
  const animations = useRef<Animation[]>([]);
  const mounted = useRef(false);
  const closing = useRef(false);
  const completion = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const origin = useRef({ x: 0, y: 18 });
  const openingOrigin = useRef(readMotionOrigin(trigger));
  useLayoutEffect(() => {
    latestClose.current = onClose;
  });

  const close = useCallback(
    (after?: () => void) => {
      const el = panel.current;
      if (!el || !mounted.current) return false;
      if (closing.current) {
        // An in-flight submit may complete during a user-requested exit.
        if (after) completion.current = after;
        return true;
      }
      closing.current = true;
      const done = after ?? latestClose.current;
      completion.current = done;
      if (reducedMotion()) {
        done();
        return true;
      }
      // Read the currently displayed pose before cancelling an interrupted entrance.
      const pose = getComputedStyle(el);
      const start = { transform: pose.transform, opacity: pose.opacity };
      const source = currentMotionOrigin(openingOrigin.current);
      const box = el.getBoundingClientRect();
      const matrix = new DOMMatrixReadOnly(pose.transform === "none" ? undefined : pose.transform);
      const visibleSource =
        source &&
        source.element.isConnected &&
        source.x >= 0 &&
        source.x <= innerWidth &&
        source.y >= 0 &&
        source.y <= innerHeight;
      const destination = visibleSource
        ? `translate(${source.x - (box.left + box.width / 2 - matrix.m41)}px,${source.y - (box.top + box.height / 2 - matrix.m42)}px) scale(${Math.min(0.45, source.width / Math.max(1, el.offsetWidth))},${Math.min(0.45, source.height / Math.max(1, el.offsetHeight))})`
        : start.transform;
      const veil = kind === "modal" ? el : backdrop.current;
      const pseudo = kind === "modal" ? "::backdrop" : "::before";
      const veilOpacity = veil ? getComputedStyle(veil, pseudo).opacity : "1";
      const continuing = animations.current.filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (target !== el && target !== veil) return true;
        animation.cancel();
        return false;
      });
      const flight = el.animate(
        [
          start,
          {
            transform: destination,
            opacity: 0,
          },
        ],
        { duration: 420, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
      );
      animations.current = [...continuing, flight];
      if (veil)
        animations.current.push(
          veil.animate([{ opacity: veilOpacity }, { opacity: 0 }], {
            duration: 420,
            easing: "ease-out",
            fill: "forwards",
            pseudoElement: pseudo,
          }),
        );
      flight.onfinish = () => {
        if (mounted.current) completion.current?.();
      };
      return true;
    },
    [kind],
  );
  useImperativeHandle(handle, () => ({ close }), [close]);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    mounted.current = true;
    closing.current = false;
    const active = document.activeElement as HTMLElement | null;
    // Strict Mode replays effects after autofocus; retain the original outside trigger.
    if (openingOrigin.current?.element.isConnected)
      returnFocus.current = openingOrigin.current.element;
    else if (active && !el.contains(active)) returnFocus.current = active;
    const previous = returnFocus.current;
    const releaseScroll = lockScroll();
    const releaseMotion = acquireMotionHold();
    const releaseBackground = kind === "drawer" ? lockDrawerBackground(el) : () => {};
    if (el instanceof HTMLDialogElement) el.showModal();
    else el.querySelector<HTMLElement>("[data-overlay-autofocus]")?.focus({ preventScroll: true });
    const box = el.getBoundingClientRect();
    const source = currentMotionOrigin(openingOrigin.current);
    origin.current = source
      ? {
          x: source.x - box.left - box.width / 2,
          y: source.y - box.top - box.height / 2,
        }
      : { x: 0, y: 18 };
    if (!reducedMotion()) {
      const flight = el.animate(
        [
          {
            transform:
              kind === "drawer" && !source
                ? "translateX(60px)"
                : `translate(${origin.current.x}px,${origin.current.y}px) scale(.32)`,
            opacity: kind === "drawer" ? 0.2 : 0,
          },
          { transform: "none", opacity: 1 },
        ],
        {
          duration: kind === "drawer" ? 620 : 460,
          easing: "cubic-bezier(.16,1,.3,1)",
          fill: "both",
        },
      );
      const veil = kind === "modal" ? el : backdrop.current;
      animations.current = [flight];
      if (veil)
        animations.current.push(
          veil.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 350,
            easing: "ease-out",
            fill: "both",
            pseudoElement: kind === "modal" ? "::backdrop" : "::before",
          }),
        );
      if (kind === "drawer")
        el.querySelectorAll(".evidence-section").forEach((section, index) => {
          animations.current.push(
            section.animate(
              [
                { opacity: 0, transform: "translateX(20px)" },
                { opacity: 1, transform: "none" },
              ],
              {
                duration: 480,
                delay: 100 + Math.min(index, 3) * 80,
                easing: "cubic-bezier(.16,1,.3,1)",
                fill: "both",
              },
            ),
          );
        });
    }
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const settlePreference = () => {
      if (!media.matches) return;
      animations.current.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      animations.current = [];
      if (closing.current) completion.current?.();
    };
    media.addEventListener("change", settlePreference);
    return () => {
      mounted.current = false;
      media.removeEventListener("change", settlePreference);
      completion.current = null;
      animations.current.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      animations.current = [];
      if (el instanceof HTMLDialogElement) el.close();
      releaseScroll();
      releaseMotion();
      releaseBackground();
      // The next overlay or version gets first choice of focus during a handoff.
      queueMicrotask(() => {
        if (mounted.current || !previous?.isConnected) return;
        const anotherOverlay = [
          ...document.querySelectorAll('dialog[open], [aria-modal="true"]'),
        ].some((node) => node !== el);
        if (!anotherOverlay) previous.focus({ preventScroll: true });
      });
    };
  }, [kind]);

  return { panel, backdrop, close };
}
