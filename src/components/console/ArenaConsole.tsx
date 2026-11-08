"use client";
import { readableClaimText } from "@/components/claim-label";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  STAGES,
  STAGE_LABELS,
  type ArenaEvent,
  type ArenaStep,
  type ArenaVersion,
  type Attack,
  type Strategy,
} from "@/lib/contracts";
import { attackMeta } from "@/components/status";
import type { StepContext } from "@/lib/step-context";
import { verdictLabel } from "@/lib/verdict-label";
import { Chars, reducedMotion, ROUTE_COLOR, Roll } from "./effects";
import { Chapter, Intro, RecordWall, VerdictFilm } from "./fx";
import { RouteChart } from "./RouteChart";
import { RouteStage } from "./RouteStage";
import { StepCard } from "./StepCard";
import { ResultRegion } from "./ResultRegion";
import { acquireMotionHold, createMotionScope, motionNow, useMotionPaused } from "./motion-runtime";
import "./console-motion.css";
import { beatsOf, clock, nameOf, usageOf } from "./beats";

/** Joins sentences without doubling their end marks. */
const listOf = (items: string[]) => items.map((item) => item.replace(/[。；;.]+$/, "")).join("；");

const METRIC_STATE: Record<string, string> = {
  成立: "supported",
  已反驳: "refuted",
  未决: "unresolved",
};

/** How long each kind of step holds the screen during a film. */
const SHOT_MS = { propose: 2600, attack: 3200, verify: 3000, revise: 2600, judge: 4200 };
const SPEEDS = [
  { value: 1, label: "常速" },
  { value: 0.6, label: "慢速" },
  { value: 1.8, label: "快速" },
];

const OUTCOME = {
  recommendation: "当前条件下的建议",
  tie: "几条路线各有适用条件",
  insufficient: "现有依据不足以判断",
  infeasible: "当前条件下无法成立",
  partial: "阶段性判断",
};

