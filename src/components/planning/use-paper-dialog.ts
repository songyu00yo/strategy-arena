"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { animatePaper, paperCorners, settlePaper } from "./paper-motion";

/** Planning dialogs own motion and focus without freezing the live workspace. */
export function usePaperDialog(options: {
  anchor?: () => HTMLElement | null;
  continuation?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef(options);
  const flight = useRef<(() => void) | null>(null);
  const leaving = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  const layoutFrame = useRef(0);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const close = useCallback((destination?: HTMLElement | null, continuation = false) => {
    if (leaving.current) return;
    leaving.current = true;
    cancelAnimationFrame(layoutFrame.current);
    if (!dialog.current) return latest.current.onClose();
    flight.current = animatePaper(
      dialog.current,
      destination ?? latest.current.anchor?.() ?? origin.current,
      false,
      () => latest.current.onClose(),
      undefined,
      { continuation },
    );
  }, []);
  const reflow = useCallback((update: () => void, focus?: () => void) => {
    const paper = dialog.current;
    if (!paper || leaving.current) return;
    // Capture before React changes the sheet's height. Retarget from this exact
    // pose after layout, including when an incoming flight is still in progress.
    const pose = paperCorners(paper);
    update();
    cancelAnimationFrame(layoutFrame.current);
    layoutFrame.current = requestAnimationFrame(() => {
      if (dialog.current !== paper || leaving.current) return;
      flight.current = animatePaper(paper, null, true, undefined, pose, { continuation: true });
      focus?.();
    });
  }, []);
  useLayoutEffect(() => {
    const paper = dialog.current;
    if (!paper) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    origin.current = before;
    leaving.current = false;
    paper.showModal();
    flight.current = animatePaper(
      paper,
      latest.current.anchor?.() ?? before,
      true,
      undefined,
      undefined,
      { continuation: latest.current.continuation },
    );
    const focusTarget =
      paper.querySelector<HTMLElement>("[data-paper-focus]") ??
      paper.querySelector<HTMLElement>("textarea, input") ??
      paper.querySelector<HTMLElement>("button");
    focusTarget?.focus({ preventScroll: true });
    const settle = () => {
      cancelAnimationFrame(layoutFrame.current);
      settlePaper(paper);
      if (leaving.current) latest.current.onClose();
    };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => {
      if (media.matches) settle();
    };
    addEventListener("resize", settle);
    media.addEventListener("change", preference);
    return () => {
      cancelAnimationFrame(layoutFrame.current);
      flight.current?.();
      paper.close();
      removeEventListener("resize", settle);
      media.removeEventListener("change", preference);
      queueMicrotask(() => {
        if (before?.isConnected && !document.querySelector("dialog[open]"))
          before.focus({ preventScroll: true });
      });
    };
  }, []);
  return { dialog, close, leaving, reflow };
}
