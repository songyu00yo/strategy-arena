"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Play, Pause } from "lucide-react";
import {
  STAGES,
  STAGE_LABELS,
  type ArenaEvent,
  type ArenaStep,
  type ArenaVersion,
  type Attack,
  type ModelUsage,
  type Stage,
  type Strategy,
} from "@/lib/contracts";
import { attackMeta, comparisonMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { strategyChanges, TextDiff } from "@/components/text-diff";

const BEAT_MS = 1900;
const AGENTS = [
  { id: "A", name: "方案 A", short: "A" },
  { id: "B", name: "方案 B", short: "B" },
  { id: "C", name: "方案 C", short: "C" },
  { id: "verify", name: "核验", short: "核" },
  { id: "judge", name: "裁判", short: "裁" },
] as const;
type AgentId = (typeof AGENTS)[number]["id"];
const nameOf = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;
const CLAIM = { user: "用户提供", estimate: "估算", unknown: "待核验", supported: "有材料" };
const OUTCOME = {
  recommendation: "当前条件下的建议",
  tie: "两条路线各有成立条件",
  insufficient: "现有依据不足以判断",
  infeasible: "当前条件下无法成立",
  partial: "阶段性判断",
};

/** One recorded step. Beats only describe what a version has stored. */
type Beat = {
  id: string;
  stage: Stage;
  agent: AgentId;
  anchor: string;
  label: string;
  line: string;
  attack?: Attack;
};

function beatsOf(version: ArenaVersion): Beat[] {
  const beats: Beat[] = [];
  for (const s of version.strategies)
    beats.push({
      id: `p:${s.id}`,
      stage: "propose",
      agent: s.id,
      anchor: `frame-${s.id}`,
      label: "提出方案",
      line: s.title,
    });
  for (const a of version.attacks)
    beats.push({
      id: `a:${a.id}`,
      stage: "attack",
      agent: a.from as AgentId,
      anchor: `thread-${a.id}`,
      label: `质疑 ${a.targetStrategyId}`,
      line: a.reason,
      attack: a,
    });
  for (const a of version.attacks) {
    const evidence = version.evidence.filter((e) => e.attackId === a.id);
    if (!evidence.length && a.status === "pending") continue;
    beats.push({
      id: `v:${a.id}`,
      stage: "verify",
      agent: "verify",
      anchor: `thread-${a.id}`,
      label: `核验 ${a.from}→${a.targetStrategyId}`,
      line: attackMeta[a.status].label,
      attack: a,
    });
  }
  for (const r of version.revisions)
    beats.push({
      id: `r:${r.strategyId}`,
      stage: "revise",
      agent: r.strategyId,
      anchor: `revision-${r.strategyId}`,
      label: "修订",
      line: r.summary,
    });
  if (version.verdict)
    beats.push({
      id: "judge",
      stage: "judge",
      agent: "judge",
      anchor: "frame-judge",
      label: "裁决",
      line: version.verdict.headline,
    });
  return beats;
}

type Box = { x: number; y: number; w: number; h: number };
type EventData = { usage?: ModelUsage | null; modelOutput?: unknown } | null;
const usageOf = (event: ArenaEvent) => (event.data as EventData)?.usage ?? null;
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function Avatar({ agent }: { agent: AgentId | string }) {
  return (
    <span className={`avatar agent-${agent}`} aria-hidden="true">
      {AGENTS.find((a) => a.id === agent)?.short ?? "?"}
    </span>
  );
}

/** A debate is a comment thread pinned to the claim it disputes. */
function Thread({
  attack,
  version,
  seen,
  selected,
  onEvidence,
}: {
  attack: Attack;
  version: ArenaVersion;
  seen: Set<string>;
  selected: boolean;
  onEvidence: (attack: Attack) => void;
}) {
  const checked = seen.has(`v:${attack.id}`);
  const replied = seen.has(`r:${attack.targetStrategyId}`);
  const judged = seen.has("judge");
  const evidence = version.evidence.filter((e) => e.attackId === attack.id);
  const response = version.revisions
    .find((r) => r.strategyId === attack.targetStrategyId)
    ?.responses.find((r) => r.attackId === attack.id);
  const finding = version.verdict?.attackFindings.find((f) => f.attackId === attack.id);
  return (
    <div
      id={`dispute-${attack.id}`}
      data-anchor={`thread-${attack.id}`}
      tabIndex={-1}
      className={`thread agent-${attack.from} ${selected ? "selected" : ""}`}
    >
      <div className="comment">
        <Avatar agent={attack.from} />
        <div>
          <button
            type="button"
            className={`comment-text ${checked && attack.status === "refuted" ? "struck" : ""}`}
            onClick={() => onEvidence(attack)}
          >
            {attack.reason}
          </button>
          <p className="soft">{attack.impact}</p>
        </div>
      </div>
      {checked && (
        <div className="comment comment-in">
          <Avatar agent="verify" />
          <div>
            <p className={`verdict-word is-${attack.status}`}>
              {attack.status === "supported" || attack.status === "refuted" ? (
                <Check size={12} aria-hidden="true" />
              ) : null}
              {attackMeta[attack.status].label}
            </p>
            {evidence.map((e) => (
              <p key={e.id}>
                {e.expression ? `${e.expression} = ${e.result ?? "无法计算"}。` : ""}
                {e.content || evidenceMeta[e.status].label}
              </p>
            ))}
          </div>
        </div>
      )}
      {replied && response && (
        <div className="comment comment-in">
          <Avatar agent={attack.targetStrategyId} />
          <div>
            <p>
              <b>{decisionMeta[response.decision].label}</b> {response.reason}
            </p>
            {response.change && <p className="now">{response.change}</p>}
          </div>
        </div>
      )}
      {judged && finding && (
        <div className="comment comment-in">
          <Avatar agent="judge" />
          <p>{finding.reason}</p>
        </div>
      )}
    </div>
  );
}

/** Figma's selection handles, on whichever frame the current step belongs to. */
function Handles() {
  return (
    <span className="handles" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function RouteFrame({
  strategy,
  id,
  version,
  seen,
  selectedAttack,
  usage,
  current: isCurrent,
  readOnly,
  onEvidence,
  onClaim,
}: {
  strategy?: Strategy;
  id: "A" | "B" | "C";
  version: ArenaVersion;
  seen: Set<string>;
  selectedAttack?: string;
  usage: string;
  current: boolean;
  readOnly: boolean;
  onEvidence: (attack: Attack) => void;
  onClaim: (s: Strategy, claimId: string) => void;
}) {
  const present = !!strategy && seen.has(`p:${id}`);
  const revision = seen.has(`r:${id}`)
    ? version.revisions.find((r) => r.strategyId === id)
    : undefined;
  const view = revision?.strategy ?? strategy;
  const changes = strategy && revision ? strategyChanges(strategy, revision.strategy) : [];
  const attacks = version.attacks.filter((a) => a.targetStrategyId === id && seen.has(`a:${a.id}`));
  const claimIds = strategy
    ? [...new Set([...strategy.claims, ...(view?.claims ?? [])].map((c) => c.id))]
    : [];
  const orphans = attacks.filter((a) => !claimIds.includes(a.targetClaimId));
  const comparison = seen.has("judge")
    ? version.verdict?.comparisons.find((c) => c.strategyId === id)
    : undefined;
  return (
    <section
      className={`frame agent-${id} ${isCurrent ? "is-current" : ""}`}
      id={`route-${id}`}
      aria-label={nameOf(id)}
    >
      <Handles />
      <header className="frame-label" data-anchor={`frame-${id}`}>
        <Avatar agent={id} />
        <b>{nameOf(id)}</b>
        <span>{usage}</span>
      </header>
      <div className="frame-body">
        {present && strategy && view ? (
          <>
            <h3>{view.title}</h3>
            <p>{view.thesis}</p>
            <p className="soft">
              {strategy.estimatedHours === view.estimatedHours
                ? `${view.estimatedHours ?? "?"} 小时`
                : `${strategy.estimatedHours} → ${view.estimatedHours} 小时`}{" "}
              · ¥{view.estimatedCost ?? "?"}
            </p>
            {comparison && (
              <p className={`verdict-word is-${comparison.status}`}>
                {comparisonMeta[comparison.status].label}：{comparison.reason}
              </p>
            )}
            <div className="claims">
              {claimIds.map((claimId) => {
                const before = strategy.claims.find((c) => c.id === claimId);
                const after = view.claims.find((c) => c.id === claimId);
                const claim = after ?? before!;
                const threads = attacks.filter((a) => a.targetClaimId === claimId);
                const lost = threads.some((a) => a.status === "supported" && seen.has(`v:${a.id}`));
                return (
                  <div key={claimId} className="claim-block">
                    <button
                      type="button"
                      className="claim-card"
                      disabled={readOnly || !after}
                      title={after ? "提出你的质疑" : "这条主张已撤回"}
                      onClick={() => onClaim(view, claimId)}
                    >
                      <span className="claim-id">
                        {claimId} · {CLAIM[claim.status]}
                        {!after && " · 已撤回"}
                        {!before && " · 修订新增"}
                      </span>
                      <span className={lost || !after ? "struck" : ""}>
                        {before?.text ?? claim.text}
                      </span>
                      {before && after && before.text !== after.text && (
                        <span className="now">{after.text}</span>
                      )}
                    </button>
                    {threads.map((a) => (
                      <Thread
                        key={a.id}
                        attack={a}
                        version={version}
                        seen={seen}
                        selected={a.id === selectedAttack}
                        onEvidence={onEvidence}
                      />
                    ))}
                  </div>
                );
              })}
              {orphans.map((a) => (
                <Thread
                  key={a.id}
                  attack={a}
                  version={version}
                  seen={seen}
                  selected={a.id === selectedAttack}
                  onEvidence={onEvidence}
                />
              ))}
            </div>
            <div data-anchor={`revision-${id}`}>
              {revision && (
                <p className="revision">
                  <b>修订{changes.length ? ` ${changes.length} 处` : "：未改"}</b>{" "}
                  {revision.summary}
                </p>
              )}
            </div>
            <p className="soft">第一步：{view.firstAction}</p>
          </>
        ) : (
          <p className="soft">等待提案</p>
        )}
      </div>
    </section>
  );
}

function RouteDetail({ beat, version }: { beat: Beat; version: ArenaVersion }) {
  if (beat.stage !== "propose" && beat.stage !== "revise") return null;
  const proposal = version.strategies.find((s) => s.id === beat.agent);
  if (!proposal) return null;
  const revision =
    beat.stage === "revise"
      ? version.revisions.find((r) => r.strategyId === beat.agent)
      : undefined;
  const view = revision?.strategy ?? proposal;
  const changes = revision ? strategyChanges(proposal, revision.strategy) : [];
  return (
    <>
      {changes.length > 0 && (
        <>
          <h3>改了什么</h3>
          {changes.map((c) => (
            <div key={c.label} className="diff-item">
              <h4>{c.label}</h4>
              <TextDiff before={c.before} after={c.after} />
            </div>
          ))}
        </>
      )}
      {beat.stage === "propose" && (
        <>
          <h3>思路</h3>
          <p>{view.thesis}</p>
        </>
      )}
      <h3>行动路径</h3>
      <ol className="steps">
        {view.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <h3>第一步</h3>
      <p>{view.firstAction}</p>
      <h3>失效条件</h3>
      <p>{view.failureCondition}</p>
      <h3>资源</h3>
      <p>{view.resources}</p>
    </>
  );
}

export function CanvasRoom({
  version,
  steps,
  events,
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
  const index = cursor === null ? last : Math.min(cursor, last);
  const shown = beats.slice(0, index + 1);
  const seen = new Set(shown.map((b) => b.id));
  const current = index >= 0 ? beats[index] : null;
  const canvas = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setCursor((value) => {
        const next = (value ?? -1) + 1;
        if (next >= last) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, BEAT_MS);
    return () => clearInterval(timer);
  }, [playing, last]);

  // Cursors and connectors follow real layout, so they survive long text and any screen size.
  useEffect(() => {
    const root = canvas.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const base = root.getBoundingClientRect();
        const next: Record<string, Box> = {
          "@canvas": { x: 0, y: 0, w: base.width, h: base.height },
        };
        root.querySelectorAll<HTMLElement>("[data-anchor]").forEach((node) => {
          const r = node.getBoundingClientRect();
          // An anchor scrolled out of its frame clamps to the frame's visible edge.
          const parent = node.closest(".frame-body")?.getBoundingClientRect();
          const top = parent ? Math.min(Math.max(r.top, parent.top), parent.bottom - 12) : r.top;
          next[node.dataset.anchor!] = {
            x: r.left - base.left,
            y: top - base.top,
            w: r.width,
            h: r.height,
          };
        });
        setBoxes(next);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener("scroll", measure, true);
    };
  }, [index, version]);

  // The current thread stays in view inside its frame.
  useEffect(() => {
    if (!current) return;
    const node = canvas.current?.querySelector<HTMLElement>(`[data-anchor="${current.anchor}"]`);
    const body = node?.closest(".frame-body");
    if (node && body) node.scrollIntoView({ block: "nearest" });
  }, [current]);

  const usageFor = (id: AgentId) => {
    const own = events.filter((e) =>
      id === "verify"
        ? e.stage === "verify"
        : id === "judge"
          ? e.stage === "judge"
          : e.actor?.split(":")[0] === id,
    );
    const used = own.flatMap((e) => usageOf(e) ?? []);
    const running = steps.some(
      (s) =>
        s.status === "running" &&
        (id === "verify"
          ? s.stage === "verify"
          : id === "judge"
            ? s.stage === "judge"
            : s.role.split(":")[0] === id),
    );
    const tokens = used.reduce((t, u) => t + u.inputTokens + u.outputTokens, 0);
    const ms = used.reduce((t, u) => t + u.durationMs, 0);
    return {
      running,
      text: running
        ? "工作中"
        : tokens
          ? `${tokens.toLocaleString()} Token · ${(ms / 1000).toFixed(1)}s`
          : own.length
            ? "已完成"
            : "等待",
    };
  };

  const center = { x: 400, y: 300 };
  const cursorPos = (agent: AgentId) => {
    const lastOwn = [...shown].reverse().find((b) => b.agent === agent);
    const box = boxes[lastOwn?.anchor ?? `frame-${agent}`] ?? boxes[`frame-${agent}`];
    if (!box) return center;
    const width = boxes["@canvas"]?.w ?? 1200;
    // Waiting on its frame label, it parks mid-way so it never hides the usage figures.
    const idle = !lastOwn || lastOwn.anchor.startsWith("frame-");
    const x = idle ? box.x + box.w * 0.46 : box.x + box.w - 22;
    return { x: Math.min(x, width - 70), y: Math.max(box.y - 8, 2) };
  };

  const verdict = seen.has("judge") ? version.verdict : null;
  const currentAttack = current?.attack;
  const totals = events.flatMap((e) => usageOf(e) ?? []);

  return (
    <div className="studio">
      <div className="studio-bar">
        {slate}
        <ol className="studio-stages" aria-label="阶段">
          {STAGES.map((stage) => {
            const own = steps.filter((s) => s.stage === stage);
            const done =
              own.length > 0 &&
              own.every((s) => s.status === "completed" || s.status === "skipped");
            const bad = own.some((s) => s.status === "failed" || s.status === "uncertain");
            return (
              <li
                key={stage}
                className={bad ? "bad" : done ? "done" : version.stage === stage ? "now" : ""}
              >
                {STAGE_LABELS[stage]}
              </li>
            );
          })}
        </ol>
        <div className="presence" aria-label="协作成员">
          {AGENTS.map((a) => (
            <Avatar key={a.id} agent={a.id} />
          ))}
        </div>
        <button
          type="button"
          className="present"
          disabled={beats.length < 2}
          onClick={() => {
            if (playing) return setPlaying(false);
            setCursor(0);
            setPlaying(true);
          }}
        >
          {playing ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
          {playing ? "暂停放映" : "从头放映"}
        </button>
      </div>
      {conditions}
      <div className="studio-notices">{notices}</div>
      <div className="studio-body">
        <nav className="layers" aria-label="思考链">
          <h2>思考链</h2>
          <p className="soft">同一模型分成五个角色</p>
          <ol>
            {beats.map((beat, i) => (
              <li key={beat.id}>
                {beat.stage !== beats[i - 1]?.stage && (
                  <span className="layer-group">{STAGE_LABELS[beat.stage]}</span>
                )}
                <button
                  type="button"
                  aria-current={i === index ? "step" : undefined}
                  aria-label={`第 ${i + 1} 步：${nameOf(beat.agent)}${beat.label}`}
                  className={i > index ? "ahead" : ""}
                  onClick={() => {
                    setPlaying(false);
                    setCursor(i >= last ? null : i);
                  }}
                >
                  <Avatar agent={beat.agent} />
                  <span>
                    <b>{beat.label}</b> {beat.line}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="canvas" ref={canvas}>
          <div className="board">
            {(["A", "B", "C"] as const).map((id) => (
              <RouteFrame
                key={id}
                id={id}
                strategy={version.strategies.find((s) => s.id === id)}
                version={version}
                seen={seen}
                selectedAttack={selectedAttack ?? currentAttack?.id}
                usage={usageFor(id).text}
                current={!currentAttack && current?.agent === id}
                readOnly={historical || busy}
                onEvidence={onEvidence}
                onClaim={onClaim}
              />
            ))}
            <section
              className={`frame agent-verify ${current?.agent === "verify" ? "is-current" : ""}`}
              aria-label="核验"
            >
              <Handles />
              <header className="frame-label" data-anchor="frame-verify">
                <Avatar agent="verify" />
                <b>核验</b>
                <span>{usageFor("verify").text}</span>
              </header>
              <div className="frame-body">
                {version.attacks.filter((a) => seen.has(`v:${a.id}`)).length === 0 && (
                  <p className="soft">等待质疑进入核验</p>
                )}
                {version.attacks
                  .filter((a) => seen.has(`v:${a.id}`))
                  .map((a) => (
                    <div key={a.id} className="check-row">
                      <p>
                        <b>
                          {a.from}→{a.targetStrategyId}.{a.targetClaimId}
                        </b>{" "}
                        <span className={`verdict-word is-${a.status}`}>
                          {attackMeta[a.status].label}
                        </span>
                      </p>
                      {a.requests.map((r, i) => (
                        <code key={i}>
                          {r.tool === "calculate" ? `计算 ${r.expression}` : `检索「${r.query}」`}
                        </code>
                      ))}
                      {version.evidence
                        .filter((e) => e.attackId === a.id)
                        .map((e) => (
                          <p key={e.id} className="soft">
                            {e.title} · {evidenceMeta[e.status].label} · 来源 {e.source}
                          </p>
                        ))}
                    </div>
                  ))}
              </div>
            </section>
            <section
              className={`frame frame-judge agent-judge ${current?.agent === "judge" ? "is-current" : ""}`}
              aria-label="裁判"
            >
              <Handles />
              <header className="frame-label" data-anchor="frame-judge">
                <Avatar agent="judge" />
                <b>裁判</b>
                <span>{usageFor("judge").text}</span>
              </header>
              <div className="frame-body">
                {verdict ? (
                  <div id="verdict" tabIndex={-1}>
                    <p className="soft">{OUTCOME[verdict.outcome]}</p>
                    <h2>
                      {verdict.preferred && <span>建议 {verdict.preferred}：</span>}
                      {verdict.headline}
                    </h2>
                    <p>{verdict.rationale}</p>
                    <div className="judge-columns">
                      <div>
                        <b>下一步</b>
                        {verdict.nextActions.map((c, i) => (
                          <p key={c}>
                            {i + 1}. {c}
                          </p>
                        ))}
                      </div>
                      <div>
                        <b>成立条件</b>
                        {verdict.conditions.map((c) => (
                          <p key={c}>{c}</p>
                        ))}
                      </div>
                      <div>
                        <b>仍需确认</b>
                        {verdict.uncertainties.map((c) => (
                          <p key={c}>{c}</p>
                        ))}
                      </div>
                      <div>
                        <b>何时退出</b>
                        <p>{verdict.exitCondition}</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="soft">裁决尚未产生</p>
                )}
              </div>
            </section>
          </div>
          <svg className="connectors" aria-hidden="true">
            {shown.flatMap((beat) => {
              if (!beat.id.startsWith("a:") || !beat.attack) return [];
              const a = beat.attack;
              const from = boxes[`frame-${a.from}`];
              const to = boxes[`thread-${a.id}`];
              if (!from || !to) return [];
              const toRight = from.x > to.x;
              const x1 = toRight ? from.x : from.x + from.w;
              const y1 = from.y + 11;
              const x2 = toRight ? to.x + to.w : to.x;
              const y2 = to.y + 14;
              const bend = Math.max(40, Math.abs(x2 - x1) * 0.45);
              const active = currentAttack?.id === a.id;
              const state = seen.has(`v:${a.id}`) ? a.status : "pending";
              return [
                <g
                  key={a.id}
                  className={`link agent-${a.from} is-${state} ${active ? "active" : ""}`}
                >
                  <path
                    d={`M${x1} ${y1}C${x1 + (toRight ? -bend : bend)} ${y1} ${x2 + (toRight ? bend : -bend)} ${y2} ${x2} ${y2}`}
                    pathLength={state === "unresolved" || state === "pending" ? undefined : 1}
                  />
                  <circle cx={x2} cy={y2} r={active ? 5 : 3} />
                </g>,
              ];
            })}
          </svg>
          {AGENTS.map((a) => {
            const pos = cursorPos(a.id);
            return (
              <div
                key={a.id}
                className={`cursor agent-${a.id} ${current?.agent === a.id ? "busy" : ""} ${usageFor(a.id).running ? "working" : ""}`}
                style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
                aria-hidden="true"
              >
                <div className="cursor-inner">
                  <svg width="16" height="18" viewBox="0 0 16 18">
                    <path d="M1 1l5.6 15.2 2.2-6.4 6.4-2.2z" />
                  </svg>
                  <span>
                    <span className="cursor-short">{a.short}</span>
                    <span className="cursor-full">
                      {a.name}
                      {usageFor(a.id).running && <em> 工作中</em>}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <aside className="inspector" aria-label="当前步骤详情">
          {current ? (
            <>
              <h2>
                <Avatar agent={current.agent} /> {nameOf(current.agent)} · {current.label}
              </h2>
              <p className="inspect-line">{current.line}</p>
              <RouteDetail beat={current} version={version} />
              {current.stage === "judge" && version.verdict && (
                <>
                  <h3>三条路线</h3>
                  {version.verdict.comparisons.map((c) => (
                    <p key={c.strategyId}>
                      <b>{c.strategyId}</b>{" "}
                      <span className={`verdict-word is-${c.status}`}>
                        {comparisonMeta[c.status].label}
                      </span>{" "}
                      {c.reason}
                    </p>
                  ))}
                </>
              )}
              {currentAttack && (
                <>
                  <h3>被质疑的主张</h3>
                  <p>
                    {currentAttack.targetClaimId}：{currentAttack.claimQuote}
                  </p>
                  <h3>核验方法</h3>
                  <p>{currentAttack.verification}</p>
                  {seen.has(`v:${currentAttack.id}`) ? (
                    <>
                      <h3>证据</h3>
                      {version.evidence
                        .filter((e) => e.attackId === currentAttack.id)
                        .map((e) => (
                          <div key={e.id} className="inspect-evidence">
                            <p>
                              <b>{e.title}</b>
                            </p>
                            {e.expression && (
                              <code>
                                {e.expression} = {e.result ?? "无法计算"}
                              </code>
                            )}
                            {e.assumptions && <p className="soft">假设：{e.assumptions}</p>}
                            <p>{e.content || evidenceMeta[e.status].label}</p>
                          </div>
                        ))}
                    </>
                  ) : (
                    <>
                      <h3>证据</h3>
                      <p className="soft">核验还没进行到这一条。</p>
                    </>
                  )}
                  <button
                    type="button"
                    className="inspect-more"
                    aria-label={`查看 ${currentAttack.from} 对 ${currentAttack.targetStrategyId} 这条质疑的完整证据`}
                    onClick={() => onEvidence(currentAttack)}
                  >
                    打开完整证据链
                  </button>
                </>
              )}
            </>
          ) : (
            <p className="soft">第一步产生后，详情会显示在这里。</p>
          )}
          <h3>用量</h3>
          <dl className="inspect-stats">
            <div>
              <dt>模型调用</dt>
              <dd>{totals.length}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>
                {totals.reduce((t, u) => t + u.inputTokens + u.outputTokens, 0).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{(totals.reduce((t, u) => t + u.durationMs, 0) / 1000).toFixed(1)}s</dd>
            </div>
            <div>
              <dt>修复重试</dt>
              <dd>{steps.filter((s) => /:(repair|retry)/.test(s.role)).length}</dd>
            </div>
          </dl>
          <details className="inspect-log">
            <summary>系统日志 {events.length} 条</summary>
            <p className="soft">真实步骤记录。模型隐藏推理未保存。</p>
            {events.map((event) => {
              const u = usageOf(event);
              const output = (event.data as EventData)?.modelOutput;
              return (
                <div key={event.seq} className={/fail|uncertain/.test(event.type) ? "bad" : ""}>
                  <p>
                    <span className="soft">{clock(event.createdAt)}</span> {event.message}
                    {u && (
                      <span className="soft">
                        {" "}
                        {u.inputTokens}/{u.outputTokens} ¥{u.estimatedCny.toFixed(4)}
                      </span>
                    )}
                  </p>
                  {output !== undefined && output !== null && (
                    <details>
                      <summary>模型输出</summary>
                      <pre>{JSON.stringify(output, null, 1)}</pre>
                    </details>
                  )}
                </div>
              );
            })}
          </details>
        </aside>
      </div>
    </div>
  );
}
