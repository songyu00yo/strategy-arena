"use client";
import { useId, useLayoutEffect, type Ref, type RefObject } from "react";
import { X } from "lucide-react";
import { useOverlayMotion, type OverlayMotionHandle } from "./overlay-motion";
import "./overlay-motion.css";
/** Content that appears or disappears inside an open dialog glides the dialog to its new
 * height instead of snapping. Small continuous changes (dragging a textarea handle) pass
 * straight through. */
function useSmoothHeight(panel: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let last = el.offsetHeight;
    let flight: Animation | null = null;
    const observer = new ResizeObserver(() => {
      if (flight) return;
      const next = el.offsetHeight;
      const from = last;
      last = next;
      if (!from || !next || Math.abs(next - from) < 8 || reduced.matches) return;
      flight = el.animate(
        [
          { height: `${from}px`, overflow: "clip" },
          { height: `${next}px`, overflow: "clip" },
        ],
        { duration: 520, easing: "cubic-bezier(.19,1,.22,1)" },
      );
      const settle = () => {
        flight = null;
        last = el.offsetHeight;
      };
      flight.onfinish = settle;
      flight.oncancel = settle;
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      flight?.cancel();
    };
  }, [panel]);
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  side = false,
  motionRef,
  trigger,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  side?: boolean;
  motionRef?: Ref<OverlayMotionHandle>;
  trigger?: HTMLElement | null;
}) {
  const titleId = useId();
  const { panel, close } = useOverlayMotion<HTMLDialogElement>(
    "modal",
    onClose,
    motionRef,
    trigger,
  );
  useSmoothHeight(panel);
  return (
    <dialog
      ref={panel}
      className={`modal overlay-motion ${wide ? "wide-modal" : ""} ${side ? "modal-side" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === panel.current) close();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={() => close()}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
