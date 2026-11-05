"use client";
import { ArrowDown, ArrowRight, ArrowUpRight, Flag, LocateFixed, Star } from "lucide-react";
import type { ArenaVersion, Attack } from "@/lib/contracts";
import { attackMeta, comparisonMeta, decisionMeta, StatusTag } from "@/components/status";
import { strategyChanges } from "@/components/text-diff";

const ROUTES = ["A", "B", "C"] as const;
/** Disputes that still need a decision come first; settled ones follow. */
const urgency: Record<Attack["status"], number> = {
  unresolved: 0,
  pending: 1,
  supported: 2,
  refuted: 3,
};

function change<T>(before: T, after: T, format: (value: T) => string) {
  return before === after ? format(after) : `${format(before)} → ${format(after)}`;
}

/** One row per route: only states that exist in this version's records are shown. */
function RouteLanes({
  version,
  onRoute,
}: {
  version: ArenaVersion;
  onRoute: (id: string) => void;
}) {
  return (
    <div className="route-lanes">
      <div className="lane-header" aria-hidden="true">
        <span>路线</span>
        <span>受到质疑</span>
        <span>修订</span>
        <span>投入估算</span>
        <span>裁决</span>
      </div>
      <ul>
        {ROUTES.map((id) => {
          const proposal = version.strategies.find((s) => s.id === id);
          const revision = version.revisions.find((r) => r.strategyId === id);
          const current = revision?.strategy ?? proposal;
          const targeted = version.attacks.filter((a) => a.targetStrategyId === id);
          const open = targeted.filter(
            (a) => a.status === "pending" || a.status === "unresolved",
          ).length;
          const upheld = targeted.filter((a) => a.status === "supported").length;
          const changes = proposal && revision ? strategyChanges(proposal, revision.strategy) : [];
          const comparison = version.verdict?.comparisons.find((c) => c.strategyId === id);
          const hours = (value: number | null) => (value === null ? "工时未估" : `${value} 小时`);
          const cost = (value: number | null) =>
            value === null ? "费用未估" : `¥${value.toLocaleString()}`;
          return (
            <li key={id} className={`route-lane lane-${id}`}>
              <button type="button" className="lane-route" onClick={() => onRoute(id)}>
                <span className="lane-letter">{id}</span>
                <span className="lane-title">{current?.title ?? "等待提案"}</span>
                <ArrowDown size={14} aria-hidden="true" />
              </button>
              <dl>
                <div>
                  <dt>受到质疑</dt>
                  <dd>
                    {targeted.length === 0
                      ? "暂无"
                      : `${targeted.length} 条${open ? `，${open} 条未决` : ""}${upheld ? `，${upheld} 条成立` : ""}`}
                  </dd>
                </div>
                <div>
                  <dt>修订</dt>
                  <dd>
                    {!revision
                      ? "尚未修订"
                      : changes.length
                        ? `${changes.length} 项变化`
                        : "复核未变"}
                  </dd>
                </div>
                <div>
                  <dt>投入估算</dt>
                  <dd>
                    {proposal && current
                      ? `${change(proposal.estimatedHours, current.estimatedHours, hours)} · ${change(proposal.estimatedCost, current.estimatedCost, cost)}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>裁决</dt>
                  <dd className="lane-verdict">
                    {comparison ? (
                      <StatusTag meta={comparisonMeta[comparison.status]} />
                    ) : (
                      "尚未裁决"
                    )}
                    {version.verdict?.preferred === id && (
                      <span className="lane-preferred">
                        <Star size={12} aria-hidden="true" />
                        当前建议
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DisputeBoard({
  version,
  selectedAttack,
  onEvidence,
  onLocate,
  onRoute,
}: {
  version: ArenaVersion;
  selectedAttack?: string;
  onEvidence: (attack: Attack) => void;
  onLocate: (attack: Attack) => void;
  onRoute: (id: string) => void;
}) {
  const disputes = [...version.attacks].sort((a, b) => urgency[a.status] - urgency[b.status]);
  const open = disputes.filter((a) => a.status === "pending" || a.status === "unresolved").length;
  const attackStageReached = version.stage !== "propose";
  return (
    <section className="dispute-board" aria-labelledby="dispute-board-title">
      <div className="board-heading">
        <h2 id="dispute-board-title">三路对照与争议</h2>
        <p role="status">
          {disputes.length ? `${disputes.length} 条争议，${open} 条未决` : "暂无争议记录"}
        </p>
        {version.verdict && (
          <a className="board-jump" href="#verdict">
            <Flag size={13} aria-hidden="true" />
            跳到裁决
          </a>
        )}
      </div>
      <RouteLanes version={version} onRoute={onRoute} />
      {disputes.length ? (
        <ol className="dispute-rows">
          {disputes.map((attack) => {
            const response = version.revisions
              .find((r) => r.strategyId === attack.targetStrategyId)
              ?.responses.find((r) => r.attackId === attack.id);
            const evidenceCount = version.evidence.filter((e) => e.attackId === attack.id).length;
            return (
              <li
                key={attack.id}
                className={`dispute-row ${attack.id === selectedAttack ? "selected" : ""}`}
              >
                <button type="button" className="dispute-open" onClick={() => onEvidence(attack)}>
                  <span className="dispute-status">
                    <StatusTag meta={attackMeta[attack.status]} />
                    <span className="dispute-routes">
                      {attack.from}
                      <ArrowRight size={12} aria-label="质疑" />
                      {attack.targetStrategyId}
                    </span>
                  </span>
                  <span className="dispute-text">
                    <strong>{attack.reason}</strong>
                    <q>{attack.claimQuote}</q>
                  </span>
                  <span className="dispute-outcome">
                    {response ? (
                      <StatusTag meta={decisionMeta[response.decision]} />
                    ) : (
                      <span className="dispute-none">路线尚未回应</span>
                    )}
                    <span className="dispute-evidence">
                      {evidenceCount ? `${evidenceCount} 项证据` : "暂无证据"}
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="dispute-locate"
                  aria-label={`在路线 ${attack.targetStrategyId} 中定位 ${attack.from} 提出的这条质疑`}
                  onClick={() => onLocate(attack)}
                >
                  <LocateFixed size={14} aria-hidden="true" />
                  <span>定位</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="dispute-empty">
          {attackStageReached
            ? "这一版本目前没有质疑记录。质疑产生后会列在这里。"
            : "交叉质疑尚未开始。三条路线形成后，会互相挑战具体判断。"}
        </p>
      )}
    </section>
  );
}
