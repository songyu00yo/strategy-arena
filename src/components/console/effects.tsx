"use client";
import { useEffect, useRef } from "react";

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Letters that settle into place. The text stays exactly as recorded. */
export function Chars({ text, active }: { text: string; active: boolean }) {
  if (!active) return <>{text}</>;
  const glyphs = Array.from(text);
  const step = Math.min(10, 180 / Math.max(glyphs.length, 1));
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {glyphs.map((glyph, i) =>
          glyph === " " ? (
            " "
          ) : (
            <span key={i} className="c-char" style={{ animationDelay: `${i * step}ms` }}>
              {glyph}
            </span>
          ),
        )}
      </span>
    </>
  );
}

/** A number that rolls to its new value. */
export function Roll({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    shown.current = value;
    if (from === value || reducedMotion()) {
      el.textContent = value.toLocaleString();
      return;
    }
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - began) / 360);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (value - from) * eased).toLocaleString();
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.textContent = value.toLocaleString();
    };
  }, [value]);
  return <span ref={ref}>{value.toLocaleString()}</span>;
}
