import type { ArenaVersion } from "./contracts";

export interface StepContext {
  stepId: string;
  title: string;
  quote: string;
}

/** Canonical persisted step text shared by the reader and the source check. No generated explanation. */
export function stepContext(version: ArenaVersion, stepId: string): StepContext | null {
  const kind = stepId.slice(0, 2);
  const key = stepId.slice(2);
  let title: string;
  let lines: (string | undefined)[];
  if (kind === "p:") {
    const strategy = version.strategies.find((entry) => entry.id === key);
    if (!strategy) return null;
    title = `独立提案 · ${strategy.title}`;
    lines = [
      strategy.thesis,
      ...strategy.claims.map((claim) => `${claim.id}：${claim.text}`),
      ...strategy.steps.map((step, i) => `${i + 1}. ${step}`),
      `所需资源：${strategy.resources}`,
      `第一步：${strategy.firstAction}`,
      `退出条件：${strategy.failureCondition}`,
      `预计投入：${strategy.estimatedHours === null ? "未提供时间估算" : `${strategy.estimatedHours} 小时`}，${strategy.estimatedCost === null ? "未提供费用估算" : `¥${strategy.estimatedCost}`}`,
    ];
  } else if (kind === "a:" || kind === "v:") {
    const attack = version.attacks.find((entry) => entry.id === key);
    if (!attack) return null;
    const evidence = version.evidence.filter((entry) => entry.attackId === key);
    if (kind === "v:" && !evidence.length && attack.status === "pending") return null;
    title = `${kind === "a:" ? "交叉质疑" : "证据核验"} · ${attack.from} → ${attack.targetStrategyId}`;
    lines = [
      `原话：${attack.claimQuote}`,
      `质疑：${attack.reason}`,
      `影响：${attack.impact}`,
      `核验办法：${attack.verification}`,
    ];
    if (kind === "v:")
      lines.push(
        `核验状态：${{ supported: "质疑成立", refuted: "质疑已反驳", unresolved: "尚无定论", pending: "待核验" }[attack.status]}`,
        ...evidence.flatMap((entry) => [
          entry.title,
          entry.expression ? `${entry.expression} = ${entry.result ?? "未知"}` : undefined,
          entry.content,
          entry.assumptions,
        ]),
      );
  } else if (kind === "r:") {
    const revision = version.revisions.find((entry) => entry.strategyId === key);
    if (!revision) return null;
    title = `策略修订 · ${revision.strategy.title}`;
    lines = [
      revision.summary,
      ...revision.responses.map(
        (response) => `${response.attackId}：${response.reason} ${response.change ?? ""}`,
      ),
      revision.strategy.thesis,
      ...revision.strategy.claims.map((claim) => `${claim.id}：${claim.text}`),
      ...revision.strategy.steps.map((step, i) => `${i + 1}. ${step}`),
      `第一步：${revision.strategy.firstAction}`,
      `退出条件：${revision.strategy.failureCondition}`,
    ];
  } else if (stepId === "judge" && version.verdict) {
    const verdict = version.verdict;
    title = `当前结论 · ${verdict.headline}`;
    lines = [
      verdict.rationale,
      `建议路线：${verdict.preferred ?? "未指定"}`,
      ...verdict.conditions.map((text) => `成立条件：${text}`),
      ...verdict.uncertainties.map((text) => `仍需确认：${text}`),
      ...verdict.nextActions.map((text) => `下一步：${text}`),
      `退出条件：${verdict.exitCondition}`,
    ];
  } else return null;
  return { stepId, title, quote: [title, ...lines].filter(Boolean).join("\n") };
}
