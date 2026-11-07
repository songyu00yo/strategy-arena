"use client";

import { useEffect, useRef, useState } from "react";
import {
  CreateArenaRequestSchema,
  ModelModeSchema,
  type ArenaSnapshot,
  type ArenaVersion,
  type Challenge,
  type ModelMode,
} from "@/lib/contracts";
import type { RecordedExample } from "@/lib/recorded-examples";
import { stepContext } from "@/lib/step-context";
import { routeModel } from "@/lib/model-routing";
import type { Health } from "./use-arena";
import { ConditionEditor } from "./condition-editor";
import { Modal } from "./modal";
import type { OverlayMotionHandle } from "./overlay-motion";
import "./recorded-challenge.css";

export function RecordedConditionEditor({
  metadata,
  version,
  trigger,
  onClose,
}: {
  metadata: RecordedExample;
  version: ArenaVersion;
  trigger: HTMLElement | null;
  onClose: () => void;
}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const initialMode = ModelModeSchema.safeParse(
    version.modelSelection?.requestedMode ?? metadata.modelId,
  );
  const mode: ModelMode = initialMode.success ? initialMode.data : "auto";
  const motion = useRef<OverlayMotionHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const live = useRef(false);
  const locked = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const cancelRequests = () => {
    live.current = false;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
  };
  const close = () => {
    cancelRequests();
    onClose();
  };
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    controllers.current.add(controller);
    void fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("health unavailable");
        const value = (await response.json()) as Health;
        if (!value.model || typeof value.model.configured !== "boolean")
          throw new Error("invalid health");
        if (live.current && !controller.signal.aborted) setHealth(value);
      })
      .catch(() => {
        if (live.current && !controller.signal.aborted)
          setHealthError("暂时无法检查模型配置，请关闭后重试。");
      })
      .finally(() => controllers.current.delete(controller));
    const dialog = root.current?.closest("dialog");
    const cancel = (event: Event) => {
      if (
        event.type === "cancel" ||
        event.target === dialog ||
        (event.target instanceof Element && event.target.closest('button[aria-label="关闭弹窗"]'))
      )
        cancelRequests();
    };
    dialog?.addEventListener("click", cancel, true);
    dialog?.addEventListener("cancel", cancel, true);
    return () => {
      cancelRequests();
      dialog?.removeEventListener("click", cancel, true);
      dialog?.removeEventListener("cancel", cancel, true);
    };
  }, []);
  const blocked =
    healthError ||
    (!health
      ? "正在检查模型配置…"
      : health.requiresAccessCode && !health.accessGranted
        ? "请先返回首页输入访问口令，再开始真实推演。"
        : "");
  async function submit(challenge: Challenge, reason: string, selectedMode: ModelMode) {
    if (!live.current || locked.current || blocked || !health) return;
    const oldVerdict = stepContext(version, "judge");
    const materials = `${challenge.materials}\n\n--- 历史案例来源，旧模型意见待复核 ---\n来源案例：${metadata.slug}\n原版本：${version.id}（V${version.number}）\n来源提交：${metadata.sourceCommit}\n本次条件变化：${reason}\n以下是旧模型意见，不是已证实事实；请按本次条件重新判断。${oldVerdict ? `\n${oldVerdict.title}\n${oldVerdict.quote}` : "\n原记录没有完整裁决。"}`;
    const prepared = CreateArenaRequestSchema.safeParse({
      ...challenge,
      materials,
      modelMode: selectedMode,
    });
    if (!prepared.success) {
      setError("修改后的条件与来源记录合并后超过输入限制，请缩短材料后重试；原文不会自动截断。");
      return;
    }
    const route = routeModel(prepared.data, selectedMode);
    const options = health.model.models ?? health.model.providers;
    const available =
      options?.find((item) => item.id === route.modelId) ??
      options?.find((item) => item.provider === route.provider);
    if (
      available
        ? !available.configured
        : !(health.model.id === route.modelId && health.model.configured)
    ) {
      setError("所选模型尚未配置，请选择已配置的模型。");
      return;
    }
    locked.current = true;
    setPending(true);
    setError("");
    const controller = new AbortController();
    controllers.current.add(controller);
    let handedOff = false;
    try {
      const response = await fetch("/api/arenas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.data),
        signal: controller.signal,
      });
      const snapshot = (await response.json()) as ArenaSnapshot & { error?: string };
      if (!live.current || controller.signal.aborted) return;
      if (!response.ok) throw new Error(snapshot.error || "未能创建真实推演，请稍后重试。");
      if (typeof snapshot.id !== "string" || !snapshot.id)
        throw new Error("服务未返回可打开的推演记录。");
      try {
        localStorage.setItem("strategy-arena:last-id", snapshot.id);
      } catch {
        /* The URL also restores the arena. */
      }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/?arena=${encodeURIComponent(snapshot.id)}`);
      handedOff = true;
    } catch (failure) {
      if (live.current && !controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "未能创建真实推演，请稍后重试。");
    } finally {
      controllers.current.delete(controller);
      if (live.current && !controller.signal.aborted && !handedOff) {
        locked.current = false;
        setPending(false);
      }
    }
  }
  return (
    <Modal title="调整条件" trigger={trigger} onClose={close} motionRef={motion} side>
      <div ref={root} className="recorded-challenge">
        {(blocked || error) && (
          <p className="recorded-challenge-error" role="alert">
            {error || blocked}
          </p>
        )}
        <ConditionEditor
          initial={version.challenge}
          initialModelMode={mode}
          modelProviders={health?.model.models ?? health?.model.providers}
          pending={pending}
          disabled={!!blocked}
          demo={false}
          onCancel={() => {
            cancelRequests();
            if (!motion.current?.close()) close();
          }}
          onSubmit={(challenge, reason, selectedMode) =>
            void submit(challenge, reason, selectedMode)
          }
        />
      </div>
    </Modal>
  );
}
