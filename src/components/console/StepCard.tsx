"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { STAGE_LABELS, type ArenaVersion, type Attack } from "@/lib/contracts";
import { leaveAs, reducedMotion, ROUTE_COLOR } from "./effects";
import { nameOf, type Beat } from "./beats";

/**
 * How to draw an open card as the one in the chain: same top-left, same width, and cropped to the
 * chain card's height so the first frame reads as that card and not a tiny page.
 */
function slotOf(index: number, open: DOMRect) {
  const slot = document.querySelector(`[data-step-source="${index}"]`)?.getBoundingClientRect();
  if (!slot) return null;
  const scale = slot.width / open.width;
  return {
    dx: slot.left - open.left,
    dy: slot.top - open.top,
    scale,
    crop: Math.max(0, open.height - slot.height / scale),
  };
}
const TILT = "perspective(1200px) rotateY(20deg)";
const FULL = "inset(-120px)";

type Row = { label: string; text: string; tone?: string };

/** Everything recorded about one step, in the order a reader would question it. */
function rowsOf(version: ArenaVersion, beat: Beat, known: Beat[]): Row[] {
  const clean = (rows: Row[]) => rows.filter((row) => row.text);
  if (beat.attack) {
    const a = beat.attack;
    const checked = known.some((b) => b.id === `v:${a.id}`);
    const reply = known
      .find((b) => b.id === `r:${a.targetStrategyId}`)
      ?.revision?.responses.find((r) => r.attackId === a.id);
    const evidence = version.evidence
      .filter((e) => e.attackId === a.id)
      .map((e) =>
        [
          e.title,
          e.expression ? `${e.expression} = ${e.result ?? "无法计算"}` : "",
          e.assumptions,
          e.content || evidenceMeta[e.status].label,
        ]
          .filter(Boolean)
          .map((part) => part.replace(/[。.]+$/, ""))
          .join("。"),
      );
    return clean([
      { label: `${a.targetStrategyId} 的原话`, text: a.claimQuote },
      { label: `${a.from} 为什么质疑`, text: a.reason },
      { label: "如果质疑成立", text: a.impact },
      { label: "怎么核验", text: a.verification },
      {
        label: "核验结果",
        text: checked ? [attackMeta[a.status].label, ...evidence].join("：") : "这一步还没有结果。",
        tone: checked ? `is-${a.status}` : "",
      },
      {
        label: `${a.targetStrategyId} 的回应`,
        text: reply
          ? [decisionMeta[reply.decision].label, reply.reason, reply.change]
              .filter(Boolean)
              .join("。")
          : "这一步还没有回应。",
      },
    ]);
  }
  if (beat.strategy) {
    const s = beat.strategy;
    return clean([
      { label: "核心思路", text: s.thesis },
      { label: "预计投入", text: `${s.estimatedHours ?? "?"} 小时，¥${s.estimatedCost ?? "?"}` },
      { label: "关键判断", text: s.claims.map((c) => `${c.id}：${c.text}`).join("\n") },
      { label: "步骤", text: s.steps.map((step, i) => `${i + 1}. ${step}`).join("\n") },
      { label: "第一步", text: s.firstAction },
      { label: "什么情况下放弃", text: s.failureCondition },
    ]);
  }
  if (beat.revision) {
    const r = beat.revision;
    return clean([
      { label: "这次修订", text: r.summary },
      { label: "改了什么", text: (beat.changes ?? []).join("、") || "没有改动。" },
      {
        label: "怎么回应质疑",
        text: r.responses
          .map((x) =>
            [decisionMeta[x.decision].label, x.reason, x.change].filter(Boolean).join("。"),
          )
          .join("\n"),
      },
      {
        label: "修订后的判断",
        text: r.strategy.claims.map((c) => `${c.id}：${c.text}`).join("\n"),
      },
    ]);
  }
  if (beat.verdict) {
    const v = beat.verdict;
    return clean([
      { label: "结论", text: v.headline },
      { label: "理由", text: v.rationale },
      { label: "下一步", text: v.nextActions.join("\n") },
      { label: "前提", text: v.conditions.join("\n") },
      { label: "仍需确认", text: v.uncertainties.join("\n") },
      { label: "退出条件", text: v.exitCondition },
    ]);
  }
  return [];
}

/**
 * A step drawn out of the chain: the same card slides up from its place in the stack, turns to face
 * the viewer and grows to reveal its detail. Closing puts it back. The page behind stays where it was.
 */
