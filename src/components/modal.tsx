"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { leaveAs } from "@/components/console/effects";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null); // The dialog must be measured before it unmounts, so this runs ahead of the effect below.
  useLayoutEffect(() => {
    const el = ref.current;
    return () =>
      leaveAs(
        el,
        [
          { transform: "none", opacity: 1 },
          { transform: "translateY(18px) scale(.93)", opacity: 0 },
        ],
        { duration: 230, backdrop: "rgb(11 13 16 / 0.34)" },
      );
  }, []);
  useEffect(() => {
    const el = ref.current;
    // The dialog unmounts before it closes, so the browser cannot restore focus by itself.
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
      el?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide-modal" : ""}`}
      aria-labelledby="modal-title"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id="modal-title">{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
