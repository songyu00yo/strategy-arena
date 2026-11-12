"use client";
import { claimLabel, readableClaimText } from "@/components/claim-label";
import {
  useEffect,
  useLayoutEffect,
  memo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { ArenaEvent, ArenaVersion, Attack, Verdict } from "@/lib/contracts";
import type { ClarificationState } from "@/lib/clarification-contracts";
import type { RecordedAnswer } from "@/lib/intake-contracts";
import { replayActionLines } from "@/lib/step-context";
import { pendingReplayAnswer } from "@/lib/replay";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import {
  beatName,
  clarificationLines,
  latestShownRevision,
  nameOf,
  outputOf,
  stageName,
  type Beat,
} from "./beats";
import { Decode, reducedMotion, ROUTE_COLOR } from "./effects";
import { type Stage } from "@/lib/contracts";
import { verdictLabel } from "@/lib/verdict-label";

import { createMotionLoop, createMotionScope, useReducedMotion } from "./motion-runtime";
import type { PlaybackTimeline } from "./use-playback-progress";
import { CLARIFICATION_SEAL_FRAMES, paperBackgroundIndex, PAPER_MOTION } from "./paper-stage";
import "./paper-stage.css";

const reduced = reducedMotion;

/** Cold open: the question on black, what this game holds, then a shutter opens on the room. */
/** The verdict lands on the page, not over it: a vermilion seal is pressed onto the chosen board. */
export function VerdictFilm({
  verdict,
  clarification,
  onDone,
  speed = 1,
}: {
  verdict?: Verdict;
  clarification?: ClarificationState;
  onDone: () => void;
  speed?: number;
}) {
  const reducePreference = useReducedMotion();
  const seal = useRef<HTMLDivElement>(null);
  const sealAnimation = useRef<Animation | null>(null);
  const playbackRate = useRef(speed);
  useLayoutEffect(() => {
    playbackRate.current = speed;
    sealAnimation.current?.updatePlaybackRate(speed);
  }, [speed]);
  useEffect(() => {
    const el = seal.current;
    const target = document.querySelector<HTMLElement>(
      clarification ? ".c-result .tag" : `[data-board="${verdict?.preferred ?? "B"}"]`,
    );
    if (clarification && target) {
      const rect = target.getBoundingClientRect();
      if (rect.top < 12 || rect.bottom > innerHeight - 12)
        target
          .closest<HTMLElement>(".c-result")
          ?.scrollIntoView({ block: "start", behavior: "instant" });
    }
    const board = target?.getBoundingClientRect();
    if (!el || !board || reducedMotion()) return onDone();
    el.style.left = `${board.left + board.width * 0.62}px`;
    el.style.top = `${board.top + Math.min(board.height * 0.42, 150)}px`;
    const scope = createMotionScope();
    const press = scope.animate(
      el,
      clarification
        ? CLARIFICATION_SEAL_FRAMES
        : [
            { transform: "translate(-50%,-50%) rotate(-14deg) scale(2.2)", opacity: 0 },
            { transform: "translate(-50%,-50%) rotate(-7deg) scale(1)", opacity: 1, offset: 0.55 },
            { transform: "translate(-50%,-50%) rotate(-7deg) scale(1)", opacity: 1, offset: 0.85 },
            { transform: "translate(-50%,-50%) rotate(-7deg) scale(1)", opacity: 0 },
          ],
      {
        duration: clarification ? PAPER_MOTION.seal : 2600,
        delay: clarification ? 0 : 200,
        easing: clarification ? "linear" : "cubic-bezier(.19,1,.22,1)",
        fill: "both",
      },
    );
    press.playbackRate = playbackRate.current;
    sealAnimation.current = press;
    press.onfinish = onDone;
    const skip = () => press.finish();
    addEventListener("keydown", skip);
    return () => {
      removeEventListener("keydown", skip);
      scope.dispose();
      if (sealAnimation.current === press) sealAnimation.current = null;
    };
    // Runs once: a poll that refreshes the record must not restart the seal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducePreference]);
  return (
    <div className="c-seal" ref={seal} aria-hidden="true">
      <b>
        {clarification
          ? clarification.review?.ready && !clarification.draftOnly
            ? "查漏完成"
            : "待确认"
          : verdictLabel(verdict!)}
      </b>
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

function linesOf(
  version: ArenaVersion,
  beat: Beat,
  progress = 1,
  visibleAnswers?: readonly RecordedAnswer[],
): string[] {
  let lines: string[] = [];
  if (beat.replayAction) {
    const enteringAnswer = beat.replayAction.kind === "answer" && progress < 0.8;
    const shownAnswers = enteringAnswer
      ? []
      : (visibleAnswers ??
        (progress < 0.8 ? beat.replayAction.answers?.map(pendingReplayAnswer) : undefined));
    return [
      ...replayActionLines(beat.replayAction, shownAnswers, progress >= 0.8),
      ...(enteringAnswer ? ["正在按保存记录填写"] : []),
    ];
  }
  if (beat.clarificationRun)
    return [
      beat.clarificationRun.summary,
      ...clarificationLines(beat.clarificationRun, beat.clarificationAnswers),
    ];
  if (beat.strategy) {
    const s = beat.strategy;
    lines = [
      s.thesis,
      ...s.steps,
      ...s.claims.map((c) => `${claimLabel(version, s.id, c.id)} · ${c.text}`),
      s.firstAction,
    ];
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
  return lines.map((line) => readableClaimText(version, line));
}

/** The wall shows only what has happened so far: real proposals, challenges, checks and revisions. */
function wallRecords(
  version: ArenaVersion,
  shown: Beat[],
  events: ArenaEvent[],
  currentId?: string,
  replayProgress = 1,
  replayAnswersVisible?: readonly RecordedAnswer[],
): WallRecord[] {
  const records: WallRecord[] = [];
  for (const beat of shown) {
    const row = WALL_ROW[beat.stage];
    const label = `${String(shown.indexOf(beat) + 1).padStart(2, "0")} ${stageName(version, beat.stage)}`;
    const lines = linesOf(
      version,
      beat,
      beat.id === currentId ? replayProgress : 1,
      beat.id === currentId ? replayAnswersVisible : undefined,
    );
    records.push({
      id: beat.id,
      agent: beat.agent,
      row,
      title: label,
      meta: `${beatName(beat)}${beat.to ? ` → ${nameOf(beat.to)}` : ""}`,
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
        lines: readableClaimText(version, JSON.stringify(output, null, 1)).split("\n"),
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
  rows: HTMLElement[];
};

/** Real records on panels set back in space, in rows by stage, the newest nearest. */
type RecordWallProps = {
  version: ArenaVersion;
  shown: Beat[];
  currentId?: string;
  events: ArenaEvent[];
  directed?: boolean;
  replayProgress?: number;
  replayAnswersVisible?: readonly RecordedAnswer[];
  timeline?: PlaybackTimeline;
};

function wallBackground(props: RecordWallProps) {
  const current = props.shown.find((beat) => beat.id === props.currentId);
  const held = !!current?.replayAction && (!!props.directed || (props.replayProgress ?? 1) < 1);
  const lastModel = paperBackgroundIndex(props.shown, props.shown.length - 1, held);
  return { held, length: lastModel + 1 };
}

function RecordWallView({
  version,
  shown,
  currentId,
  events,
  directed = false,
  replayProgress = 1,
  replayAnswersVisible,
}: RecordWallProps) {
  const reducePreference = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const panels = useRef(new Map<string, Panel>());
  const background = wallBackground({
    version,
    shown,
    currentId,
    events,
    directed,
    replayProgress,
  });
  const backgroundShown = shown.slice(0, background.length);
  const backgroundCurrent = background.held ? backgroundShown.at(-1)?.id : currentId;
  const records = wallRecords(
    version,
    backgroundShown,
    events,
    backgroundCurrent,
    replayProgress,
    replayAnswersVisible,
  );
  const signature = records.map((r) => `${r.id}\n${r.lines.join("\n")}`).join("\0");
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
    const animate = directed && !background.held && settled.current && !reduced();
    settled.current = true;
    list.forEach((record, i) => {
      const col = counts[record.row]++;
      const rank = list.length - 1 - i;
      const focus = record.id === backgroundCurrent;
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
          row.textContent = line;
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
          rows,
        };
        panels.current.set(record.id, panel);
      }
      const visibleLines = record.lines.slice(0, 10);
      if (JSON.stringify(panel.lines) !== JSON.stringify(visibleLines)) {
        panel.lines = visibleLines;
        panel.rows = visibleLines.map((line) => {
          const row = document.createElement("div");
          row.textContent = line;
          return row;
        });
        panel.el.querySelector(".body")?.replaceChildren(...panel.rows);
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
  }, [signature, backgroundCurrent, directed, background.held, reducePreference]);
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
    if (background.held) return;
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
    const loop = createMotionLoop((_time, dt) => {
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
      }
      return moving;
    });
    return () => loop.dispose();
  }, [signature, backgroundCurrent, directed, background.held, reducePreference]);
  return (
    <div
      className={`c-wall ${version.workflow === "clarification" ? "paper-record-wall" : ""}`}
      data-background-held={background.held || undefined}
      data-background-motion={background.held ? "held" : "active"}
      aria-hidden="true"
    >
      <div className="c-stage" ref={stage} />
    </div>
  );
}

export const RecordWall = memo(RecordWallView, (left, right) => {
  const a = wallBackground(left);
  const b = wallBackground(right);
  return (
    left.version === right.version &&
    left.directed === right.directed &&
    a.held === b.held &&
    a.length === b.length &&
    left.shown.slice(0, a.length).every((beat, index) => beat === right.shown[index]) &&
    left.events.length === right.events.length &&
    left.events.every((event, index) => event === right.events[index])
  );
});

/** The record behind the step in front, so the card carries substance and not only a caption. */
function detailsOf(
  version: ArenaVersion,
  beat: Beat,
  replayProgress = 1,
  replayAnswersVisible?: readonly RecordedAnswer[],
): string[] {
  if (beat.replayAction)
    return linesOf(version, beat, replayProgress, replayAnswersVisible).slice(0, 3);
  if (beat.clarificationRun)
    return clarificationLines(beat.clarificationRun, beat.clarificationAnswers).slice(0, 3);
  if (beat.strategy)
    return beat.strategy.claims
      .slice(0, 3)
      .map(
        (c) =>
          `${claimLabel(version, beat.strategy!.id, c.id)} · ${readableClaimText(version, c.text)}`,
      );
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
type ChainDeckProps = {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  directed: boolean;
  seeking?: boolean;
  lead: number;
  speed?: number;
  replayProgress?: number;
  replayAnswersVisible?: readonly RecordedAnswer[];
  reviewing: boolean;
  onStep: (index: number) => void;
  backgroundHeld?: boolean;
};

function ChainDeckView({
  version,
  beats,
  index,
  directed,
  seeking = false,
  lead,
  speed = 1,
  replayProgress = 1,
  replayAnswersVisible,
  reviewing,
  onStep,
  backgroundHeld = false,
}: ChainDeckProps) {
  const reducePreference = useReducedMotion();
  const shown = beats.slice(0, index + 1);
  const front = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState<number | null>(null);
  const current = beats[index];
  const entrance = useRef<Animation | null>(null);
  const playbackRate = useRef(speed);
  useLayoutEffect(() => {
    playbackRate.current = speed;
    entrance.current?.updatePlaybackRate(speed);
  }, [speed]);
  const seenIds = new Set(shown.map((b) => b.id));
  const attack = current?.attack;
  const running = current?.stage === "attack" ? 1 : current?.stage === "verify" ? 2 : 3;
  useEffect(() => {
    if (!front.current || !directed || backgroundHeld || reduced()) return;
    const scope = createMotionScope(seeking ? "interaction" : "story");
    const animation = scope.animate(
      front.current,
      [
        {
          translate: "12px 8px",
          rotate: "y -2deg",
          scale: "1.02",
          opacity: 1,
        },
        { translate: "0 0", rotate: "y 0deg", scale: "1", opacity: 1 },
      ],
      {
        duration: 520,
        delay: 0,
        easing: "cubic-bezier(0.19, 1, 0.22, 1)",
        fill: "backwards",
      },
    );
    animation.playbackRate = playbackRate.current;
    entrance.current = animation;
    return () => {
      scope.dispose();
      if (entrance.current === animation) entrance.current = null;
    };
    // Only a new step brings a card in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, backgroundHeld, reducePreference]);
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
            第 {peek! + 1} 步 · {beatName(peeked)}
            {peeked.to ? ` → ${nameOf(peeked.to)}` : ""} · {stageName(version, peeked.stage)}
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
                {isFront ? beatName(beat) : (SHORT[beat.agent] ?? beat.agent)}
                {beat.to ? ` → ${isFront ? nameOf(beat.to) : beat.to}` : ""}
              </b>
              <span>
                {dispute
                  ? checked
                    ? attackMeta[attack.status].label
                    : "核验中"
                  : state
                    ? attackMeta[beat.attack!.status].label
                    : stageName(version, beat.stage)}
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
                        delay={lead * speed + (r === 0 ? 700 : 300)}
                        speed={speed}
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
                  <>
                    <small className="c-deck-summary-label">摘要 · 展开详情查看完整记录</small>
                    <ul>
                      {(backgroundHeld
                        ? ["本次操作在原补问纸面中展示。", "展开详情查看保存的来源。"]
                        : detailsOf(version, beat, replayProgress, replayAnswersVisible)
                      ).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const ChainDeck = memo(
  ChainDeckView,
  (left, right) =>
    left.version === right.version &&
    left.beats === right.beats &&
    left.index === right.index &&
    left.backgroundHeld === right.backgroundHeld &&
    left.directed === right.directed &&
    left.seeking === right.seeking &&
    left.lead === right.lead &&
    left.speed === right.speed &&
    left.reviewing === right.reviewing &&
    left.onStep === right.onStep &&
    (!!left.backgroundHeld ||
      (left.replayProgress === right.replayProgress &&
        left.replayAnswersVisible === right.replayAnswersVisible)),
);

/** The record of the current step, always in clear view, written out as it happens. */
function LiveRecordView({
  version,
  beat,
  index,
  directed,
  seeking = false,
  lead,
  speed = 1,
  replayProgress = 1,
  replayAnswersVisible,
  onEvidence,
  backgroundHeld = false,
}: {
  version: ArenaVersion;
  beat: Beat | null;
  index: number;
  directed: boolean;
  seeking?: boolean;
  lead: number;
  speed?: number;
  replayProgress?: number;
  replayAnswersVisible?: readonly RecordedAnswer[];
  onEvidence: (attack: Attack) => void;
  backgroundHeld?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [beat?.id]);
  if (!beat) return null;
  const lines = linesOf(version, beat, replayProgress, replayAnswersVisible);
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
          {String(index + 1).padStart(2, "0")} {stageName(version, beat.stage)}
        </b>
        <span>
          {beatName(beat)} {beat.to ? ` → ${nameOf(beat.to)}` : ""}
        </span>
      </div>
      {beat.attack && (
        <button type="button" className="c-live-action" onClick={() => onEvidence(beat.attack!)}>
          看这条质疑的证据 →
        </button>
      )}
      <div className="body" ref={content}>
        {lines.map((line, i) => (
          <div key={`${i}:${line}`}>
            <Decode
              text={line}
              active={directed && !backgroundHeld}
              origin={seeking ? "interaction" : "story"}
              delay={lead * speed + 160 + i * 110}
              speed={speed}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export const LiveRecord = memo(
  LiveRecordView,
  (left, right) =>
    left.version === right.version &&
    left.beat === right.beat &&
    left.index === right.index &&
    left.directed === right.directed &&
    left.seeking === right.seeking &&
    left.lead === right.lead &&
    left.speed === right.speed &&
    left.backgroundHeld === right.backgroundHeld &&
    left.onEvidence === right.onEvidence &&
    (!left.beat?.replayAction ||
      (left.replayProgress === right.replayProgress &&
        left.replayAnswersVisible === right.replayAnswersVisible)),
);