export function StepCard({
  version,
  beats,
  index,
  last,
  reviewing,
  onOpen,
  onStage,
  onEvidence,
  onClose,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  /** The furthest step the viewer has reached; later ones are not shown. */
  last: number;
  reviewing: boolean;
  onOpen: (index: number) => void;
  onStage: (index: number) => void;
  onEvidence: (attack: Attack) => void;
  onClose: () => void;
}) {
  const beat = beats[index];
  const known = reviewing ? beats : beats.slice(0, last + 1);
  const ref = useRef<HTMLDialogElement>(null);
  const showing = useRef(index);
  const first = useRef(true);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    showing.current = index;
  }, [index]);

  // Close: the card goes back into its slot, wherever the viewer has paged to by then.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (!el) return;
      const slot = slotOf(showing.current, el.getBoundingClientRect());
      leaveAs(
        el,
        slot
          ? [
              { transform: "none", clipPath: FULL, offset: 0 },
              {
                transform: `translate(${slot.dx}px,${slot.dy - 120}px) perspective(1200px) rotateY(8deg) scale(${slot.scale * 1.05})`,
                clipPath: `inset(0 0 ${slot.crop * 0.8}px 0)`,
                offset: 0.68,
              },
              {
                transform: `translate(${slot.dx}px,${slot.dy}px) ${TILT} scale(${slot.scale})`,
                clipPath: `inset(0 0 ${slot.crop}px 0)`,
                offset: 1,
              },
            ]
          : [
              { transform: "none", opacity: 1 },
              { transform: "translateY(18px) scale(.94)", opacity: 0 },
            ],
        {
          duration: 430,
          backdrop: "rgb(11 13 16 / 0.42)",
          easing: "cubic-bezier(.5,0,.2,1)",
          display: "flex",
        },
      );
    };
  }, []);

  // Open: draw the card out of the stack.
  useLayoutEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (el && !reducedMotion()) {
      const open = el.getBoundingClientRect();
      const slot = slotOf(index, open);
      el.animate(
        slot
          ? [
              {
                transform: `translate(${slot.dx}px,${slot.dy}px) ${TILT} scale(${slot.scale})`,
                clipPath: `inset(0 0 ${slot.crop}px 0)`,
                offset: 0,
              },
              {
                transform: `translate(${slot.dx}px,${slot.dy - 130}px) perspective(1200px) rotateY(6deg) scale(${slot.scale * 1.05})`,
                clipPath: `inset(0 0 ${slot.crop * 0.8}px 0)`,
                offset: 0.34,
              },
              { transform: "translate(0,-6px) scale(1.01)", clipPath: FULL, offset: 0.84 },
              { transform: "none", clipPath: FULL, offset: 1 },
            ]
          : [
              { transform: "translateY(24px) scale(.94)", opacity: 0 },
              { transform: "none", opacity: 1 },
            ],
        { duration: slot ? 680 : 320, easing: "cubic-bezier(.55,0,.15,1)" },
      );
    }
    const settled = setTimeout(() => setArrived(true), 720);
    return () => {
      document.body.style.overflow = overflow;
      clearTimeout(settled);
      el?.close();
      // The source card is hidden until this one is back in its slot, and hidden things cannot take focus.
      setTimeout(() => {
        if (document.activeElement === document.body) previous?.focus({ preventScroll: true });
      }, 450);
    };
    // The card opens once; paging inside it changes content only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paging: the new step's detail slides in, on the same card.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reducedMotion()) return;
    body.current?.animate(
      [
        { transform: "translateX(26px)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 280, easing: "cubic-bezier(.16,1,.3,1)" },
    );
  }, [index]);

  const verified = beat.attack && known.some((b) => b.id === `v:${beat.attack!.id}`);
  return (
    <dialog
      ref={ref}
      className={`c-pull ${arrived ? "arrived" : ""}`}
      aria-labelledby="c-pull-title"
      style={
        {
          "--route": (ROUTE_COLOR[beat.agent] ?? "11,13,16").replaceAll(",", " "),
        } as CSSProperties
      }
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="tb">
        <b id="c-pull-title">
          第 {index + 1} 步 · {STAGE_LABELS[beat.stage]}
        </b>
        <span>
          {nameOf(beat.agent)}
          {beat.to ? ` → ${nameOf(beat.to)}` : ""}
          {verified ? ` · ${attackMeta[beat.attack!.status].label}` : ""}
        </span>
        <button type="button" aria-label="收起这张卡片" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="c-step" ref={body}>
        <h3>{beat.title}</h3>
        <dl key={beat.id}>
          {rowsOf(version, beat, known).map((row) => (
            <div key={row.label} className={row.tone}>
              <dt>{row.label}</dt>
              <dd>{row.text}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="actions">
        <button
          type="button"
          className="secondary-button"
          disabled={index <= 0}
          onClick={() => onOpen(index - 1)}
        >
          上一步
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={index >= last}
          onClick={() => onOpen(index + 1)}
        >
          下一步
        </button>
        <span />
        <button type="button" className="text-button" onClick={() => onStage(index)}>
          在舞台上看这一步
        </button>
        {beat.attack && (
          <button type="button" className="primary-button" onClick={() => onEvidence(beat.attack!)}>
            看证据
          </button>
        )}
      </div>
    </dialog>
  );
}
