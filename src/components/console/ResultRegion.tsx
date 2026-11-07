"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { reducedMotion } from "./effects";
import { createMotionScope, useReducedMotion } from "./motion-runtime";

/** Keep the result in the flow until its space has closed. A new request starts at the current size. */
export function ResultRegion({
  open,
  expanded,
  children,
}: {
  open: boolean;
  expanded: boolean;
  children: ReactNode;
}) {
  const reducePreference = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    const card = host?.firstElementChild as HTMLElement | null;
    if (!host || !card) return;
    const scope = createMotionScope("interaction");
    let parts: Animation[] = [];
    let target = -1;
    const freeze = () => {
      // Read the displayed values before canceling an interrupted transition.
      const height = host.getBoundingClientRect().height;
      const style = getComputedStyle(card);
      const opacity = style.opacity;
      const transform = style.transform;
      parts.forEach((part) => part.cancel());
      host.style.height = `${height}px`;
      card.style.opacity = opacity;
      card.style.transform = transform;
    };
    const resize = () => {
      const next = open ? card.getBoundingClientRect().height + 5 : 0;
      if (Math.abs(next - target) < 0.5) return;
      target = next;
      freeze();
      const height = host.style.height;
      const opacity = card.style.opacity;
      const transform = card.style.transform;
      host.style.visibility = "visible";
      const finish = () => {
        host.style.height = `${next}px`;
        host.style.visibility = open ? "visible" : "hidden";
        card.style.opacity = open ? "1" : "0";
        card.style.transform = open ? "none" : "translateY(-8px)";
        parts.forEach((part) => part.cancel());
        parts = [];
      };
      if (reducedMotion() || (next === 0 && parseFloat(height) === 0)) return finish();
      const timing = {
        duration: open ? 620 : 460,
        easing: "cubic-bezier(.2,.75,.25,1)",
        fill: "both",
      } as const;
      parts = [
        scope.animate(host, [{ height }, { height: `${next}px` }], timing),
        scope.animate(
          card,
          [
            { opacity, transform },
            { opacity: open ? 1 : 0, transform: open ? "none" : "translateY(-8px)" },
          ],
          timing,
        ),
      ];
      parts[0].onfinish = finish;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(card);
    return () => {
      observer.disconnect();
      freeze();
      scope.dispose();
    };
  }, [open, expanded, reducePreference]);
  return (
    <div ref={ref} className="c-result-region" inert={!open} aria-hidden={!open}>
      {children}
    </div>
  );
}
