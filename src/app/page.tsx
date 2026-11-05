"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Crosshair,
  FileSearch,
  Flag,
  Layers3,
  LoaderCircle,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  Square,
  X,
} from "lucide-react";
import {
  STAGES,
  STAGE_LABELS,
  type Attack,
  type Strategy,
  type ArenaVersion,
  type Challenge,
} from "@/lib/contracts";
import { stageProgress } from "@/lib/stage-progress";
import { ChallengeForm } from "@/components/challenge-form";
import { StrategyCard, PendingCard } from "@/components/strategy-card";
import { DisputeBoard } from "@/components/dispute-board";
import { comparisonMeta, findingMeta, StatusTag } from "@/components/status";
import { EvidenceDrawer } from "@/components/evidence-drawer";
import { Modal } from "@/components/modal";
import { useArena } from "@/components/use-arena";

const statusLabels = {
  ready: "准备上场",
  running: "正在推演",
  completed: "本轮已收束",
  paused: "已暂停",
  failed: "本轮未完成",
  uncertain: "结果待确认",
  superseded: "历史版本",
};
function money(value: number, currency: "CNY" | "USD" = "CNY") {
  const symbol = currency === "USD" ? "$" : "¥";
  return value < 0.01 && value > 0 ? `< ${symbol}0.01` : `${symbol}${value.toFixed(2)}`;
}
/** What differs from the parent version's input. Long text only reports that it changed. */
function conditionChanges(parent: Challenge, current: Challenge) {
  const yuan = (v: number | null) => (v === null ? "未填写" : `¥${v.toLocaleString()}`);
  const hours = (v: number | null) => (v === null ? "未填写" : `${v} 小时`);
  const fields: [string, string, string][] = [
    ["目标", parent.goal, current.goal],
    ["硬性限制", parent.constraints, current.constraints],
    ["偏好", parent.preferences, current.preferences],
    ["备选方案", parent.options.join("、"), current.options.join("、")],
    ["材料", parent.materials, current.materials],
    ["领域", parent.domain, current.domain],
    ["预算上限", yuan(parent.budget), yuan(current.budget)],
    ["可用时间", hours(parent.timeHours), hours(current.timeHours)],
  ];
  return fields
    .filter(([, before, after]) => before !== after)
    .map(([label, before, after]) => ({
      label,
      detail:
        before.length > 24 || after.length > 24
          ? "内容已修改"
          : `${before || "未填写"} → ${after || "未填写"}`,
    }));
}
/** Failed, uncertain and paused differ in what the user can safely do next, so they differ here. */
function RunNotice({
  version,
  historical,
  busy,
  onRefresh,
}: {
  version: ArenaVersion;
  historical: boolean;
  busy: boolean;
  onRefresh: () => void;
}) {
  const copy = {
    failed: {
      title: "本轮未完成",
      next: "已产生的结果保留在下方。可以修改条件后开新版本。",
    },
    uncertain: {
      title: "结果待确认：无法判断请求是否完成或已计费",
      next: "相应预留不会释放，系统也不会自动重试，需要由运行者核账。已产生的结果保留在下方。",
    },
    paused: {
      title: "本轮已停止",
      next: "不再发起新步骤。已发出的请求仍可能返回并计费，迟到的结果归入这一版本。",
    },
  }[version.status as "failed" | "uncertain" | "paused"];
  if (!copy && !version.error) return null;
  const alert = version.status !== "paused";
  return (
    <div className={`version-error run-${version.status}`} role={alert ? "alert" : "status"}>
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{copy?.title ?? "本轮暂时停在这里"}</strong>
        {version.error && <p>{version.error}</p>}
        <span>{copy?.next ?? "已产生的结果保留在下方。请求状态不确定时，请先刷新确认。"}</span>
      </div>
      {!historical && (
        <button type="button" className="text-button" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={13} aria-hidden="true" />
          刷新状态
        </button>
      )}
    </div>
  );
}
function Verdict({
  version,
  onEvidence,
}: {
  version: ArenaVersion;
  onEvidence: (a: Attack) => void;
}) {
  const v = version.verdict;
  if (!v) return null;
  return (
    <section id="verdict" tabIndex={-1} className="verdict" aria-labelledby="verdict-heading">
      <div className="verdict-side">
        <span className="verdict-kicker">
          <Flag size={15} aria-hidden="true" />
          条件裁决
        </span>
        {v.preferred && <span className="verdict-letter">{v.preferred}</span>}
      </div>
      <div className="verdict-main">
        <div className="verdict-label">
          <span>
            {
              {
                recommendation: "当前条件下的建议",
                tie: "两条路线，各有成立条件",
                insufficient: "现有依据不足以判断",
                infeasible: "当前条件下无法成立",
                partial: "阶段性判断",
              }[v.outcome]
            }
          </span>
          <span>V{version.number.toString().padStart(2, "0")}</span>
        </div>
        <h2 id="verdict-heading">{v.headline}</h2>
        <p className="verdict-rationale">{v.rationale}</p>
        <div className="verdict-columns">
          <div>
            <h3>建议成立的条件</h3>
            {v.conditions.length ? (
              <ul>
                {v.conditions.map((c, i) => (
                  <li key={i}>
                    <Check size={14} />
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">暂未给出明确成立条件。</p>
            )}
            {v.uncertainties.length > 0 && (
              <div className="uncertainties">
                <h3>仍需确认</h3>
                {v.uncertainties.map((u, i) => (
                  <p key={i}>{u}</p>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3>现在可以做什么</h3>
            <ol className="verdict-actions">
              {v.nextActions.map((a, i) => (
                <li key={i}>
                  <span>0{i + 1}</span>
                  {a}
                </li>
              ))}
            </ol>
            <p className="exit-condition">
              <strong>何时退出或改道</strong>
              {v.exitCondition}
            </p>
          </div>
        </div>
        {v.comparisons.length > 0 && (
          <div className="comparison-list">
            {v.comparisons.map((c) => (
              <div key={c.strategyId}>
                <span className="comparison-route">{c.strategyId}</span>
                <StatusTag meta={comparisonMeta[c.status]} className="comparison-status" />
                <p>{c.reason}</p>
              </div>
            ))}
          </div>
        )}
        {v.attackFindings.length > 0 && (
          <details className="verdict-findings">
            <summary>
              查看裁决对质疑的逐条回应
              <ChevronDown size={14} />
            </summary>
            {v.attackFindings.map((f) => {
              const attack = version.attacks.find((a) => a.id === f.attackId);
              return (
                <button
                  key={f.attackId}
                  type="button"
                  disabled={!attack}
                  onClick={() => attack && onEvidence(attack)}
                >
                  <StatusTag meta={findingMeta[f.status]} />
                  <p>{f.reason}</p>
                  <ArrowUpRight size={15} />
                </button>
              );
            })}
          </details>
        )}
      </div>
    </section>
  );
}

export default function Page() {
  const arena = useArena();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [attackId, setAttackId] = useState<string | null>(null);
  const [locatedId, setLocatedId] = useState<string | null>(null);
  const [claimTarget, setClaimTarget] = useState<{ strategy: Strategy; claimId: string } | null>(
    null,
  );
  const [challengeText, setChallengeText] = useState("");
  const [mobileRoute, setMobileRoute] = useState("A");
  const [showEvents, setShowEvents] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const accessRequired = !!arena.health?.requiresAccessCode && !arena.health?.accessGranted;
  const selected = arena.snapshot?.versions.find((v) => v.id === versionId) ?? arena.active;
  const historical = !!selected && selected.id !== arena.snapshot?.activeVersionId;
  const running = arena.active && ["running", "ready"].includes(arena.active.status);
  const configured = arena.health?.model.configured;
  // Resolve by ID, so an open drawer follows status changes from newer snapshots.
  const attack = selected?.attacks.find((a) => a.id === attackId) ?? null;
  const closeAttack = useCallback(() => setAttackId(null), []);
  const selectAttack = (a: Attack) => {
    setLocatedId(null);
    setAttackId(a.id);
  };
  const goToRoute = (id: string, targetId = `route-${id}`) => {
    setMobileRoute(id);
    // Runs after the tab switch commits and after a closing drawer has returned focus.
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
  };
  const locateAttack = (a: Attack) => {
    setAttackId(null);
    setLocatedId(a.id);
    goToRoute(a.targetStrategyId, `dispute-${a.id}`);
  };
  // Only a displayed-version transition or a completed local rematch requests heading focus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousDisplayedVersion = useRef<string | undefined>(undefined);
  const localVersionNavigation = useRef(false);
  const displayedVersionId = selected?.id;
  const overlayOpen =
    editing || modelOpen || claimTarget !== null || stopConfirm || attack !== null;
  useEffect(() => {
    const transitioned = previousDisplayedVersion.current !== displayedVersionId;
    previousDisplayedVersion.current = displayedVersionId;
    if (
      (!transitioned && !localVersionNavigation.current) ||
      !displayedVersionId ||
      historical ||
      overlayOpen
    )
      return;
    localVersionNavigation.current = false;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "instant" });
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [displayedVersionId, historical, overlayOpen]);
  const versionEvents = arena.snapshot?.events.filter((e) => e.versionId === selected?.id) ?? [];
  const selectedSteps = arena.snapshot?.steps.filter((s) => s.versionId === selected?.id) ?? [];
  const selectedRunning = !!selected && ["running", "ready"].includes(selected.status);
  const parentVersion = arena.snapshot?.versions.find((v) => v.id === selected?.parentVersionId);
  const parentChanges =
    parentVersion && selected ? conditionChanges(parentVersion.challenge, selected.challenge) : [];
  return (
    <div className="site-shell">
      <a href="#main" className="skip-link">
        跳转到主要内容
      </a>
      <header className="site-header">
        <button
          className="wordmark"
          aria-label="方案擂台首页"
          type="button"
          onClick={() => {
            if (!running) {
              arena.reset();
              setVersionId(null);
            }
          }}
        >
          <span className="brand-symbol">
            <i />
            <i />
            <i />
          </span>
          <span>方案擂台</span>
        </button>
        <div className="header-right">
          <button
            type="button"
            className={`model-pill ${configured === false ? "unconfigured" : ""}`}
            onClick={() => setModelOpen(true)}
          >
            <span className={`connection-dot ${configured ? "connected" : ""}`} />
            {configured === false ? "模型待配置" : arena.health ? "真实模型推演" : "连接服务中"}
            <Settings2 size={13} />
          </button>
        </div>
      </header>
      <main id="main">
        {arena.error && (
          <div className="global-error" role="alert">
            <span>{arena.error}</span>
            <div>
              {arena.snapshot && (
                <button type="button" onClick={() => arena.sync()} disabled={arena.busy}>
                  <RefreshCw size={13} />
                  刷新状态
                </button>
              )}
              <button
                className="icon-button"
                type="button"
                aria-label="关闭错误提示"
                onClick={arena.clearError}
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}
        {!arena.snapshot ? (
          <>
            <section className="hero">
              <h1>
                <span>让好想法，</span>
                <span>打过一场。</span>
              </h1>
              <p>
                别急着选一个答案。让三条路线独立出发、相互质疑、用证据修正，最后带着成立条件行动。
              </p>
            </section>
            <section className="entry-section" aria-label="开始一次方案推演">
              <div className="entry-form-wrap">
                {accessRequired && (
                  <form
                    className="access-panel"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await arena.unlock(accessCode)) setAccessCode("");
                    }}
                  >
                    <div>
                      <span className="eyebrow">受邀预览</span>
                      <h2>凭访问码入场</h2>
                      <p>这是一个受邀预览。输入运行者提供的访问码，即可开始真实推演。</p>
                    </div>
                    <label className="sr-only" htmlFor="access-code">
                      访问码
                    </label>
                    <div className="access-input-row">
                      <input
                        id="access-code"
                        type="password"
                        autoComplete="off"
                        placeholder="输入访问码"
                        value={accessCode}
                        onChange={(e) => setAccessCode(e.target.value)}
                        required
                      />
                      <button type="submit" className="primary-button" disabled={arena.busy}>
                        {arena.busy ? "验证中…" : "验证访问码"}
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  </form>
                )}
                {arena.restoring ? (
                  <div className="restoring-state">
                    <LoaderCircle className="spin" size={24} />
                    <p>正在找回上一次的擂台…</p>
                  </div>
                ) : (
                  <ChallengeForm
                    pending={arena.busy}
                    modelProviders={arena.health?.model.providers}
                    disabled={configured === false || !arena.health || accessRequired}
                    onSubmit={async (challenge, _reason, modelMode) => {
                      if (await arena.create(challenge, modelMode)) setVersionId(null);
                    }}
                  />
                )}
                {(configured === false || arena.healthError) && (
                  <div className="configuration-notice">
                    <CircleHelp size={16} />
                    <div>
                      <strong>{arena.healthError || "还差一步：连接真实模型"}</strong>
                      <p>
                        {arena.healthError
                          ? "连接恢复后刷新页面即可继续。"
                          : "配置 API 密钥后即可上场。当前不会生成模拟结果或发起计费请求。"}
                      </p>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setModelOpen(true)}
                      >
                        查看连接信息
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <aside className="entry-explainer">
                <h2>一场推演怎么进行</h2>
                <ol className="process-explainer">
                  <li>
                    <span>1</span>
                    <div>
                      <strong>三路独立提案</strong>
                      <p>从你的目标与限制出发，形成三条可比较的路线。</p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>逐条质疑和核验</strong>
                      <p>追问具体原话，检索你的材料、核算投入，再修订方案。</p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>给出有条件的建议</strong>
                      <p>说清何时成立、还缺什么证据，以及现在的第一步。</p>
                    </div>
                  </li>
                </ol>
                <div className="honesty-note">
                  <FileSearch size={15} />
                  <p>未知会保留未知，估算会标明估算。你随时可以补充条件，重新开局。</p>
                </div>
              </aside>
            </section>
          </>
        ) : (
          selected && (
            <div className="arena-view">
              <div className="arena-topline">
                <span className="eyebrow">推演现场</span>
                <div className="arena-top-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setEditing(true);
                    }}
                    disabled={arena.busy}
                  >
                    <Settings2 size={14} />
                    修改条件再开局
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!running}
                    onClick={() => {
                      arena.reset();
                      setVersionId(null);
                    }}
                  >
                    <Plus size={14} />
                    新问题
                  </button>
                </div>
              </div>
              <section className="arena-intro">
                <div>
                  <div className="arena-version-line">
                    <label className="version-select">
                      <Layers3 size={13} />
                      <select
                        aria-label="选择推演版本"
                        value={selected.id}
                        onChange={(e) => {
                          setVersionId(e.target.value);
                          setAttackId(null);
                          setLocatedId(null);
                        }}
                      >
                        {arena.snapshot.versions.map((v) => (
                          <option key={v.id} value={v.id}>
                            V{String(v.number).padStart(2, "0")}{" "}
                            {v.id === arena.snapshot?.activeVersionId ? "当前版本" : "历史版本"}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} />
                    </label>
                    <span className={`run-status ${selected.status}`} role="status">
                      {selected.status === "running" && <span className="working-dot" />}
                      {statusLabels[selected.status]}
                    </span>
                    {historical && <span className="historical-tag">只读</span>}
                  </div>
                  <h1 ref={headingRef} tabIndex={-1}>
                    {selected.challenge.goal}
                  </h1>
                  <div className="arena-conditions">
                    {selected.challenge.constraints && (
                      <span>
                        <strong>硬性限制</strong>
                        {selected.challenge.constraints}
                      </span>
                    )}
                    {selected.challenge.preferences && (
                      <span>
                        <strong>偏好</strong>
                        {selected.challenge.preferences}
                      </span>
                    )}
                    {selected.challenge.budget !== null && (
                      <span>
                        <strong>预算上限</strong>¥{selected.challenge.budget.toLocaleString()}
                      </span>
                    )}
                    {selected.challenge.timeHours !== null && (
                      <span>
                        <strong>可用时间</strong>
                        {selected.challenge.timeHours} 小时
                      </span>
                    )}
                  </div>
                  {selected.changeReason && (
                    <p className="version-reason">
                      <CornerIcon />
                      本轮改动：{selected.changeReason}
                    </p>
                  )}
                  {parentVersion && parentChanges.length > 0 && (
                    <div className="condition-delta">
                      <span>相比 V{String(parentVersion.number).padStart(2, "0")}</span>
                      <ul>
                        {parentChanges.map((c) => (
                          <li key={c.label}>
                            <strong>{c.label}</strong>
                            {c.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="arena-cost">
                  <span>本轮费用估算</span>
                  <strong>
                    {selected.modelSelection?.currency === "USD"
                      ? money(selected.costUsd ?? 0, "USD")
                      : money(selected.costCny)}
                  </strong>
                  {(selected.reservedCny > 0 || (selected.reservedUsd ?? 0) > 0) && (
                    <small>
                      另有{" "}
                      {selected.modelSelection?.currency === "USD"
                        ? money(selected.reservedUsd ?? 0, "USD")
                        : money(selected.reservedCny)}{" "}
                      调用中预留
                    </small>
                  )}
                  {selected.modelSelection && (
                    <small>
                      {selected.modelSelection.modelId}
                      <br />
                      {selected.modelSelection.reason}
                    </small>
                  )}
                  <small>按已记录用量估算，非最终账单</small>
                </div>
              </section>
              {historical && (
                <div className="history-notice">
                  <Layers3 size={15} />
                  <p>你正在查看历史版本。条件、证据与结果保留在当时的状态。</p>
                  <button className="text-button" type="button" onClick={() => setVersionId(null)}>
                    回到当前版本
                    <ArrowRight size={13} />
                  </button>
                </div>
              )}
              <RunNotice
                version={selected}
                historical={historical}
                busy={arena.busy}
                onRefresh={() => arena.sync()}
              />
              <section className="stage-rail" aria-label="推演进度">
                {STAGES.map((stage, i) => {
                  const steps = selectedSteps.filter((s) => s.stage === stage);
                  const { completed, failed, unknown } = stageProgress(steps);
                  const current = selected.stage === stage && !completed;
                  return (
                    <div
                      key={stage}
                      className={`stage ${completed ? "done" : ""} ${current ? "current" : ""} ${failed ? "failed" : ""} ${unknown ? "unknown" : ""}`}
                      aria-current={current ? "step" : undefined}
                    >
                      <span className="stage-index">
                        {failed ? (
                          <X size={13} aria-hidden="true" />
                        ) : unknown ? (
                          <CircleHelp size={13} aria-hidden="true" />
                        ) : completed ? (
                          <Check size={13} aria-hidden="true" />
                        ) : (
                          String(i + 1).padStart(2, "0")
                        )}
                      </span>
                      <span>
                        {STAGE_LABELS[stage]}
                        {failed ? (
                          <small>失败</small>
                        ) : unknown ? (
                          <small>待确认</small>
                        ) : (
                          current && selectedRunning && <small>进行中</small>
                        )}
                      </span>
                      {i < 4 && <ArrowRight size={13} />}
                    </div>
                  );
                })}
                <div className="stage-controls">
                  {running && !historical ? (
                    <button
                      type="button"
                      className="stop-button"
                      disabled={arena.busy}
                      onClick={() => setStopConfirm(true)}
                    >
                      <Square size={10} fill="currentColor" />
                      现在收束
                    </button>
                  ) : (
                    <span className="stage-finished">
                      {selected.status === "completed" ? "推演结束" : statusLabels[selected.status]}
                    </span>
                  )}
                </div>
              </section>
              {!arena.auto && running && !historical && (
                <div className="paused-notice">
                  <span>自动推进已停止。刷新确认本轮状态后，可继续推进。</span>
                  <button type="button" className="text-button" onClick={arena.resume}>
                    继续推进
                    <ArrowRight size={13} />
                  </button>
                </div>
              )}
              <div className="arena-section-title">
                <h2>
                  三条路线<span>{selected.strategies.length}/3 条已形成</span>
                </h2>
                <button
                  className="events-toggle"
                  type="button"
                  onClick={() => setShowEvents(!showEvents)}
                  aria-expanded={showEvents}
                >
                  <Radio size={14} />
                  <span>现场记录</span>
                  <span className="event-count">{versionEvents.length}</span>
                  <ChevronDown size={13} />
                </button>
              </div>
              {showEvents && (
                <section className="event-rail" aria-label="现场记录">
                  {versionEvents.length ? (
                    versionEvents
                      .slice(-30)
                      .reverse()
                      .map((e) => (
                        <div className="event-item" key={e.seq}>
                          <span className="event-time">
                            {new Date(e.createdAt).toLocaleTimeString("zh-CN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                          <span
                            className={`event-marker ${e.type.includes("fail") ? "red" : ""}`}
                          />
                          <p>{e.message}</p>
                          {e.actor && <span className="event-actor">{e.actor}</span>}
                        </div>
                      ))
                  ) : (
                    <p className="muted">等待首条真实事件…</p>
                  )}
                </section>
              )}
              {selected.strategies.length > 0 && (
                <DisputeBoard
                  version={selected}
                  selectedAttack={attack?.id ?? locatedId ?? undefined}
                  onEvidence={selectAttack}
                  onLocate={locateAttack}
                  onRoute={(id) => goToRoute(id)}
                />
              )}
              <div className="mobile-route-tabs" role="tablist" aria-label="策略路线">
                {["A", "B", "C"].map((id) => (
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${id}`}
                    tabIndex={mobileRoute === id ? 0 : -1}
                    aria-selected={mobileRoute === id}
                    aria-controls={`route-${id}`}
                    key={id}
                    onKeyDown={(e) => {
                      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                      e.preventDefault();
                      const ids = ["A", "B", "C"];
                      const next =
                        e.key === "Home"
                          ? "A"
                          : e.key === "End"
                            ? "C"
                            : ids[(ids.indexOf(id) + (e.key === "ArrowRight" ? 1 : 2)) % 3];
                      setMobileRoute(next);
                      document.getElementById(`tab-${next}`)?.focus();
                    }}
                    onClick={() => setMobileRoute(id)}
                  >
                    {id}
                    <span>
                      {selected.strategies.some((s) => s.id === id)
                        ? `${selected.attacks.filter((a) => a.targetStrategyId === id).length} 条争议`
                        : "等待提案"}
                    </span>
                  </button>
                ))}
              </div>
              <section className="strategy-grid" aria-label="三条策略路线">
                {["A", "B", "C"].map((id) => {
                  const s = selected.strategies.find((s) => s.id === id);
                  return (
                    <div
                      id={`route-${id}`}
                      tabIndex={-1}
                      role="tabpanel"
                      aria-labelledby={`tab-${id}`}
                      className={`strategy-column ${mobileRoute === id ? "mobile-active" : ""}`}
                      key={id}
                    >
                      {s ? (
                        <StrategyCard
                          strategy={s}
                          version={selected}
                          historical={historical}
                          busy={arena.busy}
                          selectedAttack={attack?.id ?? locatedId ?? undefined}
                          onAttack={selectAttack}
                          onClaim={(strategy, claimId) => {
                            setClaimTarget({ strategy, claimId });
                            setChallengeText("");
                          }}
                        />
                      ) : (
                        <PendingCard
                          id={id}
                          running={selected.status === "running" && selected.stage === "propose"}
                        />
                      )}
                    </div>
                  );
                })}
              </section>
              {selected.verdict ? (
                <Verdict version={selected} onEvidence={selectAttack} />
              ) : (
                <section className="verdict-waiting">
                  <Flag size={24} strokeWidth={1.3} />
                  <div>
                    <h2>
                      {["paused", "failed", "uncertain"].includes(selected.status)
                        ? "尚未形成最终裁决"
                        : "裁决，留在交锋之后。"}
                    </h2>
                    <p>
                      {["paused", "failed", "uncertain"].includes(selected.status)
                        ? "请根据已经完成的提案与核验判断下一步。修改条件后可以重新开局。"
                        : "待关键判断接受核验、路线完成修订后，这里会给出成立条件与下一步行动。"}
                    </p>
                  </div>
                </section>
              )}
              <div className="arena-bottom-note">
                <FileSearch size={14} />
                <span>
                  材料检索仅使用你提供的文本。工具证据与估算均可追溯；未知事项不会被当作事实。
                </span>
              </div>
            </div>
          )
        )}
      </main>
      <footer className="site-footer">
        <div>
          <span className="footer-brand">方案擂台</span>
          <span>让好策略，经得起挑战。</span>
        </div>
        <button type="button" className="text-button" onClick={() => setModelOpen(true)}>
          模型与版本
          <ArrowUpRight size={12} />
        </button>
      </footer>
      {modelOpen && (
        <Modal title="模型与运行信息" onClose={() => setModelOpen(false)}>
          <div className="model-information">
            <span className={`model-state ${configured ? "configured" : ""}`}>
              <span className="connection-dot" />
              {configured ? "已有模型密钥配置，连通性待实际请求确认" : "模型尚未配置"}
            </span>
            <dl>
              <div>
                <dt>模型</dt>
                <dd>{selected?.modelSelection?.modelId || arena.health?.model.id || "尚未获取"}</dd>
              </div>
              <div>
                <dt>应用版本</dt>
                <dd>{arena.health?.version ?? "—"}</dd>
              </div>
              <div>
                <dt>当前提示词版本</dt>
                <dd>{arena.health?.model.promptVersion ?? "—"}</dd>
              </div>
              <div>
                <dt>数据契约版本</dt>
                <dd>{arena.health?.model.schemaVersion ?? "—"}</dd>
              </div>
              {selected && (
                <div>
                  <dt>本局生成配置</dt>
                  <dd>
                    {selected.runConfiguration
                      ? `${String(selected.runConfiguration.id)} · ${String(selected.runConfiguration.promptVersion)}`
                      : "早期记录：未保存完整配置"}
                  </dd>
                </div>
              )}
              <div>
                <dt>构建标识</dt>
                <dd>{arena.health?.commit || "本地开发"}</dd>
              </div>
            </dl>
            {!configured && (
              <div className="model-setup">
                <h3>连接真实模型后开始</h3>
                <p>
                  请由运行此服务的人配置服务端的模型 API 密钥，并重启服务。密钥不在浏览器内保存。
                </p>
                <p>
                  当前模型：<code>{arena.health?.model.id || "查看服务配置"}</code>
                </p>
              </div>
            )}
            <div className="model-cost-note">
              <strong>费用如何计算？</strong>
              <p>
                发起推演会调用已配置的模型。总费用取决于问题长度、材料与推演步骤，开始前无法给出可靠的固定金额。运行中显示的是按实际已记录用量计算的费用估算。
              </p>
            </div>
            <p className="muted">
              不同思路由同一个已配置模型分角色生成，不代表不同模型的独立意见。
            </p>
          </div>
        </Modal>
      )}
      {editing && selected && (
        <Modal title="修改条件，重新开局" wide onClose={() => setEditing(false)}>
          <p className="modal-intro">
            补充限制、材料或偏好后生成新版本，原版本会保留。请说明改动原因。
          </p>
          <ChallengeForm
            initial={selected.challenge}
            initialModelMode={arena.active?.modelSelection?.requestedMode ?? "deepseek"}
            modelProviders={arena.health?.model.providers}
            pending={arena.busy}
            editing
            submitLabel="按新条件重新推演"
            onCancel={() => setEditing(false)}
            onSubmit={async (challenge, reason, modelMode) => {
              if (await arena.rematch(challenge, reason, modelMode)) {
                localVersionNavigation.current = true;
                setVersionId(null);
                setEditing(false);
              }
            }}
          />
        </Modal>
      )}
      {claimTarget && (
        <Modal title="向这条判断发起挑战" onClose={() => setClaimTarget(null)}>
          <div className="challenge-dialog">
            <span className="eyebrow">路线 {claimTarget.strategy.id} / 关键判断</span>
            <blockquote>
              {claimTarget.strategy.claims.find((c) => c.id === claimTarget.claimId)?.text}
            </blockquote>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await arena.intervene(claimTarget.strategy.id, claimTarget.claimId, challengeText)
                ) {
                  localVersionNavigation.current = true;
                  setClaimTarget(null);
                  setVersionId(null);
                }
              }}
            >
              <label className="field">
                <span>你认为哪里需要再想一遍？</span>
                <textarea
                  value={challengeText}
                  onChange={(e) => setChallengeText(e.target.value)}
                  minLength={3}
                  maxLength={1000}
                  required
                  rows={4}
                  placeholder="指出有问题的前提、缺失的条件，或提供反证。"
                />
              </label>
              <p className="muted">
                你的质疑会进入真实推演。必要时会创建新版本，并产生新的模型调用费用。
              </p>
              <button
                className="primary-button"
                type="submit"
                disabled={arena.busy || challengeText.trim().length < 3}
              >
                {arena.busy ? "正在提交…" : "提交质疑"}
                <Crosshair size={16} />
              </button>
            </form>
          </div>
        </Modal>
      )}
      {attack && selected && (
        <EvidenceDrawer
          attack={attack}
          version={selected}
          onClose={closeAttack}
          onLocate={locateAttack}
        />
      )}
      {stopConfirm && (
        <Modal title="在这里收束本轮？" onClose={() => setStopConfirm(false)}>
          <div className="stop-dialog">
            <p>系统将停止发起后续推演步骤，保留已完成的提案与证据。</p>
            <p>
              已经发出的模型请求无法撤回，仍可能完成并产生费用；如果裁决尚未形成，本轮会明确保留为未完成状态。
            </p>
            <div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStopConfirm(false)}
              >
                继续推演
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={arena.busy}
                onClick={async () => {
                  await arena.stop();
                  setStopConfirm(false);
                }}
              >
                确认收束
                <Square size={12} />
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
function CornerIcon() {
  return <span aria-hidden="true">↳</span>;
}
