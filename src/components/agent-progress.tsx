import type { ArenaVersion, ModelDraft } from "@/lib/contracts";
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
export function AgentProgress({
  version,
  drafts,
  web,
}: {
  version: ArenaVersion;
  drafts: ModelDraft[];
  web?: { webConfigured: boolean; provider?: "deepseek" | "tavily" };
}) {
  const agent = version.agent;
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
  if (!agent && !currentDrafts.length && !archivedDrafts.length) return null;
  return (
    <section className="agent-progress" aria-label="自主规划与实时文字">
      {agent && (
        <>
          <div className="agent-progress-heading">
            <strong>自主推演</strong>
            <span>
              {agent.plans.length} 次规划 · {agent.toolsUsed}/{agent.limits.tools} 次工具调用 ·{" "}
              {agent.externalToolsUsed}/{agent.limits.externalTools} 次联网
            </span>
          </div>
          {web && (
            <p>
              {web.webConfigured
                ? `联网来源 ${web.provider === "tavily" ? "Tavily" : "DeepSeek"}，已配置。`
                : "联网搜索待配置，当前可检索已解析材料并计算。"}
            </p>
          )}
          {agent.plans.at(-1) && <p>{agent.plans.at(-1)!.summary}</p>}
          {agent.plans.at(-1)?.questions.length ? (
            <details>
              <summary>本轮核验问题</summary>
              <ul>
                {agent.plans.at(-1)!.questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <ol className="agent-actions">
            {agent.actions.map((action) => (
              <li key={action.id} data-state={action.status}>
                <span>
                  {labels[action.kind]}
                  {["A", "B", "C"].includes(action.role) ? ` ${action.role}` : ""}
                </span>
                <small>
                  第 {action.round} 轮 ·{" "}
                  {
                    {
                      pending: "待执行",
                      running: "执行中",
                      completed: "完成",
                      failed: "失败",
                      uncertain: "待核对",
                      skipped: "已跳过",
                    }[action.status]
                  }
                </small>
              </li>
            ))}
          </ol>
          {agent.stopReason && <p role="status">{agent.stopReason}</p>}
        </>
      )}
      {archivedDrafts.map((draft) => (
        <details key={draft.stepId} className="agent-draft">
          <summary>
            {labels[draft.stage]} {draft.role} ·{" "}
            {draft.status === "interrupted" ? "生成中断，结果待核对" : "本次生成未通过核验"}
          </summary>
          {Object.entries(draft.fields).map(([field, text]) => (
            <p key={field}>{text}</p>
          ))}
        </details>
      ))}
      {currentDrafts.map((draft) => (
        <div key={draft.stepId} className="agent-draft" aria-label="实时生成文字">
          <strong>
            {labels[draft.stage]} {draft.role} · 生成中，尚未核验
          </strong>
          <div>
            {Object.entries(draft.fields).map(([field, text]) => (
              <p key={field}>{text}</p>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
