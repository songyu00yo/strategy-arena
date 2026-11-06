"use client";
import type { CSSProperties } from "react";
import type { ArenaVersion } from "@/lib/contracts";
import { comparisonMeta } from "@/components/status";
import { ROUTE_COLOR } from "./effects";
import type { Beat } from "./beats";

const ROUTES = ["A", "B", "C"] as const;

/** A bar against the largest value or the user's own limit. Past the limit it turns red. */
function Bar({
  value,
  max,
  limit,
  unit,
}: {
  value: number | null | undefined;
  max: number;
  limit: number | null;
  unit: string;
}) {
  if (value === null || value === undefined) return <span className="c-bar none">未估算</span>;
  const over = limit !== null && value > limit;
  return (
    <span className={`c-bar ${over ? "over" : ""}`}>
      <span className="track">
        <i style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
        {limit !== null && <u style={{ left: `${(limit / max) * 100}%` }} />}
      </span>
      <b>{unit === "¥" ? `¥${value.toLocaleString()}` : `${value.toLocaleString()}${unit}`}</b>
    </span>
  );
}

/**
 * Compares the three routes using only what the record holds: their estimates, the user's limits,
 * and how their challenges ended. It deliberately has no combined score, because none would be earned.
 */
export function RouteChart({
  version,
  beats,
  index,
  onStep,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  onStep: (index: number) => void;
}) {
  const shown = beats.slice(0, index + 1);
  const seen = new Set(shown.map((b) => b.id));
  const attacks = shown.filter((b) => b.stage === "attack").map((b) => b.attack!);
  const verdict = seen.has("judge") ? version.verdict : null;
  const routes = ROUTES.map((id) => {
    const proposal = seen.has(`p:${id}`) ? version.strategies.find((s) => s.id === id) : undefined;
    const revised = seen.has(`r:${id}`)
      ? version.revisions.find((r) => r.strategyId === id)?.strategy
      : undefined;
    const view = revised ?? proposal;
    const taken = attacks.filter((a) => a.targetStrategyId === id);
    const state = (status: string) =>
      taken.filter((a) => seen.has(`v:${a.id}`) && a.status === status).length;
    const upheld = state("supported");
    const refuted = state("refuted");
    const open = taken.length - upheld - refuted;
    return { id, view, upheld, refuted, open };
  });
  const { timeHours, budget } = version.challenge;
  const maxOf = (values: (number | null | undefined)[], limit: number | null) =>
    Math.max(limit ?? 0, ...values.map((v) => v ?? 0), 1);
  const maxHours = maxOf(
    routes.map((r) => r.view?.estimatedHours),
    timeHours,
  );
  const maxCost = maxOf(
    routes.map((r) => r.view?.estimatedCost),
    budget,
  );
  const jumpTo = (id: string) => {
    const target = ["r:", "p:"]
      .map((prefix) => shown.findIndex((b) => b.id === `${prefix}${id}`))
      .find((i) => i >= 0);
    if (target !== undefined) onStep(target);
  };
  return (
    <section className="c-compare" aria-label="三路对比">
      <h2>
        三路对比 <span>工时和费用是估算，竖线是你的上限，点路线看详情</span>
      </h2>
      <div className="c-chart">
        <div className="head" aria-hidden="true">
          <span>路线</span>
          <span>工时</span>
          <span>费用</span>
          <span>被质疑结果</span>
          <span>裁判</span>
        </div>
        {routes.map(({ id, view, upheld, refuted, open }) => {
          const comparison = verdict?.comparisons.find((c) => c.strategyId === id);
          return (
            <button
              key={id}
              type="button"
              aria-label={`查看路线 ${id} 的详情`}
              disabled={!view}
              className={`row ${verdict?.preferred === id ? "pick" : ""}`}
              style={{ "--route": ROUTE_COLOR[id].replaceAll(",", " ") } as CSSProperties}
              onClick={() => jumpTo(id)}
            >
              <span className="name">
                <b>{id}</b>
                <em>{view?.title.replace(/^路线\s*[ABC][：:]\s*/, "") ?? "等待提案"}</em>
              </span>
              <Bar value={view?.estimatedHours} max={maxHours} limit={timeHours} unit="小时" />
              <Bar value={view?.estimatedCost} max={maxCost} limit={budget} unit="¥" />
              <span className="tally" title={`成立 ${upheld}，尚无定论 ${open}，已反驳 ${refuted}`}>
                {Array.from({ length: upheld }, (_, i) => (
                  <i key={`u${i}`} className="is-supported" />
                ))}
                {Array.from({ length: open }, (_, i) => (
                  <i key={`o${i}`} className="is-unresolved" />
                ))}
                {Array.from({ length: refuted }, (_, i) => (
                  <i key={`f${i}`} className="is-refuted" />
                ))}
                <small>
                  {upheld + open + refuted
                    ? `成立 ${upheld} · 未决 ${open} · 反驳 ${refuted}`
                    : "—"}
                </small>
              </span>
              <span className={`judge ${comparison?.status ?? ""}`}>
                {comparison ? comparisonMeta[comparison.status].label : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
