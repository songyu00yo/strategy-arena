"use client";

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Check, MousePointer2 } from "lucide-react";
import type { IntakeAnswer, IntakeQuestion, RecordedAnswer } from "@/lib/intake-contracts";
import type { ReplayAction } from "@/lib/replay-contracts";
import { QuestionInput } from "../question-input";
import "../guided-intake.css";
import "./replay-question-scene.css";

const LABELS = {
  questions: "这一轮需要补充什么",
  answer: "回看这一项回答",
  round_confirm: "确认这一轮的回答",
  summary_submit: "确认摘要并继续查漏",
  summary_confirm: "确认最终需求摘要",
  handoff: "交接确认需求与执行提示词",
};

const BUTTONS = {
  questions: "开始回答",
  answer: "继续梳理",
  round_confirm: "确认本轮回答并继续梳理",
  summary_submit: "确认摘要并继续查漏",
  summary_confirm: "确认最终摘要",
  handoff: "查看需求与执行提示词",
};
const EMPTY_CHOICES: string[] = [];

const bounded = (progress: number) =>
  Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 1;

/** FLIP geometry is derived from measured rectangles, with no guessed source position. */
export function replayFlipGeometry(
  source: Pick<DOMRect, "left" | "top" | "width" | "height">,
  target: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0)
    return null;
  return {
    x: source.left + source.width / 2 - target.left - target.width / 2,
    y: source.top + source.height / 2 - target.top - target.height / 2,
    scaleX: source.width / target.width,
    scaleY: source.height / target.height,
  };
}

/** Display only the saved value reached by the current, externally controlled action. */
export function replayAnswerAt(
  question: IntakeQuestion,
  saved: RecordedAnswer | undefined,
  progress: number,
): IntakeAnswer {
  const empty: IntakeAnswer = {
    questionId: question.id,
    state: "answered",
    value: question.type === "multiple" ? [] : "",
  };
  if (!saved || progress < 0.32) return empty;
  if (saved.state !== "answered")
    return progress >= 0.45 ? { ...empty, state: saved.state } : empty;
  const entered = bounded((progress - 0.45) / 0.3);
  if (Array.isArray(saved.value))
    return {
      ...empty,
      value: saved.value.filter(
        (_, index) => progress >= 0.45 + index * (0.3 / Math.max(saved.value.length, 1)),
      ),
    };
  if (question.type === "single") return { ...empty, value: progress >= 0.45 ? saved.value : "" };
  const glyphs = Array.from(saved.value);
  return { ...empty, value: glyphs.slice(0, Math.ceil(entered * glyphs.length)).join("") };
}

function previousAnswer(question: IntakeQuestion, answers: RecordedAnswer[]) {
  return answers.findLast(
    (answer) =>
      answer.questionId === question.id &&
      answer.question.title === question.title &&
      answer.question.type === question.type &&
      JSON.stringify(answer.question.options) === JSON.stringify(question.options),
  );
}

function answerLabel(answer: RecordedAnswer | undefined, confirmed: boolean) {
  if (!answer) return "待回答";
  if (answer.state === "unknown") return "暂时不知道，保持未决";
  if (answer.state === "skipped") return "已跳过，保持未决";
  if (answer.needsReconfirmation) return "待重新确认";
  return confirmed ? "已确认" : "已保存，待确认";
}

