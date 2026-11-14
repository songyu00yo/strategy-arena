"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { reducedMotion } from "./effects";
import { createMotionScope, useReducedMotion } from "./motion-runtime";
import { PAPER_MOTION } from "./paper-stage";

/** Keep the result in the flow until its space has closed. A new request starts at the current size. */
export function ResultRegion({
  open,
  expanded,
  children,
  theater = false,
  speed = 1,
  holdSpace = false,
}: {
  open: boolean;
  expanded: boolean;
  children: ReactNode;
  theater?: boolean;
  speed?: number;
  holdSpace?: boolean;
}) {
  const reducePreference = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const settleInitialOpen = useRef(open);
  const animations = useRef<Animation[]>([]);
  const playbackRate = useRef(speed);
  const retaining = !open && holdSpace;
  useLayoutEffect(() => {
    playbackRate.current = theater && !expanded ? speed : 1;
    animations.current.forEach((part) => part.updatePlaybackRate(playbackRate.current));
  }, [speed, theater, expanded]);
  useLayoutEffect(() => {
    const host = ref.current;
    const card = host?.firstElementChild as HTMLElement | null;
    if (!host || !card) return;
    const scope = createMotionScope(theater && !expanded ? "story" : "interaction");
    let parts: Animation[] = [];
    let target = -1;
    const freeze = () => {
      // Read the displayed values before canceling an interrupted transition.
      const height = host.getBoundingClientRect().height;
      const hostOpacity = getComputedStyle(host).opacity;
      const style = getComputedStyle(card);
      const opacity = style.opacity;
      const transform = style.transform;
      parts.forEach((part) => part.cancel());
      host.style.height = `${height}px`;
      host.style.opacity = hostOpacity;
      card.style.opacity = opacity;
      card.style.transform = transform;
    };
    const resize = () => {
      const maximumHeight = parseFloat(getComputedStyle(host).maxHeight);
      const naturalHeight = card.getBoundingClientRect().height + 5;
      const next = open
        ? Number.isFinite(maximumHeight)
          ? Math.min(naturalHeight, maximumHeight)
          : naturalHeight
        : retaining
          ? host.getBoundingClientRect().height
          : 0;
      if (Math.abs(next - target) < 0.5) return;
      target = next;
      freeze();
      const height = host.style.height;
      const hostOpacity = host.style.opacity || "1";
      const opacity = card.style.opacity;
      const transform = card.style.transform;
      host.style.visibility = "visible";
      const finish = () => {
        host.style.height = `${next}px`;
        host.style.visibility = open ? "visible" : "hidden";
        host.style.opacity = retaining ? "0" : "1";
        card.style.opacity = open || retaining ? "1" : "0";
        card.style.transform = open ? "none" : "translateY(-8px)";
        parts.forEach((part) => part.cancel());
        parts = [];
        animations.current = [];
      };
      // Existing results take their natural space before the first painted frame.
      // The enclosing paper entrance remains, with stable controls below it.
      if (settleInitialOpen.current) {
        settleInitialOpen.current = false;
        return finish();
      }
      if (reducedMotion() || (next === 0 && parseFloat(height) === 0)) return finish();
      const timing = {
        duration: theater ? (open ? PAPER_MOTION.open : PAPER_MOTION.fold) : open ? 260 : 220,
        easing: "cubic-bezier(.2,.75,.25,1)",
        fill: "both",
      } as const;
      parts = [
        scope.animate(
          host,
          [
            { height, opacity: hostOpacity },
            { height: `${next}px`, opacity: open ? 1 : retaining ? 0 : hostOpacity },
          ],
          timing,
        ),
        scope.animate(
          card,
          [
            { opacity, transform },
            { opacity: open || retaining ? 1 : 0, transform: open ? "none" : "translateY(-8px)" },
          ],
          timing,
        ),
      ];
      animations.current = parts;
      parts.forEach((part) => part.updatePlaybackRate(playbackRate.current));
      parts[0].onfinish = finish;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(card);
    return () => {
      observer.disconnect();
      freeze();
      scope.dispose();
      animations.current = [];
    };
  }, [open, expanded, reducePreference, theater, retaining]);
  return (
    <div
      ref={ref}
      className="c-result-region"
      tabIndex={open ? 0 : -1}
      aria-label="完整需求报告滚动区域"
      inert={!open}
      aria-hidden={!open}
    >
      {children}
    </div>
  );
}
