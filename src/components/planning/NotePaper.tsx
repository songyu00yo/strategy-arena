"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, X } from "lucide-react";
import type { PlanningController } from "../use-planning";
import { acquireMotionHold } from "../console/motion-runtime";
import { animatePaper } from "./paper-motion";

export function NotePaper({
  controller,
  itemIds = [],
  onClose,
}: {
  controller: PlanningController;
  itemIds?: string[];
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const key = `strategy-arena:planning:note:${controller.snapshot!.session.id}`;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const value = sessionStorage.getItem(key);
        if (value) setText(value);
      } catch {}
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = acquireMotionHold();
    el.showModal();
    const cleanup = animatePaper(el, previous, true);
    el.querySelector("textarea")?.focus({ preventScroll: true });
    return () => {
      cleanup();
      release();
      el.close();
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      });
    };
  }, []);
  const submit = async () => {
    if (!text.trim()) return;
    const result = await controller.act({ kind: "note", text: text.trim(), itemIds });
    if (result) {
      try {
        sessionStorage.removeItem(key);
      } catch {}
      onClose();
    }
  };
  return (
    <dialog
      ref={dialog}
      className="p-paper p-note-paper"
      aria-labelledby="planning-note-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="p-paper-top">
        <div>
          <span className="p-paper-number">你的补充</span>
          <span>你 → 工作台</span>
        </div>
        <button type="button" aria-label="收起补充" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="p-paper-body">
          <p className="p-eyebrow">随时改主意，也随时追问</p>
          <h2 id="planning-note-title">还有一件事。</h2>
          <p className="p-question-reason">补充限制、指出误解，或说说你想换一个方向的原因。</p>
          {itemIds.length > 0 && (
            <p>
              关于：
              {controller
                .snapshot!.session.items.filter((item) => itemIds.includes(item.id))
                .map((item) => item.title)
                .join("、")}
            </p>
          )}
          <label className="p-own-answer">
            <span>想让大家知道的事</span>
            <textarea
              rows={7}
              maxLength={6000}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                try {
                  sessionStorage.setItem(key, event.target.value);
                } catch {}
              }}
              placeholder="这里没理解对，我其实更在意……"
            />
          </label>
          {controller.error && (
            <p role="alert" className="p-inline-error">
              {controller.error}
            </p>
          )}
        </div>
        <footer className="p-paper-bottom">
          <button
            type="submit"
            className="primary-button"
            disabled={
              !text.trim() ||
              !!controller.pendingAction ||
              !controller.snapshot!.session.capabilities.canAddNote
            }
          >
            {controller.pendingAction === "note" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ArrowUpRight size={16} />
            )}
            把补充递进去
          </button>
        </footer>
      </form>
    </dialog>
  );
}
