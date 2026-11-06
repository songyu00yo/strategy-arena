"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, GitCompareArrows, LoaderCircle } from "lucide-react";
import type { ArenaVersion } from "@/lib/contracts";
import type { DecisionReview } from "@/lib/decision-review";
import { Modal } from "./modal";
import { DisclosureMotion } from "./disclosure-motion";
import "./decision-review-panel.css";

const CHOICE_LABELS: Record<string, string> = {
  conditional: "可按条件试行",
  violates: "存在硬限制冲突",
  unknown: "关键条件待确认",
  A: "倾向路线 A",
  B: "倾向路线 B",
  C: "倾向路线 C",
  tie: "几条路线各有所长",
  insufficient: "先补齐关键依据",
  infeasible: "先解决条件冲突",
};
const QUESTION_LABELS: Record<string, string> = {
  route_a: "路线 A",
  route_b: "路线 B",
  route_c: "路线 C",
  preference: "选择倾向",
};

export function DecisionReviewPanel({
  arenaId,
  version,
  configured,
  readOnly = false,
}: {
  arenaId: string;
  version: ArenaVersion;
  configured: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<DecisionReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const endpoint = `/api/arenas/${arenaId}/decision-review`;
  useEffect(() => {
    alive.current = true;
    const requests = controllers.current;
    return () => {
      alive.current = false;
      requests.forEach((controller) => controller.abort());
    };
  }, []);

  async function request(method: "GET" | "POST") {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const response = await fetch(
        method === "GET" ? `${endpoint}?versionId=${version.id}` : endpoint,
        {
          method,
          cache: "no-store",
          signal: controller.signal,
          headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
          body:
            method === "POST"
              ? JSON.stringify({ versionId: version.id, operationId: crypto.randomUUID() })
              : undefined,
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "暂时无法读取复核，请稍后重试。");
      if (alive.current) setReview(data);
      return data as DecisionReview | null;
    } finally {
      controllers.current.delete(controller);
    }
  }

  useEffect(() => {
    if (!open && !busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${endpoint}?versionId=${version.id}`, { cache: "no-store" });
        const data = await response.json();
        if (stopped || !alive.current) return;
        if (!response.ok) throw new Error(data.error || "读取复核进度失败。");
        setReview(data);
        if (busy || data?.status === "pending") timer = setTimeout(poll, 1200);
      } catch (failure) {
        if (!stopped && alive.current)
          setError(failure instanceof Error ? failure.message : "读取复核进度失败。");
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, busy, endpoint, version.id]);

  const run = async () => {
    if (
      inFlight.current ||
      !configured ||
      readOnly ||
      review?.status === "pending" ||
      review?.status === "uncertain"
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await request("POST");
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : "复核请求尚未完成。");
        await request("GET").catch(() => {});
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const pending = busy || review?.status === "pending";
  const preference = review?.answers.find((answer) => answer.name === "preference");
  const candidate =
    preference?.type === "choice" && ["A", "B", "C"].includes(preference.choice)
      ? preference.choice
      : null;
  const violates =
    candidate &&
    version.verdict?.comparisons.some(
      (comparison) => comparison.strategyId === candidate && comparison.status === "violates",
    );
  return (
    <>
      <button
        type="button"
        className="text-button"
        onClick={(event) => {
          setTrigger(event.currentTarget);
          setOpen(true);
        }}
      >
        <GitCompareArrows size={14} /> 快速复核
      </button>
      {open && (
        <Modal title="快速复核 · Decisions" trigger={trigger} onClose={() => setOpen(false)}>
          <div className="decision-review" data-motion-origin="interaction">
            <p className="decision-review-intro">
              使用 GPT 6 Luna，对照本版本的目标、硬限制和已有证据，再检查三条路线。费用单独记录。
            </p>
            <div className="decision-review-original">
              <small>V{version.number} 本轮结论</small>
              <strong>{version.verdict?.headline}</strong>
            </div>
            {!configured && <p role="status">请先配置 OpenAI 模型，才能运行这项复核。</p>}
            {readOnly && !review && <p>历史版本可查看已保存的复核记录。</p>}
            {(!review || review.canRetry) && !readOnly && (
              <button
                type="button"
                className="primary-button"
                disabled={!configured || pending}
                onClick={() => void run()}
              >
                {pending ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}
                {pending ? "正在复核…" : review ? "重新请求复核" : "用 Luna 运行快速复核"}
              </button>
            )}
            {pending && <p role="status">正在检查本版本，关闭后可回来查看结果。</p>}
            {(error || review?.error) && (
              <p className="decision-review-error" role="alert">
                {error || review?.error}
              </p>
            )}
            {review?.status === "uncertain" && (
              <p>调用结果与费用待确认，已保留预留，暂停再次发送。</p>
            )}
            {review?.stale && (
              <p className="decision-review-error">
                这是先前输入或配置下的复核记录，请按记录对应的版本理解。
              </p>
            )}
            <DisclosureMotion open={review?.status === "completed"}>
              <div className="decision-review-results">
                {review?.answers.map((answer) => (
                  <div
                    className={`decision-review-answer ${answer.name === "preference" ? "preference" : ""}`}
                    key={answer.name}
                  >
                    <span>{QUESTION_LABELS[answer.name] ?? answer.name}</span>
                    <strong>
                      {answer.type === "refusal"
                        ? "本项未作判断"
                        : (CHOICE_LABELS[answer.choice] ?? answer.choice)}
                    </strong>
                  </div>
                ))}
                {candidate && (
                  <p>
                    {version.verdict?.preferred === candidate
                      ? "这次复核与本轮建议一致。"
                      : `本轮${version.verdict?.preferred ? `建议 ${version.verdict.preferred}` : "保留了多个可能方向"}，复核倾向 ${candidate}。可结合证据查看分歧。`}
                  </p>
                )}
                {violates && (
                  <p className="decision-review-error">
                    该路线已记录硬限制冲突，需要先解决冲突再考虑执行。
                  </p>
                )}
                <button
                  type="button"
                  className="text-button"
                  aria-expanded={details}
                  onClick={() => setDetails(!details)}
                >
                  {details ? "收起判断分布" : "展开判断分布"}
                </button>
                <DisclosureMotion open={details}>
                  {review?.answers
                    .filter((answer) => answer.type === "choice")
                    .map((answer) => (
                      <div className="decision-review-distribution" key={answer.name}>
                        <strong>
                          {QUESTION_LABELS[answer.name]} · 模型判断信心{" "}
                          {(answer.confidence * 100).toFixed(1)}%
                        </strong>
                        {answer.probabilities.map((item) => (
                          <div key={String(item.value)}>
                            <span>{CHOICE_LABELS[String(item.value)] ?? String(item.value)}</span>
                            <meter min={0} max={1} value={item.probability} />
                            <span>{(item.probability * 100).toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                    ))}
                </DisclosureMotion>
                <p className="decision-review-note">
                  分值反映 Luna 对本次输入的判断。实际行动仍需满足明确限制，并核对关键未知项。
                </p>
              </div>
            </DisclosureMotion>
            {review?.usage && (
              <p className="decision-review-cost">
                本次复核约 ${(review.usage.estimatedUsd ?? 0).toFixed(6)} ·{" "}
                {review.usage.inputTokens.toLocaleString()} 输入 Token ·{" "}
                {(review.usage.durationMs / 1000).toFixed(2)} 秒
              </p>
            )}
            {(review?.reservedUsd ?? 0) > 0 && (
              <p className="decision-review-cost">调用中预留 ${review!.reservedUsd.toFixed(6)}</p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
