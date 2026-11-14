"use client";

import { useId } from "react";
import type { IntakeAnswer, IntakeQuestion } from "@/lib/intake-contracts";
import {
  decodeChoiceValue,
  encodeOtherValue,
  isOtherOption,
  MAX_ANSWER_LENGTH,
  OTHER_SEPARATOR,
} from "@/lib/answer-options";
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
  const currentValues = Array.isArray(value) ? value : [String(value)];
  const selectedValue = (option: string) =>
    currentValues.find((entry) => decodeChoiceValue(entry, question.options)?.option === option);
  const withoutOption = (option: string) =>
    currentValues.filter((entry) => decodeChoiceValue(entry, question.options)?.option !== option);
  const totalLength = currentValues.reduce((sum, entry) => sum + entry.length, 0);
  const otherSelected = question.options.some(
    (option) => isOtherOption(option) && selectedValue(option) !== undefined,
  );
  const setValue = (value: IntakeAnswer["value"]) => {
    if (!readOnly) onChange({ ...answer, state: "answered", value });
  };
  const toggleOption = (option: string, chosen: boolean) => {
    const selected = isOtherOption(option) ? encodeOtherValue(option, "") : option;
    if (question.type === "single") {
      setValue(selected);
      return;
    }
    const next = withoutOption(option);
    if (!chosen) next.push(selected);
    if (next.reduce((sum, entry) => sum + entry.length, 0) <= MAX_ANSWER_LENGTH) setValue(next);
  };
  const fields =
    question.type === "single" || question.type === "multiple" ? (
      <>
        <div className="gi-answer-options" aria-describedby={`${id}-reason`}>
          {question.options.map((option) => {
            const chosen = selectedValue(option) !== undefined;
            const addedLength =
              option.length + (isOtherOption(option) ? OTHER_SEPARATOR.length : 0);
            return (
              <label key={option} className={chosen ? "selected" : ""} data-answer-option={option}>
                <input
                  type={question.type === "single" ? "radio" : "checkbox"}
                  name={id}
                  checked={chosen}
                  disabled={
                    question.type === "multiple" &&
                    !chosen &&
                    (totalLength + addedLength > MAX_ANSWER_LENGTH ||
                      (isOtherOption(option) && otherSelected))
                  }
                  onChange={() => toggleOption(option, chosen)}
                />
                <span>{option}</span>
              </label>
            );
          })}
        </div>
        {question.options.filter(isOtherOption).map((option) => {
          const entry = selectedValue(option);
          if (entry === undefined) return null;
          const detail = decodeChoiceValue(entry, question.options)?.detail ?? "";
          const remaining = question.type === "multiple" ? withoutOption(option) : [];
          const remainingLength = remaining.reduce((sum, entry) => sum + entry.length, 0);
          return (
            <label key={option} className="gi-answer-field gi-other-answer">
              <span>补充“{option}”的具体内容</span>
              <textarea
                rows={2}
                maxLength={Math.max(
                  0,
                  MAX_ANSWER_LENGTH - option.length - OTHER_SEPARATOR.length - remainingLength,
                )}
                value={detail}
                data-answer-field
                placeholder="请具体说明你的选择"
                aria-label={`补充“${option}”的具体内容`}
                aria-describedby={`${id}-reason`}
                onChange={(event) => {
                  const encoded = encodeOtherValue(option, event.target.value);
                  if (encoded.length + remainingLength > MAX_ANSWER_LENGTH) return;
                  setValue(question.type === "single" ? encoded : [...remaining, encoded]);
                }}
              />
              {!detail.trim() && (
                <small role="status">请补充具体内容。可以先保存草稿，暂不完成本轮确认。</small>
              )}
            </label>
          );
        })}
      </>
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
            maxLength={MAX_ANSWER_LENGTH}
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
