"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, LoaderCircle } from "lucide-react";
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
  const leaving = useRef(false);
  const stamp = useRef<HTMLSpanElement>(null);

  if (open && !shown) setShown(true);

  // Arrive: the veil fades in, the card rises out of a soft blur.
  useLayoutEffect(() => {
    if (!shown || !open) return;
    leaving.current = false;
    const veil = layer.current;
    const panel = card.current;
    if (!veil || !panel) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animations = reduced
      ? []
      : [
          veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: "ease" }),
          panel.animate(
            [
              { opacity: 0, transform: "translateY(48px) rotate(2deg)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 1000, delay: 120, easing: EASE, fill: "backwards" },
          ),
        ];
    const focus = setTimeout(() => input.current?.focus({ preventScroll: true }), 260);
    return () => {
      clearTimeout(focus);
      animations.forEach((animation) => animation.cancel());
    };
  }, [shown, open]);

  // Leave: the card lifts and dissolves, then the veil and its blur clear.
  useEffect(() => {
    if (open || !shown || leaving.current) return;
    leaving.current = true;
    const veil = layer.current;
    const panel = card.current;
    if (!veil || !panel || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(false);
      return;
    }
    const seal = stamp.current;
    seal?.animate(
      [
        { opacity: 0, transform: "rotate(-14deg) scale(2.3)" },
        { opacity: 1, transform: "rotate(-10deg) scale(0.94)", offset: 0.62 },
        { opacity: 1, transform: "rotate(-10deg) scale(1)" },
      ],
      { duration: 460, easing: "cubic-bezier(.5,0,.75,0)", fill: "forwards" },
    );
    // The press of the stamp nudges the ticket, then the ticket is taken away.
    panel.animate(
      [
        { transform: "none", offset: 0 },
        { transform: "translateY(2px) scale(.995)", offset: 0.28 },
        { transform: "none", offset: 0.4 },
        { transform: "none", opacity: 1, offset: 0.55 },
        { transform: "translateY(-46px) rotate(-1.5deg)", opacity: 0 },
      ],
      { duration: 1500, easing: "cubic-bezier(.6,0,.2,1)", fill: "forwards" },
    );
    const clear = veil.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 700,
      delay: 1000,
      easing: "cubic-bezier(.4,0,.2,1)",
      fill: "forwards",
    });
    clear.onfinish = () => setShown(false);
  }, [open, shown]);

  // A refused code: one damped shake, the input stays selected for retyping.
  useEffect(() => {
    if (!error || !open || !card.current) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    card.current.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-10px)" },
        { transform: "translateX(8px)" },
        { transform: "translateX(-5px)" },
        { transform: "translateX(2px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 520, easing: "cubic-bezier(.36,.07,.19,.97)" },
    );
    input.current?.select();
  }, [error, open]);

  if (!shown || typeof document === "undefined") return null;
  return createPortal(
    <div ref={layer} className="access-gate" data-leaving={!open || undefined}>
      <form
        ref={card}
        className="access-gate-card"
        role="dialog"
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
