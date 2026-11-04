"use client";

import { useCallback, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
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
} from "@/lib/contracts";
import { ChallengeForm } from "@/components/challenge-form";
import { StrategyCard, PendingCard } from "@/components/strategy-card";
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
function money(value: number) {
  return value < 0.01 && value > 0 ? "< ¥0.01" : `¥${value.toFixed(2)}`;
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
    <section className="verdict" aria-labelledby="verdict-heading">
      <div className="verdict-side">
        <span className="eyebrow">THE VERDICT</span>
        <Flag size={30} strokeWidth={1.4} />
        <span>条件裁决</span>
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
                <span className={`comparison-status ${c.status}`}>
                  {{ eligible: "符合条件", violates: "触及限制", unknown: "待确认" }[c.status]}
                </span>
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
                  <span>
                    {{ supported: "成立", refuted: "已反驳", unresolved: "未决" }[f.status]}
                  </span>
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
  const [attack, setAttack] = useState<Attack | null>(null);
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
  const closeAttack = useCallback(() => setAttack(null), []);
  const selectAttack = (a: Attack) => setAttack(a);
  const versionEvents = arena.snapshot?.events.filter((e) => e.versionId === selected?.id) ?? [];
  const selectedSteps = arena.snapshot?.steps.filter((s) => s.versionId === selected?.id) ?? [];
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
          <span className="wordmark-en">STRATEGY ARENA</span>
        </button>
        <div className="header-right">
          <span className="header-motto">让想法交锋，让行动有据。</span>
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
              <div className="hero-kicker">
                <span className="eyebrow">A BETTER WAY TO DECIDE</span>
                <span>学习 / 生活 / 工作 / 创作</span>
              </div>
              <div className="hero-heading">
                <h1>
                  让好想法，
                  <br />
                  <span className="hero-last">
                    打过一场<span className="hero-period">。</span>
                    <svg viewBox="0 0 520 30" aria-hidden="true">
                      <path d="M3 21C140 3 328 1 513 13M13 27C155 13 348 10 502 18" />
                    </svg>
                  </span>
                </h1>
                <div className="hero-aside">
                  <span className="hero-asterisk">↗</span>
                  <p>
                    别急着选一个答案。
                    <br />
                    让三种路线独立出发，
                    <br />
                    相互质疑，用证据修正。
                  </p>
                  <span className="hero-aside-note">最后，带着成立条件行动。</span>
                </div>
              </div>
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
                      <span className="eyebrow">PRIVATE PREVIEW</span>
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
                    disabled={configured === false || !arena.health || accessRequired}
                    onSubmit={async (challenge) => {
                      if (await arena.create(challenge)) setVersionId(null);
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
                <div className="explainer-heading">
                  <span className="eyebrow">HOW IT WORKS</span>
                  <span>三种策略，接受追问。</span>
                </div>
                <h2>
                  三路独立。
                  <br />
                  一轮交锋。
                </h2>
                <div className="mini-arena" aria-label="推演机制示意">
                  <div className="mini-route">
                    <span>A</span>
                    <i />
                    <i />
                    <small>独立提案</small>
                  </div>
                  <div className="mini-route">
                    <span>B</span>
                    <i />
                    <i />
                    <small>不同路线</small>
                  </div>
                  <div className="mini-route">
                    <span>C</span>
                    <i />
                    <i />
                    <small>反向思考</small>
                  </div>
                  <div className="mini-attack">
                    <Crosshair size={17} />
                    <span>关键前提，逐条挑战</span>
                    <ArrowRight size={16} />
                  </div>
                </div>
                <ol className="process-explainer">
                  <li>
                    <span>01</span>
                    <div>
                      <strong>先展开选择</strong>
                      <p>从你的目标与限制出发，形成三条可比较的路线。</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>让判断接受质疑</strong>
                      <p>追问具体原话，检索材料、核算投入，再修订方案。</p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>给出有条件的建议</strong>
                      <p>说清何时成立、还缺什么证据，以及现在的第一步。</p>
                    </div>
                  </li>
                </ol>
                <div className="honesty-note">
                  <FileSearch size={15} />
                  <p>
                    未知会保留未知。估算会标明估算。
                    <br />
                    你随时可以补充条件，重新开局。
                  </p>
                </div>
              </aside>
            </section>
            <section className="manifesto">
              <span className="eyebrow">GOOD DECISIONS ARE MADE, NOT GUESSED.</span>
              <p>
                答案不必一开始就对。
                <br />
                <span>但每一轮，都应该更接近可行动。</span>
              </p>
              <ArrowDown size={24} strokeWidth={1.3} />
            </section>
          </>
        ) : (
          selected && (
            <div className="arena-view">
              <div className="arena-topline">
                <span className="eyebrow">LIVE ARENA / 你的方案现场</span>
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
                          setAttack(null);
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
                    <span className={`run-status ${selected.status}`}>
                      {selected.status === "running" && <span className="working-dot" />}
                      {statusLabels[selected.status]}
                    </span>
                    {historical && <span className="historical-tag">只读</span>}
                  </div>
                  <h1>{selected.challenge.goal}</h1>
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
                </div>
                <div className="arena-cost">
                  <span>本轮费用估算</span>
                  <strong>{money(selected.costCny)}</strong>
                  {selected.reservedCny > 0 && (
                    <small>另有 {money(selected.reservedCny)} 调用中预留</small>
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
              {selected.error && (
                <div className="version-error" role="alert">
                  <strong>本轮暂时停在这里</strong>
                  <p>{selected.error}</p>
                  <span>已产生的结果保留在下方。请求状态不确定时，请先刷新确认。</span>
                </div>
              )}
              <section className="stage-rail" aria-label="推演进度">
                {STAGES.map((stage, i) => {
                  const steps = selectedSteps.filter((s) => s.stage === stage);
                  const completed =
                    steps.length > 0 &&
                    steps.every((s) => s.status === "completed" || s.status === "skipped");
                  const current = selected.stage === stage && !completed;
                  return (
                    <div
                      key={stage}
                      className={`stage ${completed ? "done" : ""} ${current ? "current" : ""}`}
                      aria-current={current ? "step" : undefined}
                    >
                      <span className="stage-index">
                        {completed ? <Check size={13} /> : String(i + 1).padStart(2, "0")}
                      </span>
                      <span>
                        {STAGE_LABELS[stage]}
                        {current && running && <small>进行中</small>}
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
                  让路线，正面交锋<span>{selected.strategies.length}/3 条已形成</span>
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
                    <span>{selected.strategies.find((s) => s.id === id)?.title ?? "等待提案"}</span>
                  </button>
                ))}
              </div>
              <section className="strategy-grid" aria-label="三条策略路线">
                {["A", "B", "C"].map((id) => {
                  const s = selected.strategies.find((s) => s.id === id);
                  return (
                    <div
                      id={`route-${id}`}
                      role="tabpanel"
                      aria-labelledby={`tab-${id}`}
                      className={`strategy-column ${mobileRoute === id ? "mobile-active" : ""}`}
                      key={id}
                    >
                      {s ? (
                        <StrategyCard
                          strategy={s}
                          version={selected}
                          readOnly={historical || arena.busy}
                          selectedAttack={attack?.id}
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
        <span>THINK IN PARALLEL. ACT WITH REASON.</span>
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
              {configured ? "真实模型已连接" : "模型尚未连接"}
            </span>
            <dl>
              <div>
                <dt>模型</dt>
                <dd>{arena.health?.model.id || "尚未获取"}</dd>
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
            pending={arena.busy}
            editing
            submitLabel="按新条件重新推演"
            onCancel={() => setEditing(false)}
            onSubmit={async (challenge, reason) => {
              if (await arena.rematch(challenge, reason)) {
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
        <EvidenceDrawer attack={attack} version={selected} onClose={closeAttack} />
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
