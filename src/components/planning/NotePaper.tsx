"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { PlanningController } from "../use-planning";
import { agentPaperAnchor } from "./paper-motion";
import { usePaperDialog } from "./use-paper-dialog";

export function NotePaper({
  controller,
  itemIds = [],
  onClose,
}: {
  controller: PlanningController;
  itemIds?: string[];
  onClose: () => void;
}) {
  const id = useId();
  const key = `strategy-arena:planning:note:${controller.snapshot!.session.id}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState<{ text: string; cursor: number } | null>(null);
  const submitting = useRef(false);
  const { dialog, close, leaving } = usePaperDialog({ onClose });
  const saved =
    !!attempt &&
    controller.arrivals.some(
      (event) =>
        event.kind === "note_saved" && event.seq > attempt.cursor && event.detail === attempt.text,
    );
  const busy = saving || controller.pendingAction !== null;
  useEffect(() => {
    if (!saved) return;
    try {
      sessionStorage.removeItem(key);
    } catch {}
    const timer = setTimeout(() => close(agentPaperAnchor("A"), true), 220);
    return () => clearTimeout(timer);
  }, [saved, key, close]);
  const submit = async () => {
    if (
      !text.trim() ||
      submitting.current ||
      busy ||
      saved ||
      leaving.current ||
      controller.unknownRequest ||
      !controller.snapshot!.session.capabilities.canAddNote
    )
      return;
    submitting.current = true;
    setSaving(true);
    setAttempt({ text: text.trim(), cursor: controller.snapshot!.eventCursor });
    try {
      await controller.act({ kind: "note", text: text.trim(), itemIds });
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className={`p-paper p-note-paper ${saved ? "is-receipt" : ""}`}
      aria-labelledby={`${id}-${saved ? "saved" : "title"}`}
      aria-busy={busy && !saved}
      onCancel={(event) => {
        event.preventDefault();
        if (!saved) close();
      }}
    >
      <header className="p-paper-top">
        <div>
          <span className="p-paper-number">补充需求</span>
          <span>你 → A</span>
        </div>
        <button type="button" aria-label="收起补充" disabled={saved} onClick={() => close()}>
          <X size={18} />
        </button>
      </header>
      <div className="p-paper-content">
        <form
          style={saved ? { visibility: "hidden" } : undefined}
          aria-hidden={saved || undefined}
          inert={saved}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <div className="p-paper-body">
            <h2 id={`${id}-title`}>补充或修改要求</h2>
            {itemIds.length > 0 && (
              <p className="p-note-context">
                {controller
                  .snapshot!.session.items.filter((item) => itemIds.includes(item.id))
                  .map((item) => item.title)
                  .join("、")}
              </p>
            )}
            <label className="p-own-answer">
              <span id={`${id}-text-label`}>补充内容</span>
              <textarea
                aria-labelledby={`${id}-text-label`}
                data-paper-focus
                rows={6}
                maxLength={6000}
                value={text}
                disabled={busy || saved || controller.unknownRequest}
                onChange={(event) => {
                  setText(event.target.value);
                  try {
                    sessionStorage.setItem(key, event.target.value);
                  } catch {}
                }}
                placeholder="补充限制、纠正理解，或调整方向"
              />
            </label>
            {controller.error && (
              <p role="alert" className="p-inline-error">
                {controller.error}
              </p>
            )}
          </div>
          <footer className="p-paper-bottom">
            {controller.unknownRequest ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void controller.retryUnknown()}
              >
                <RefreshCw size={14} />
                核对保存状态
              </button>
            ) : (
              <button
                type="submit"
                className="primary-button"
                disabled={
                  !text.trim() || busy || !controller.snapshot!.session.capabilities.canAddNote
                }
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
                {busy ? "保存中" : "保存补充"}
              </button>
            )}
            <span className="p-answer-status" role="status">
              {controller.unknownRequest ? "保存结果待核对，文字已保留。" : "⌘ / Ctrl + Enter 保存"}
            </span>
          </footer>
        </form>
        {saved && (
          <div className="p-receipt-content is-compact" role="status">
            <Check size={20} />
            <h2 id={`${id}-saved`}>补充已保存</h2>
            <p>接下来会根据你的补充更新分析。</p>
          </div>
        )}
      </div>
    </dialog>
  );
}
