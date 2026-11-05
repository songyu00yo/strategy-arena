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
  Layers3,
  LoaderCircle,
  Plus,
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
import { ChallengeForm } from "@/components/challenge-form";
import { ArenaConsole } from "@/components/console/ArenaConsole";
import "@/components/console/console.css";
import { Chars, Dust } from "@/components/console/effects";
import { HomeFlow } from "@/components/console/HomeFlow";
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
  const locateAttack = (a: Attack) => {
    setAttackId(null);
    setLocatedId(a.id);
    // Runs after a closing drawer has returned focus.
    requestAnimationFrame(() => {
      const target = document.getElementById(`dispute-${a.id}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
  };
  // Entering an arena or a new version starts at its goal, not where the form's button was.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const activeVersionId = arena.snapshot?.activeVersionId;
  useEffect(() => {
    if (!activeVersionId) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "instant" });
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeVersionId]);
  const versionEvents = arena.snapshot?.events.filter((e) => e.versionId === selected?.id) ?? [];
  const selectedSteps = arena.snapshot?.steps.filter((s) => s.versionId === selected?.id) ?? [];
  const selectedRunning = !!selected && ["running", "ready"].includes(selected.status);
  const parentVersion = arena.snapshot?.versions.find((v) => v.id === selected?.parentVersionId);
  const parentChanges =
    parentVersion && selected ? conditionChanges(parentVersion.challenge, selected.challenge) : [];
  return (
    <div className={`site-shell console-shell ${arena.snapshot ? "" : "home"}`}>
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
          <div className="h-grid">
            <Dust />
            <section className="h-lead" aria-label="开始一次方案推演">
              <h1>
                <Chars text="先让三个方案互相挑错，再决定。" active />
              </h1>
              <p>说出你的问题。三条路线各自提案、互相质疑、查证修正，最后给你一个带条件的建议。</p>
              <div className="h-form">
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
            </section>
            <HomeFlow />
          </div>
        ) : (
          selected && (
            <div className="arena-view">
              <ArenaConsole
                key={selected.id}
                version={selected}
                steps={selectedSteps}
                model={arena.snapshot.model}
                events={versionEvents}
                historical={historical}
                busy={arena.busy}
                selectedAttack={attack?.id ?? locatedId ?? undefined}
                onEvidence={selectAttack}
                onClaim={(strategy, claimId) => {
                  setClaimTarget({ strategy, claimId });
                  setChallengeText("");
                }}
                conditions={
                  <section className="arena-intro">
                    <div>
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
                      <strong>{money(selected.costCny)}</strong>
                      {selected.reservedCny > 0 && (
                        <small>另有 {money(selected.reservedCny)} 调用中预留</small>
                      )}
                      <small>按已记录用量估算，非最终账单</small>
                    </div>
                  </section>
                }
                slate={
                  <>
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
                  </>
                }
                notices={
                  <>
                    {historical && (
                      <div className="history-notice">
                        <Layers3 size={15} />
                        <p>你正在查看历史版本。条件、证据与结果保留在当时的状态。</p>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setVersionId(null)}
                        >
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
                    {selected.status !== "completed" && selected.status !== "superseded" && (
                      <section className="stage-rail" aria-label="推演进度">
                        {STAGES.map((stage, i) => {
                          const steps = selectedSteps.filter((s) => s.stage === stage);
                          const completed =
                            steps.length > 0 &&
                            steps.every((s) => s.status === "completed" || s.status === "skipped");
                          const failed = steps.some((s) => s.status === "failed");
                          const unknown = steps.some((s) => s.status === "uncertain");
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
                            <span className="stage-finished">{statusLabels[selected.status]}</span>
                          )}
                        </div>
                      </section>
                    )}
                    {!arena.auto && running && !historical && (
                      <div className="paused-notice">
                        <span>自动推进已停止。刷新确认本轮状态后，可继续推进。</span>
                        <button type="button" className="text-button" onClick={arena.resume}>
                          继续推进
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    )}
                  </>
                }
              />
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
