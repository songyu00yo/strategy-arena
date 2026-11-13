"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { createMotionScope, acquireMotionHold } from "./console/motion-runtime";
import { acquireOverlayScrollLock } from "./overlay-handoff";
import "./access-gate.css";

const EASE = "cubic-bezier(.19,1,.22,1)";

/**
 * The invited-preview gate is an admission ticket laid over the page. It slides in and
 * straightens; a right code gets a vermilion stamp pressed onto it, then the ticket is
 * taken away and the paper veil lifts. A wrong code shakes it once.
 */
export function AccessGate({
  open,
  busy,
  error,
  onUnlock,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onUnlock: (code: string) => Promise<boolean>;
}) {
  const [shown, setShown] = useState(open);
  const [code, setCode] = useState("");
  const layer = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const first = useRef(true);
  const stamp = useRef<HTMLSpanElement>(null);

  if (open && !shown) setShown(true);

  useLayoutEffect(() => {
    if (!shown) {
      first.current = true;
      return;
    }
    const veil = layer.current;
    const panel = card.current;
    if (!veil || !panel) return;
    const scope = createMotionScope("interaction");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const panelStyle = getComputedStyle(panel);
    const veilOpacity = first.current ? "0" : getComputedStyle(veil).opacity;
    const from = first.current
      ? { opacity: "0", transform: "translateY(16px) rotate(.6deg)" }
      : { opacity: panelStyle.opacity, transform: panelStyle.transform };
    first.current = false;
    if (reduced) {
      veil.style.opacity = open ? "1" : "0";
      panel.style.opacity = open ? "1" : "0";
      panel.style.transform = "none";
      if (!open) scope.later(0, () => setShown(false));
    } else {
      if (!open && stamp.current)
        scope.animate(
          stamp.current,
          [
            { opacity: 0, transform: "rotate(-14deg) scale(1.3)" },
            { opacity: 1, transform: "rotate(-10deg) scale(1)" },
          ],
          { duration: 140, easing: EASE, fill: "forwards" },
        );
      scope.animate(
        panel,
        [
          from,
          { opacity: open ? 1 : 0, transform: open ? "none" : "translateY(-12px) scale(.985)" },
        ],
        {
          duration: open ? 360 : 240,
          easing: EASE,
          fill: "both",
        },
      );
      const clear = scope.animate(veil, [{ opacity: veilOpacity }, { opacity: open ? 1 : 0 }], {
        duration: open ? 260 : 240,
        easing: EASE,
        fill: "both",
      });
      if (!open) clear.onfinish = () => setShown(false);
    }
    if (open) scope.later(80, () => input.current?.focus({ preventScroll: true }));
    return () => {
      const visiblePanel = getComputedStyle(panel);
      const visibleVeil = getComputedStyle(veil);
      const pose = { transform: visiblePanel.transform, opacity: visiblePanel.opacity };
      const opacity = visibleVeil.opacity;
      scope.dispose();
      Object.assign(panel.style, pose);
      veil.style.opacity = opacity;
    };
  }, [shown, open]);

  useLayoutEffect(() => {
    if (!shown) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const releaseMotion = acquireMotionHold();
    const releaseScroll = acquireOverlayScrollLock();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const fields = [
        ...(card.current?.querySelectorAll<HTMLElement>(
          "input:not(:disabled),button:not(:disabled)",
        ) ?? []),
      ];
      if (!fields.length) return;
      const first = fields[0];
      const last = fields[fields.length - 1];
      if (
        !card.current?.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    };
    addEventListener("keydown", trap);
    return () => {
      removeEventListener("keydown", trap);
      releaseScroll();
      releaseMotion();
      if (
        previousFocus?.isConnected &&
        !document.querySelector('dialog[open], [aria-modal="true"]')
      )
        previousFocus.focus({ preventScroll: true });
    };
  }, [shown]);

  useEffect(() => {
    if (!error || !open || !card.current) return;
    input.current?.select();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const scope = createMotionScope("interaction");
    scope.animate(
      card.current,
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-4px)" },
        { transform: "translateX(3px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 180, easing: EASE, composite: "add" },
    );
    return () => scope.dispose();
  }, [error, open]);

  if (!shown || typeof document === "undefined") return null;
  return createPortal(
    <div ref={layer} className="access-gate" data-leaving={!open || undefined}>
      <form
        ref={card}
        className="access-gate-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-gate-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !open) return;
          if (await onUnlock(code)) setCode("");
        }}
      >
        <div className="access-gate-stub" aria-hidden="true">
          <span className="access-gate-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>方案擂台</strong>
          <small>ADMIT ONE</small>
        </div>
        <div className="access-gate-main">
          <span className="access-gate-eyebrow">受邀预览 · 入场券</span>
          <h2 id="access-gate-title">凭码入场</h2>
          <p>输入运行者提供的访问码后，就可以开始推演。</p>
          <label className="sr-only" htmlFor="access-code">
            访问码
          </label>
          <div className="access-gate-field" data-invalid={(!!error && open) || undefined}>
            <input
              ref={input}
              id="access-code"
              type="password"
              autoComplete="off"
              placeholder="输入访问码"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={!open}
              required
            />
            <button type="submit" className="access-gate-submit" disabled={busy || !open}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}
              <span>{busy ? "验证中…" : "验证访问码"}</span>
            </button>
          </div>
          <p className="access-gate-error" role="alert">
            {open ? error : ""}
          </p>
        </div>
        <span ref={stamp} className="access-gate-stamp" aria-hidden="true">
          准入
        </span>
      </form>
    </div>,
    document.body,
  );
}
