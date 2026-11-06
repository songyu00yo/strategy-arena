"use client";

import { useCallback, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { acquireMotionHold } from "./console/motion-runtime";
import { reducedMotion } from "./console/effects";

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

/** Keep the real overlay, focus trap and playback hold alive until its exit has finished. */
export function useOverlayMotion<T extends HTMLElement>(
  kind: "modal" | "drawer",
  onClose: () => void,
  handle?: Ref<OverlayMotionHandle>,
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
            transform:
              kind === "drawer"
                ? "translateX(102%)"
                : `translate(${origin.current.x * 0.7}px,${origin.current.y * 0.7}px) scale(.45)`,
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
    if (active && !el.contains(active)) returnFocus.current = active;
    const previous = returnFocus.current;
    const releaseScroll = lockScroll();
    const releaseMotion = acquireMotionHold();
    if (el instanceof HTMLDialogElement) el.showModal();
    else el.querySelector<HTMLElement>("[data-overlay-autofocus]")?.focus({ preventScroll: true });
    const box = el.getBoundingClientRect();
    const trigger =
      previous?.isConnected && previous !== document.body ? previous.getBoundingClientRect() : null;
    origin.current = trigger
      ? {
          x: trigger.left + trigger.width / 2 - box.left - box.width / 2,
          y: trigger.top + trigger.height / 2 - box.top - box.height / 2,
        }
      : { x: 0, y: 18 };
    if (!reducedMotion()) {
      const flight = el.animate(
        [
          {
            transform:
              kind === "drawer"
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
    return () => {
      mounted.current = false;
      completion.current = null;
      animations.current.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      animations.current = [];
      if (el instanceof HTMLDialogElement) el.close();
      releaseScroll();
      releaseMotion();
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