export function ReplayQuestionScene({
  action,
  previousAnswers = [],
  progress = 1,
  playing = false,
  seeking = false,
}: {
  action: ReplayAction;
  previousAnswers?: RecordedAnswer[];
  progress?: number;
  playing?: boolean;
  speed?: number;
  seeking?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
  const amount = bounded(progress);
  const questions = action.questions ?? [];
  const currentAnswer = action.kind === "answer" ? action.answers?.[0] : undefined;
  const confirmed = amount >= 0.8;
  const confirming = ["round_confirm", "summary_submit", "summary_confirm", "handoff"].includes(
    action.kind,
  );
  const targetQuestion = questions.find((question) => question.id === currentAnswer?.questionId);
  const choices =
    currentAnswer?.state === "answered" && Array.isArray(currentAnswer.value)
      ? currentAnswer.value
      : EMPTY_CHOICES;
  const clickTimes = confirming
    ? [0.8]
    : choices.length
      ? choices.map((_, index) => 0.45 + index * (0.3 / choices.length))
      : [0.45];
  const targetIndex = choices.length
    ? Math.min(choices.length - 1, clickTimes.filter((time) => amount >= time).length)
    : 0;
  const moveStart = confirming || targetIndex === 0 ? 0.15 : clickTimes[targetIndex - 1];
  const moveEnd = confirming ? 0.75 : clickTimes[targetIndex];
  const movement = bounded((amount - moveStart) / (moveEnd - moveStart));
  const pressed =
    !!(currentAnswer || confirming) &&
    clickTimes.some((time) => amount >= time && amount < time + 0.05);
  const phase = amount < 0.2 ? "show" : amount < 0.8 ? "answer" : "settle";
  const closesGroup =
    action.kind === "round_confirm" ||
    action.kind === "summary_submit" ||
    action.kind === "handoff";
  const closing = playing && !seeking && closesGroup && amount > 0.94 ? (amount - 0.94) / 0.06 : 0;
  const sourceRole = action.kind === "handoff" ? "C" : "B";
  const opened = useRef(false);
  const measureFlip = useRef<() => void>(() => {});
  const point = useRef({ actionId: "", x: 0, y: 0, originX: 0, originY: 0, placed: false });
  const measurePointer = useRef<() => void>(() => {});
  const currentQuestionId = currentAnswer?.questionId;

  useLayoutEffect(() => {
    const measure = () => {
      const element = root.current;
      const stage = element?.closest<HTMLElement>(".c-stage3");
      if (!element || !stage) return;
      const previousTransform = element.style.transform;
      element.style.transform = "none";
      const target = element.getBoundingClientRect();
      element.style.transform = previousTransform;
      const stageBox = stage.getBoundingClientRect();
      const board = stage.querySelector<HTMLElement>(`[data-board="${sourceRole}"]`);
      const boardBox = board?.getBoundingClientRect();
      const visible =
        !!boardBox &&
        boardBox.width > 0 &&
        boardBox.height > 0 &&
        boardBox.right > Math.max(0, stageBox.left) &&
        boardBox.left < Math.min(innerWidth, stageBox.right) &&
        boardBox.bottom > Math.max(0, stageBox.top) &&
        boardBox.top < Math.min(innerHeight, stageBox.bottom);
      const source = visible && boardBox ? boardBox : stageBox;
      const geometry = replayFlipGeometry(source, target);
      element.dataset.flipOrigin = geometry
        ? visible
          ? `board-${sourceRole.toLowerCase()}`
          : "stage-plane"
        : "unavailable";
      element.dataset.flipFallback = visible
        ? ""
        : !board
          ? "board-missing"
          : !boardBox?.width || !boardBox.height
            ? "board-empty-size"
            : "board-outside-viewport";
      if (!geometry) {
        element.dataset.flipFallback = "source-or-target-empty-size";
        opened.current = true;
        element.style.setProperty("--replay-open", "1");
        return;
      }
      element.style.setProperty("--replay-source-x", `${geometry.x}px`);
      element.style.setProperty("--replay-source-y", `${geometry.y}px`);
      element.style.setProperty("--replay-source-scale-x", String(geometry.scaleX));
      element.style.setProperty("--replay-source-scale-y", String(geometry.scaleY));
    };
    measureFlip.current = measure;
    measure();
  }, [action.id, sourceRole]);

  useLayoutEffect(() => {
    const isOpening = action.kind === "questions" || action.kind === "summary_submit";
    if (!playing || seeking || !isOpening || amount >= 0.18) opened.current = true;
    const opening = opened.current ? 1 : bounded(amount / 0.18);
    root.current?.style.setProperty("--replay-open", String(opening));
    if (root.current) root.current.dataset.replayOpened = String(opened.current);
  }, [action.kind, amount, playing, seeking]);

  useLayoutEffect(() => {
    const viewport = body.current;
    if (!viewport || !currentQuestionId) return;
    const fieldset = [...viewport.querySelectorAll<HTMLElement>("[data-question-id]")].find(
      (node) => node.dataset.questionId === currentQuestionId,
    );
    if (fieldset)
      viewport.scrollTop +=
        fieldset.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8;
  }, [action.id, currentQuestionId]);

  useLayoutEffect(() => {
    const viewport = body.current;
    if (!viewport || action.kind !== "questions" || !playing) return;
    const travel = bounded((amount - 0.2) / 0.6);
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight) * travel;
  }, [action.id, action.kind, amount, playing]);

  useLayoutEffect(() => {
    const measure = () => {
      const element = root.current;
      const viewport = body.current;
      const cursor = pointer.current;
      if (!element || !viewport || !cursor) return;
      const fieldset = [...element.querySelectorAll<HTMLElement>("[data-question-id]")].find(
        (node) => node.dataset.questionId === currentAnswer?.questionId,
      );
      const optionInput = (value: string | undefined) => {
        const label = [
          ...(fieldset?.querySelectorAll<HTMLElement>("[data-answer-option]") ?? []),
        ].find((node) => node.dataset.answerOption === value);
        return label?.querySelector<HTMLElement>("input") ?? label ?? null;
      };
      let target: HTMLElement | null = null;
      if (confirming) target = element.querySelector<HTMLElement>("[data-replay-confirm]");
      else if (currentAnswer?.state === "unknown" || currentAnswer?.state === "skipped")
        target =
          fieldset?.querySelector<HTMLElement>(`[data-answer-state="${currentAnswer.state}"]`) ??
          null;
      else if (targetQuestion?.type === "single" || targetQuestion?.type === "multiple")
        target = optionInput(
          choices.length ? choices[targetIndex] : String(currentAnswer?.value ?? ""),
        );
      else target = fieldset?.querySelector<HTMLElement>("[data-answer-field]") ?? null;
      if (!target) {
        cursor.style.visibility = "hidden";
        return;
      }
      const targetBox = target.getBoundingClientRect();
      const viewportBox = viewport.getBoundingClientRect();
      if (
        playing &&
        !confirming &&
        amount >= 0.15 &&
        (targetBox.top < viewportBox.top + 12 || targetBox.bottom > viewportBox.bottom - 12)
      )
        viewport.scrollTop += targetBox.top - viewportBox.top - viewportBox.height * 0.35;
      const panel = element.getBoundingClientRect();
      const scaleX = panel.width / Math.max(1, element.offsetWidth);
      const scaleY = panel.height / Math.max(1, element.offsetHeight);
      const positionOf = (node: HTMLElement) => {
        const box = node.getBoundingClientRect();
        return {
          x: (box.left + Math.min(box.width / 2, 22) - panel.left) / scaleX,
          y: (box.top + box.height / 2 - panel.top) / scaleY,
        };
      };
      const destination = positionOf(target);
      const state = point.current;
      if (state.actionId !== action.id) {
        const heading = element.querySelector<HTMLElement>("h3");
        const origin = state.placed
          ? { x: state.x, y: state.y }
          : heading
            ? positionOf(heading)
            : destination;
        state.actionId = action.id;
        state.originX = origin.x;
        state.originY = origin.y;
      }
      const previousControl =
        choices.length && targetIndex > 0 ? optionInput(choices[targetIndex - 1]) : null;
      const origin = previousControl
        ? positionOf(previousControl)
        : { x: state.originX, y: state.originY };
      state.x = origin.x + (destination.x - origin.x) * movement;
      state.y = origin.y + (destination.y - origin.y) * movement;
      state.placed = true;
      cursor.style.left = `${state.x}px`;
      cursor.style.top = `${state.y}px`;
      cursor.style.visibility = "visible";
    };
    measurePointer.current = measure;
    measure();
  }, [
    action.id,
    amount,
    choices,
    confirming,
    currentAnswer,
    movement,
    targetIndex,
    targetQuestion,
    playing,
  ]);

  useLayoutEffect(() => {
    const element = root.current;
    const viewport = body.current;
    if (!element || !viewport) return;
    const measure = () => {
      measureFlip.current();
      measurePointer.current();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    viewport.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
    };
  }, []);

  const rows = questions.length
    ? questions.map((question) => ({
        question,
        saved:
          action.answers?.find((answer) => answer.questionId === question.id) ??
          previousAnswer(question, previousAnswers),
      }))
    : previousAnswers.map((answer) => ({ question: answer.question, saved: answer }));
  const summary = action.summary?.challenge;
  const summaryFields: Array<[string, string]> = summary
    ? [
        ["目标", summary.goal],
        ["硬性限制", summary.constraints || "未说明"],
        ["偏好", summary.preferences || "未说明"],
        ["已有想法", summary.options.join("\n") || "未说明"],
        ["预算（元）", summary.budget == null ? "未说明" : String(summary.budget)],
        ["时间（小时）", summary.timeHours == null ? "未说明" : String(summary.timeHours)],
        ["材料", summary.materials || "未说明"],
      ]
    : [];

  return (
    <section
      ref={root}
      className={`replay-question-scene guided-intake ${playing ? "is-playing" : ""} ${seeking ? "is-seeking" : ""}`}
      aria-label="补问过程回放"
      data-replay-action={action.kind}
      data-replay-phase={phase}
      style={{ "--replay-fold": closing } as CSSProperties}
    >
      <header className="replay-question-heading">
        <div>
          <span>
            第 {action.round} 轮 · 需求修订 {action.revision}
          </span>
          <h3>{LABELS[action.kind]}</h3>
        </div>
        <p>按保存记录重建，动画节奏为演示编排</p>
      </header>
      <div ref={body} className="replay-question-body">
        {questions.length ? (
          rows.map(({ question, saved }) => {
            const editing = action.kind === "answer" && currentAnswer?.questionId === question.id;
            const shown = editing
              ? replayAnswerAt(question, saved, amount)
              : replayAnswerAt(question, saved, 1);
            const savedConfirmed =
              saved?.state === "answered" &&
              saved.confirmation === "confirmed" &&
              !saved.needsReconfirmation;
            const committed =
              !editing && savedConfirmed && (action.kind !== "round_confirm" || confirmed);
            return (
              <div
                key={question.id}
                className={`replay-question-item ${editing ? "is-current" : ""}`}
              >
                <QuestionInput
                  question={question}
                  answer={shown}
                  onChange={() => {}}
                  disabled={false}
                  readOnly
                />
                <p
                  className="replay-answer-status"
                  data-confirmation={committed ? "confirmed" : "pending"}
                >
                  {editing && saved?.state === "answered"
                    ? amount < 0.75
                      ? "正在填写，待确认"
                      : "已填写，待确认"
                    : answerLabel(editing && amount < 0.45 ? undefined : saved, committed)}
                </p>
              </div>
            );
          })
        ) : summary ? (
          <dl className="replay-summary-answers">
            {summaryFields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {!!action.summary?.assumptions.length && (
              <div>
                <dt>暂定假设，待核对</dt>
                <dd>{action.summary.assumptions.join("\n")}</dd>
              </div>
            )}
          </dl>
        ) : (
          <>
            <p className="replay-summary-source">
              这次操作未保存完整摘要，下面显示此前已回放的回答。
            </p>
            <dl className="replay-summary-answers">
              {rows.map(({ question, saved }) => (
                <div key={question.id}>
                  <dt>{question.title}</dt>
                  <dd>
                    {saved?.state === "answered"
                      ? Array.isArray(saved.value)
                        ? saved.value.join("、")
                        : saved.value
                      : answerLabel(saved, false)}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
      <footer className="replay-question-footer">
        <p role="status">
          {confirming && confirmed
            ? action.kind === "handoff"
              ? "交接记录已生成"
              : action.kind === "summary_submit"
                ? "摘要已提交，继续查漏"
                : "本次确认已记录"
            : action.kind === "answer"
              ? amount < 0.75
                ? "正在填写，待确认"
                : "已填写，待确认"
              : "按记录回看本轮操作"}
        </p>
        <button
          type="button"
          disabled
          data-replay-confirm
          className={`primary-button ${confirming && confirmed ? "is-confirmed" : ""}`}
        >
          {confirming && confirmed && <Check size={16} />}
          {BUTTONS[action.kind]}
        </button>
      </footer>
      <div
        ref={pointer}
        className="replay-question-pointer"
        aria-hidden="true"
        style={{ opacity: amount >= 0.15 && amount < 0.96 ? 1 : 0 }}
        data-pressed={pressed}
      >
        <MousePointer2 size={25} />
      </div>
    </section>
  );
}
