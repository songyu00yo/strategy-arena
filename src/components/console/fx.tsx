"use client";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { ArenaEvent, ArenaVersion, Attack, Verdict } from "@/lib/contracts";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { latestShownRevision, nameOf, outputOf, type Beat } from "./beats";
import { Chars, Decode, Dust, reducedMotion, ROUTE_COLOR } from "./effects";
import { STAGE_LABELS, type Stage } from "@/lib/contracts";
import { verdictLabel } from "@/lib/verdict-label";

import { createMotionLoop, createMotionScope, useReducedMotion } from "./motion-runtime";

const reduced = reducedMotion;

/** Cold open: the question on black, what this game holds, then a shutter opens on the room. */
export function Intro({
  version,
  events,
  demo,
  onReveal,
  onDone,
}: {
  version: ArenaVersion;
  events: ArenaEvent[];
  demo: boolean;
  onReveal: () => void;
  onDone: () => void;
}) {
  const reducePreference = useReducedMotion();
  const lines = [
    `${version.strategies.length} 条路线`,
    `${version.attacks.length} 次质疑`,
    `${version.evidence.length} 项证据`,
    `${events.length} 条步骤记录`,
    demo
      ? "预设演示，未调用模型"
      : version.modelSelection
        ? `同一模型 ${version.modelSelection.modelId} 分成五个角色`
        : "早期记录：模型未记录",
  ].filter((line) => !line.startsWith("0 "));
  const [count, setCount] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reducedMotion()) {
      onReveal();
      return onDone();
    }
    const scope = createMotionScope();
    if (count < lines.length) {
      scope.later(count === 0 ? 800 : 130, () => setCount(count + 1));
      return () => scope.dispose();
    }
    scope.later(320, () => {
      onReveal();
      const open =
        box.current &&
        scope.animate(
          box.current,
          [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(50% 0 50% 0)" }],
          { duration: 520, easing: "cubic-bezier(.76,0,.24,1)", fill: "forwards" },
        );
      if (open) open.onfinish = onDone;
      else onDone();
    });
    return () => scope.dispose();
  }, [count, lines.length, onDone, onReveal, reducePreference]);
  useEffect(() => {
    const skip = () => {
      onReveal();
      onDone();
    };
    addEventListener("keydown", skip, { once: true });
    addEventListener("mousedown", skip, { once: true });
    return () => {
      removeEventListener("keydown", skip);
      removeEventListener("mousedown", skip);
    };
  }, [onDone, onReveal]);
  return (
    <div className="c-intro" ref={box} aria-hidden="true">
      <Dust />
      <p className="q">
        <Chars text={version.challenge.goal} active />
      </p>
      <ul>
        {lines.slice(0, count).map((line) => (
          <li key={line}>
            <Decode text={line} active />
          </li>
        ))}
      </ul>
    </div>
  );
}

const emberSets = new Map<string, string[]>();
const EMBERS = (route: string | null) => {
  const key = route ?? "none";
  let set = emberSets.get(key);
  if (!set) {
    set = [ROUTE_COLOR[route ?? ""] ?? "255,255,255", "120,130,150", "255,175,60"];
    emberSets.set(key, set);
  }
  return set;
};

const CHAPTER: Record<Stage, string> = {
  propose: "提案",
  attack: "质疑",
  verify: "核验",
  revise: "修订",
  judge: "裁决",
};