export function ArenaConsole({
  version,
  steps,
  events,
  demo,
  slate,
  notices,
  conditions,
  agent,
  drafts,
  selectedAttack,
  historical,
  startFromBeginning = false,
  allowRecordedChallenges = false,
  busy,
  onEvidence,
  onClaim,
  onFollowUp,
  onAdjustConditions,
}: {
  version: ArenaVersion;
  steps: ArenaStep[];
  events: ArenaEvent[];
  demo: boolean;
  slate: React.ReactNode;
  notices: React.ReactNode;
  conditions: React.ReactNode;
  /** The agent's plan and action chain: its own band, so it never pushes the stage around. */
  agent?: React.ReactNode;
  /** Live and archived draft text: kept in the rail with its own scroll. */
  drafts?: React.ReactNode;
  selectedAttack?: string;
  historical: boolean;
  startFromBeginning?: boolean;
  allowRecordedChallenges?: boolean;
  busy: boolean;
  onEvidence: (attack: Attack) => void;
  onClaim: (strategy: Strategy, claimId: string) => void;
  onFollowUp?: (context: StepContext, trigger: HTMLElement | null) => void;
  onAdjustConditions?: (trigger: HTMLElement | null) => void;
}) {
  const beats = beatsOf(version);
  const last = beats.length - 1;
  const [cursor, setCursor] = useState<number | null>(startFromBeginning ? -1 : null);
  const [playing, setPlaying] = useState(startFromBeginning);
  const [speed, setSpeed] = useState(1);
  const [intro, setIntro] = useState(startFromBeginning);
  const [revealed, setRevealed] = useState(false);
  const [motion, setMotion] = useState(startFromBeginning);
  const [seeking, setSeeking] = useState(false);
  const [playbackPaused, setPlaybackPaused] = useState(false);
  const [filmDone, setFilmDone] = useState(false);
  const [stepwise, setStepwise] = useState(false);
  const [wholeResult, setWholeResult] = useState(false);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const paused = useMotionPaused();
  const nowPanel = useRef<HTMLElement>(null);
  const index = cursor === null ? last : Math.min(cursor, last);
  const current = index >= 0 ? beats[index] : null;
  const shown = beats.slice(0, index + 1);
  const seen = new Set(shown.map((b) => b.id));

  // A game in progress plays out as its results arrive. A finished game opens on its result.
  const live = version.status === "running" || version.status === "ready";
  const startedLive = useRef(live);
  useEffect(() => {
    if (!startedLive.current || reducedMotion()) return;
    const frame = requestAnimationFrame(() => {
      setMotion(true);
      setCursor(0);
      setPlaying(true);
      try {
        if (!sessionStorage.getItem("arena-intro")) setIntro(true);
      } catch {
        // Without session storage the opening simply does not play.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const reveal = useCallback(() => {
    setRevealed(true);
    if (startFromBeginning) setCursor((cursor) => (cursor === -1 ? 0 : cursor));
  }, [startFromBeginning]);
  const endFilm = useCallback(() => setFilmDone(true), []);
  const endIntro = useCallback(() => {
    setIntro(false);
    try {
      sessionStorage.setItem("arena-intro", "1");
    } catch {
      // Nothing to remember it in.
    }
  }, []);

  const stage = current?.stage;
  // The first step of a stage waits for its word to land, so the two never collide.
  const firstOfStage = !!stage && stage !== "judge" && beats[index - 1]?.stage !== stage;
  const lead = playing && !seeking && firstOfStage ? 560 / speed : 0;
  // Count only active playback time. Data refreshes and overlays must not spend the remaining shot.
  const shotClock = useRef({ id: "", elapsed: 0 });
  useLayoutEffect(() => {
    if (playbackPaused) return acquireMotionHold();
  }, [playbackPaused]);
  useEffect(() => {
    if (!playing || !stage || paused || openStep !== null || (intro && !revealed)) return;
    if (stepwise && index < last) return;
    const id = current?.id ?? "";
    if (shotClock.current.id !== id) shotClock.current = { id, elapsed: 0 };
    const clock = shotClock.current;
    const began = motionNow();
    const backlog = last - index;
    const full = SHOT_MS[stage] + (firstOfStage ? 560 : 0);
    const hold =
      backlog > 0 && startedLive.current ? Math.max(650, full / (1 + backlog * 0.5)) : full;
    const timer = setTimeout(
      () => {
        if (index < last) return setCursor(live || index + 1 < last ? index + 1 : null);
        if (live) return;
        setPlaying(false);
        setMotion(false);
        setCursor(null);
      },
      Math.max(0, hold - clock.elapsed) / speed,
    );
    return () => {
      clearTimeout(timer);
      clock.elapsed += (motionNow() - began) * speed;
    };
  }, [
    playing,
    current?.id,
    index,
    last,
    stage,
    speed,
    live,
    intro,
    revealed,
    firstOfStage,
    stepwise,
    openStep,
    paused,
  ]);

  const goTo = useCallback(
    (i: number) => {
      const target = Math.max(0, Math.min(i, last));
      if (last < 0 || target === index) return;
      startedLive.current = false;
      setIntro(false);
      // A seek performs the chosen shot directly; interruptions replace its choreography.
      setPlaying((p) => p && stepwise && target === index + 1);
      setPlaybackPaused(false);
      setSeeking(true);
      setMotion(true);
      setFilmDone(true);
      shotClock.current = { id: "", elapsed: 0 };
      setCursor(target >= last ? null : target);
    },
    [last, index, stepwise],
  );
  const replay = useCallback(() => {
    startedLive.current = false;
    if (playing) {
      setPlaybackPaused(true);
      return setPlaying(false);
    }
    setPlaybackPaused(false);
    setSeeking(false);
    setMotion(true);
    if (!playbackPaused) setFilmDone(false);
    if (index >= last && !playbackPaused) {
      shotClock.current = { id: "", elapsed: 0 };
      setCursor(0);
    }
    setPlaying(true);
  }, [playing, index, last, playbackPaused]);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target?.closest?.("input, textarea, select, dialog, .evidence-drawer")) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(index - 1);
      } else if (e.key === "End" || e.key === "G") {
        e.preventDefault();
        goTo(last);
      } else if (e.key === "Home") {
        e.preventDefault();
        goTo(0);
      } else if (e.key === " " && target?.tagName !== "BUTTON") {
        e.preventDefault();
        replay();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [goTo, index, last, replay]);

  // A replay reveals the log in step with the boards. Nothing is invented for the gap.
  const logged =
    index >= last
      ? events
      : events.slice(0, Math.ceil(((index + 1) / Math.max(beats.length, 1)) * events.length));
  const used = logged.flatMap((e) => usageOf(e) ?? []);
  const attacks = shown.filter((b) => b.stage === "attack").map((b) => b.attack!);
  const checked = attacks.filter((a) => seen.has(`v:${a.id}`));
  const count = (status: Attack["status"]) => checked.filter((a) => a.status === status).length;
  const tokens = used.reduce((t, u) => t + u.inputTokens + u.outputTokens, 0);
  const peak = Math.max(1, ...used.map((u) => u.inputTokens + u.outputTokens));
  const verdict = version.verdict;
  const directed = motion;
  // The result takes the lead once the game has reached it. Looking back at a step hides it.
  const atResult = !!verdict && index === last;
  // Looking back over a finished game, each step shows how it turned out.
  const reviewing = !!version.verdict && !live && !playing;
  const canReturn = !!version.verdict && index < last && !playing;
  const speedLabel = SPEEDS.find((s) => s.value === speed)?.label ?? "常速";
  // Counts roll when the energy reaches them, not before.
  const rollDelay = !directed
    ? 0
    : stage === "attack"
      ? lead + 980 / speed
      : stage === "verify"
        ? lead + 1280 / speed
        : 0;
  const metrics: [string, number, string][] = [
    ["质疑", attacks.length, ""],
    ["成立", count("supported"), "bad"],
    ["已反驳", count("refuted"), "ok"],
    ["未决", attacks.length - count("supported") - count("refuted"), "warn"],
    [demo ? "演示调用" : startFromBeginning ? "原记录调用" : "模型调用", used.length, ""],
    [demo ? "Token（预设）" : startFromBeginning ? "原记录 Token" : "Token", tokens, ""],
  ];

  // Keep controls mounted. Interruptions start from the displayed pose, not the start keyframe.
  useLayoutEffect(() => {
    const nodes = [
      ...(nowPanel.current?.querySelectorAll<HTMLElement>(
        ":scope > .fl, :scope > .big, :scope > p",
      ) ?? []),
    ];
    if (!seeking || reducedMotion()) {
      nodes.forEach((node) => {
        node.style.opacity = "";
        node.style.transform = "";
      });
      return;
    }
    const scope = createMotionScope("interaction");
    const starts = nodes.map((node) => ({
      opacity: node.style.opacity || "0.35",
      transform: node.style.transform || "translateY(16px)",
    }));
    const animations = nodes.map((node, i) => {
      const animation = scope.animate(node, [starts[i], { opacity: 1, transform: "none" }], {
        duration: 560,
        easing: "cubic-bezier(.16,1,.3,1)",
        fill: "both",
      });
      animation.onfinish = () => {
        node.style.opacity = "";
        node.style.transform = "";
        animation.cancel();
      };
      return animation;
    });
    return () => {
      const displayed = nodes.map((node) => {
        const style = getComputedStyle(node);
        return { opacity: style.opacity, transform: style.transform };
      });
      animations.forEach((animation, i) => {
        const interrupted = animation.playState === "running";
        animation.cancel();
        if (interrupted) Object.assign(nodes[i].style, displayed[i]);
      });
      scope.dispose();
    };
  }, [current?.id, seeking]);

  return (
    <div
      data-motion-origin={seeking ? "interaction" : "story"}
      className={`c-root ${playing ? "theater" : ""} ${paused ? "held" : ""} ${seeking ? "is-seeking" : ""} ${atResult ? "at-result" : ""}`}
    >
      <RecordWall
        version={version}
        shown={shown}
        currentId={current?.id}
        events={logged}
        directed={directed && !seeking}
      />
      <div className="c-hud">
        <div className="c-slate">{slate}</div>
        {verdict && (
          <ResultRegion open={atResult} expanded={wholeResult}>
            <section
              className={`c-result ${wholeResult ? "whole" : ""}`}
              aria-label="结论"
              id="verdict"
            >
              <div className="lead">
                <div className="tag">
                  <b
                    className={verdict.preferred ? "pick" : "none"}
                    style={
                      verdict.preferred
                        ? ({
                            "--route": ROUTE_COLOR[verdict.preferred].replaceAll(",", " "),
                          } as CSSProperties)
                        : undefined
                    }
                  >
                    {verdictLabel(verdict)}
                  </b>
                  <span>{OUTCOME[verdict.outcome]}</span>
                </div>
                <h2>{readableClaimText(version, verdict.headline)}</h2>
                <p>{readableClaimText(version, verdict.rationale)}</p>
              </div>
              <div className="act">
                <div className="first">
                  <small>现在该做的第一步</small>
                  <strong>{readableClaimText(version, verdict.nextActions[0])}</strong>
                </div>
                <dl>
                  <div>
                    <dt>前提</dt>
                    <dd>{readableClaimText(version, listOf(verdict.conditions)) || "未给出"}</dd>
                  </div>
                  <div>
                    <dt>仍需确认</dt>
                    <dd>{readableClaimText(version, listOf(verdict.uncertainties)) || "未列出"}</dd>
                  </div>
                  <div>
                    <dt>退出条件</dt>
                    <dd>{readableClaimText(version, verdict.exitCondition)}</dd>
                  </div>
                </dl>
                {verdict.nextActions.length > 1 && (
                  <p className="more">
                    接着做：{readableClaimText(version, listOf(verdict.nextActions.slice(1)))}
                  </p>
                )}
                <button
                  type="button"
                  aria-expanded={wholeResult}
                  aria-controls="verdict"
                  onClick={() => setWholeResult((w) => !w)}
                >
                  {wholeResult ? "收起结论" : "看完整结论"}
                </button>
              </div>
            </section>
          </ResultRegion>
        )}
        <div className="c-conditions">{conditions}</div>
        {agent && <div className="c-agent">{agent}</div>}
        <div className="c-notices">{notices}</div>
        <div className="c-track">
          <div className="c-time" role="group" aria-label="推演步骤">
            {STAGES.map((stage) => {
              const own = steps.filter((s) => s.stage === stage);
              const list = beats.flatMap((b, i) => (b.stage === stage ? [{ b, i }] : []));
              const done =
                own.length > 0 &&
                own.every((s) => s.status === "completed" || s.status === "skipped") &&
                (!startFromBeginning || list.every(({ i }) => i <= index));
              const bad = own.some((s) => s.status === "failed" || s.status === "uncertain");
              return (
                <div
                  key={stage}
                  className={`seg ${bad ? "bad" : done ? "done" : version.stage === stage ? "live" : ""} ${current?.stage === stage ? "here" : ""}`}
                  style={{ flexGrow: Math.max(list.length, 2) }}
                >
                  <span>{STAGE_LABELS[stage]}</span>
                  <div className="ticks">
                    {list.map(({ b, i }) => (
                      <button
                        key={b.id}
                        type="button"
                        aria-label={`第 ${i + 1} 步`}
                        data-tip={`第 ${i + 1} 步`}
                        aria-current={i === index ? "step" : undefined}
                        className={`${i <= index ? "seen" : ""} ${i === index ? "cur" : ""} ${b.stage === "verify" && b.attack ? `is-${b.attack.status}` : ""}`}
                        onClick={() => goTo(i)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <dl className="c-metrics">
            {metrics.map(([label, value, tone]) => (
              <div key={label} className={tone} data-state={METRIC_STATE[label]}>
                <dt>{label}</dt>
                <dd>
                  <Roll
                    value={value}
                    delay={rollDelay}
                    animate={directed}
                    origin={seeking ? "interaction" : "story"}
                  />
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <main className="c-main">
          <RouteStage
            version={version}
            demo={demo}
            beats={beats}
            index={index}
            speed={speed}
            directed={directed}
            seeking={seeking}
            camera={playing || seeking}
            lead={lead}
            located={selectedAttack}
            reviewing={reviewing}
            onStep={setOpenStep}
            onEvidence={onEvidence}
            entering={intro && !revealed}
            readOnly={(historical && !allowRecordedChallenges) || busy}
            onClaim={onClaim}
          />
          <div className="c-rail">
            <section className="c-now" ref={nowPanel} aria-label="正在发生">
              <div className="fl">
                {current ? (
                  <>
                    <b>{nameOf(current.agent)}</b>
                    {current.to && (
                      <>
                        {" → "}
                        <b>{nameOf(current.to)}</b>
                      </>
                    )}
                  </>
                ) : (
                  "正在发生"
                )}
                <span>
                  {index + 1}/{beats.length}
                </span>
              </div>
              <div className="big">
                <Chars
                  text={current ? current.title : "等待第一步"}
                  active={directed && !seeking}
                  delay={180}
                />
              </div>
              <p>
                {current
                  ? current.plain
                  : demo
                    ? "等待演示步骤，三条路线与步骤内容均为预设，未调用模型。"
                    : "同一模型分成五个角色，替你比较三条路线。"}
              </p>
              {canReturn && (
                <button type="button" className="c-back" onClick={() => goTo(last)}>
                  回到结果 →
                </button>
              )}
              <div className="c-ctrl">
                <button
                  type="button"
                  aria-label="上一步"
                  disabled={index <= 0}
                  onClick={() => goTo(index - 1)}
                >
                  ←
                </button>
                <button type="button" disabled={beats.length < 2} onClick={replay}>
                  {playing ? "暂停放映" : index < last || playbackPaused ? "继续放映" : "从头放映"}
                </button>
                <button
                  type="button"
                  aria-label="下一步"
                  disabled={index >= last}
                  onClick={() => goTo(index + 1)}
                >
                  →
                </button>
                <button
                  type="button"
                  aria-label="放映速度"
                  onClick={() =>
                    setSpeed((s) => SPEEDS[(SPEEDS.findIndex((x) => x.value === s) + 1) % 3].value)
                  }
                >
                  {speedLabel}
                </button>
                <button
                  type="button"
                  aria-pressed={stepwise}
                  title="每一步停住，按 → 或“下一步”继续"
                  className={stepwise ? "on" : ""}
                  onClick={() => {
                    if (stepwise && playing) setSeeking(false);
                    setStepwise(!stepwise);
                  }}
                >
                  逐步看
                </button>
              </div>
            </section>
            {drafts && <div className="c-drafts">{drafts}</div>}
            <section className="c-trace" aria-label="步骤记录">
              <h2>
                步骤记录 <span>{logged.length}</span>
              </h2>
              <div className="c-log">
                {logged.slice(-40).map((event, i, list) => {
                  const usage = usageOf(event);
                  return (
                    <div
                      key={event.seq}
                      className={`${i === list.length - 1 ? "hot" : ""} ${/fail|uncertain/.test(event.type) ? "bad" : ""}`}
                    >
                      <b>{clock(event.createdAt)}</b> {event.message}
                      {usage && ` ${usage.inputTokens}/${usage.outputTokens}`}
                    </div>
                  );
                })}
              </div>
              <div className="c-scope" aria-hidden="true">
                {used.map((u, i) => (
                  <i
                    key={i}
                    style={{ height: `${((u.inputTokens + u.outputTokens) / peak) * 100}%` }}
                  />
                ))}
              </div>
              <small>
                {demo
                  ? "演示内容：步骤和用量都是预设的，未调用模型。"
                  : `未保存模型的隐藏推理，这里展示的是实际记录的步骤。${version.modelSelection?.modelId ?? "早期记录：模型未记录"}`}
              </small>
            </section>
          </div>
        </main>
        <div className="c-bottom">
          <RouteChart version={version} beats={beats} index={index} onStep={setOpenStep} />
          <section className="c-list" aria-label="全部质疑">
            <h2>
              全部质疑 <span>点击看证据</span>
            </h2>
            <div className="rows">
              {attacks.length === 0 && <div className="quiet">交叉质疑尚未开始。</div>}
              {attacks.map((a) => {
                const state = seen.has(`v:${a.id}`) ? a.status : "pending";
                return (
                  <button
                    key={a.id}
                    type="button"
                    id={`dispute-${a.id}`}
                    data-attack={a.id}
                    title="查看这条质疑的证据"
                    className={`c-row ${a.id === current?.attack?.id ? "sel" : ""} ${a.id === selectedAttack ? "located" : ""}`}
                    onClick={() => onEvidence(a)}
                  >
                    <em className={`is-${state}`}>
                      {a.from}→{a.targetStrategyId} {attackMeta[state].label}
                    </em>
                    <span>{readableClaimText(version, a.reason)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
      {playing && directed && !seeking && current && current.stage !== "judge" && (
        <Chapter key={current.stage} stage={current.stage} />
      )}
      {verdict && directed && !filmDone && current?.id === "judge" && (
        <VerdictFilm verdict={verdict} onDone={endFilm} />
      )}
      {openStep !== null && beats[openStep] && (
        <StepCard
          version={version}
          beats={beats}
          index={openStep}
          last={index}
          reviewing={reviewing}
          onOpen={setOpenStep}
          onClose={() => setOpenStep(null)}
          onFollowUp={
            onFollowUp && (!historical || allowRecordedChallenges) && !busy
              ? (context, trigger) => {
                  setOpenStep(null);
                  onFollowUp(context, trigger);
                }
              : undefined
          }
          onAdjustConditions={
            onAdjustConditions && (!historical || allowRecordedChallenges) && !busy
              ? (trigger) => {
                  setOpenStep(null);
                  onAdjustConditions(trigger);
                }
              : undefined
          }
          onStage={(i) => {
            setOpenStep(null);
            goTo(i);
          }}
          onEvidence={(attack) => {
            setOpenStep(null);
            onEvidence(attack);
          }}
        />
      )}
      {intro && (
        <Intro version={version} events={events} demo={demo} onReveal={reveal} onDone={endIntro} />
      )}
    </div>
  );
}
