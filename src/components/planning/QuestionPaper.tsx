"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, LoaderCircle, X } from "lucide-react";
import type { PlanningAnswerInput, PlanningQuestion } from "@/lib/planning-contracts";
import type { PlanningController } from "../use-planning";
import { acquireMotionHold } from "../console/motion-runtime";
import { agentPaperAnchor, animatePaper, paperCorners } from "./paper-motion";
import { answerText, emptyPlanningAnswer, planningAnswerError } from "./client-utils";

const answerKey = (sessionId: string, question: PlanningQuestion) =>
  `strategy-arena:planning:answer:${sessionId}:${question.id}:${question.version}`;

export function QuestionPaper({
  question,
  controller,
  onClose,
}: {
  question: PlanningQuestion;
  controller: PlanningController;
  onClose: () => void;
}) {
  const id = useId();
  const session = controller.snapshot!.session;
  const storageKey = answerKey(session.id, question);
  const [answer, setAnswer] = useState<PlanningAnswerInput>(emptyPlanningAnswer(question));
  const [validation, setValidation] = useState("");
  const [receipt, setReceipt] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const stopFlight = useRef<(() => void) | null>(null);
  const leaving = useRef(false);
  const onCloseRef = useRef(onClose);
  const current = session.questions.find(
    (entry) => entry.id === question.id && entry.version === question.version,
  );
  const isActive = current?.status === "active";
  const busy = controller.pendingAction !== null;
  const accepted = session.answers.find(
    (entry) => entry.questionId === question.id && entry.questionVersion === question.version,
  );
  const acceptedRef = useRef(accepted);
  const acceptedId = accepted?.id;
  const received =
    accepted &&
    controller.arrivals.some(
      (event) =>
        event.kind === "answer_saved" &&
        (event.answerId === accepted.id ||
          (event.questionId === question.id && event.questionVersion === question.version)),
    );
  useLayoutEffect(() => {
    acceptedRef.current = accepted;
    onCloseRef.current = onClose;
  }, [accepted, onClose]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(
          sessionStorage.getItem(storageKey) ?? "null",
        ) as PlanningAnswerInput | null;
        if (saved?.questionId === question.id && saved.questionVersion === question.version)
          setAnswer(saved);
      } catch {}
    });
    return () => cancelAnimationFrame(frame);
  }, [storageKey, question.id, question.version]);
  const change = (next: PlanningAnswerInput) => {
    setAnswer(next);
    setValidation("");
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  };

  const close = () => {
    if (leaving.current) return;
    leaving.current = true;
    const pose = dialog.current ? paperCorners(dialog.current) : undefined;
    stopFlight.current?.();
    if (!dialog.current) return onCloseRef.current();
    stopFlight.current = animatePaper(
      dialog.current,
      agentPaperAnchor(question.askedBy),
      false,
      () => onCloseRef.current(),
      pose,
    );
  };

  useLayoutEffect(() => {
    const paper = dialog.current;
    if (!paper) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = acquireMotionHold();
    paper.showModal();
    stopFlight.current = animatePaper(paper, agentPaperAnchor(question.askedBy), true);
    // Focus is usable immediately; it never waits for the paper's decorative flight.
    paper
      .querySelector<HTMLElement>("textarea, input, .p-option, .p-paper-close")
      ?.focus({ preventScroll: true });
    const resize = () => {
      stopFlight.current?.();
      paper.style.transform = "";
      if (leaving.current) onCloseRef.current();
    };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => {
      if (media.matches) resize();
    };
    addEventListener("resize", resize);
    media.addEventListener("change", preference);
    return () => {
      stopFlight.current?.();
      release();
      paper.close();
      removeEventListener("resize", resize);
      media.removeEventListener("change", preference);
      queueMicrotask(() => {
        if (before?.isConnected && !document.querySelector("dialog[open]"))
          before.focus({ preventScroll: true });
      });
    };
  }, [question.askedBy]);

  useEffect(() => {
    const savedAnswer = acceptedRef.current;
    if (!received || !savedAnswer || leaving.current) return;
    leaving.current = true;
    const frame = requestAnimationFrame(() => {
      setReceipt(true);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
    });
    const timer = setTimeout(
      () => {
        const pose = dialog.current ? paperCorners(dialog.current) : undefined;
        stopFlight.current?.();
        if (dialog.current)
          stopFlight.current = animatePaper(
            dialog.current,
            agentPaperAnchor(savedAnswer.question.answerTo),
            false,
            () => onCloseRef.current(),
            pose,
          );
        else onCloseRef.current();
      },
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 720,
    );
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [received, acceptedId, storageKey]);

  const submit = async (value: PlanningAnswerInput) => {
    if (busy || !isActive || receipt || leaving.current) return;
    const problem = planningAnswerError(question, value);
    if (problem) return setValidation(problem);
    change(value);
    await controller.act({ kind: "answer", answers: [value] });
  };

  return (
    <dialog
      ref={dialog}
      className={`p-paper ${receipt ? "is-receipt" : ""}`}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        if (!receipt) close();
      }}
    >
      <header className="p-paper-top">
        <div>
          <span className="p-paper-number">{receipt ? "回执" : "请你定夺"}</span>
          <span>{receipt ? `你 → ${question.answerTo}` : `${question.askedBy} → 你`}</span>
        </div>
        <button
          type="button"
          className="p-paper-close"
          aria-label="暂时收起问题"
          disabled={receipt}
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      {receipt && accepted ? (
        <div className="p-receipt-content" role="status">
          <span className="p-stamp">已收到</span>
          <Check size={24} />
          <h2 id={`${id}-title`}>你的回答，已经收到。</h2>
          <p>{answerText(question, accepted)}</p>
          <small>
            {accepted.state === "unknown"
              ? "仍保留为未知"
              : accepted.state === "skipped"
                ? "已记下暂时跳过"
                : "已保存"}{" "}
            · 交给 {question.answerTo} 继续细化
          </small>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(answer);
          }}
        >
          <div className="p-paper-body">
            <div className="p-paper-fold" aria-hidden="true" />
            <p className="p-eyebrow">
              {session.agents.find((agent) => agent.id === question.askedBy)?.name ??
                question.askedBy}{" "}
              递来一个问题
            </p>
            <h2 id={`${id}-title`}>{question.title}</h2>
            <p className="p-question-reason">{question.reason}</p>
            {!isActive && (
              <p className="p-inline-error" role="alert">
                这张问题纸已经处理或更新。你的草稿仍保留，请收起后查看当前问题。
              </p>
            )}
            <fieldset
              disabled={busy || !isActive || !session.capabilities.canAnswer}
              className="p-answer-fields"
            >
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
                          onChange={() =>
                            change({
                              ...answer,
                              state: "answered",
                              optionIds:
                                question.type === "single"
                                  ? [option.id]
                                  : chosen
                                    ? answer.optionIds.filter((value) => value !== option.id)
                                    : [...answer.optionIds, option.id],
                            })
                          }
                        />
                        <span className="p-option-index" aria-hidden="true">
                          {chosen ? <Check size={16} /> : String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="p-option-copy">
                          <strong>{option.label}</strong>
                          <span>{option.description}</span>
                          {option.consequences.length > 0 && (
                            <small>{option.consequences.join(" · ")}</small>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {question.type === "number" && (
                <label className="p-own-answer">
                  <span>你的数值{question.unit ? `（${question.unit}）` : ""}</span>
                  <input
                    type="number"
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
              <label className="p-own-answer">
                <span>
                  {question.type === "text" ? "写下你的想法" : "也可以补充，或提出自己的方向"}
                </span>
                <textarea
                  rows={question.type === "text" ? 4 : 2}
                  maxLength={6000}
                  value={answer.text}
                  placeholder={question.placeholder || "不必组织得很完整，照你的想法说。"}
                  onChange={(event) =>
                    change({ ...answer, state: "answered", text: event.target.value })
                  }
                />
              </label>
            </fieldset>
            {(validation || controller.error) && (
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
                  disabled={busy || !isActive}
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
                  disabled={busy || !isActive}
                  onClick={() =>
                    void submit({ ...emptyPlanningAnswer(question), state: "skipped" })
                  }
                >
                  暂时跳过
                </button>
              )}
            </div>
            <button
              className="primary-button p-answer-submit"
              disabled={busy || !isActive || !session.capabilities.canAnswer}
              type="submit"
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUpRight size={16} />}
              {busy ? "正在保存" : "把回答递回去"}
            </button>
            <small>
              <ArrowLeft size={12} />
              可以收起继续看；未提交的文字会留在这张纸上。
            </small>
          </footer>
        </form>
      )}
    </dialog>
  );
}
