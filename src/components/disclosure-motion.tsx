"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { reducedMotion } from "./console/effects";

/** A reversible disclosure: its own interaction clock is independent of story playback. */
export function DisclosureMotion({
  open,
  children,
  id,
  className,
  contentKey,
}: {
  open: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
  contentKey?: string | number;
}) {
  const generatedId = useId();
  const regionId = id ?? generatedId;
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const outer = host.current;
    const inner = content.current;
    if (!outer || !inner) return;
    let animations: Animation[] = [];
    let target = -1;
    let finishCurrent = () => {};
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const freeze = () => {
      const height = outer.getBoundingClientRect().height;
      const style = getComputedStyle(inner);
      const pose = { opacity: style.opacity, transform: style.transform, filter: style.filter };
      animations.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      animations = [];
      outer.style.height = `${height}px`;
      Object.assign(inner.style, pose);
    };
    if (!open && outer.contains(document.activeElement)) {
      document
        .querySelector<HTMLElement>(`[aria-controls="${CSS.escape(regionId)}"]`)
        ?.focus({ preventScroll: true });
    }
    const resize = () => {
      const next = open ? inner.offsetHeight : 0;
      if (Math.abs(target - next) < 0.5) return;
      // An auto-sized host has already followed the new content by the time ResizeObserver runs.
      // Restore the last settled height before measuring the start pose of a phase/line-wrap change.
      if (open && outer.style.height === "auto" && target >= 0) outer.style.height = `${target}px`;
      target = next;
      freeze();
      outer.style.visibility = "visible";
      const settle = () => {
        outer.style.height = open ? "auto" : "0px";
        outer.style.visibility = open ? "visible" : "hidden";
        Object.assign(inner.style, {
          opacity: open ? "1" : "0",
          transform: open ? "none" : "translateY(-14px) scale(.98)",
          filter: open ? "none" : "blur(3px)",
        });
        animations.forEach((animation) => animation.cancel());
        animations = [];
      };
      finishCurrent = settle;
      if (reducedMotion() || (next === 0 && parseFloat(outer.style.height) === 0)) return settle();
      const timing = {
        duration: open ? 560 : 420,
        easing: open ? "cubic-bezier(.16,1,.3,1)" : "cubic-bezier(.4,0,.2,1)",
        fill: "both",
      } as const;
      animations = [
        outer.animate([{ height: outer.style.height }, { height: `${next}px` }], timing),
        inner.animate(
          [
            {
              opacity: inner.style.opacity,
              transform: inner.style.transform,
              filter: inner.style.filter,
            },
            {
              opacity: open ? 1 : 0,
              transform: open ? "none" : "translateY(-14px) scale(.98)",
              filter: open ? "none" : "blur(3px)",
            },
          ],
          timing,
        ),
      ];
      animations[0].onfinish = settle;
    };
    resize();
    const onPreference = () => {
      if (media.matches) finishCurrent();
    };
    media.addEventListener("change", onPreference);
    const observer = new ResizeObserver(resize);
    observer.observe(inner);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onPreference);
      freeze();
    };
  }, [open, regionId]);
  return (
    <div
      id={regionId}
      ref={host}
      className={className}
      inert={!open}
      aria-hidden={!open}
      style={{ height: 0, overflow: "clip", visibility: "hidden" }}
    >
      <div
        ref={content}
        style={{ display: "flow-root", opacity: 0, transformOrigin: "top center" }}
      >
        {contentKey === undefined ? (
          children
        ) : (
          <TransitionContents contentKey={contentKey}>{children}</TransitionContents>
        )}
      </div>
    </div>
  );
}

/** Exit the previous phase before mounting the next one; ordinary input edits keep their DOM. */
function TransitionContents({
  contentKey,
  children,
}: {
  contentKey: string | number;
  children: ReactNode;
}) {
  const [shown, setShown] = useState({ key: contentKey, children });
  // Remember the latest controlled fields without changing the phase or replaying its entrance.
  if (shown.key === contentKey && shown.children !== children)
    setShown({ key: contentKey, children });
  const node = useRef<HTMLDivElement>(null);
  const requested = useRef({ key: contentKey, children });
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    requested.current = { key: contentKey, children };
  });
  useLayoutEffect(() => {
    const el = node.current;
    if (!el || shown.key === contentKey) return;
    const style = getComputedStyle(el);
    const start = { opacity: style.opacity, transform: style.transform };
    animation.current?.cancel();
    el.inert = true;
    let disposed = false;
    const arrive = () => {
      if (disposed) return;
      animation.current?.cancel();
      animation.current = null;
      setShown(requested.current);
    };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const onPreference = () => {
      if (media.matches) arrive();
    };
    if (media.matches) queueMicrotask(arrive);
    else {
      animation.current = el.animate(
        [start, { opacity: 0, transform: "translateY(-12px) scale(.985)" }],
        { duration: 180, easing: "cubic-bezier(.4,0,.2,1)", fill: "both" },
      );
      animation.current.onfinish = arrive;
    }
    media.addEventListener("change", onPreference);
    return () => {
      disposed = true;
      media.removeEventListener("change", onPreference);
      animation.current?.cancel();
      animation.current = null;
    };
  }, [contentKey, shown.key]);
  useLayoutEffect(() => {
    const el = node.current;
    if (!el || shown.key !== requested.current.key) return;
    el.inert = false;
    el.querySelector<HTMLElement>("[data-disclosure-autofocus]")?.focus({ preventScroll: true });
    if (reducedMotion()) return;
    const enter = el.animate(
      [
        { opacity: 0, transform: "translateY(16px) scale(.985)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 380, easing: "cubic-bezier(.16,1,.3,1)" },
    );
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const onPreference = () => {
      if (media.matches) enter.cancel();
    };
    media.addEventListener("change", onPreference);
    return () => {
      media.removeEventListener("change", onPreference);
      enter.cancel();
    };
  }, [shown.key]);
  return <div ref={node}>{shown.children}</div>;
}
