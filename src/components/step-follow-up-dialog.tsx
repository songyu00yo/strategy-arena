"use client";

import { useId, useRef, useState } from "react";
import type { ArenaVersion } from "@/lib/contracts";
import type { StepContext } from "@/lib/step-context";
import { DisclosureMotion } from "./disclosure-motion";
import { Modal } from "./modal";
import type { OverlayMotionHandle } from "./overlay-motion";
import "./step-follow-up-dialog.css";

export interface StepFollowUpDialogProps {
  version: ArenaVersion;
  context: StepContext;
  trigger: HTMLElement | null;
  pending: boolean;
  error?: string;
  disabled?: boolean;
  demo?: boolean;
  onClose: () => void;
  onSubmit: (text: string) => Promise<boolean>;
  onAdjustConditions?: () => void;
}

export function StepFollowUpDialog({
  version,
  context,
  trigger,
  pending,
  error,
  disabled = false,
  demo = false,
  onClose,
  onSubmit,
  onAdjustConditions,
}: StepFollowUpDialogProps) {
  const quoteId = useId();
  const [showQuote, setShowQuote] = useState(false);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState("");
  const motion = useRef<OverlayMotionHandle>(null);
  const submitting = useRef(false);
  const close = () => {
    if (!motion.current?.close()) onClose();
  };
  return (
    <Modal title="补充这一步" trigger={trigger} onClose={onClose} motionRef={motion} side>
      <form
        className="step-follow-up"
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmed = text.trim();
          if (
            pending ||
            disabled ||
            submitting.current ||
            trimmed.length < 3 ||
            trimmed.length > 1000
          )
            return;
          submitting.current = true;
          setFailure("");
          try {
            if (await onSubmit(trimmed)) close();
          } catch (cause) {
            setFailure(
              cause instanceof Error ? cause.message : "这次没有提交成功，请保留补充内容后重试。",
            );
          } finally {
            submitting.current = false;
          }
        }}
      >
        <div className="step-follow-up-source">
          <div className="step-follow-up-source-row">
            <span title={`V${version.number} · ${context.title}`}>
              V{version.number} · {context.title.split(" · ")[0]}
            </span>
            <button
              type="button"
              className="text-button"
              aria-expanded={showQuote}
              aria-controls={quoteId}
              onClick={() => setShowQuote(!showQuote)}
            >
              {showQuote ? "收起原文" : "查看原文"}
            </button>
          </div>
          <DisclosureMotion open={showQuote} id={quoteId}>
            <blockquote>{context.quote}</blockquote>
          </DisclosureMotion>
        </div>
        <label className="field">
          <span>补充或质疑</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            minLength={3}
            maxLength={1000}
            required
            rows={3}
            data-overlay-autofocus
            readOnly={pending}
            placeholder="这里漏了什么条件，或哪一点你不认同？"
          />
        </label>
        {onAdjustConditions && (
          <p className="step-follow-up-shortcuts">
            <button
              type="button"
              className="text-button"
              disabled={pending}
              onClick={() => {
                const handoff = () => {
                  onClose();
                  onAdjustConditions();
                };
                if (!motion.current?.close(handoff)) handoff();
              }}
            >
              调整条件
            </button>
          </p>
        )}
        <p className="step-follow-up-notice">
          {demo
            ? "演示只播放预设内容，不调用模型、不计费。"
            : "确认后新建真实推演并计费，原记录保留。"}
        </p>
        {(error || failure) && (
          <p className="step-follow-up-error" role="alert">
            {error || failure}
          </p>
        )}
        <div className="step-follow-up-actions">
          <button type="button" className="text-button" onClick={close}>
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={pending || disabled || text.trim().length < 3 || text.trim().length > 1000}
          >
            {pending ? "正在创建新版本…" : "补充后重新推演"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
