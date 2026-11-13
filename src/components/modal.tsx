"use client";
import { useId, type Ref } from "react";
import { X } from "lucide-react";
import { useOverlayMotion, type OverlayMotionHandle } from "./overlay-motion";
import "./overlay-motion.css";

/** Native dialogs target their paper padding and their backdrop at the dialog itself. */
export function isDialogBackdropClick(
  event: Pick<MouseEvent, "target" | "clientX" | "clientY">,
  dialog: HTMLElement | null | undefined,
) {
  if (!dialog || event.target !== dialog) return false;
  const box = dialog.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  );
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
        if (isDialogBackdropClick(e, panel.current)) close();
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
