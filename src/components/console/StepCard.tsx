"use client";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { X } from "lucide-react";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { STAGE_LABELS, type ArenaVersion, type Attack } from "@/lib/contracts";
import { reducedMotion, ROUTE_COLOR } from "./effects";
import { acquireMotionHold } from "./motion-runtime";
import "./step-card-motion.css";
import { nameOf, type Beat } from "./beats";

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];
type Matrix = [number, number, number, number, number, number, number, number, number];
type Flight = { parts: Animation[]; path: (t: number) => Quad; at: number; ms: number };
const DRAW_MS = 620;
const LAND_MS = 460;
const HANDOFF = 0.7;
const SAMPLES = 40;

/** Read the projected border corners, including every ancestor's perspective. */
function corners(el: HTMLElement): Quad {
  const points = [
    [0, 0],
    [el.offsetWidth, 0],
    [el.offsetWidth, el.offsetHeight],
    [0, el.offsetHeight],
  ].map(([x, y]) => {
    const marker = document.createElement("i");
    marker.style.cssText = `position:absolute;left:${x - el.clientLeft}px;top:${y - el.clientTop}px;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden`;
    marker.setAttribute("aria-hidden", "true");
    el.append(marker);
    return marker;
  });
  const quad = points.map((marker) => {
    const box = marker.getBoundingClientRect();
    return { x: box.left, y: box.top };
  }) as Quad;
  points.forEach((marker) => marker.remove());
  return quad;
}

/** A planar homography maps the whole card, not an estimated tilted bounding box. */
function project(width: number, height: number, q: Quad): Matrix {
  const [a, b, c, d] = q;
  const dx1 = b.x - c.x;
  const dx2 = d.x - c.x;
  const dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y;
  const dy2 = d.y - c.y;
  const dy3 = a.y - b.y + c.y - d.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(det) > 0.0001 ? (dx3 * dy2 - dx2 * dy3) / det : 0;
  const h = Math.abs(det) > 0.0001 ? (dx1 * dy3 - dx3 * dy1) / det : 0;
  return [
    (b.x - a.x + g * b.x) / width,
    (d.x - a.x + h * d.x) / height,
    a.x,
    (b.y - a.y + g * b.y) / width,
    (d.y - a.y + h * d.y) / height,
    a.y,
    g / width,
    h / height,
    1,
  ];
}
function inverse(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((n) => n / det) as Matrix;
}
function multiply(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3) * 3;
    const col = i % 3;
    return a[row] * b[col] + a[row + 1] * b[col + 3] + a[row + 2] * b[col + 6];
  }) as Matrix;
}
function cssMatrix(m: Matrix) {
  return `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,${m[8]})`;
}
function progress(t: number, opening = false) {
  if (t >= 1) return 1;
  const ms = opening ? DRAW_MS : LAND_MS;
  const w = opening ? 14.1 : 19.6;
  const z = opening ? 0.8 : 1;
  const seconds = (t * ms) / 1000;
  if (z >= 1) return 1 - (1 + w * seconds) * Math.exp(-w * seconds);
  const wd = w * Math.sqrt(1 - z * z);
  return (
    1 -
    Math.exp(-z * w * seconds) * (Math.cos(wd * seconds) + ((z * w) / wd) * Math.sin(wd * seconds))
  );
}
function pathBetween(from: Quad, to: Quad, ms: number, velocity?: Quad, opening = false) {
  return (t: number): Quad => {
    const settled = progress(t, opening);
    const momentum = t * (1 - t) ** 3 * ms;
    const lift = -70 * Math.sin(Math.PI * Math.min(1, settled)) ** 2;
    return from.map((point, i) => ({
      x: point.x + (to[i].x - point.x) * settled + (velocity?.[i].x ?? 0) * momentum,
      y: point.y + (to[i].y - point.y) * settled + (velocity?.[i].y ?? 0) * momentum + lift,
    })) as Quad;
  };
}
function stopFlight(flight: Flight | null) {
  flight?.parts.forEach((part) => {
    part.onfinish = null;
    part.cancel();
  });
}
function velocityOf(flight: Flight | null): Quad | undefined {
  if (!flight) return;
  const elapsed = Math.min(flight.ms, performance.now() - flight.at);
  if (elapsed >= flight.ms) return;
  const now = flight.path(elapsed / flight.ms);
  const before = flight.path(Math.max(0, elapsed - 8) / flight.ms);
  const dt = Math.max(1, Math.min(elapsed, 8));
  return now.map((p, i) => ({ x: (p.x - before[i].x) / dt, y: (p.y - before[i].y) / dt })) as Quad;
}

