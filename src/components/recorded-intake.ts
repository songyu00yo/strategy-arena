"use client";

import type { ArenaVersion, ModelMode } from "@/lib/contracts";
import type { IntakeDraft } from "@/lib/intake-contracts";
import type { RecordedExample } from "@/lib/recorded-examples";
import { clearExamplePickerRequest } from "@/lib/example-navigation";
import { readIntakeDraftPointer, saveIntakeDraftPointer } from "./intake-draft-pointer";

/** Create a user-owned draft. Historical simulated answers and model text remain reference material. */
export async function prepareRecordedIntake({
  goal,
  modelMode,
  metadata,
  version,
  quote = "",
  materials = "",
  signal,
}: {
  goal: string;
  modelMode: ModelMode;
  metadata: RecordedExample;
  version: ArenaVersion;
  quote?: string;
  materials?: string;
  signal: AbortSignal;
}): Promise<IntakeDraft> {
  if (goal.trim().length < 2) throw new Error("请先写下你自己的目标或补充要求。");
  if (goal.length > 3000)
    throw new Error("本次目标与条件超过3000字，请在原输入中精简后再提交；内容会保留。");
  const reference = [
    "# 示例参考，待本人核对",
    "本文件仅供参考。示例中的模拟回答、确认和模型建议均不代表本次用户已经选择或授权。",
    `案例 ${metadata.slug}`,
    `来源提交 ${metadata.sourceCommits?.join(" → ") || metadata.sourceCommit}`,
    `原记录 V${version.number}（${version.id}）`,
    metadata.caseType === "simulated_real_model"
      ? `原案例回答由${metadata.simulationActor ?? "模拟答题方"}模拟提交，模型输出来自真实调用；没有真实执行反馈。`
      : "原模型意见需要按本次目标重新核对。",
    "## 原始目标",
    version.intake?.originalGoal ?? version.challenge.goal,
    "## 旧记录中的需求说明，仅作参考",
    version.clarification?.specification ?? "未记录需求说明。",
    "## 旧步骤引用，仅作参考",
    quote || "本次从条件调整入口创建草稿。",
    "## 补充材料，仅作资料",
    materials || "未补充文字材料。",
  ].join("\n\n");
  const file = new File([reference], "示例参考-待核对.md", { type: "text/markdown" });
  if (file.size > 10 * 1024 * 1024)
    throw new Error("示例参考材料超过现有单文件10 MiB上限，请精简材料后重试；原文不会自动截断。");
  const created = await fetch("/api/intakes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, modelMode, workflow: "clarification" }),
    signal,
  });
  const draft = (await created.json()) as IntakeDraft & { error?: string };
  if (!created.ok) throw new Error(draft.error || "未能创建需求草稿，请稍后重试。");
  if (typeof draft.id !== "string" || !draft.id) throw new Error("服务未返回可恢复的需求草稿。");
  signal.throwIfAborted();
  saveIntakeDraftPointer(draft.id, true);
  if (readIntakeDraftPointer() !== draft.id)
    throw new Error(
      "需求草稿已保存，但浏览器未能记录恢复位置。请返回首页，在“我的历史”打开刚创建的草稿。",
    );
  const body = new FormData();
  body.append("file", file);
  const uploaded = await fetch(`/api/intakes/${encodeURIComponent(draft.id)}/attachments`, {
    method: "POST",
    body,
    signal,
  });
  const saved = (await uploaded.json()) as IntakeDraft & { error?: string };
  if (!uploaded.ok)
    throw new Error(
      saved.error || "需求草稿已保存，参考材料尚未完整添加，请从“我的历史”继续这份草稿。",
    );
  signal.throwIfAborted();
  clearExamplePickerRequest();
  return saved;
}
