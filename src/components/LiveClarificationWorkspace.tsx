"use client";

import { memo, useEffect, useRef, type ReactNode } from "react";
import type { ArenaVersion } from "@/lib/contracts";
import type { ClarificationRun, ClarificationState } from "@/lib/clarification-contracts";
import type {
  IntakeDraft,
  IntakeDraftResponse,
  IntakeActivity,
  RecordedAnswer,
  IntakeConfirmation,
} from "@/lib/intake-contracts";
import { hasCompleteChoiceAnswer } from "@/lib/answer-options";
import { animateLivePaper, liveAnchor, LIVE_PAPER_TIMING } from "./live-paper-motion";
import { revealInWindow } from "./motion-scroll";
import { PlanningReportContent } from "./planning-report-content";
import "./live-clarification.css";

const ROLES = ["A", "B", "C"] as const;
const NAMES = { A: "需求理解", B: "方案构造", C: "审查与规划" };
const STATUS = {
  idle: "待命",
  running: "正在处理",
  waiting: "等待你决定",
  completed: "已完成",
  failed: "未完成",
  uncertain: "结果待确认",
};
const EMPTY_ACTIVITY: IntakeActivity = { operationId: null, calls: [] };
export type LiveAnswerReceipt = { id: string; decisionId: string; text: string };
type MotionEvent = { id: string; source: string; target: string; text: string; seal?: boolean };

