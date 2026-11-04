"use client";
import { ArrowUpRight, Crosshair, CornerDownRight, Clock3, Coins, ShieldAlert } from "lucide-react";
import type { ArenaVersion, Attack, Strategy } from "@/lib/contracts";
const claimLabels = {
  user: "用户提供",
  estimate: "估算",
  unknown: "待核验",
  supported: "有材料支持",
};
const attackLabels = {
  pending: "待核验",
  supported: "质疑成立",
  refuted: "质疑已反驳",
  unresolved: "尚无定论",
};
export function StrategyCard({
  strategy,
  version,
  selectedAttack,
  onAttack,
  onClaim,
  readOnly,
}: {
  strategy: Strategy;
  version: ArenaVersion;
  selectedAttack?: string;
  onAttack: (a: Attack) => void;
  onClaim: (s: Strategy, id: string) => void;
  readOnly: boolean;
}) {
  const revision = version.revisions.find((r) => r.strategyId === strategy.id);
  const view = revision?.strategy ?? strategy;
  const diffs = revision
    ? [
        { label: "路线标题", before: strategy.title, after: view.title },
        { label: "核心思路", before: strategy.thesis, after: view.thesis },
        {
          label: "行动步骤",
          before: strategy.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
          after: view.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
        },
        { label: "所需资源", before: strategy.resources, after: view.resources },
        { label: "第一步行动", before: strategy.firstAction, after: view.firstAction },
        { label: "失效条件", before: strategy.failureCondition, after: view.failureCondition },
        {
          label: "费用估算",
          before:
            strategy.estimatedCost === null
              ? "未提供估算"
              : `¥${strategy.estimatedCost.toLocaleString()}`,
          after:
            view.estimatedCost === null ? "未提供估算" : `¥${view.estimatedCost.toLocaleString()}`,
        },
        {
          label: "时间估算",
          before:
            strategy.estimatedHours === null ? "未提供估算" : `${strategy.estimatedHours} 小时`,
          after: view.estimatedHours === null ? "未提供估算" : `${view.estimatedHours} 小时`,
        },
      ].filter((d) => d.before !== d.after)
    : [];
  const attacks = version.attacks.filter((a) => a.targetStrategyId === strategy.id);
  return (
    <article className={`strategy-card strategy-${strategy.id}`}>
      <div className="strategy-top">
        <span className="strategy-number">0{["A", "B", "C"].indexOf(strategy.id) + 1}</span>
        <span className="strategy-letter">
          {strategy.id}
          <span>路线</span>
        </span>
        <ArrowUpRight size={22} />
      </div>
      <div className="strategy-body">
        <div className="strategy-title-line">
          <h2>{view.title}</h2>
          {revision && <span className="revision-badge">{diffs.length ? "已修订" : "已复核"}</span>}
        </div>
        <p className="strategy-thesis">{view.thesis}</p>
        <div className="strategy-steps">
          <span className="section-caption">行动路径</span>
          <ol>
            {view.steps.map((step, index) => (
              <li key={index}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {step}
              </li>
            ))}
          </ol>
        </div>
        <div className="claim-list">
          <div className="section-caption">
            关键判断 <span>{readOnly ? "历史版本" : "点击可提出质疑"}</span>
          </div>
          {view.claims.map((claim) => {
            const related = attacks.filter((a) => a.targetClaimId === claim.id);
            return (
              <button
                className={`claim ${related.length ? "under-attack" : ""} ${related.some((a) => a.id === selectedAttack) ? "highlighted" : ""}`}
                key={claim.id}
                type="button"
                disabled={readOnly}
                onClick={() => onClaim(view, claim.id)}
              >
                <span className="claim-meta">
                  <span className={`claim-status ${claim.status}`}>
                    {claimLabels[claim.status]}
                  </span>
                  <Crosshair size={14} />
                </span>
                <span>{claim.text}</span>
                {related.length > 0 && (
                  <span className="claim-attacked">
                    {related.length} 条质疑指向此处 <ArrowUpRight size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {attacks.length > 0 && (
          <div className="attack-list">
            <div className="section-caption">
              交叉质疑 <span>{attacks.length} 条</span>
            </div>
            {attacks.map((a) => (
              <button
                type="button"
                className={`attack-item ${a.id === selectedAttack ? "selected" : ""}`}
                key={a.id}
                onClick={() => onAttack(a)}
              >
                <span className="attack-item-head">
                  <span>
                    <Crosshair size={12} />
                    {a.from} → {a.targetStrategyId}
                  </span>
                  <span className={`attack-status ${a.status}`}>{attackLabels[a.status]}</span>
                </span>
                <span>{a.reason}</span>
                <span className="attack-detail-link">
                  查看证据与回应 <ArrowUpRight size={12} />
                </span>
              </button>
            ))}
          </div>
        )}
        {revision && (
          <div className="revision-note">
            <CornerDownRight size={16} />
            <div>
              <strong>{diffs.length ? "行动内容已更新" : "完成复核，保留路线"}</strong>
              <p>{revision.summary}</p>
            </div>
          </div>
        )}
        {revision && (
          <details className="revision-diff">
            <summary>
              查看修订前后 <span>{diffs.length ? `${diffs.length} 项变化` : "行动内容未变"}</span>
            </summary>
            {diffs.length ? (
              diffs.map((d) => (
                <div className="diff-item" key={d.label}>
                  <h4>{d.label}</h4>
                  <div>
                    <span>修订前</span>
                    <p>{d.before}</p>
                  </div>
                  <div>
                    <span>修订后</span>
                    <p>{d.after}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="diff-unchanged">
                本轮的行动步骤、资源、第一步与投入估算均保留原内容。请结合修订回应中的理由判断。
              </p>
            )}
          </details>
        )}
        <div className="resource-block">
          <span className="section-caption">资源与投入</span>
          <p>{view.resources}</p>
          <div className="estimate-row">
            {view.estimatedCost !== null && (
              <span>
                <Coins size={13} />¥{view.estimatedCost.toLocaleString()} <small>估算</small>
              </span>
            )}
            {view.estimatedHours !== null && (
              <span>
                <Clock3 size={13} />
                {view.estimatedHours} 小时 <small>估算</small>
              </span>
            )}
          </div>
        </div>
        <div className="failure-condition">
          <ShieldAlert size={14} />
          <span>
            <strong>失效条件</strong>
            {view.failureCondition}
          </span>
        </div>
        <div className="first-action">
          <span>第一步</span>
          <p>{view.firstAction}</p>
          <ArrowUpRight size={17} />
        </div>
      </div>
    </article>
  );
}

export function PendingCard({ id, running }: { id: string; running: boolean }) {
  return (
    <article className="strategy-card pending-card">
      <div className="strategy-top">
        <span className="strategy-number">0{["A", "B", "C"].indexOf(id) + 1}</span>
        <span className="strategy-letter">
          {id}
          <span>路线</span>
        </span>
        <span className={running ? "working-dot" : "waiting-dot"} />
      </div>
      <div className="pending-body">
        <span className="pending-mark">{id}</span>
        <h3>{running ? "独立思考中" : "等待独立提案"}</h3>
        <p>
          {running
            ? "正在根据你的目标与条件形成路线。"
            : "这条路线将在此出现，随后接受其他方案的挑战。"}
        </p>
        <div className="pending-lines">
          <i />
          <i />
          <i />
        </div>
        <span className="pending-footnote">只展示真实生成的结果</span>
      </div>
    </article>
  );
}
