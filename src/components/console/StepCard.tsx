"use client";
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { X } from "lucide-react";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { STAGE_LABELS, type ArenaVersion, type Attack } from "@/lib/contracts";
import { holdMotion, reducedMotion, ROUTE_COLOR } from "./effects";
import { nameOf, type Beat } from "./beats";

/** One spring drives the whole flight, so nothing in it can change speed abruptly. */
type Spring = { ms: number; w: number; z: number };
const DRAW: Spring = { ms: 620, w: 14.1, z: 0.8 };
const LAND: Spring = { ms: 460, w: 19.6, z: 1 };
const STEPS = 40;
const TILT = (20 * Math.PI) / 180;

function spring(ms: number, { w, z }: Spring) {
  const t = ms / 1000;
  if (z >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}
function smooth(from: number, to: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Leave a gap where this step sits in the chain. Set on the DOM so the page never re-renders mid-flight. */
function markDeck(pulled: number | null, gap = pulled !== null) {
  document.querySelectorAll<HTMLElement>("[data-step-source]").forEach((card) => {
    const i = Number(card.dataset.stepSource);
    card.classList.toggle("pulled", i === pulled);
    card.classList.toggle("past-gap", gap && pulled !== null && i > pulled);
  });
}

/** A copy of the chain card, sitting exactly over the top of the open one until it fades. */
function faceOf(source: HTMLElement, scale: number) {
  const face = source.cloneNode(true) as HTMLElement;
  face.removeAttribute("data-step-source");
  face.removeAttribute("role");
  face.removeAttribute("tabindex");
  face.classList.remove("pulled", "past-gap");
  face.classList.add("c-pull-face");
  face.setAttribute("aria-hidden", "true");
  face.style.width = `${source.offsetWidth}px`;
  face.style.height = `${source.offsetHeight}px`;
  face.style.transform = `scale(${scale})`;
  return face;
}

/**
 * Every part of the card as a function of one number: 0 is in the chain, 1 is fully open.
 * Only transform and opacity change, so the flight runs on the compositor.
 */
function fly(el: HTMLDialogElement, index: number, from: number, to: number, how: Spring) {
  // Measured first: from here on the animations below change what the browser reports.
  const open = el.getBoundingClientRect();
  const lines = [
    ...el.querySelectorAll<HTMLElement>(
      ":scope > .tb, .c-step h3, .c-step dl > div, :scope > .actions",
    ),
  ].map((line) => ({
    line,
    bottom: Math.min(1, (line.getBoundingClientRect().bottom - open.top) / open.height),
  }));
  const source = document.querySelector<HTMLElement>(`[data-step-source="${index}"]`);
  const slot = source?.getBoundingClientRect();
  const samples = Array.from({ length: STEPS + 1 }, (_, i) =>
    i === STEPS ? to : from + (to - from) * spring((how.ms * i) / STEPS, how),
  );
  const timing = { duration: how.ms, fill: "both", easing: "linear" } as const;
  const parts: Animation[] = [
    el.animate(
      samples.map((p) => ({ opacity: smooth(0, 0.8, p) })),
      { ...timing, pseudoElement: "::backdrop" },
    ),
  ];
  el.querySelector(".c-pull-face")?.remove();
  if (!source || !slot || !source.offsetWidth) {
    parts.unshift(
      el.animate(
        samples.map((p) => ({
          transform: `translateY(${(1 - p) * 24}px) scale(${0.94 + 0.06 * p})`,
          opacity: smooth(0, 0.6, p),
        })),
        timing,
      ),
    );
    return parts;
  }
  const dx = slot.left - open.left;
  const dy = slot.top - open.top;
  const small = slot.width / open.width / Math.cos(TILT);
  const fit = open.width / source.offsetWidth;
  const low = Math.min(1, (source.offsetHeight * fit) / open.height);
  const height = (p: number) => low + (1 - low) * smooth(0.04, 0.86, p);
  parts.unshift(
    el.animate(
      samples.map((p) => {
        const x = dx * (1 - smooth(0.12, 1, p));
        const y = dy * (1 - p) - 70 * Math.sin(Math.PI * Math.min(p, 1));
        const turn = Math.max(0, 1 - p) ** 2 * 20;
        return {
          transform: `translate(${x}px,${y}px) perspective(1200px) rotateY(${turn}deg) scale(${small + (1 - small) * p})`,
        };
      }),
      timing,
    ),
    (el.querySelector(".c-pull-bg") as HTMLElement).animate(
      samples.map((p) => ({ transform: `scaleY(${Math.min(1, height(p))})` })),
      timing,
    ),
  );
  const face = faceOf(source, fit);
  el.append(face);
  parts.push(
    face.animate(
      samples.map((p) => ({ opacity: 1 - smooth(0.05, 0.3, p) })),
      timing,
    ),
  );
  // Each line of detail appears as the growing card reaches it.
  lines.forEach(({ line, bottom }) => {
    let start = 0.1;
    while (start < 1 && height(start) < bottom) start += 0.01;
    parts.push(
      line.animate(
        samples.map((p) => {
          const shown = smooth(start, start + 0.16, p);
          return { opacity: shown, transform: `translateY(${(1 - shown) * 10}px)` };
        }),
        timing,
      ),
    );
  });
  return parts;
}

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
  const body = useRef<HTMLDivElement>(null);
  const showing = useRef(index);
  const leaving = useRef(false);
  const first = useRef(true);
  const flight = useRef<{ parts: Animation[]; from: number; to: number; how: Spring; at: number }>(
    null,
  );

  const launch = (to: number, how: Spring, done: () => void) => {
    const el = ref.current;
    if (!el) return;
    const now = flight.current;
    const elapsed = now ? performance.now() - now.at : Infinity;
    const from = !now
      ? 1 - to
      : elapsed >= now.how.ms
        ? now.to
        : now.from + (now.to - now.from) * spring(elapsed, now.how);
    now?.parts.forEach((part) => part.cancel());
    const parts = fly(el, showing.current, from, to, how);
    flight.current = { parts, from, to, how, at: performance.now() };
    parts[0].onfinish = done;
  };

  // Open: draw the card out of the stack. Once there it holds no animation at all.
  useLayoutEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    holdMotion(true);
    el?.showModal();
    markDeck(index);
    if (!reducedMotion())
      launch(1, DRAW, () => {
        el?.querySelector(".c-pull-face")?.remove();
        flight.current?.parts.forEach((part) => part.cancel());
        flight.current = { parts: [], from: 1, to: 1, how: DRAW, at: 0 };
      });
    return () => {
      holdMotion(false);
      markDeck(null);
      el?.close();
      previous?.focus({ preventScroll: true });
    };
    // The card opens once; paging inside it changes content only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the gap under the step on show, including when new results redraw the chain.
  useLayoutEffect(() => {
    showing.current = index;
    if (!leaving.current) markDeck(index);
  });

  /** Put the card back, then carry on with what the viewer asked for. */
  const leave = (then: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    if (reducedMotion()) return then();
    // The later cards close up while it descends, so it lands in a slot that is ready for it.
    setTimeout(() => markDeck(showing.current, false), LAND.ms * 0.45);
    launch(0, LAND, then);
  };

  // Paging: the new step's detail slides in, on the same card.
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
      className="c-pull"
      aria-labelledby="c-pull-title"
      style={
        {
          "--route": (ROUTE_COLOR[beat.agent] ?? "11,13,16").replaceAll(",", " "),
        } as CSSProperties
      }
      onCancel={(event) => {
        event.preventDefault();
        leave(onClose);
      }}
      onClick={(event) => {
        if (event.target === ref.current) leave(onClose);
      }}
    >
      <div className="c-pull-bg" />
      <div className="tb">
        <b id="c-pull-title">
          第 {index + 1} 步 · {STAGE_LABELS[beat.stage]}
        </b>
        <span>
          {nameOf(beat.agent)}
          {beat.to ? ` → ${nameOf(beat.to)}` : ""}
          {verified ? ` · ${attackMeta[beat.attack!.status].label}` : ""}
        </span>
        <button type="button" aria-label="收起这张卡片" onClick={() => leave(onClose)}>
          <X size={17} />
        </button>
      </div>
      <div className="c-step" ref={body}>
        <h3>{beat.title}</h3>
        <dl>
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
        <button type="button" className="text-button" onClick={() => leave(() => onStage(index))}>
          在舞台上看这一步
        </button>
        {beat.attack && (
          <button
            type="button"
            className="primary-button"
            onClick={() => leave(() => onEvidence(beat.attack!))}
          >
            看证据
          </button>
        )}
      </div>
    </dialog>
  );
}