function previewText(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function confirmedAnswer(answer: RecordedAnswer | undefined) {
  if (
    !answer ||
    answer.state !== "answered" ||
    answer.confirmation !== "confirmed" ||
    answer.needsReconfirmation
  )
    return false;
  if (answer.question.type === "single" || answer.question.type === "multiple")
    return hasCompleteChoiceAnswer(answer.question.type, answer.question.options, answer.value);
  return !Array.isArray(answer.value) && !!answer.value.trim();
}

function providedConfirmation(
  item: ClarificationState["items"][number],
  answers: RecordedAnswer[],
  confirmation?: IntakeConfirmation,
) {
  const provided = item.provided;
  if (!provided?.quote.trim() || /尚未|还没|不确定|不知道|待定|待确认/.test(provided.quote))
    return false;
  if (provided.sourceRef === "confirmed_summary") {
    const summary = confirmation?.summary?.challenge;
    return (
      !!summary &&
      !confirmation?.pendingSummaryFields?.length &&
      (["goal", "constraints", "preferences"] as const).some((field) =>
        summary[field].includes(provided.quote),
      )
    );
  }
  const source = answers.find((answer) => answer.questionId === provided.sourceRef);
  const value = source && (Array.isArray(source.value) ? source.value.join("、") : source.value);
  return confirmedAnswer(source) && !!value?.includes(provided.quote);
}

function DecisionItems({
  items,
  state,
  currentAnswers,
  confirmation,
}: {
  items: ClarificationState["items"];
  state?: ClarificationState;
  currentAnswers?: RecordedAnswer[];
  confirmation?: IntakeConfirmation;
}) {
  return (
    <ul className="live-decision-list">
      {items.map((item) => {
        const answers = currentAnswers ?? state?.rounds.flatMap((round) => round.answers) ?? [];
        const answer = answers.findLast(
          (answer) => (answer.question.decisionId ?? answer.questionId) === item.id,
        );
        return (
          <li key={item.id} data-motion-anchor={`decision-${item.id}`}>
            <strong>{previewText(item.title, 60)}</strong>
            <span>
              {answer?.needsReconfirmation
                ? "待重新确认"
                : answer?.confirmation === "pending" && answer.state === "answered"
                  ? "待确认"
                  : confirmedAnswer(answer) || providedConfirmation(item, answers, confirmation)
                    ? "已确认"
                    : item.required
                      ? "需要决定"
                      : "可继续完善"}
            </span>
            <p>{previewText(item.description, 140)}</p>
            {(item.title.length > 60 || item.description.length > 140) && (
              <details className="live-item-detail">
                <summary>查看完整事项</summary>
                <strong>{item.title}</strong>
                <p>{item.description}</p>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function runSummary(run: ClarificationRun | undefined) {
  if (!run) return "";
  return "summary" in run.output
    ? run.output.summary
    : "error" in run.output
      ? run.output.error
      : "";
}

const AgentCard = memo(function AgentCard({
  role,
  status,
  summary,
  entries,
  eventId,
}: {
  role: "A" | "B" | "C";
  status: keyof typeof STATUS;
  summary: string;
  entries: string;
  eventId: string;
}) {
  return (
    <section
      className={`c-board c-board-${role} live-agent-card enter${status === "running" ? " speaking" : ""}${status === "waiting" ? " target" : ""}`}
      data-motion-anchor={`agent-${role}`}
      data-agent-state={status}
      data-agent-event={eventId}
      aria-label={`${role} ${NAMES[role]}`}
    >
      <header>
        <b>{role}</b>
        <h2>{NAMES[role]}</h2>
        <span role="status">{STATUS[status]}</span>
      </header>
      <div className="c-board-body">
        <p className="live-agent-summary">
          {summary ? previewText(summary, 140) : "等待当前任务的真实处理结果。"}
        </p>
        {(summary || entries) && (
          <details>
            <summary>展开工作记录</summary>
            <div className="live-agent-details">
              {summary && <p>{summary}</p>}
              {entries.split("\n").map((entry, index) => (
                <p key={index}>{entry}</p>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
});

function useSpatialEvents(identity: string, events: MotionEvent[]) {
  const queue = useRef<MotionEvent[]>([]);
  const completed = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const busy = useRef(false);
  const cleanup = useRef<() => void>(() => {});
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    try {
      completed.current = new Set(
        JSON.parse(sessionStorage.getItem(`live-paper-events:${identity}`) ?? "[]"),
      );
    } catch {
      completed.current = new Set();
    }
    pending.current = new Set();
    return () => {
      mounted.current = false;
      cleanup.current();
      queue.current = [];
      busy.current = false;
    };
  }, [identity]);
  useEffect(() => {
    for (const event of events) {
      if (completed.current.has(event.id) || pending.current.has(event.id)) continue;
      pending.current.add(event.id);
      if (event.id.startsWith("answer:")) queue.current.unshift(event);
      else queue.current.push(event);
    }
    const next = () => {
      if (!mounted.current || busy.current) return;
      const event = queue.current.shift();
      if (!event) return;
      const target = liveAnchor(event.target);
      const source = liveAnchor(event.source);
      if (!target) {
        pending.current.delete(event.id);
        next();
        return;
      }
      const box = target.getBoundingClientRect();
      const paper = document.createElement("div");
      paper.className = event.seal ? "live-motion-note live-verdict-seal" : "live-motion-note";
      paper.setAttribute("aria-hidden", "true");
      paper.dataset.motionEvent = event.id;
      paper.dataset.motionSource = event.source;
      paper.dataset.motionTarget = event.target;
      paper.textContent = event.text;
      paper.style.left = `${Math.max(12, Math.min(innerWidth - 230, box.left + box.width / 2 - 100))}px`;
      paper.style.top = `${Math.max(12, Math.min(innerHeight - 100, box.top + Math.min(60, box.height / 2)))}px`;
      (document.querySelector(".console-shell") ?? document.body).appendChild(paper);
      busy.current = true;
      const finish = () => {
        paper.remove();
        cleanup.current = () => {};
        busy.current = false;
        pending.current.delete(event.id);
        completed.current.add(event.id);
        try {
          sessionStorage.setItem(
            `live-paper-events:${identity}`,
            JSON.stringify([...completed.current]),
          );
        } catch {}
        next();
      };
      const dispose = animateLivePaper(
        paper,
        source,
        event.seal ? LIVE_PAPER_TIMING.seal : LIVE_PAPER_TIMING.answer,
        finish,
      );
      cleanup.current = () => {
        dispose();
        paper.remove();
      };
    };
    next();
  }, [identity, events]); // Deduplicate real event IDs across polling and render updates.
}

function PaperWorkspace({
  identity,
  goal,
  state,
  activity,
  currentAnswers,
  confirmation,
  questionsPending,
  children,
  mode,
  receipt,
  actions,
  paperOpen = false,
  presentHandoff = false,
}: {
  identity: string;
  goal: string;
  state: ClarificationState | undefined;
  activity: IntakeActivity;
  currentAnswers?: RecordedAnswer[];
  confirmation?: IntakeConfirmation;
  questionsPending: boolean;
  children?: ReactNode;
  mode: "live" | "result";
  receipt?: LiveAnswerReceipt | null;
  actions?: ReactNode;
  paperOpen?: boolean;
  presentHandoff?: boolean;
}) {
  const runs = state?.runs ?? [];
  const items = (state?.items ?? []).filter((item) => !state?.retiredIds.includes(item.id));
  const currentIds = new Set(
    state?.rounds.at(-1)?.questions.map((question) => question.decisionId),
  );
  const itemPriority = (item: ClarificationState["items"][number]) =>
    item.id === receipt?.decisionId ? 0 : currentIds.has(item.id) ? 1 : item.required ? 2 : 3;
  const focusItems = items
    .toSorted((left, right) => itemPriority(left) - itemPriority(right))
    .slice(0, 4);
  const focusIds = new Set(focusItems.map((item) => item.id));
  const otherItems = items.filter((item) => !focusIds.has(item.id));
  const conclusion = state?.review?.summary || "保留已知内容，等待有依据的规划审查。";
  const lastRuns = ROLES.map((role) => runs.findLast((run) => run.role === role));
  const events: MotionEvent[] = [];
  if (receipt)
    events.push({
      id: receipt.id,
      source: "question-paper",
      target: `decision-${receipt.decisionId}`,
      text: receipt.text.slice(0, 100),
    });
  for (const call of activity.calls)
    if (call.state === "running")
      events.push({
        id: `call:${call.callId}`,
        source: receipt ? `decision-${receipt.decisionId}` : "decision-stage",
        target: `agent-${call.role}`,
        text: `${NAMES[call.role]}接收当前事项`,
      });
  for (const run of lastRuns) {
    if (run?.status !== "completed") continue;
    events.push({
      id: `run:${run.id}`,
      source: `agent-${run.role}`,
      target: run.role === "C" ? "conclusion" : "decision-stage",
      text: run.role === "C" ? "规划审查" : runSummary(run).slice(0, 100),
      seal: run.role === "C",
    });
    if (run.role === "C" && state?.specification.trim()) {
      events.push({
        id: `archive:${run.id}:report`,
        source: "conclusion",
        target: "planning-report",
        text: "详细规划报告归档",
      });
      if (state.executionPrompt.trim())
        events.push({
          id: `archive:${run.id}:prompt`,
          source: "planning-report",
          target: "execution-prompt",
          text: "执行提示词归档",
        });
    }
  }
  const handoffRun = lastRuns[2];
  const presentationEvents =
    mode === "live"
      ? events
      : presentHandoff && handoffRun?.status === "completed"
        ? events.filter(
            (event) =>
              event.id === `run:${handoffRun.id}` ||
              event.id.startsWith(`archive:${handoffRun.id}:`),
          )
        : [];
  useSpatialEvents(identity, presentationEvents);
  return (
    <section
      className="live-workspace c-root opening"
      data-paper-open={paperOpen || undefined}
      data-experience-mode={mode}
      aria-label={mode === "live" ? "真实需求协作工作区" : "需求规划成果"}
    >
      <header className="live-workspace-heading c-hud">
        <div className="c-slate">
          <p>方案擂台</p>
          <h1>{previewText(goal, 64)}</h1>
          {goal.length > 64 && (
            <details className="live-goal-detail">
              <summary>查看完整目标</summary>
              <p>{goal}</p>
            </details>
          )}
        </div>
        <div className="live-workspace-actions c-agent">{actions}</div>
      </header>
      <div className="live-stage c-stage3">
        <div className="live-agent-grid c-world">
          {ROLES.map((role, index) => {
            const run = lastRuns[index];
            const call = activity.calls.findLast((call) => call.role === role);
            const status =
              call?.state ??
              (role === "B" && questionsPending ? "waiting" : (run?.status ?? "idle"));
            const entries =
              role === "A"
                ? items.map((item) => `${item.title} — ${item.description}`).join("\n")
                : role === "B"
                  ? (state?.rounds.at(-1)?.questions ?? [])
                      .map((question) => `${question.title} — ${question.reason}`)
                      .join("\n")
                  : state?.review
                    ? [
                        ...state.review.gaps.map((item) => item.title),
                        ...state.review.conflicts,
                      ].join("\n")
                    : "";
            return (
              <AgentCard
                key={role}
                role={role}
                status={status}
                summary={runSummary(run)}
                entries={entries}
                eventId={call?.callId ?? run?.id ?? ""}
              />
            );
          })}
        </div>
      </div>
      <section
        className="live-decision-stage"
        data-motion-anchor="decision-stage"
        aria-label="当前需求事项"
      >
        <h2>正在明确的事项</h2>
        {items.length ? (
          <>
            <DecisionItems
              items={focusItems}
              state={state}
              currentAnswers={currentAnswers}
              confirmation={confirmation}
            />
            {otherItems.length > 0 && (
              <details className="live-other-items">
                <summary>展开其余 {otherItems.length} 项需求事项</summary>
                <DecisionItems
                  items={otherItems}
                  state={state}
                  currentAnswers={currentAnswers}
                  confirmation={confirmation}
                />
              </details>
            )}
          </>
        ) : (
          <p>目标已保存。这里会呈现 Agent 实际整理出的事项。</p>
        )}
      </section>
      <section
        className="live-conclusion"
        data-motion-anchor="conclusion"
        aria-label="当前规划结论"
      >
        <h2>当前规划</h2>
        <p>{previewText(conclusion, 220)}</p>
        {conclusion.length > 220 && (
          <details className="live-conclusion-detail">
            <summary>查看完整审查结论</summary>
            <p>{conclusion}</p>
          </details>
        )}
        {children}
      </section>
      <details className="live-history">
        <summary>查看工作历史{runs.length ? ` · ${runs.length} 条记录` : ""}</summary>
        <ol>
          {runs.map((run) => (
            <li key={run.id}>
              <strong>
                {run.role} · {NAMES[run.role]}
              </strong>
              <span>
                {run.status === "completed"
                  ? "完成"
                  : run.status === "uncertain"
                    ? "结果待确认"
                    : "未完成"}
              </span>
              <p>{runSummary(run)}</p>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

export function LiveClarificationWorkspace({
  draft,
  receipt,
  onOpenQuestions,
  onReviewSummary,
  onPreview,
  onRestart,
  onOpenTools,
  disabled,
  previewDisabled = false,
  paperOpen,
  children,
}: {
  draft: IntakeDraft | IntakeDraftResponse;
  receipt?: LiveAnswerReceipt | null;
  onOpenQuestions: () => void;
  onReviewSummary?: () => void;
  onPreview: () => void;
  onRestart?: () => void;
  onOpenTools: () => void;
  disabled: boolean;
  previewDisabled?: boolean;
  paperOpen: boolean;
  children?: ReactNode;
}) {
  const response = draft as Partial<IntakeDraftResponse>;
  return (
    <PaperWorkspace
      identity={draft.id}
      goal={draft.goal}
      state={draft.clarification}
      activity={response.activity ?? EMPTY_ACTIVITY}
      currentAnswers={draft.answers}
      confirmation={draft.confirmation}
      mode="live"
      questionsPending={draft.status === "questions"}
      paperOpen={paperOpen}
      receipt={receipt}
      actions={
        <>
          <button
            type="button"
            className="secondary-button"
            data-open-live-questions
            onClick={onOpenQuestions}
          >
            {draft.questions.length ? `继续回答` : "查看梳理进度"}
          </button>
          {onReviewSummary && (
            <button
              type="button"
              className="primary-button"
              disabled={disabled}
              onClick={onReviewSummary}
            >
              核对并交接需求
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || previewDisabled}
            onClick={onPreview}
          >
            先看当前规划
          </button>
          {onRestart && (
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={onRestart}
            >
              重新梳理需求
            </button>
          )}
          <button type="button" className="text-button" onClick={onOpenTools}>
            目标与材料
          </button>
        </>
      }
    >
      {children}
    </PaperWorkspace>
  );
}

export function FormalPlanningWorkspace({
  version,
  onReplay,
  presentHandoff = false,
}: {
  version: ArenaVersion;
  onReplay: () => void;
  presentHandoff?: boolean;
}) {
  return (
    <PaperWorkspace
      identity={version.intake?.id ?? version.id}
      presentHandoff={presentHandoff}
      goal={version.challenge.goal}
      state={version.clarification}
      currentAnswers={version.intake?.answers}
      confirmation={version.intake?.confirmation}
      activity={EMPTY_ACTIVITY}
      mode="result"
      questionsPending={false}
      actions={
        <>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              const report = document.querySelector<HTMLElement>(
                '[data-motion-anchor="planning-report"]',
              );
              if (report) revealInWindow(report, { block: "start", origin: "interaction" });
            }}
          >
            查看详细规划
          </button>
          <button type="button" className="text-button" onClick={onReplay}>
            回放历史过程
          </button>
        </>
      }
    >
      <PlanningReport
        specification={version.clarification?.specification ?? ""}
        executionPrompt={version.clarification?.executionPrompt ?? ""}
        formal={!version.clarification?.draftOnly}
      />
    </PaperWorkspace>
  );
}

export function PlanningReport({
  specification,
  executionPrompt,
  formal = false,
  initiallyOpen = true,
}: {
  specification: string;
  executionPrompt: string;
  formal?: boolean;
  initiallyOpen?: boolean;
}) {
  if (!specification.trim()) return null;
  return (
    <div className="live-report" aria-label={formal ? "正式需求规划报告" : "当前规划草稿"}>
      <p className="live-report-status">{formal ? "正式需求记录" : "规划草稿 · 保留未决事项"}</p>
      <details open={initiallyOpen} data-motion-anchor="planning-report">
        <summary>详细规划报告</summary>
        <PlanningReportContent content={specification} />
      </details>
      <details data-motion-anchor="execution-prompt">
        <summary>执行提示词</summary>
        <pre>{executionPrompt}</pre>
      </details>
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          const content = `${specification}\n\n---\n\n# 执行提示词\n\n${executionPrompt}`;
          const url = URL.createObjectURL(
            new Blob([content], { type: "text/markdown;charset=utf-8" }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = "方案擂台-需求规划.md";
          link.click();
          URL.revokeObjectURL(url);
        }}
      >
        导出 Markdown
      </button>
    </div>
  );
}
