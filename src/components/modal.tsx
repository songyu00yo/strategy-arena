"use client";
import { useId, type Ref } from "react";
import { X } from "lucide-react";
import { useOverlayMotion, type OverlayMotionHandle } from "./overlay-motion";
import "./overlay-motion.css";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  motionRef,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  motionRef?: Ref<OverlayMotionHandle>;
}) {
  const titleId = useId();
  const { panel, close } = useOverlayMotion<HTMLDialogElement>("modal", onClose, motionRef);
  return (
    <dialog
      ref={panel}
      className={`modal overlay-motion ${wide ? "wide-modal" : ""}`}
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
