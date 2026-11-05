"use client";
import { useCallback, useEffect, useState } from "react";
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
import { attackMeta, comparisonMeta } from "@/components/status";
import { Decode, Roll } from "./effects";
import { Intro, RecordWall, VerdictFilm } from "./fx";
import { RouteStage } from "./RouteStage";
import { beatsOf, clock, nameOf, usageOf } from "./beats";

/** How long each kind of step holds the screen during a film. */
const SHOT_MS = { propose: 1900, attack: 3200, verify: 2600, revise: 2400, judge: 5400 };

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
  const index = cursor === null ? last : Math.min(cursor, last);
  const current = index >= 0 ? beats[index] : null;
  const shown = beats.slice(0, index + 1);
  const seen = new Set(shown.map((b) => b.id));

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        if (!sessionStorage.getItem("arena-intro")) setIntro(true);
      } catch {
        // Without session storage the opening simply does not play.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  // The film starts as the shutter opens, so the result is never shown before its first step.
  const reveal = useCallback(() => {
    setRevealed((done) => {
      if (!done && last >= 1) {
        setMotion(true);
        setFilmDone(false);
        setCursor(0);
        setPlaying(true);
      }
      return true;
    });
  }, [last]);
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
  useEffect(() => {
    if (!playing || !stage) return;
    const timer = setTimeout(() => {
      if (index >= last) return setPlaying(false);
      setCursor(index + 1 >= last ? null : index + 1);
    }, SHOT_MS[stage] / speed);
    return () => clearTimeout(timer);
  }, [playing, index, last, stage, speed]);

  const goTo = useCallback(
    (i: number) => {
      setPlaying(false);
      setMotion(i === index + 1);
      setFilmDone(false);
      setCursor(i >= last ? null : Math.max(i, 0));
    },
    [last, index],
  );
  const replay = () => {
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
  const directed = motion || version.status === "running";
  const metrics: [string, number, string][] = [
    ["质疑", attacks.length, ""],
    ["成立", count("supported"), "bad"],
    ["已反驳", count("refuted"), "ok"],
    ["未决", attacks.length - count("supported") - count("refuted"), "warn"],
    ["模型调用", used.length, ""],
    ["Token", tokens, ""],
  ];

  return (
    <div className={`c-root ${playing && current?.stage !== "judge" ? "theater" : ""}`}>
      <RecordWall version={version} events={logged} />
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
              <div key={label} className={tone}>
                <dt>{label}</dt>
                <dd>
                  <Roll value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <main className="c-main">
          <RouteStage
            version={version}
            beats={beats}
            index={index}
            speed={speed}
            directed={directed}
            camera={cursor !== null || playing}
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
                <Decode
                  key={current?.id}
                  text={current ? current.title : "等待第一步"}
                  active={directed}
                />
              </div>
              <p>{current ? current.plain : "同一模型分成五个角色，替你比较三条路线。"}</p>
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
                  onClick={() => setSpeed((s) => (s >= 4 ? 0.5 : s * 2))}
                >
                  {speed}×
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
              <small>模型隐藏推理未保存，这里只有真实步骤。{model.id}</small>
            </section>
          </div>
        </main>
        <div className="c-bottom">
          <section className={`c-verdict ${verdict ? "ready" : ""}`} aria-label="裁决">
            {verdict ? (
              <div key="v" id="verdict" tabIndex={-1}>
                <small>{OUTCOME[verdict.outcome]}</small>
                <h2>
                  {verdict.preferred && <span>建议 {verdict.preferred}：</span>}
                  {verdict.headline}
                </h2>
                <p>{verdict.rationale}</p>
                <div className="grid">
                  <div>
                    <b>下一步</b> {verdict.nextActions.join("；")}
                  </div>
                  <div>
                    <b>前提</b> {verdict.conditions.join("；") || "未给出"}
                  </div>
                  <div>
                    <b>仍需确认</b> {verdict.uncertainties.join("；") || "未列出"}
                  </div>
                  <div>
                    <b>退出</b> {verdict.exitCondition}
                  </div>
                </div>
                {verdict.comparisons.map((c) => (
                  <div key={c.strategyId} className="quiet">
                    {c.strategyId} {comparisonMeta[c.status].label} · {c.reason}
                  </div>
                ))}
              </div>
            ) : (
              <div className="quiet">裁决留在全部质疑结束之后。</div>
            )}
          </section>
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
                    className={`c-row ${a.id === current?.attack?.id ? "sel" : ""}`}
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
