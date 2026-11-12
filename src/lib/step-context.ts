import type { ArenaVersion } from "./contracts";
import type { ClarificationRun } from "./clarification-contracts";
import type { IntakeQuestion, RecordedAnswer } from "./intake-contracts";

export interface StepContext {
  stepId: string;
  title: string;
  quote: string;
}

/** Bind a question to the following saved input snapshot, never to a later edited answer. */
export function clarificationAnswersForRun(
  version: ArenaVersion,
  run: ClarificationRun,
): RecordedAnswer[] {
  if (run.role !== "B" || !("questions" in run.output)) return [];
  const rounds = version.clarification?.rounds ?? [];
  const index = rounds.findIndex((round) => round.runIds.includes(run.id));
  if (index < 0 || !rounds[index + 1]) return [];
  const sourceQuestions = run.output.questions;
  const questionKey = (question: IntakeQuestion) =>
    JSON.stringify([
      question.id,
      question.title,
      question.type,
      question.options,
      question.unit,
      question.authorization ?? "",
    ]);
  const shown = new Set(rounds[index].questions.map(questionKey));
  const asked = new Set(sourceQuestions.map(questionKey).filter((key) => shown.has(key)));
  return rounds[index + 1].answers.filter((answer) => asked.has(questionKey(answer.question)));
}

export function clarificationQuestionText(
  question: IntakeQuestion,
  answer?: RecordedAnswer,
): string {
  const value =
    answer && (Array.isArray(answer.value) ? answer.value.join("、") : answer.value.trim());
  const response =
    !answer || (answer.state === "answered" && !value)
      ? "尚未回答（未确认）"
      : answer.state === "unknown"
        ? "不知道（未决）"
        : answer.state === "skipped"
          ? "已跳过（未决）"
          : `${value}${question.unit ? ` ${question.unit}` : ""}（${answer.needsReconfirmation ? "待重新确认" : answer.confirmation === "confirmed" ? "已确认" : answer.confirmation === "pending" ? "待确认" : "确认状态未记录"}）`;
  return [
    question.title,
    question.options.length ? `候选选项 — ${question.options.join(" / ")}` : "",
    question.authorization ? `单项授权范围 — ${question.authorization}` : "",
    `已记录回答 — ${response}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Canonical persisted step text shared by the reader and the source check. No generated explanation. */
export function stepContext(version: ArenaVersion, stepId: string): StepContext | null {
  if (version.workflow === "clarification" && stepId.startsWith("clarification:")) {
    const run = version.clarification?.runs.find((entry) => `clarification:${entry.id}` === stepId);
    if (!run) return null;
    const title = `${run.role} · 第 ${run.round} 轮需求审查`;
    const answers = clarificationAnswersForRun(version, run);
    return {
      stepId,
      title,
      quote: [
        title,
        run.summary,
        ...("questions" in run.output
          ? run.output.questions.map((question) =>
              clarificationQuestionText(
                question,
                answers.find((answer) => answer.questionId === question.id),
              ),
            )
          : []),
        `记录 ${run.id}`,
        `调用 ${run.operationId}`,
        `依据修订 ${run.basedOnRevision}`,
      ].join("\n"),
    };
  }
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
    const revision = version.revisions.findLast(
      (entry) => entry.revisionId === key || entry.strategyId === key,
    );
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
