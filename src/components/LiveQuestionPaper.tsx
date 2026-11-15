"use client";

import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { X } from "lucide-react";
import { isDialogBackdropClick } from "./modal";
import type { OverlayMotionHandle } from "./overlay-motion";
import { animateLivePaper, liveAnchor, LIVE_PAPER_TIMING } from "./live-paper-motion";

/** The original editable children stay mounted throughout their spatial handoff. */
export function LiveQuestionPaper({
  title,
  children,
  onClose,
  onDismiss,
  trigger,
  motionRef,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onDismiss?: () => void;
  trigger?: HTMLElement | null;
  motionRef?: Ref<OverlayMotionHandle>;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const latestClose = useRef(onClose);
  const cleanup = useRef<(preservePose?: boolean) => void>(() => {});
  const initialTrigger = useRef(trigger);
  const latestDismiss = useRef(onDismiss);
  const closing = useRef(false);
  useLayoutEffect(() => {
    latestClose.current = onClose;
    latestDismiss.current = onDismiss;
  }, [onClose, onDismiss]);
  const close = (after?: () => void) => {
    const node = panel.current;
    if (!node || closing.current) return false;
    closing.current = true;
    latestDismiss.current?.();
    cleanup.current(true);
    cleanup.current = animateLivePaper(
      node,
      liveAnchor("agent-B"),
      LIVE_PAPER_TIMING.answer,
      () => {
        node.close();
        (after ?? latestClose.current)();
      },
      true,
    );
    return true;
  };
  useImperativeHandle(motionRef, () => ({ close, replace: (after) => close(after) }));
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const previous =
      initialTrigger.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    node.showModal();
    node.querySelector<HTMLElement>("[data-overlay-autofocus]")?.focus({ preventScroll: true });
    const duration =
      LIVE_PAPER_TIMING.cue +
      LIVE_PAPER_TIMING.shape +
      LIVE_PAPER_TIMING.transfer +
      LIVE_PAPER_TIMING.receive +
      LIVE_PAPER_TIMING.reveal;
    cleanup.current = animateLivePaper(node, liveAnchor("agent-B"), duration);
    return () => {
      cleanup.current();
      node.close();
      const focusTarget =
        previous?.isConnected && previous.getClientRects().length
          ? previous
          : document.querySelector<HTMLElement>("[data-open-live-questions]");
      if (focusTarget && !focusTarget.closest("[inert]"))
        focusTarget.focus({ preventScroll: true });
    };
  }, []); // The paper owns a single opening, independent of polling and editable input.
  return (
    <dialog
      ref={panel}
      className="modal live-question-paper"
      aria-label={title}
      data-motion-anchor="question-paper"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (isDialogBackdropClick(event, panel.current)) close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={() => close()}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
