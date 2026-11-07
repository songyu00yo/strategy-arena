"use client";

import { useRef, useState } from "react";
import type { ArenaVersion } from "@/lib/contracts";
import type { StepContext } from "@/lib/step-context";
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
  const [text, setText] = useState("");
  const [failure, setFailure] = useState("");
  const motion = useRef<OverlayMotionHandle>(null);
  const submitting = useRef(false);
  const close = () => {
    if (!motion.current?.close()) onClose();
  };
  return (
    <Modal title="补充这一步" trigger={trigger} onClose={onClose} motionRef={motion}>
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
          <span>
            V{version.number} · {context.title}
          </span>
          <blockquote>{context.quote}</blockquote>
        </div>
        <label className="field">
          <span>你想补充什么，或对哪里有疑问？</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            minLength={3}
            maxLength={1000}
            required
            rows={4}
            readOnly={pending}
            placeholder="例如：这里漏算了交通时间；我更在意稳定性；这条证据能说明什么？"
          />
        </label>
        {onAdjustConditions && (
          <p className="step-follow-up-shortcuts">
            预算、时间或偏好变了？
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
            ? "演示中的内容和用量均为预设。提交只开启一轮预设播放，不调用模型、不计费。"
            : "提交后会从头推演一个新版本，并产生模型费用。这条记录和旧版本会保留，补充内容会作为待复核意见。"}
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
