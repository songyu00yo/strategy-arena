"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { reducedMotion } from "@/components/console/effects";
import { useOverlayMotion } from "./overlay-motion";
import "./overlay-motion.css";
import {
  ArrowRight,
  FileSearch,
  Calculator,
  X,
  CornerDownRight,
  ExternalLink,
  LocateFixed,
} from "lucide-react";
import type { ArenaVersion, Attack, Evidence } from "@/lib/contracts";
import { attackMeta, decisionMeta, evidenceMeta, StatusTag } from "@/components/status";

function EvidenceItem({ item }: { item: Evidence }) {
  const external = /^https?:\/\//.test(item.source);
  return (
    <article className={`evidence-item evidence-${item.status}`}>
      <div className="evidence-item-heading">
        {item.tool === "calculate" ? <Calculator size={16} /> : <FileSearch size={16} />}
        <h4>{item.title}</h4>
        <StatusTag meta={evidenceMeta[item.status]} />
      </div>
      {item.expression && (
        <div className="calculation">
          <code>{item.expression}</code>
          <ArrowRight size={16} />
          <strong>{item.result ?? "无法计算"}</strong>
        </div>
      )}
      {item.assumptions && (
        <p className="evidence-assumptions">
          <strong>计算假设：</strong>
          {item.assumptions}
        </p>
      )}
      <p className="evidence-content">{item.content || "此项未返回可用内容。"}</p>
      <div className="evidence-source">
        <span>来源</span>
        {external ? (
          <a href={item.source} target="_blank" rel="noreferrer">
            {item.source}
            <ExternalLink size={11} />
          </a>
        ) : (
          <span>{item.source}</span>
        )}
      </div>
      {item.sourceIds.length > 0 && (
        <p className="source-ids">材料定位：{item.sourceIds.join("、")}</p>
      )}
    </article>
  );
}
export function EvidenceDrawer({
  attack,
  version,
  onClose,
  onLocate,
}: {
  attack: Attack;
  version: ArenaVersion;
  onClose: () => void;
  onLocate: (attack: Attack) => void;
}) {
  const { panel: dialogRef, backdrop, close } = useOverlayMotion<HTMLElement>("drawer", onClose);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousAttack = useRef(attack.id);
  // A different citation changes the content in place; snapshot refreshes do not re-enter it.
  useLayoutEffect(() => {
    if (previousAttack.current === attack.id) return;
    previousAttack.current = attack.id;
    const content = contentRef.current;
    if (!content) return;
    content.scrollTop = 0;
    if (reducedMotion()) return;
    const animation = content.animate(
      [
        { opacity: 0.5, transform: "translateX(10px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: "cubic-bezier(.16,1,.3,1)" },
    );
    return () => animation.cancel();
  }, [attack.id]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input, textarea, summary, [tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [close, dialogRef]);
  const evidence = version.evidence.filter((e) => e.attackId === attack.id);
  const revision = version.revisions.find((r) => r.strategyId === attack.targetStrategyId);
  const response = revision?.responses.find((r) => r.attackId === attack.id);
  const borrowed = version.revisions
    .filter((r) => r.strategyId !== attack.targetStrategyId)
    .flatMap((r) =>
      r.responses
        .filter((response) => response.attackId === attack.id)
        .map((response) => ({ revision: r, response })),
    );
  const finding = version.verdict?.attackFindings.find((f) => f.attackId === attack.id);
  // Show what a citation points at, never a bare internal evidence ID.
  const citations = (ids: string[]) =>
    ids.map((id) => version.evidence.find((e) => e.id === id)?.title ?? id).join("、");
  return (
    <div className="drawer-backdrop overlay-motion" ref={backdrop} onClick={() => close()}>
      <aside
        ref={dialogRef}
        className="evidence-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-heading">
          <div>
            <span className="eyebrow">证据链</span>
            <h2 id="evidence-title">这一条，站得住吗？</h2>
            <div className="drawer-summary">
              <StatusTag meta={attackMeta[attack.status]} />
              <span>
                {attack.from} 质疑路线 {attack.targetStrategyId}
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => close(() => onLocate(attack))}
              >
                <LocateFixed size={13} aria-hidden="true" />
                在路线 {attack.targetStrategyId} 中定位
              </button>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => close()}
            data-overlay-autofocus
            aria-label="关闭证据详情"
          >
            <X size={22} />
          </button>
        </div>
        <div className="drawer-scroll" ref={contentRef}>
          <section className="evidence-section">
            <span className="evidence-step">01 / 被挑战的原话</span>
            <blockquote>{attack.claimQuote}</blockquote>
            <span className="evidence-route">
              路线 {attack.targetStrategyId} · 判断 {attack.targetClaimId}
            </span>
          </section>
          <section className="evidence-section">
            <span className="evidence-step red">02 / {attack.from} 提出的质疑</span>
            <h3>{attack.reason}</h3>
            <p>{attack.impact}</p>
            <div className="verify-plan">
              <FileSearch size={15} />
              <span>
                <strong>核验方法</strong>
                {attack.verification}
              </span>
            </div>
          </section>
          <section className="evidence-section">
            <span className="evidence-step">03 / 工具返回的证据</span>
            {evidence.length ? (
              evidence.map((e) => <EvidenceItem key={e.id} item={e} />)
            ) : (
              <div className="evidence-empty">
                <FileSearch size={24} />
                <p>尚未获得核验结果</p>
                <span>这里会展示材料原文、计算过程与来源。没有依据时会明确保留未知。</span>
              </div>
            )}
          </section>
          <section className="evidence-section">
            <span className="evidence-step">04 / 路线如何回应</span>
            {response ? (
              <div className="revision-response">
                <StatusTag meta={decisionMeta[response.decision]} />
                <p>{response.reason}</p>
                {response.change && (
                  <div className="response-change">
                    <CornerDownRight size={15} />
                    <span>{response.change}</span>
                  </div>
                )}
                {response.evidenceIds.length > 0 && (
                  <small>引用证据：{citations(response.evidenceIds)}</small>
                )}
              </div>
            ) : (
              <p className="muted">等待策略修订阶段回应。</p>
            )}
          </section>
          {borrowed.length > 0 && (
            <section className="evidence-section">
              <span className="evidence-step">其他路线借鉴</span>
              <p className="borrow-note">
                以下路线将这条质疑用于检查自身，不代表被质疑路线接受了质疑。
              </p>
              {borrowed.map(({ revision: other, response: otherResponse }) => (
                <div className="borrowed-revision" key={other.strategyId}>
                  <h3>
                    路线 {other.strategyId} · {other.strategy.title}
                  </h3>
                  <span className="response-decision">
                    {
                      {
                        accept: "采纳为自身修订依据",
                        reject: "未采纳至本路线",
                        unresolved: "本路线仍需确认",
                      }[otherResponse.decision]
                    }
                  </span>
                  <p>{otherResponse.reason}</p>
                  {otherResponse.change && (
                    <div className="response-change">
                      <CornerDownRight size={15} />
                      <span>{otherResponse.change}</span>
                    </div>
                  )}
                  <div className="borrowed-action">
                    <strong>该路线现在的第一步</strong>
                    <p>{other.strategy.firstAction}</p>
                  </div>
                </div>
              ))}
            </section>
          )}
          {finding && (
            <section className="evidence-section finding-section">
              <span className="evidence-step">最终裁决中的回应</span>
              <span className={`finding-status ${finding.status}`}>
                {
                  {
                    supported: "这项质疑成立",
                    refuted: "这项质疑被反驳",
                    unresolved: "证据不足，仍未决",
                  }[finding.status]
                }
              </span>
              <h3>{finding.reason}</h3>
              {finding.evidenceIds.length > 0 && (
                <small>裁决引用证据：{citations(finding.evidenceIds)}</small>
              )}
              <p>
                {version.verdict?.preferred && (
                  <strong>当前建议路线 {version.verdict.preferred} · </strong>
                )}
                {version.verdict?.headline}
              </p>
            </section>
          )}
          {revision && (
            <section className="evidence-section next-action-section">
              <span className="evidence-step">05 / 转化成行动</span>
              <h3>{revision.strategy.firstAction}</h3>
              <p>
                <strong>留意失效条件：</strong>
                {revision.strategy.failureCondition}
              </p>
            </section>
          )}
        </div>
        <div className="drawer-footer">材料检索只查找你提供的文本；计算结果取决于输入与假设。</div>
      </aside>
    </div>
  );
}
