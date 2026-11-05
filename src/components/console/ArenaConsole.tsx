"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  STAGES,
  STAGE_LABELS,
  type ArenaEvent,
  type ArenaSnapshot,
  type ArenaStep,
  type ArenaVersion,
  type Attack,
  type Strategy,
} from "@/lib/contracts";
import { attackMeta } from "@/components/status";
import { Chars, reducedMotion, ROUTE_COLOR, Roll } from "./effects";
import { Chapter, Intro, RecordWall, VerdictFilm } from "./fx";
import { RouteChart } from "./RouteChart";
import { RouteStage } from "./RouteStage";
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
  tie: "两条路线各有成立条件",
  insufficient: "现有依据不足以判断",
  infeasible: "当前条件下无法成立",
  partial: "阶段性判断",
};

export function ArenaConsole({
  version,
  steps,
  events,
  model,
  slate,
  notices,
  conditions,
  selectedAttack,
  historical,
  busy,
  onEvidence,
  onClaim,
}: {
  version: ArenaVersion;
  steps: ArenaStep[];
  events: ArenaEvent[];
  model: ArenaSnapshot["model"];
  slate: React.ReactNode;
  notices: React.ReactNode;
  conditions: React.ReactNode;
  selectedAttack?: string;
  historical: boolean;
  busy: boolean;
  onEvidence: (attack: Attack) => void;
  onClaim: (strategy: Strategy, claimId: string) => void;
}) {
  const beats = beatsOf(version);
  const last = beats.length - 1;
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [intro, setIntro] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [motion, setMotion] = useState(false);
  const [filmDone, setFilmDone] = useState(false);
  const [stepwise, setStepwise] = useState(false);
  const [wholeResult, setWholeResult] = useState(false);
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
  const reveal = useCallback(() => setRevealed(true), []);
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
  const lead = playing && firstOfStage ? 560 / speed : 0;
  // Each step's clock starts when the step does, so a new result arriving never restarts it.
  const shotClock = useRef({ index: -1, at: 0 });
  useEffect(() => {
    if (!playing || !stage) return;
    // Step by step: the viewer moves on when ready. Only the last step still finishes by itself.
    if (stepwise && index < last) return;
    // Only a game already complete at first sight skips ahead; one being watched walks to its end.
    const behind = !live && startedLive.current && index <= 1 && last - index > 2;
    if (intro && !revealed && !behind) return;
    const now = performance.now();
    if (shotClock.current.index !== index) shotClock.current = { index, at: now };
    // In a live game, steps shorten while results wait in line, so the screen catches up without a jump.
    // A replay the viewer asked for keeps its full pace.
    const backlog = last - index;
    const full = SHOT_MS[stage] / speed + lead;
    const hold =
      backlog > 0 && startedLive.current ? Math.max(650 / speed, full / (1 + backlog * 0.5)) : full;
    const timer = setTimeout(
      () => {
        if (behind) {
          setIntro(false);
          setMotion(false);
          setPlaying(false);
          setCursor(null);
          return;
        }
        if (index < last) return setCursor(live || index + 1 < last ? index + 1 : null);
        if (live) return;
        setPlaying(false);
        setCursor(null);
      },
      behind ? 0 : Math.max(0, hold - (now - shotClock.current.at)),
    );
    return () => clearTimeout(timer);
  }, [playing, index, last, stage, speed, live, intro, revealed, lead, stepwise]);

  const goTo = useCallback(
    (i: number) => {
      startedLive.current = false;
      // In step-by-step viewing, moving on is the point; anything else leaves playback.
      setPlaying((p) => p && stepwise && i === index + 1);
      setMotion(i === index + 1);
      setFilmDone(false);
      setCursor(i >= last ? null : Math.max(i, 0));
    },
    [last, index, stepwise],
  );
  const replay = () => {
    startedLive.current = false;
    if (playing) return setPlaying(false);
    setMotion(true);
    setFilmDone(false);
    if (index >= last) setCursor(0);
    setPlaying(true);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
        setPlaying((p) => {
          if (!p) {
            setMotion(true);
            setFilmDone(false);
            if (cursor === null) setCursor(0);
          }
          return !p;
        });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [goTo, index, last, cursor]);

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
  const verdict = seen.has("judge") ? version.verdict : null;
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
    ["模型调用", used.length, ""],
    ["Token", tokens, ""],
  ];

  return (
    <div className={`c-root ${playing ? "theater" : ""} ${atResult ? "at-result" : ""}`}>
      <RecordWall version={version} shown={shown} currentId={current?.id} events={logged} />
      <div className="c-hud">
        <div className="c-slate">{slate}</div>
        <div className="c-conditions">{conditions}</div>
        <div className="c-notices">{notices}</div>
        <div className="c-track">
          <div className="c-time" role="group" aria-label="推演步骤">
            {STAGES.map((stage) => {
              const own = steps.filter((s) => s.stage === stage);
              const done =
                own.length > 0 &&
                own.every((s) => s.status === "completed" || s.status === "skipped");
              const bad = own.some((s) => s.status === "failed" || s.status === "uncertain");
              const list = beats.flatMap((b, i) => (b.stage === stage ? [{ b, i }] : []));
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
                  <Roll value={value} delay={rollDelay} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {atResult && verdict && (
          <section
            className={`c-result ${directed ? "arrive" : ""} ${wholeResult ? "whole" : ""}`}
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
                  {verdict.preferred ? `建议 ${verdict.preferred}` : "暂无单一建议"}
                </b>
                <span>{OUTCOME[verdict.outcome]}</span>
              </div>
              <h2>
                <Chars text={verdict.headline} active={directed} delay={500} />
              </h2>
              <p>{verdict.rationale}</p>
            </div>
            <div className="act">
              <div className="first">
                <small>现在第一步</small>
                <strong>{verdict.nextActions[0]}</strong>
              </div>
              <dl>
                <div>
                  <dt>前提</dt>
                  <dd>{listOf(verdict.conditions) || "未给出"}</dd>
                </div>
                <div>
                  <dt>仍需确认</dt>
                  <dd>{listOf(verdict.uncertainties) || "未列出"}</dd>
                </div>
                <div>
                  <dt>退出条件</dt>
                  <dd>{verdict.exitCondition}</dd>
                </div>
              </dl>
              {verdict.nextActions.length > 1 && (
                <p className="more">接着做：{listOf(verdict.nextActions.slice(1))}</p>
              )}
              <button type="button" onClick={() => setWholeResult((w) => !w)}>
                {wholeResult ? "收起结论" : "看完整结论"}
              </button>
            </div>
          </section>
        )}
        <main className="c-main">
          <RouteStage
            version={version}
            beats={beats}
            index={index}
            speed={speed}
            directed={directed}
            camera={cursor !== null || playing}
            lead={lead}
            located={selectedAttack}
            reviewing={reviewing}
            onStep={goTo}
            onEvidence={onEvidence}
            entering={intro && !revealed}
            readOnly={historical || busy}
            onClaim={onClaim}
          />
          <div className="c-rail">
            <section className="c-now" key={current?.id} aria-label="正在发生">
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
                  active={directed}
                  delay={180}
                />
              </div>
              <p>{current ? current.plain : "同一模型分成五个角色，替你比较三条路线。"}</p>
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
                  {playing ? "暂停放映" : "从头放映"}
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
                  onClick={() => setStepwise((v) => !v)}
                >
                  逐步看
                </button>
              </div>
            </section>
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
                {model.id === "demo-no-model"
                  ? "演示内容：步骤和用量都是预设的，未调用模型。"
                  : `模型隐藏推理未保存，这里只有真实步骤。${model.id}`}
              </small>
            </section>
          </div>
        </main>
        <div className="c-bottom">
          <RouteChart version={version} beats={beats} index={index} onStep={goTo} />
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
                    <span>{a.reason}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
      {playing && current && current.stage !== "judge" && (
        <Chapter key={current.stage} stage={current.stage} />
      )}
      {verdict && directed && !filmDone && current?.id === "judge" && (
        <VerdictFilm verdict={verdict} onDone={endFilm} />
      )}
      {intro && (
        <Intro
          version={version}
          events={events}
          model={model}
          onReveal={reveal}
          onDone={endIntro}
        />
      )}
    </div>
  );
}
