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
      // Leaving retraces the landing: the sheet lifts back into depth instead of shrinking into a button.
      void visibleSource;
      void box;
      void matrix;
      const destination =
        kind === "drawer"
          ? "translateX(64px) rotate(0.4deg)"
          : "perspective(1200px) translateY(22px) rotateX(7deg) scale(0.95)";
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
        { duration: 480, easing: "cubic-bezier(.65,0,.15,1)", fill: "forwards" },
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
      // A sheet is laid on the desk: it comes down out of depth, slightly tilted, and settles flat.
      // A drawer is a slip of paper slid out from between the pages.
      const flight = el.animate(
        kind === "drawer"
          ? [
              { transform: "translateX(72px) rotate(0.6deg)", opacity: 0 },
              { transform: "none", opacity: 1 },
            ]
          : [
              {
                transform: `perspective(1200px) translate(${origin.current.x * 0.06}px, 34px) rotateX(9deg) scale(0.94)`,
                opacity: 0,
              },
              { transform: "none", opacity: 1 },
            ],
        {
          duration: kind === "drawer" ? 820 : 760,
          easing: "cubic-bezier(.19,1,.22,1)",
          fill: "both",
        },
      );
      const veil = kind === "modal" ? el : backdrop.current;
      animations.current = [flight];
      if (veil)
        animations.current.push(
          veil.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 620,
            easing: "cubic-bezier(.19,1,.22,1)",
            fill: "both",
            pseudoElement: kind === "modal" ? "::backdrop" : "::before",
          }),
        );
      if (kind === "drawer")
        el.querySelectorAll(".evidence-section").forEach((section, index) => {
          animations.current.push(
            section.animate(
              [
                { opacity: 0, transform: "translateY(10px)" },
                { opacity: 1, transform: "none" },
              ],
              {
                duration: 720,
                delay: 160 + Math.min(index, 4) * 90,
                easing: "cubic-bezier(.19,1,.22,1)",
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