/** Preserve the source card's own styling without a computed-style walk through its text. */
function copyCard(source: HTMLElement) {
  const clone = source.cloneNode(true) as HTMLElement;
  const style = getComputedStyle(source);
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background",
    "border",
    "border-top",
    "box-shadow",
  ]) {
    clone.style.setProperty(property, style.getPropertyValue(property));
  }
  [
    clone,
    ...clone.querySelectorAll<HTMLElement>("[id], [role], [tabindex], [data-step-source]"),
  ].forEach((node) => {
    node.removeAttribute("id");
    node.removeAttribute("role");
    node.removeAttribute("tabindex");
    node.removeAttribute("data-step-source");
  });
  clone.classList.remove("pulled", "past-gap");
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  return clone;
}
function sourceOf(index: number) {
  const source = document.querySelector<HTMLElement>(`[data-step-source="${index}"]`);
  const box = source?.getBoundingClientRect();
  return source && box && box.width > 1 && box.height > 1 ? source : null;
}

/** Gap movements use the same clock as the flight, with no deferred class changes. */
function markDeck(pulled: number | null, gap = pulled !== null, ms = 240) {
  document.querySelectorAll<HTMLElement>("[data-step-source]").forEach((card) => {
    card.style.setProperty("--deck-gap-ms", `${ms}ms`);
    const i = Number(card.dataset.stepSource);
    card.classList.toggle("pulled", i === pulled);
    card.classList.toggle("past-gap", gap && pulled !== null && i > pulled);
  });
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
  const flight = useRef<Flight | null>(null);
  const proxy = useRef<HTMLElement | null>(null);
  const paging = useRef<Animation | null>(null);
  const closingAction = useRef<(() => void) | null>(null);
  const gapOrigins = useRef<{ card: HTMLElement; x: number; y: number }[]>([]);

  const clearFlight = () => {
    stopFlight(flight.current);
    flight.current = null;
    proxy.current?.remove();
    proxy.current = null;
    ref.current?.querySelector(".c-pull-face")?.remove();
  };

  const fly = (opening: boolean, done: () => void, continuing = false) => {
    const el = ref.current;
    if (!el) return;
    const source = sourceOf(showing.current);
    const current = corners(el);
    const currentTransform = getComputedStyle(el).transform;
    const currentOpacity = Number(getComputedStyle(el).opacity);
    const velocity = velocityOf(flight.current);
    const detail = [...el.children].filter(
      (node) => !node.classList.contains("c-pull-face"),
    ) as HTMLElement[];
    const initialOpacity = detail.map((node) => Number(getComputedStyle(node).opacity));
    const oldFace = el.querySelector<HTMLElement>(".c-pull-face");
    const initialFace = oldFace ? Number(getComputedStyle(oldFace).opacity) : 0;
    const backdropOpacity = Number(getComputedStyle(el, "::backdrop").opacity);
    clearFlight();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const open = corners(el);
    const base = inverse(project(width, height, open));
    const ms = source ? (opening ? DRAW_MS : LAND_MS) : 200;
    const slot = source ? corners(source) : open;
    const from = opening && !continuing ? slot : current;
    const to = opening ? open : slot;
    const path = pathBetween(from, to, ms, opening && !continuing ? undefined : velocity, opening);
    const timing = { duration: ms, easing: "linear", fill: "both" } as const;
    const parts: Animation[] = [];
    const add = (node: Element, frames: Keyframe[], options: KeyframeAnimationOptions = {}) => {
      const animation = node.animate(frames, { ...timing, ...options });
      parts.push(animation);
      return animation;
    };
    const geometry = Array.from({ length: SAMPLES + 1 }, (_, i) => ({
      transform: cssMatrix(multiply(base, project(width, height, path(i / SAMPLES)))),
    }));
    const driver = add(
      el,
      source
        ? geometry
        : [
            {
              transform: opening ? "translateY(12px) scale(.98)" : currentTransform,
              opacity: opening ? 0 : currentOpacity,
            },
            {
              transform: opening ? "none" : "translateY(8px) scale(.98)",
              opacity: opening ? 1 : 0,
            },
          ],
    );
    add(
      el,
      [{ opacity: opening && !continuing ? 0 : backdropOpacity }, { opacity: opening ? 1 : 0 }],
      {
        pseudoElement: "::backdrop",
        easing: "cubic-bezier(.2,.8,.3,1)",
      },
    );

    if (source) {
      const face = copyCard(source);
      face.classList.add("c-pull-face");
      face.style.width = `${source.offsetWidth}px`;
      face.style.height = `${source.offsetHeight}px`;
      face.style.transform = `scale(${width / source.offsetWidth},${height / source.offsetHeight})`;
      face.style.transformOrigin = "0 0";
      face.style.boxShadow = getComputedStyle(source).boxShadow;
      el.append(face);
      add(
        face,
        opening
          ? [
              { opacity: continuing ? initialFace : 1 },
              { opacity: 0, offset: 0.36 },
              { opacity: 0 },
            ]
          : [{ opacity: initialFace }, { opacity: 1, offset: 0.42 }, { opacity: 1 }],
      );
      detail.forEach((node, i) =>
        add(
          node,
          opening
            ? [
                { opacity: continuing ? initialOpacity[i] : 0 },
                { opacity: 1, offset: 0.55 },
                { opacity: 1 },
              ]
            : [{ opacity: initialOpacity[i] }, { opacity: 0, offset: 0.4 }, { opacity: 0 }],
        ),
      );

      if (!opening) {
        const landing = copyCard(source);
        landing.classList.add("c-return-proxy");
        Object.assign(landing.style, {
          width: `${source.offsetWidth}px`,
          height: `${source.offsetHeight}px`,
          maxHeight: "none",
          minHeight: "0",
          transform: "none",
          transformOrigin: "0 0",
          translate: "none",
          rotate: "none",
          scale: "none",
          opacity: "0",
          zIndex: getComputedStyle(source).zIndex,
        });
        source.parentElement?.append(landing);
        proxy.current = landing;
        const deckBase = inverse(
          project(source.offsetWidth, source.offsetHeight, corners(landing)),
        );
        const landingGeometry = Array.from({ length: SAMPLES + 1 }, (_, i) => ({
          transform: cssMatrix(
            multiply(deckBase, project(source.offsetWidth, source.offsetHeight, path(i / SAMPLES))),
          ),
        }));
        add(landing, landingGeometry);
        // Both copies share a clock and the exact same screen quadrilateral at the handoff.
        add(el, [
          { opacity: 1, offset: 0, easing: "steps(1,end)" },
          { opacity: 0, offset: HANDOFF },
          { opacity: 0 },
        ]);
        add(landing, [
          { opacity: 0, offset: 0, easing: "steps(1,end)" },
          { opacity: 1, offset: HANDOFF },
          { opacity: getComputedStyle(source).opacity },
        ]);
      }
    }
    if (!opening) {
      gapOrigins.current.forEach(({ card, x, y }) =>
        add(
          card,
          Array.from({ length: SAMPLES + 1 }, (_, i) => ({
            translate: `${x * (1 - progress(i / SAMPLES))}px ${y * (1 - progress(i / SAMPLES))}px`,
          })),
        ),
      );
    }
    // Starting every part at this common time prevents one-frame lag between the two card copies.
    const start = document.timeline.currentTime;
    if (typeof start === "number")
      parts.forEach((part) => {
        part.startTime = start;
      });
    flight.current = { parts, path, at: performance.now(), ms };
    driver.onfinish = done;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    const release = acquireMotionHold();
    // A user can draw a card while a seek is still rearranging the deck. Freeze that exact pose.
    const deckTransitions = [...document.querySelectorAll<HTMLElement>("[data-step-source]")]
      .flatMap((card) => card.getAnimations())
      .filter(
        (animation) =>
          "transitionProperty" in animation &&
          ["transform", "opacity"].includes(String(animation.transitionProperty)) &&
          animation.playState === "running",
      );
    deckTransitions.forEach((animation) => animation.pause());
    el.showModal();
    markDeck(index, true, DRAW_MS);
    if (!reducedMotion()) fly(true, clearFlight);
    const onResize = () => {
      if (!flight.current) return;
      // A changed viewport invalidates the flight. Preserve its current visible pose before fading.
      const closing = closingAction.current;
      if (!closing) {
        fly(true, clearFlight, true);
        return;
      }
      const visible =
        proxy.current && Number(getComputedStyle(proxy.current).opacity) > 0 ? proxy.current : el;
      const targets = [
        el,
        ...el.querySelectorAll<HTMLElement>(".c-pull-face, .c-pull-bg, .tb, .c-step, .actions"),
        ...(proxy.current ? [proxy.current] : []),
      ];
      const frozen = targets.map((node) => {
        const style = getComputedStyle(node);
        return { node, transform: style.transform, opacity: style.opacity };
      });
      const veil = getComputedStyle(el, "::backdrop").opacity;
      stopFlight(flight.current);
      frozen.forEach(({ node, transform, opacity }) => {
        node.style.transform = transform;
        node.style.opacity = opacity;
      });
      const fade = visible.animate(
        [{ opacity: getComputedStyle(visible).opacity }, { opacity: 0 }],
        { duration: 160, fill: "forwards" },
      );
      const backdrop = el.animate([{ opacity: veil }, { opacity: 0 }], {
        duration: 160,
        fill: "forwards",
        pseudoElement: "::backdrop",
      });
      flight.current = {
        parts: [fade, backdrop],
        path: () => corners(el),
        at: performance.now(),
        ms: 160,
      };
      fade.onfinish = closing;
    };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const settlePreference = () => {
      if (!media.matches) return;
      paging.current?.cancel();
      clearFlight();
      el.style.transform = "";
      el.style.opacity = "";
      if (closingAction.current) closingAction.current();
    };
    media.addEventListener("change", settlePreference);
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      media.removeEventListener("change", settlePreference);
      paging.current?.cancel();
      clearFlight();
      markDeck(null, false, 0);
      document
        .querySelectorAll<HTMLElement>("[data-step-source]")
        .forEach((card) => card.style.removeProperty("--deck-gap-ms"));
      el.close();
      release();
      deckTransitions.forEach((animation) => {
        if (animation.playState === "paused") animation.play();
      });
      queueMicrotask(() => {
        // Evidence may take over in the same commit. Its focus must win that handoff.
        if (previous?.isConnected && !document.querySelector("dialog[open], .evidence-drawer")) {
          previous.focus({ preventScroll: true });
        }
      });
    };
    // The dialog owns one hold and one flight; paging only changes its content and return target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    showing.current = index;
    if (!leaving.current) markDeck(index);
  });

  const leave = (then: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    closingAction.current = then;
    paging.current?.cancel();
    gapOrigins.current = [
      ...document.querySelectorAll<HTMLElement>("[data-step-source].past-gap"),
    ].map((card) => {
      const [x, y = "0"] = getComputedStyle(card).translate.split(" ");
      return { card, x: parseFloat(x) || 0, y: parseFloat(y) || 0 };
    });
    markDeck(showing.current, false, 0);
    if (reducedMotion()) return then();
    fly(false, then);
  };

  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    paging.current?.cancel();
    if (reducedMotion() || leaving.current) return;
    // If a page changes mid-draw, continue from the current pose instead of snapping fully open.
    if (flight.current) fly(true, clearFlight, true);
    paging.current =
      body.current?.animate(
        [
          { transform: "translateX(12px)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 240, easing: "cubic-bezier(.2,.8,.3,1)" },
      ) ?? null;
    return () => paging.current?.cancel();
    // Flight inputs are read from refs; only a selected-record change starts paging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          onClick={() => {
            if (!leaving.current) onOpen(index - 1);
          }}
        >
          上一步
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={index >= last}
          onClick={() => {
            if (!leaving.current) onOpen(index + 1);
          }}
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
