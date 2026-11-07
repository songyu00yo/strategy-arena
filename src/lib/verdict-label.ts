import type { Verdict } from "./contracts";

export function verdictLabel(verdict: Verdict) {
  if (verdict.preferred) return `建议 ${verdict.preferred}`;
  const labels: Record<Verdict["outcome"], string> = {
    recommendation: "先确认建议的前提",
    tie: "几条路线各有所长",
    insufficient: "先补齐关键依据",
    infeasible: "先解决条件冲突",
    partial: "先看已有结论",
  };
  return labels[verdict.outcome];
}
