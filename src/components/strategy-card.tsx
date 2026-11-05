"use client";
import { ArrowUpRight, Crosshair, CornerDownRight, Clock3, Coins, ShieldAlert } from "lucide-react";
import type { ArenaVersion, Attack, Strategy } from "@/lib/contracts";
import { attackMeta, decisionMeta, StatusTag } from "@/components/status";
import { strategyChanges, TextDiff } from "@/components/text-diff";

const claimLabels = {
  user: "用户提供",
  estimate: "估算",
  unknown: "待核验",
  supported: "有材料支持",
};

/** A dispute shown on the claim it targets, with the route's response beside it. */
function DisputeThread({
  attack,
  version,
  currentText,
  selected,
  onAttack,
}: {
  attack: Attack;
  version: ArenaVersion;
  currentText?: string;
  selected: boolean;
  onAttack: (a: Attack) => void;
}) {
  const response = version.revisions
    .find((r) => r.strategyId === attack.targetStrategyId)
    ?.responses.find((r) => r.attackId === attack.id);
  return (
    <div
      id={`dispute-${attack.id}`}
      tabIndex={-1}
      className={`dispute-thread ${selected ? "selected" : ""}`}
    >
      <div className="thread-head">
        <span className="thread-from">
          <Crosshair size={12} aria-hidden="true" />
          {attack.from} → {attack.targetStrategyId}
        </span>
        <StatusTag meta={attackMeta[attack.status]} />
      </div>
      {currentText !== attack.claimQuote && (
        <p className="thread-quote">
          <span>被质疑时的原话</span>
          {attack.claimQuote}
        </p>
      )}
      <p className="thread-reason">{attack.reason}</p>
      {response && (
        <div className="thread-response">
          <StatusTag meta={decisionMeta[response.decision]} />
          {response.change && (
            <span className="thread-change">
              <CornerDownRight size={13} aria-hidden="true" />
              {response.change}
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        className="attack-detail-link"
        aria-label={`查看证据与回应：${attack.from} 对 ${attack.targetStrategyId} 的质疑`}
        onClick={() => onAttack(attack)}
      >
        查看证据与回应 <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function StrategyCard({
  strategy,
  version,
  selectedAttack,
  onAttack,
  onClaim,
  historical,
  busy,
}: {
  strategy: Strategy;
  version: ArenaVersion;
  selectedAttack?: string;
  onAttack: (a: Attack) => void;
  onClaim: (s: Strategy, id: string) => void;
  historical: boolean;
  busy: boolean;
}) {
  const revision = version.revisions.find((r) => r.strategyId === strategy.id);
  const view = revision?.strategy ?? strategy;
  const diffs = revision ? strategyChanges(strategy, view) : [];
  const attacks = version.attacks.filter((a) => a.targetStrategyId === strategy.id);
  // A revision may withdraw a disputed claim. Its dispute must stay visible on this route.
  const orphaned = attacks.filter((a) => !view.claims.some((c) => c.id === a.targetClaimId));
  return (
    <article className={`strategy-card strategy-${strategy.id}`}>
      <div className="strategy-top">
        <span className="strategy-letter">
          {strategy.id}
          <span>路线</span>
        </span>
      </div>
      <div className="strategy-body">
        <div className="track-head">
          <div className="strategy-title-line">
            <h2>{view.title}</h2>
            {revision && (
              <span className="revision-badge">{diffs.length ? "已修订" : "已复核"}</span>
            )}
          </div>
          <p className="strategy-thesis">{view.thesis}</p>
        </div>
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
            关键判断与争议{" "}
            <span>
              {historical ? "历史版本只读" : busy ? "正在处理请求" : "点击判断可提出你的质疑"}
            </span>
          </div>
          {view.claims.map((claim) => {
            const related = attacks.filter((a) => a.targetClaimId === claim.id);
            return (
              <div className="claim-group" key={claim.id}>
                <button
                  className={`claim ${related.length ? "under-attack" : ""} ${related.some((a) => a.id === selectedAttack) ? "highlighted" : ""}`}
                  type="button"
                  disabled={historical || busy}
                  onClick={() => onClaim(view, claim.id)}
                >
                  <span className="claim-meta">
                    <span className={`claim-status ${claim.status}`}>
                      {claimLabels[claim.status]}
                    </span>
                    {related.length > 0 && (
                      <span className="claim-disputed">{related.length} 条争议</span>
                    )}
                    <Crosshair size={14} aria-hidden="true" />
                  </span>
                  <span>{claim.text}</span>
                </button>
                {related.map((a) => (
                  <DisputeThread
                    key={a.id}
                    attack={a}
                    version={version}
                    currentText={claim.text}
                    selected={a.id === selectedAttack}
                    onAttack={onAttack}
                  />
                ))}
              </div>
            );
          })}
          {orphaned.length > 0 && (
            <div className="claim-group claim-withdrawn">
              <p className="withdrawn-note">这些判断已在修订中撤回或改写，争议记录保留：</p>
              {orphaned.map((a) => (
                <DisputeThread
                  key={a.id}
                  attack={a}
                  version={version}
                  selected={a.id === selectedAttack}
                  onAttack={onAttack}
                />
              ))}
            </div>
          )}
        </div>
        <div className="track-revision">
          {revision && (
            <>
              <div className="revision-note">
                <CornerDownRight size={16} aria-hidden="true" />
                <div>
                  <strong>{diffs.length ? "修订后内容有变化" : "完成复核，内容未变"}</strong>
                  <p>{revision.summary}</p>
                  {diffs.length > 0 && (
                    <p className="revision-fields">变化：{diffs.map((d) => d.label).join("、")}</p>
                  )}
                </div>
              </div>
              <details className="revision-diff">
                <summary>
                  查看修订前后{" "}
                  <span>{diffs.length ? `${diffs.length} 项变化` : "行动内容未变"}</span>
                </summary>
                {diffs.length ? (
                  diffs.map((d) => (
                    <div className="diff-item" key={d.label}>
                      <h4>{d.label}</h4>
                      <TextDiff before={d.before} after={d.after} />
                    </div>
                  ))
                ) : (
                  <p className="diff-unchanged">
                    本轮的判断、行动步骤、资源、第一步与投入估算均保留原内容。请结合修订回应中的理由判断。
                  </p>
                )}
              </details>
            </>
          )}
        </div>
        <div className="resource-block">
          <span className="section-caption">资源与投入</span>
          <p>{view.resources}</p>
          <div className="estimate-row">
            {view.estimatedCost !== null && (
              <span>
                <Coins size={13} aria-hidden="true" />¥{view.estimatedCost.toLocaleString()}{" "}
                <small>估算</small>
              </span>
            )}
            {view.estimatedHours !== null && (
              <span>
                <Clock3 size={13} aria-hidden="true" />
                {view.estimatedHours} 小时 <small>估算</small>
              </span>
            )}
          </div>
        </div>
        <div className="failure-condition">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>
            <strong>失效条件</strong>
            {view.failureCondition}
          </span>
        </div>
        <div className="first-action">
          <span>第一步</span>
          <p>{view.firstAction}</p>
        </div>
      </div>
    </article>
  );
}

export function PendingCard({ id, running }: { id: string; running: boolean }) {
  return (
    <article className="strategy-card pending-card">
      <div className="strategy-top">
        <span className="strategy-letter">
          {id}
          <span>路线</span>
        </span>
        <span className={running ? "working-dot" : "waiting-dot"} />
      </div>
      <div className="pending-body">
        <h3>{running ? "独立思考中" : "等待独立提案"}</h3>
        <p>
          {running
            ? "正在根据你的目标与条件形成路线。"
            : "这条路线将在此出现，随后接受其他方案的挑战。"}
        </p>
        <span className="pending-footnote">只展示真实生成的结果</span>
      </div>
    </article>
  );
}
