"use client";

import { useId } from "react";
import type { IntakeAnswer, IntakeQuestion } from "@/lib/intake-contracts";
import { DisclosureMotion } from "./disclosure-motion";

export function QuestionInput({
  question,
  answer,
  onChange,
  disabled,
  readOnly = false,
}: {
  question: IntakeQuestion;
  answer: IntakeAnswer;
  onChange: (answer: IntakeAnswer) => void;
  disabled: boolean;
  readOnly?: boolean;
}) {
  const id = useId();
  const active = answer.state === "answered";
  const value = readOnly && !active ? (question.type === "multiple" ? [] : "") : answer.value;
  const setValue = (value: IntakeAnswer["value"]) => {
    if (!readOnly) onChange({ ...answer, state: "answered", value });
  };
  const fields =
    question.type === "single" || question.type === "multiple" ? (
      <div className="gi-answer-options" aria-describedby={`${id}-reason`}>
        {question.options.map((option) => {
          const chosen = Array.isArray(value) ? value.includes(option) : value === option;
          return (
            <label key={option} className={chosen ? "selected" : ""} data-answer-option={option}>
              <input
                type={question.type === "single" ? "radio" : "checkbox"}
                name={id}
                checked={chosen}
                onChange={() =>
                  setValue(
                    question.type === "single"
                      ? option
                      : chosen
                        ? (Array.isArray(answer.value) ? answer.value : []).filter(
                            (v) => v !== option,
                          )
                        : [...(Array.isArray(answer.value) ? answer.value : []), option],
                  )
                }
              />
              <span>{option}</span>
            </label>
          );
        })}
      </div>
    ) : (
      <label className="gi-answer-field">
        <span className="sr-only">{question.title}</span>
        {question.type === "number" ? (
          <input
            type="number"
            value={String(value)}
            data-answer-field
            placeholder={question.placeholder}
            aria-describedby={`${id}-reason`}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <textarea
            rows={2}
            maxLength={3000}
            value={String(value)}
            data-answer-field
            placeholder={question.placeholder}
            aria-describedby={`${id}-reason`}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {question.unit && <small>{question.unit}</small>}
      </label>
    );
  return (
    <fieldset
      className="gi-question"
      disabled={disabled || readOnly}
      data-question-id={question.id}
    >
      <legend>{question.title}</legend>
      <p id={`${id}-reason`}>
        {question.authorization
          ? `${question.reason} 本项授权范围为${question.authorization}`
          : question.reason}
      </p>
      <div className="gi-answer-states" role="group" aria-label="回答方式">
        {(
          [
            ["answered", "我来补充"],
            ["unknown", "暂时不知道"],
            ["skipped", "跳过"],
          ] as const
        ).map(([state, label]) => (
          <button
            key={state}
            type="button"
            aria-pressed={answer.state === state}
            data-answer-state={state}
            onClick={() => {
              if (!readOnly) onChange({ ...answer, state });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {readOnly ? (
        <div id={`${id}-answer`} className="gi-answer-readonly">
          {fields}
        </div>
      ) : (
        <DisclosureMotion open={active} id={`${id}-answer`}>
          {fields}
        </DisclosureMotion>
      )}
    </fieldset>
  );
}
