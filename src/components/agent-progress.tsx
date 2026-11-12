"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArenaVersion, ModelDraft } from "@/lib/contracts";
import { CLARIFICATION_ROLES } from "./console/beats";
import "./agent-progress.css";

const labels: Record<string, string> = {
  plan: "规划",
  propose: "提案",
  attack: "质疑",
  tools: "查证",
  verify: "核验",
  revise: "修订",
  judge: "裁决",
};
const states = {
  pending: "待执行",
  running: "执行中",
  completed: "完成",
  failed: "失败",
  uncertain: "待核对",
  skipped: "已跳过",
} as const;

function roleOf(role: string) {
  return ["A", "B", "C"].includes(role) ? ` ${role}` : "";
}

/** The plan and the action chain: one ruled band that keeps its height while the run goes on. */
function AgentPlan({
  version,
  web,
}: {
  version: ArenaVersion;
  web?: { webConfigured: boolean; provider?: "deepseek" | "tavily" };
}) {
  const agent = version.agent;
  const clarification = version.workflow === "clarification" ? version.clarification : undefined;
  const entries = clarification
    ? clarification.runs.map((run) => ({
        ...run,
        label: `${run.role} ${CLARIFICATION_ROLES[run.role]}`,
      }))
    : agent!.actions.map((action) => ({
        ...action,
        label: `${labels[action.kind]}${roleOf(action.role)}`,
      }));
  const [open, setOpen] = useState(false);
  const chain = useRef<HTMLOListElement>(null);
  const plan = agent?.plans.at(-1);
  const summary = clarification?.runs.at(-1)?.summary ?? plan?.summary;
  const questions = clarification
    ? (version.requirements?.unresolved ??
      clarification.items
        .filter((item) => !clarification.retiredIds.includes(item.id))
        .map((item) => item.title))
    : plan?.questions;
  const stopReason = clarification
    ? clarification.draftOnly
      ? "当前为含未决事项的交接草稿。"
      : "本版本按确认记录交接。"
    : agent?.stopReason;
  const running = entries.findIndex((action) => action.status === "running");
  const reached = entries.reduce(
    (last, action, index) => (action.status === "pending" ? last : index),
    -1,
  );
  const now = running >= 0 ? entries[running] : undefined;

  // Keep the step that is running in view without moving the page.
  useEffect(() => {
    const list = chain.current;
    const node = list?.children[running >= 0 ? running : Math.max(reached, 0)] as
      | HTMLElement
      | undefined;
    if (!list || !node) return;
    const target = node.offsetLeft - list.clientWidth / 2 + node.offsetWidth / 2;
    list.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [running, reached]);

  return (
    <section
      className="agent-progress"
      aria-label="自主规划与实时文字"
      data-open={open ? "true" : undefined}
    >
      <div className="ap-head">
        <strong className="ap-title">{clarification ? "需求审查记录" : "自主推演"}</strong>
        <span className="ap-count">
          {clarification
            ? `${clarification.rounds.length} 轮 · ${clarification.runs.length} 条角色调用记录`
            : `${agent!.plans.length} 次规划 · ${agent!.toolsUsed}/${agent!.limits.tools} 次工具调用 · ${agent!.externalToolsUsed}/${agent!.limits.externalTools} 次联网`}
        </span>
        {now && (
          <span className="ap-now" role="status">
            {now.label} 执行中
          </span>
        )}
        <button
          type="button"
          className="ap-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? clarification
              ? "收起记录"
              : "收起规划"
            : clarification
              ? "看审查记录"
              : "看规划"}
        </button>
      </div>
      <ol className="agent-actions" ref={chain}>
        {entries.map((action, index) => (
          <li
            key={action.id}
            data-state={action.status}
            data-passed={index < reached ? "true" : undefined}
          >
            <i aria-hidden="true" />
            <span>{action.label}</span>
            <small>
              第 {action.round} 轮 · {states[action.status]}
            </small>
          </li>
        ))}
      </ol>
      <div className="ap-more" inert={!open}>
        <div>
          {web && (
            <p className="ap-web">
              {web.webConfigured
                ? `联网来源 ${web.provider === "tavily" ? "Tavily" : "DeepSeek"}，已配置。`
                : "联网搜索待配置，当前可检索已解析材料并计算。"}
            </p>
          )}
          {summary && <p className="ap-summary">{summary}</p>}
          {questions?.length ? (
            <div className="ap-questions">
              <b>{clarification ? "待决定事项" : "本轮核验问题"}</b>
              <ul>
                {questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {stopReason && <p role="status">{stopReason}</p>}
        </div>
      </div>
    </section>
  );
}

/** Text while it is still being written: it follows the newest line in its own scroll. */
function LiveDraft({ draft }: { draft: ModelDraft }) {
  const body = useRef<HTMLDivElement>(null);
  const length = Object.values(draft.fields).join("").length;
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    if (nearBottom || node.dataset.follow !== "off")
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [length]);
  return (
    <div className="agent-draft live" aria-label="实时生成文字">
      <strong>
        <span>
          {labels[draft.stage]} {draft.role}
        </span>
        <em>生成中，尚未核验</em>
      </strong>
      <div
        ref={body}
        className="ap-draft-body"
        onScroll={(event) => {
          const node = event.currentTarget;
          node.dataset.follow =
            node.scrollHeight - node.scrollTop - node.clientHeight < 24 ? "on" : "off";
        }}
      >
        {Object.entries(draft.fields).map(([field, text]) => (
          <p key={field}>{text}</p>
        ))}
        <i className="ap-caret" aria-hidden="true" />
      </div>
    </div>
  );
}

export function AgentProgress({
  version,
  drafts,
  web,
  part,
}: {
  version: ArenaVersion;
  drafts: ModelDraft[];
  web?: { webConfigured: boolean; provider?: "deepseek" | "tavily" };
  /** "plan" is the band above the stage; "drafts" is the live text in the side rail. */
  part: "plan" | "drafts";
}) {
  if (part === "plan")
    return version.agent || (version.workflow === "clarification" && version.clarification) ? (
      <AgentPlan version={version} web={web} />
    ) : null;
  const currentDrafts = drafts.filter(
    (draft) =>
      draft.versionId === version.id &&
      draft.status === "generating" &&
      ["running", "ready"].includes(version.status),
  );
  const archivedDrafts = drafts.filter(
    (draft) =>
      draft.versionId === version.id &&
      ["rejected", "interrupted"].includes(draft.status) &&
      Object.keys(draft.fields).length > 0,
  );
  if (!currentDrafts.length && !archivedDrafts.length) return null;
  return (
    <section className="agent-drafts" aria-label="模型实时文字">
      {currentDrafts.map((draft) => (
        <LiveDraft key={draft.stepId} draft={draft} />
      ))}
      {archivedDrafts.map((draft) => (
        <details key={draft.stepId} className="agent-draft archived">
          <summary>
            {labels[draft.stage]} {draft.role} ·{" "}
            {draft.status === "interrupted" ? "生成中断，结果待核对" : "本次生成未通过核验"}
          </summary>
          {Object.entries(draft.fields).map(([field, text]) => (
            <p key={field}>{text}</p>
          ))}
        </details>
      ))}
    </section>
  );
}
