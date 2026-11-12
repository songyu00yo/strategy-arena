import type { ArenaVersion } from "./contracts";
import type { ClarificationRun } from "./clarification-contracts";
import type { IntakeQuestion, RecordedAnswer } from "./intake-contracts";
import type { ReplayAction } from "./replay-contracts";
import { buildClarificationReplay, pendingReplayAnswer, REPLAY_ACTION_TITLES } from "./replay";

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

export function replaySummaryLines(summary: ReplayAction["summary"]): string[] {
  if (!summary) return ["本次操作未记录完整摘要，保留现有来源记录。"];
  const { challenge, assumptions } = summary;
  const domains = {
    general: "不限领域",
    learning: "学习成长",
    life: "生活决策",
    work: "工作业务",
    creation: "内容创作",
  };
  return [
    `目标 — ${challenge.goal}`,
    `要求 — ${challenge.constraints || "未填写"}`,
    `偏好与风格 — ${challenge.preferences || "未填写"}`,
    `已有想法 — ${challenge.options.join("、") || "未填写"}`,
    `预算上限 — ${challenge.budget === null ? "未填写" : `${challenge.budget} 元`}`,
    `时间上限 — ${challenge.timeHours === null ? "未填写" : `${challenge.timeHours} 小时`}`,
    `成果领域 — ${domains[challenge.domain]}`,
    `材料 — ${challenge.materials || "未提供"}`,
    `暂定假设（待核对） — ${assumptions.join("、") || "未列出"}`,
  ];
}

/** Render accepted records as source text without pretending that a selected value is confirmed. */
export function replayActionLines(
  action: ReplayAction,
  visibleAnswers?: readonly RecordedAnswer[],
  committed = true,
): string[] {
  const answers =
    visibleAnswers ??
    (action.kind === "answer"
      ? action.answers?.map(pendingReplayAnswer)
      : action.kind === "questions"
        ? []
        : action.answers) ??
    [];
  return [
    REPLAY_ACTION_TITLES[action.kind],
    ...(action.questions ?? []).map((question) =>
      clarificationQuestionText(
        question,
        answers.find((answer) => answer.questionId === question.id),
      ),
    ),
    ...(["summary_submit", "summary_confirm"].includes(action.kind)
      ? replaySummaryLines(action.summary)
      : []),
    action.kind === "summary_submit" ? "已提交摘要，等待模型查漏与提交结果。" : "",
    action.kind === "summary_confirm"
      ? committed
        ? "保存记录显示需求摘要已明确确认。"
        : "正在展示摘要确认过程。"
      : "",
    action.kind === "handoff"
      ? committed
        ? "保存记录中的需求说明与执行提示词已生成。"
        : "正在整理保存记录中的交接结果。"
      : "",
    action.source?.kind === "snapshot"
      ? "按保存记录重建，原始点击顺序和输入速度未记录。"
      : "依据保存的请求记录。",
  ].filter(Boolean);
}

/** Canonical persisted step text shared by the reader and the source check. No generated explanation. */
export function stepContext(
  version: ArenaVersion,
  stepId: string,
  replayActions?: readonly ReplayAction[],
): StepContext | null {
  if (version.workflow === "clarification" && stepId.startsWith("replay:")) {
    const action = buildClarificationReplay(version, replayActions).find(
      (step) => step.id === stepId,
    )?.replayAction;
    if (!action) return null;
    const source = version.clarification?.runs.find((run) => run.id === action.sourceRunId);
    return {
      stepId,
      title: `${REPLAY_ACTION_TITLES[action.kind]} · 第 ${action.round} 轮`,
      quote: [
        ...replayActionLines(action),
        `依据修订 ${action.revision}`,
        source ? `原模型记录 ${source.id}\n${source.summary}` : "",
        action.source
          ? `操作来源 ${action.source.reference}${action.source.sha256 ? `\n来源校验 ${action.source.sha256}` : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (version.workflow === "clarification" && stepId.startsWith("clarification:")) {
    const run = version.clarification?.runs.find((entry) => `clarification:${entry.id}` === stepId);
    if (!run) return null;
    const title = `${run.role} · 第 ${run.round} 轮需求审查`;
    return {
      stepId,
      title,
      quote: [
        title,
        run.summary,
        ...("questions" in run.output
          ? run.output.questions.map((question) => clarificationQuestionText(question, undefined))
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
