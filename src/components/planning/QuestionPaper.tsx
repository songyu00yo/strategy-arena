"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, LoaderCircle, PencilLine, RefreshCw, X } from "lucide-react";
import type { PlanningAnswerInput, PlanningQuestion } from "@/lib/planning-contracts";
import type { PlanningController } from "../use-planning";
import { agentPaperAnchor } from "./paper-motion";
import { usePaperDialog } from "./use-paper-dialog";
import { answerText, emptyPlanningAnswer, planningAnswerError } from "./client-utils";

const answerKey = (sessionId: string, question: PlanningQuestion) =>
  `strategy-arena:planning:answer:${sessionId}:${question.id}:${question.version}`;
function restoreAnswer(key: string, question: PlanningQuestion) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as PlanningAnswerInput | null;
    if (saved?.questionId === question.id && saved.questionVersion === question.version)
      return saved;
  } catch {}
  return emptyPlanningAnswer(question);
}

export function QuestionPaper({
  question,
  controller,
  onClose,
  continuation = false,
}: {
  question: PlanningQuestion;
  controller: PlanningController;
  onClose: () => void;
  continuation?: boolean;
}) {
  const id = useId();
  const session = controller.snapshot!.session;
  const storageKey = answerKey(session.id, question);
  const [answer, setAnswer] = useState(() => restoreAnswer(storageKey, question));
  const [ownAnswer, setOwnAnswer] = useState(
    () => question.type === "text" || !!restoreAnswer(storageKey, question).text,
  );
  const [validation, setValidation] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const submitting = useRef(false);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const current = session.questions.find(
    (entry) => entry.id === question.id && entry.version === question.version,
  );
  const isActive = current?.status === "active";
  const busy = saving || recovering || previewing || controller.pendingAction !== null;
  const accepted = session.answers.find(
    (entry) => entry.questionId === question.id && entry.questionVersion === question.version,
  );
  const acceptedId = accepted?.id;
  const received =
    !!accepted &&
    controller.arrivals.some(
      (event) =>
        event.kind === "answer_saved" &&
        (event.answerId === accepted.id ||
          (event.questionId === question.id && event.questionVersion === question.version)),
    );
  const nextQuestion = useRef(false);
  const { dialog, close, leaving, reflow } = usePaperDialog({
    anchor: () => agentPaperAnchor(question.askedBy),
    continuation,
    onClose,
  });
  useLayoutEffect(() => {
    nextQuestion.current = session.questions.some(
      (entry) => entry.status === "active" && entry.id !== question.id,
    );
  }, [session.questions, question.id]);

  const previewAcknowledged =
    previewing &&
    current?.status === "withdrawn" &&
    session.progress.endedEarly &&
    session.status === "working";
  const previewAgent = session.agents.find(
    (agent) => agent.status === "running" && agent.operationId === session.activeOperationId,
  )?.id;
  useEffect(() => {
    // The polling snapshot acknowledges collection closing before the paid model
    // request finishes. Reveal its live progress without discarding the draft.
    if (previewAcknowledged) close(agentPaperAnchor(previewAgent ?? "D"), true);
  }, [previewAcknowledged, previewAgent, close]);

  useEffect(() => {
    if (!received || !acceptedId) return;
    let departure: ReturnType<typeof setTimeout> | undefined;
    const feedback = setTimeout(() => {
      setReceipt(true);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      departure = setTimeout(
        () => close(agentPaperAnchor(question.answerTo), nextQuestion.current),
        220,
      );
    }, 120);
    return () => {
      clearTimeout(feedback);
      clearTimeout(departure);
    };
  }, [received, acceptedId, storageKey, question.answerTo, close]);

  const change = (next: PlanningAnswerInput) => {
    setAnswer(next);
    setValidation("");
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  };
  const submit = async (value: PlanningAnswerInput) => {
    if (
      submitting.current ||
      busy ||
      !isActive ||
      receipt ||
      received ||
      leaving.current ||
      controller.unknownRequest ||
      !session.capabilities.canAnswer
    )
      return;
    const problem = planningAnswerError(question, value);
    if (problem) return setValidation(problem);
    submitting.current = true;
    change(value);
    setSaving(true);
    setFailed(false);
    try {
      const result = await controller.act({ kind: "answer", answers: [value] });
      if (!result) setFailed(true);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  const retry = async () => {
    if (recovering || busy) return;
    setRecovering(true);
    try {
      await controller.retryUnknown();
    } finally {
      setRecovering(false);
    }
  };
  const preview = async () => {
    if (
      submitting.current ||
      busy ||
      received ||
      controller.unknownRequest ||
      !session.capabilities.canPreview
    )
      return;
    submitting.current = true;
    setPreviewing(true);
    try {
      if (await controller.act({ kind: "preview" })) close();
    } finally {
      submitting.current = false;
      setPreviewing(false);
    }
  };
  const select = (optionId: string) => ({
    ...answer,
    state: "answered" as const,
    optionIds: [optionId],
  });
  const showOwnAnswer = () => {
    reflow(
      () => setOwnAnswer(true),
      () => textInput.current?.focus({ preventScroll: true }),
    );
  };
  const showContinue =
    question.type !== "single" || ownAnswer || answer.optionIds.length > 0 || failed;
  const disabled =
    busy || !isActive || received || controller.unknownRequest || !session.capabilities.canAnswer;
  const unanswered = session.questions.filter((entry) => entry.status === "active").length;

  return (
    <dialog
      ref={dialog}
      className={`p-paper p-question-paper ${receipt ? "is-receipt" : ""}`}
      aria-labelledby={`${id}-${receipt ? "receipt" : "question"}-title`}
      aria-busy={busy && !received}
      onCancel={(event) => {
        event.preventDefault();
        if (!received) close();
      }}
    >
      <header className="p-paper-top">
        <div>
          <span className="p-paper-number">{receipt ? "已保存" : "确认需求"}</span>
          <span>{receipt ? `你 → ${question.answerTo}` : `${question.askedBy} → 你`}</span>
          {!receipt && unanswered > 1 && (
            <small className="p-question-progress">待答 {unanswered} 题</small>
          )}
        </div>
        <button
          type="button"
          className="p-paper-close"
          aria-label="暂时收起问题"
          disabled={received}
          onClick={() => close()}
        >
          <X size={18} />
        </button>
      </header>
      <div className="p-paper-content">
        <form
          style={receipt ? { visibility: "hidden" } : undefined}
          aria-hidden={receipt || undefined}
          inert={receipt}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(answer);
          }}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit(answer);
            }
          }}
        >
          <div className="p-paper-body">
            <div className="p-paper-fold" aria-hidden="true" />
            <h2 id={`${id}-question-title`}>{question.title}</h2>
            {question.reason && <p className="p-question-reason">{question.reason}</p>}
            {!isActive && !received && !previewing && (
              <p className="p-inline-error" role="alert">
                问题已更新。当前填写内容仍已保留。
              </p>
            )}
            <fieldset disabled={disabled} className="p-answer-fields">
              <legend className="sr-only">你的回答</legend>
              {(question.type === "single" || question.type === "multiple") && (
                <div
                  className="p-options"
                  role="group"
                  aria-label={question.type === "single" ? "选择一个方向" : "选择适合的方向"}
                >
                  {question.options.map((option, index) => {
                    const chosen = answer.optionIds.includes(option.id);
                    return (
                      <label className={`p-option ${chosen ? "chosen" : ""}`} key={option.id}>
                        <input
                          type={question.type === "single" ? "radio" : "checkbox"}
                          name={`${id}-choice`}
                          checked={chosen}
                          aria-label={option.label}
                          onClick={() => {
                            if (question.type === "single") void submit(select(option.id));
                          }}
                          onChange={() =>
                            change(
                              question.type === "single"
                                ? select(option.id)
                                : {
                                    ...answer,
                                    state: "answered",
                                    optionIds: chosen
                                      ? answer.optionIds.filter((value) => value !== option.id)
                                      : [...answer.optionIds, option.id],
                                  },
                            )
                          }
                          onKeyDown={(event) => {
                            if (
                              question.type !== "single" ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.nativeEvent.isComposing
                            )
                              return;
                            if (
                              [
                                "ArrowDown",
                                "ArrowRight",
                                "ArrowUp",
                                "ArrowLeft",
                                "Home",
                                "End",
                              ].includes(event.key)
                            ) {
                              event.preventDefault();
                              const offset = ["ArrowDown", "ArrowRight"].includes(event.key)
                                ? 1
                                : -1;
                              const next =
                                event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? question.options.length - 1
                                    : (index + offset + question.options.length) %
                                      question.options.length;
                              change(select(question.options[next].id));
                              dialog.current
                                ?.querySelectorAll<HTMLInputElement>('input[type="radio"]')
                                [next]?.focus({ preventScroll: true });
                            } else if (event.key === " " || event.key === "Enter") {
                              event.preventDefault();
                              void submit(select(option.id));
                            }
                          }}
                        />
                        <span className="p-option-index" aria-hidden="true">
                          {chosen ? <Check size={16} /> : String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="p-option-copy">
                          <strong>{option.label}</strong>
                          {option.description && <span>{option.description}</span>}
                          {option.consequences.length > 0 && (
                            <small>{option.consequences.join(" · ")}</small>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {question.type === "single" && (
                <p className="p-answer-hint">点选即保存。方向键浏览，空格或回车确认。</p>
              )}
              {question.type === "number" && (
                <label className="p-own-answer">
                  <span id={`${id}-number-label`}>
                    你的数值{question.unit ? `（${question.unit}）` : ""}
                  </span>
                  <input
                    type="number"
                    aria-labelledby={`${id}-number-label`}
                    data-paper-focus
                    step="any"
                    placeholder={question.placeholder}
                    value={answer.number ?? ""}
                    onChange={(event) =>
                      change({
                        ...answer,
                        state: "answered",
                        number: event.target.value === "" ? null : Number(event.target.value),
                      })
                    }
                  />
                </label>
              )}
              {!ownAnswer && (
                <button
                  type="button"
                  className="text-button p-own-answer-toggle"
                  onClick={showOwnAnswer}
                >
                  <PencilLine size={13} />
                  自己填写
                </button>
              )}
              {ownAnswer && (
                <label className="p-own-answer">
                  <span id={`${id}-text-label`}>
                    {question.type === "text" ? "你的想法" : "补充或自己的方向"}
                  </span>
                  <textarea
                    ref={textInput}
                    aria-labelledby={`${id}-text-label`}
                    data-paper-focus
                    rows={question.type === "text" ? 4 : 2}
                    maxLength={6000}
                    value={answer.text}
                    placeholder={question.placeholder || "写下具体要求"}
                    onChange={(event) =>
                      change({ ...answer, state: "answered", text: event.target.value })
                    }
                  />
                </label>
              )}
            </fieldset>
            {(validation || controller.error) && !received && (
              <p className="p-inline-error" role="alert">
                {validation || controller.error}
              </p>
            )}
          </div>
          <footer className="p-paper-bottom">
            <div className="p-answer-alternatives">
              {question.allowUnknown && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void submit({ ...emptyPlanningAnswer(question), state: "unknown" })
                  }
                >
                  暂时不知道
                </button>
              )}
              {question.allowSkip && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void submit({ ...emptyPlanningAnswer(question), state: "skipped" })
                  }
                >
                  跳过
                </button>
              )}
              {session.capabilities.canPreview && (
                <button
                  type="button"
                  disabled={busy || received || controller.unknownRequest}
                  onClick={() => void preview()}
                >
                  先看分析
                </button>
              )}
            </div>
            {controller.unknownRequest && !received ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void retry()}
              >
                <RefreshCw size={14} />
                核对保存状态
              </button>
            ) : (
              showContinue && (
                <button
                  className="primary-button p-answer-submit"
                  disabled={disabled || !!planningAnswerError(question, answer)}
                  type="submit"
                >
                  {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
                  {busy ? "保存中" : failed ? "重试保存" : "继续"}
                </button>
              )
            )}
            <span className="p-answer-status" role="status">
              {previewing
                ? "正在整理分析…"
                : received
                  ? "已保存"
                  : busy
                    ? "保存中…"
                    : controller.unknownRequest
                      ? "保存结果待核对，回答已保留。"
                      : failed
                        ? "未保存成功，当前回答已保留。"
                        : ownAnswer || question.type !== "single"
                          ? "⌘ / Ctrl + Enter 继续"
                          : ""}
            </span>
          </footer>
        </form>
        {receipt && accepted && (
          <div className="p-receipt-content is-compact" role="status">
            <span className="p-stamp">已保存</span>
            <Check size={20} />
            <h2 id={`${id}-receipt-title`}>
              {accepted.state === "unknown"
                ? "已记录：暂时不知道"
                : accepted.state === "skipped"
                  ? "已记录：跳过"
                  : "回答已保存"}
            </h2>
            <p>{answerText(question, accepted)}</p>
            <small>
              {accepted.state === "unknown" || accepted.state === "skipped"
                ? "保留为未确定事项"
                : `交给 ${question.answerTo} 继续分析`}
            </small>
          </div>
        )}
      </div>
    </dialog>
  );
}