/** The stage word lands huge, then flies up and becomes its label on the timeline. */
export function Chapter({ stage }: { stage: Stage }) {
  const reducePreference = useReducedMotion();
  const word = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = word.current;
    if (!el || reduced()) return;
    const scope = createMotionScope();
    scope.later(360, () => {
      const to = document.querySelector(".c-time .seg.here span")?.getBoundingClientRect();
      const from = el.getBoundingClientRect();
      if (!to) return;
      const scale = Math.max(0.04, to.height / from.height);
      scope.animate(
        el,
        [
          { transform: "none", opacity: 1 },
          {
            transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px,${
              to.top + to.height / 2 - (from.top + from.height / 2)
            }px) scale(${scale})`,
            opacity: 0,
          },
        ],
        { duration: 420, easing: "cubic-bezier(.7,0,.15,1)", fill: "forwards" },
      );
    });
    return () => scope.dispose();
  }, [reducePreference]);
  if (reducePreference) return null;
  return (
    <div className="c-chapter" aria-hidden="true">
      <b ref={word}>
        <Chars text={CHAPTER[stage]} active />
      </b>
    </div>
  );
}

/** The verdict lands: black bursts out of the chosen board, then folds into the verdict panel. */
export function VerdictFilm({ verdict, onDone }: { verdict: Verdict; onDone: () => void }) {
  const reducePreference = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || reducedMotion()) return onDone();
    const pick = document
      .querySelector(`[data-board="${verdict.preferred ?? "B"}"]`)
      ?.getBoundingClientRect();
    const scope = createMotionScope();
    const x = pick ? pick.left + pick.width / 2 : innerWidth / 2;
    const y = pick ? pick.top + pick.height / 2 : innerHeight / 2;
    const entrance = scope.animate(
      el,
      [
        { clipPath: `circle(0px at ${x}px ${y}px)` },
        { clipPath: `circle(150vmax at ${x}px ${y}px)` },
      ],
      { duration: 600, delay: 350, easing: "cubic-bezier(.7,0,.2,1)", fill: "both" },
    );
    let closing: Animation | undefined;
    const close = () => {
      if (closing) return;
      const panel = document.querySelector(".c-result")?.getBoundingClientRect();
      const inset = panel
        ? `inset(${panel.top}px ${innerWidth - panel.right}px ${innerHeight - panel.bottom}px ${panel.left}px)`
        : "inset(50%)";
      const currentClip = getComputedStyle(el).clipPath;
      const entered = entrance.playState === "finished";
      const panelX = panel ? panel.left + panel.width / 2 : innerWidth / 2;
      const panelY = panel ? panel.top + panel.height / 2 : innerHeight / 2;
      const endClip = entered ? inset : `circle(0px at ${panelX}px ${panelY}px)`;
      entrance.cancel();
      closing = scope.animate(
        el,
        [
          { clipPath: entered ? "inset(0px)" : currentClip, opacity: 1 },
          { clipPath: endClip, opacity: 1, offset: 0.85 },
          { clipPath: endClip, opacity: 0 },
        ],
        { duration: 800, easing: "cubic-bezier(.76,0,.24,1)", fill: "forwards" },
      );
      closing.onfinish = onDone;
    };
    scope.later(2500, close);
    addEventListener("keydown", close);
    return () => {
      scope.dispose();
      removeEventListener("keydown", close);
    };
    // Runs once: a poll that refreshes the record must not restart the verdict's timing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducePreference]);
  return (
    <div className="c-film" ref={box} aria-hidden="true">
      <Dust embers={EMBERS(verdict.preferred)} />
      <small>
        <Chars text={verdictLabel(verdict)} active delay={520} />
      </small>
      <div className="head">
        <Chars text={verdict.headline} active delay={650} />
      </div>
      <ul>
        {verdict.conditions.slice(0, 2).map((line, i) => (
          <li key={line}>
            <Decode text={line} active delay={1000 + i * 150} />
          </li>
        ))}
      </ul>
    </div>
  );
}

type WallRecord = {
  id: string;
  agent: string;
  row: number;
  title: string;
  meta: string;
  lines: string[];
};
const WALL_ROW: Record<Stage, number> = { propose: 0, attack: 1, verify: 2, revise: 3, judge: 3 };
const WALL_LIMIT = 24;

function linesOf(version: ArenaVersion, beat: Beat): string[] {
  let lines: string[] = [];
  if (beat.strategy) {
    const s = beat.strategy;
    lines = [s.thesis, ...s.steps, ...s.claims.map((c) => `${c.id}：${c.text}`), s.firstAction];
  } else if (beat.stage === "attack" && beat.attack) {
    const a = beat.attack;
    lines = [`原话：${a.claimQuote}`, `质疑：${a.reason}`, a.impact, `核验：${a.verification}`];
  } else if (beat.stage === "verify" && beat.attack) {
    lines = [
      attackMeta[beat.attack.status].label,
      ...version.evidence
        .filter((e) => e.attackId === beat.attack!.id)
        .flatMap((e) => [
          e.title,
          e.expression ? `${e.expression} = ${e.result ?? "无法计算"}` : "",
          e.assumptions,
          e.content,
          e.source,
        ])
        .filter(Boolean),
    ];
  } else if (beat.revision) {
    lines = [
      beat.revision.summary,
      ...(beat.changes ?? []).map((c) => `改动：${c}`),
      ...beat.revision.responses.flatMap((r) => [
        `${decisionMeta[r.decision].label}：${r.reason}`,
        r.change,
      ]),
    ].filter(Boolean);
  } else if (beat.verdict) {
    const v = beat.verdict;
    lines = [
      v.headline,
      v.rationale,
      ...v.conditions.map((c) => `前提：${c}`),
      ...v.uncertainties.map((c) => `待确认：${c}`),
      ...v.nextActions.map((c) => `下一步：${c}`),
    ];
  }
  return lines;
}

/** The wall shows only what has happened so far: real proposals, challenges, checks and revisions. */
function wallRecords(version: ArenaVersion, shown: Beat[], events: ArenaEvent[]): WallRecord[] {
  const records: WallRecord[] = [];
  for (const beat of shown) {
    const row = WALL_ROW[beat.stage];
    const label = `${String(shown.indexOf(beat) + 1).padStart(2, "0")} ${STAGE_LABELS[beat.stage]}`;
    const lines = linesOf(version, beat);
    records.push({
      id: beat.id,
      agent: beat.agent,
      row,
      title: label,
      meta: `${nameOf(beat.agent)}${beat.to ? ` → ${nameOf(beat.to)}` : ""}`,
      lines,
    });
  }
  for (const event of events) {
    const output = outputOf(event);
    if (output && event.stage)
      records.push({
        id: `o:${event.seq}`,
        agent: event.actor?.split(":")[0] ?? "",
        row: WALL_ROW[event.stage],
        title: "模型结构化输出",
        meta: event.actor ?? "",
        lines: JSON.stringify(output, null, 1).split("\n"),
      });
  }
  return records.slice(-WALL_LIMIT);
}

type Panel = {
  el: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  aim: number;
  lines: string[];
  row: number;
  ch: number;
  typing: boolean;
  rows: HTMLElement[];
};

/** Real records on panels set back in space, in rows by stage, the newest nearest. */
export function RecordWall({
  version,
  shown,
  currentId,
  events,
  directed = false,
}: {
  version: ArenaVersion;
  shown: Beat[];
  currentId?: string;
  events: ArenaEvent[];
  directed?: boolean;
}) {
  const reducePreference = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const panels = useRef(new Map<string, Panel>());
  const records = wallRecords(version, shown, events);
  const signature = records.map((r) => r.id).join();
  const latest = useRef(records);
  const settled = useRef(false);
  useEffect(() => {
    latest.current = records;
  });
  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const counts = [0, 0, 0, 0];
    const list = latest.current;
    const animate = directed && settled.current && !reduced();
    settled.current = true;
    list.forEach((record, i) => {
      const col = counts[record.row]++;
      const rank = list.length - 1 - i;
      const focus = record.id === currentId;
      let panel = panels.current.get(record.id);
      if (!panel) {
        const el = document.createElement("div");
        const head = document.createElement("div");
        head.className = "tb";
        const name = document.createElement("b");
        name.textContent = record.title;
        const meta = document.createElement("span");
        meta.textContent = record.meta;
        head.append(name, meta);
        const body = document.createElement("div");
        body.className = "body";
        const displayLines = record.lines.slice(0, 10);
        const rows = displayLines.map((line) => {
          const row = document.createElement("div");
          row.textContent = animate ? "" : line;
          body.appendChild(row);
          return row;
        });
        el.append(head, body);
        host.appendChild(el);
        panel = {
          el,
          x: (col - 2.2) * 372 + (record.row % 2) * 70,
          y: (record.row - 1.5) * 188,
          z: animate ? -700 : -300,
          aim: -300,
          lines: displayLines,
          row: 0,
          ch: 0,
          typing: animate,
          rows,
        };
        panels.current.set(record.id, panel);
      }
      if (!directed) {
        panel.typing = false;
        panel.rows.forEach((row, i) => (row.textContent = panel!.lines[i]));
      }
      panel.aim = focus ? -170 : -250 - Math.min(rank, 14) * 44; // Three planes of depth, so the wall reads as stacked windows and not a flat sheet.
      const plane = rank < 4 ? "near" : rank < 10 ? "mid" : "far";
      panel.el.className = `c-cw ${plane} ${focus ? "now" : ""}`;
      panel.el.style.setProperty(
        "--route",
        (ROUTE_COLOR[record.agent] ?? "90,100,120").replaceAll(",", " "),
      );
      panel.el.style.animationDelay = `${-((i * 1.3) % 9)}s`;
      panel.el.style.zIndex = String(100 - rank);
    });
    for (const [id, panel] of panels.current)
      if (!list.some((r) => r.id === id)) {
        panel.el.remove();
        panels.current.delete(id);
      }
  }, [signature, currentId, directed, reducePreference]);
  // The wall fills the same share of the stage on any screen.
  useEffect(() => {
    const fit = () => {
      if (stage.current)
        stage.current.style.scale = String(Math.max(0.8, Math.min(1.75, innerHeight / 860)));
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);
  useEffect(() => {
    const all = panels.current;
    const place = (p: Panel) => {
      p.el.style.transform = `translate3d(${p.x - 180}px, ${p.y - 115}px, ${p.z}px)`;
    };
    if (reduced()) {
      for (const p of all.values()) {
        p.z = p.aim;
        place(p);
        p.rows.forEach((row, i) => (row.textContent = p.lines[i]));
      }
      return;
    }
    let budget = 0;
    const loop = createMotionLoop((_time, dt) => {
      budget += dt * 1000;
      const typing = budget >= 48;
      const steps = typing ? 3 : 0;
      if (typing) budget = 0;
      let moving = false;
      for (const p of all.values()) {
        if (Math.abs(p.aim - p.z) > 0.5) {
          p.z += (p.aim - p.z) * Math.min(1, dt * (directed ? 6 : 10));
          place(p);
          moving = true;
        } else if (p.z !== p.aim) {
          p.z = p.aim;
          place(p);
        }
        if (!p.typing) continue;
        moving = true;
        for (let n = 0; n < steps && p.typing; n++) {
          if (p.row >= p.lines.length) {
            p.typing = false;
            break;
          }
          p.ch += 1;
          p.rows[p.row].textContent = p.lines[p.row].slice(0, p.ch);
          if (p.ch >= p.lines[p.row].length) {
            p.row += 1;
            p.ch = 0;
          }
        }
      }
      return moving;
    });
    return () => loop.dispose();
  }, [signature, currentId, directed, reducePreference]);
  return (
    <div className="c-wall" aria-hidden="true">
      <div className="c-stage" ref={stage} />
    </div>
  );
}

/** The record behind the step in front, so the card carries substance and not only a caption. */
function detailsOf(beat: Beat): string[] {
  if (beat.strategy) return beat.strategy.claims.slice(0, 3).map((c) => `${c.id}：${c.text}`);
  if (beat.revision)
    return [
      ...(beat.changes ?? []).map((c) => `改动：${c}`),
      ...beat.revision.responses.map((r) => `${decisionMeta[r.decision].label}：${r.reason}`),
    ].slice(0, 3);
  if (beat.verdict)
    return [
      ...beat.verdict.nextActions.map((c) => `下一步：${c}`),
      ...beat.verdict.conditions.map((c) => `前提：${c}`),
    ].slice(0, 3);
  return [];
}

const SHORT: Record<string, string> = { verify: "核验", judge: "裁判" };

/** The chain of thought: every step so far stays in view, grouped by stage, the newest in front. */
export function ChainDeck({
  version,
  beats,
  index,
  directed,
  seeking = false,
  lead,
  reviewing,
  onStep,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  directed: boolean;
  seeking?: boolean;
  lead: number;
  reviewing: boolean;
  onStep: (index: number) => void;
}) {
  const reducePreference = useReducedMotion();
  const shown = beats.slice(0, index + 1);
  const front = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState<number | null>(null);
  const current = beats[index];
  const seenIds = new Set(shown.map((b) => b.id));
  const attack = current?.attack;
  const running = current?.stage === "attack" ? 1 : current?.stage === "verify" ? 2 : 3;
  useEffect(() => {
    if (!front.current || !directed || reduced()) return;
    const scope = createMotionScope(seeking ? "interaction" : "story");
    scope.animate(
      front.current,
      [
        {
          translate: "90px 12px",
          rotate: "y -12deg",
          scale: "1.02",
          opacity: 0,
        },
        { translate: "0 0", rotate: "y 0deg", scale: "1", opacity: 1 },
      ],
      { duration: 520, delay: lead + 40, easing: "cubic-bezier(.16,1.05,.3,1)", fill: "backwards" },
    );
    return () => scope.dispose();
    // Only a new step brings a card in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, reducePreference]);
  // Long records stay inside the card: the line being worked on is always the one in view.
  useEffect(() => {
    const body = front.current?.querySelector<HTMLElement>(".body");
    const row = body?.querySelector<HTMLElement>(".ln.run");
    if (body && row) body.scrollTop = Math.max(0, row.offsetTop - 2);
  }, [current?.id]);
  if (!shown.length) return null; // Looking back, a step shows how it turned out, so the reasons can be weighed in one place.
  const known = reviewing ? beats : shown;
  const checked = !!attack && (reviewing || seenIds.has(`v:${attack.id}`));
  const response =
    attack &&
    latestShownRevision(known, attack.targetStrategyId)?.revision?.responses.find(
      (r) => r.attackId === attack.id,
    );
  const evidence = attack ? version.evidence.filter((e) => e.attackId === attack.id) : [];
  const rows: [string, string][] = attack
    ? [
        [`${attack.targetStrategyId} 原话`, attack.claimQuote],
        [`${attack.from} 质疑`, attack.reason],
        [
          "核验",
          checked
            ? [
                attackMeta[attack.status].label,
                ...evidence.map(
                  (e) =>
                    `${e.expression ? `${e.expression} = ${e.result ?? "无法计算"} ` : ""}${e.content || evidenceMeta[e.status].label}`,
                ),
              ].join(" · ")
            : "等待",
        ],
        [
          `${attack.targetStrategyId} 回应`,
          response
            ? `${decisionMeta[response.decision].label}。${response.reason} ${response.change}`
            : "等待",
        ],
      ]
    : [];
  const peeked = peek !== null ? shown[peek] : null;
  return (
    <div className="c-deck" style={{ "--n": Math.max(shown.length - 1, 1) } as CSSProperties}>
      {peeked && (
        <div
          key={peeked.id}
          className="c-deck-peek"
          aria-hidden="true"
          style={
            {
              "--route": (ROUTE_COLOR[peeked.agent] ?? "11,13,16").replaceAll(",", " "),
            } as CSSProperties
          }
        >
          <em>
            第 {peek! + 1} 步 · {nameOf(peeked.agent)}
            {peeked.to ? ` → ${nameOf(peeked.to)}` : ""} · {STAGE_LABELS[peeked.stage]}
            {peeked.stage === "verify" && peeked.attack && reviewing
              ? ` · ${attackMeta[peeked.attack.status].label}`
              : ""}
          </em>
          <strong>{peeked.title}</strong>
          <p>{peeked.plain}</p>
          <small>点击查看详情</small>
        </div>
      )}
      {shown.map((beat, i) => {
        const depth = shown.length - 1 - i;
        const isFront = depth === 0;
        const dispute = isFront && !!attack;
        // A small extra gap between stages lets the fan read as groups.
        const gaps = new Set(shown.slice(i).map((b) => b.stage)).size - 1;
        const state = beat.stage === "verify" && beat.attack ? beat.attack.status : "";
        return (
          <div
            key={beat.id}
            ref={isFront ? front : undefined}
            data-step-source={i}
            {...(isFront
              ? {}
              : {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": `查看第 ${i + 1} 步`,
                  title: beat.title,
                  onClick: () => {
                    setPeek(null);
                    onStep(i);
                  },
                  // The card stays put while pointed at: moving it would slip out from under the pointer.
                  onMouseEnter: () => setPeek(i),
                  onMouseLeave: () => setPeek(null),
                  onFocus: () => setPeek(i),
                  onBlur: () => setPeek(null),
                  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.currentTarget.click();
                    }
                  },
                })}
            className={`c-deck-card ${isFront ? "c-deck-now" : ""} ${dispute ? "c-float-card" : ""} ${state ? `is-${state}` : ""}`}
            style={
              {
                "--d": depth,
                "--g": gaps,
                "--route": (ROUTE_COLOR[beat.agent] ?? "11,13,16").replaceAll(",", " "),
                zIndex: 100 - depth,
              } as CSSProperties
            }
          >
            <div className="tb">
              <b>
                {String(i + 1).padStart(2, "0")}{" "}
                {isFront ? nameOf(beat.agent) : (SHORT[beat.agent] ?? beat.agent)}
                {beat.to ? ` → ${isFront ? nameOf(beat.to) : beat.to}` : ""}
              </b>
              <span>
                {dispute
                  ? checked
                    ? attackMeta[attack.status].label
                    : "核验中"
                  : state
                    ? attackMeta[beat.attack!.status].label
                    : STAGE_LABELS[beat.stage]}
              </span>
              {isFront && (
                <button
                  type="button"
                  className="c-deck-open"
                  aria-label={`查看第 ${i + 1} 步`}
                  onClick={() => onStep(i)}
                >
                  展开详情
                </button>
              )}
            </div>
            {dispute ? (
              <div className="body">
                {rows.map(([label, text], r) => (
                  <div
                    key={label}
                    className={`ln ${r === running ? "run" : r < running ? "ran" : ""}`}
                  >
                    <em>{label}</em>
                    <span>
                      <Decode
                        text={text}
                        active={directed && r === running}
                        origin={seeking ? "interaction" : "story"}
                        delay={lead + (r === 0 ? 700 : 300)}
                      />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="body plain">
                <strong>{beat.title}</strong>
                <p>{beat.plain}</p>
                {isFront && (
                  <ul>
                    {detailsOf(beat).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The record of the current step, always in clear view, written out as it happens. */
export function LiveRecord({
  version,
  beat,
  index,
  directed,
  seeking = false,
  lead,
  onEvidence,
}: {
  version: ArenaVersion;
  beat: Beat | null;
  index: number;
  directed: boolean;
  seeking?: boolean;
  lead: number;
  onEvidence: (attack: Attack) => void;
}) {
  if (!beat) return null;
  const lines = linesOf(version, beat);
  return (
    <div
      className={`c-live ${directed ? "arrive" : ""}`}
      role="region"
      aria-label="这一步的详情"
      style={
        {
          "--route": (ROUTE_COLOR[beat.agent] ?? "11,13,16").replaceAll(",", " "),
          animationDelay: `${lead}ms`,
        } as CSSProperties
      }
    >
      <div className="tb">
        <b>
          {String(index + 1).padStart(2, "0")} {STAGE_LABELS[beat.stage]}
        </b>
        <span>
          {nameOf(beat.agent)} {beat.to ? ` → ${nameOf(beat.to)}` : ""}
        </span>
      </div>
      {beat.attack && (
        <button type="button" className="c-live-action" onClick={() => onEvidence(beat.attack!)}>
          看这条质疑的证据 →
        </button>
      )}
      <div className="body">
        {lines.map((line, i) => (
          <div key={`${i}:${line}`}>
            <Decode
              text={line}
              active={directed}
              origin={seeking ? "interaction" : "story"}
              delay={lead + 160 + i * 110}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
