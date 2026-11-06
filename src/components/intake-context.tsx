"use client";

import { useId, useState } from "react";
import type { ArenaVersion } from "@/lib/contracts";
import { DisclosureMotion } from "./disclosure-motion";

export function IntakeContext({ intake }: { intake: NonNullable<ArenaVersion["intake"]> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  return (
    <div className="intake-context">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? "收起任务依据" : "查看补充回答与材料"}
      </button>
      <DisclosureMotion open={open} id={id}>
        <div className="intake-context-body">
          <p>
            <strong>原始目标</strong> {intake.originalGoal}
          </p>
          {intake.answers.map((answer) => (
            <p key={answer.questionId}>
              <strong>{answer.question.title}</strong>{" "}
              {answer.state === "answered"
                ? Array.isArray(answer.value)
                  ? answer.value.join("、")
                  : answer.value
                : answer.state === "unknown"
                  ? "暂时不知道"
                  : "暂不提供"}
            </p>
          ))}
          {intake.assumptions.length > 0 && (
            <div>
              <strong>本轮暂定假设</strong>
              <ul>
                {intake.assumptions.map((assumption, index) => (
                  <li key={index}>{assumption}</li>
                ))}
              </ul>
            </div>
          )}
          {intake.usedSources.length > 0 && <strong>本轮采用的材料片段</strong>}
          {intake.usedSources.map((source) => (
            <div key={source.id}>
              <button
                type="button"
                className="text-button"
                aria-expanded={sourceId === source.id}
                aria-controls={`${id}-${source.id}`}
                onClick={() => setSourceId(sourceId === source.id ? null : source.id)}
              >
                {source.filename} · {source.location}
              </button>
              <DisclosureMotion open={sourceId === source.id} id={`${id}-${source.id}`}>
                <blockquote>{source.text}</blockquote>
                <a href={`/api/intakes/${intake.id}/attachments/${source.attachmentId}`} download>
                  下载原附件
                </a>
              </DisclosureMotion>
            </div>
          ))}
        </div>
      </DisclosureMotion>
    </div>
  );
}
