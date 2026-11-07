"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
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
} from "@/lib/contracts";
import { stageProgress } from "@/lib/stage-progress";
import { ChallengeForm } from "@/components/challenge-form";
import { ConditionEditor } from "@/components/condition-editor";
import { StepFollowUpDialog } from "@/components/step-follow-up-dialog";
import { supplementDraftKey, type SupplementDraft } from "@/components/supplement-draft";
import { DisclosureMotion } from "@/components/disclosure-motion";
import { VersionComparison } from "@/components/version-comparison";
import { challengeChanges } from "@/lib/challenge-changes";
import type { StepContext } from "@/lib/step-context";
import { GuidedIntake } from "@/components/guided-intake";
import { RecordedExamples } from "@/components/recorded-examples";
import { GoalFocusStage } from "@/components/goal-focus-stage";
import { IntakeContext } from "@/components/intake-context";
import { DecisionReviewPanel } from "@/components/decision-review-panel";
import { ArenaConsole } from "@/components/console/ArenaConsole";
import "@/components/console/console.css";
import { ClickFx, Leaving } from "@/components/console/effects";
import "@/components/focused-home.css";
import "@/components/friend-feedback.css";
import { EvidenceDrawer } from "@/components/evidence-drawer";
import { Modal } from "@/components/modal";
import type { OverlayMotionHandle } from "@/components/overlay-motion";
import { IdentityHistory } from "@/components/identity-history";
import { AgentProgress } from "@/components/agent-progress";
import { useArena } from "@/components/use-arena";

const ERROR_EXIT: Keyframe[] = [
  { transform: "none", opacity: 1 },
  { transform: "translateY(-14px)", opacity: 0 },
];

const statusLabels = {
  ready: "准备上场",
  running: "正在推演",
  completed: "本轮已完成",
  paused: "已暂停",
  failed: "本轮未完成",
  uncertain: "结果待确认",
  superseded: "历史版本",
};
function money(value: number, currency: "CNY" | "USD" = "CNY") {
  const symbol = currency === "USD" ? "$" : "¥";
  return value < 0.01 && value > 0 ? `< ${symbol}0.01` : `${symbol}${value.toFixed(2)}`;
}
/** Failed, uncertain and paused differ in what the user can safely do next, so they differ here. */
function RunNotice({
  demo,
  version,
  historical,
  busy,
  onRefresh,
}: {
  demo: boolean;
  version: ArenaVersion;
  historical: boolean;
  busy: boolean;
  onRefresh: () => void;
}) {
  const copy = {
    failed: {
      title: "本轮未完成",
      next: "下方保留了已有结果。你可以修改条件，创建新版本。",
    },
    uncertain: {
      title: "这次请求的结果和费用还未确认",
      next: "这笔预留暂不释放，也不会自动重试。请让运行服务的人核对调用结果和费用。下方保留了已有结果。",
    },
    paused: {
      title: "本轮已停止",
      next: demo
        ? "演示已停止，已展示的预设内容会保留。未调用模型，不产生费用。"
        : "不再发起新步骤。已发出的请求仍可能返回并计费，迟到的结果归入这一版本。",
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
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [attackId, setAttackId] = useState<string | null>(null);
  const [locatedId, setLocatedId] = useState<string | null>(null);
  const [claimTarget, setClaimTarget] = useState<{
    strategy: Strategy;
    claimId: string;
    version: ArenaVersion;
    trigger: HTMLElement | null;
  } | null>(null);
  const [editSource, setEditSource] = useState<{
    version: ArenaVersion;
    focus?: "budget" | "timeHours" | "constraints" | "preferences";
    trigger: HTMLElement | null;
  } | null>(null);
  const [followUp, setFollowUp] = useState<{
    version: ArenaVersion;
    context: StepContext;
    trigger: HTMLElement | null;
    returnTo: string | null;
  } | null>(null);
  const [challengeText, setChallengeText] = useState("");
  const [supplementDrafts, setSupplementDrafts] = useState<Record<string, SupplementDraft>>({});
  const [claimOriginalOpen, setClaimOriginalOpen] = useState(false);
  const claimQuoteId = useId();
  const [stopConfirm, setStopConfirm] = useState(false);
  const [overlayVersionId, setOverlayVersionId] = useState<string | null>(null);
  const editMotion = useRef<OverlayMotionHandle>(null);
  const claimMotion = useRef<OverlayMotionHandle>(null);
  const stopMotion = useRef<OverlayMotionHandle>(null);
  const locateFrame = useRef(0);
  const navigationEpoch = useRef(0);
  const versionPin = useRef<{ previous: string | null; epoch: number } | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const accessRequired = !!arena.health?.requiresAccessCode && !arena.health?.accessGranted;
  const selected = arena.snapshot?.versions.find((v) => v.id === versionId) ?? arena.active;
  const historical = !!selected && selected.id !== arena.snapshot?.activeVersionId;
  const running = arena.active && ["running", "ready"].includes(arena.active.status);
  const configured = arena.health?.model.configured;
  // Demo mode (pnpm demo) must never read as a live model run.
  const demo = arena.health?.version === "demo";
  // Resolve by ID, so an open drawer follows status changes from newer snapshots.
  const sameOverlayVersion = overlayVersionId === selected?.id;
  const attack = sameOverlayVersion
    ? (selected?.attacks.find((a) => a.id === attackId) ?? null)
    : null;
  const closeAttack = useCallback(() => setAttackId(null), []);
  const chooseVersion = (id: string | null) => {
    navigationEpoch.current += 1;
    versionPin.current = null;
    setVersionId(id);
  };
  const releaseVersionPin = (pin = versionPin.current) => {
    if (!pin || versionPin.current !== pin) return;
    versionPin.current = null;
    if (navigationEpoch.current === pin.epoch) setVersionId(pin.previous);
  };
  const beginVersionOverlay = () => {
    setOverlayVersionId(selected?.id ?? null);
    setEditing(false);
    setClaimTarget(null);
    setStopConfirm(false);
    setAttackId(null);
  };
  const beginEditableOverlay = (source: ArenaVersion, returnTo = versionId) => {
    beginVersionOverlay();
    setOverlayVersionId(source.id);
    versionPin.current = { previous: returnTo, epoch: navigationEpoch.current };
    setVersionId(source.id);
    arena.clearError();
  };
  const openConditions = (
    source: ArenaVersion,
    trigger: HTMLElement | null,
    focus?: "budget" | "timeHours" | "constraints" | "preferences",
    returnTo = versionId,
  ) => {
    beginEditableOverlay(source, returnTo);
    setFollowUp(null);
    setEditSource({ version: source, trigger, focus });
    setEditing(true);
  };
  const versionModelUnavailable = (source: ArenaVersion) => {
    if (demo) return false;
    const models = arena.health?.model.models ?? arena.health?.model.providers;
    const selectedModel = source.modelSelection;
    return selectedModel
      ? !(
          models?.find((model) => model.id === selectedModel.modelId) ??
          models?.find((model) => model.provider === selectedModel.provider)
        )?.configured
      : !arena.health?.model.configured;
  };
  const selectAttack = (a: Attack) => {
    beginVersionOverlay();
    setLocatedId(null);
    setAttackId(a.id);
  };
  const locateAttack = (a: Attack) => {
    setAttackId(null);
    setLocatedId(a.id);
    // Runs after a closing drawer has returned focus.
    cancelAnimationFrame(locateFrame.current);
    locateFrame.current = requestAnimationFrame(() => {
      const target = document.getElementById(`dispute-${a.id}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
  };
  // Background updates must not take focus from a dialog or a historical version.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const versionSelectRef = useRef<HTMLSelectElement>(null);
  const historyNavigation = useRef(false);
  const previousDisplayedVersion = useRef<string | undefined>(undefined);
  const localVersionNavigation = useRef(false);
  const displayedVersionId = selected?.id;
  const followUpDraftKey = followUp
    ? supplementDraftKey(
        followUp.version.id,
        `step:${followUp.context.stepId}`,
        followUp.context.quote,
      )
    : "";
  useEffect(() => () => cancelAnimationFrame(locateFrame.current), [displayedVersionId]);
  const overlayOpen =
    modelOpen ||
    (sameOverlayVersion &&
      (editing || followUp !== null || claimTarget !== null || stopConfirm || attack !== null));
  useEffect(() => {
    const transitioned = previousDisplayedVersion.current !== displayedVersionId;
    previousDisplayedVersion.current = displayedVersionId;
    if (historyNavigation.current && displayedVersionId && !overlayOpen) {
      historyNavigation.current = false;
      const frame = requestAnimationFrame(() =>
        versionSelectRef.current?.focus({ preventScroll: true }),
      );
      return () => cancelAnimationFrame(frame);
    }
    if (
      (!transitioned && !localVersionNavigation.current) ||
      !displayedVersionId ||
      historical ||
      overlayOpen
    )
      return;
    const localNavigation = localVersionNavigation.current;
    const focusAtSchedule = document.activeElement;
    localVersionNavigation.current = false;
    const frame = requestAnimationFrame(() => {
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      const focused = document.activeElement;
      const interactive =
        focused instanceof HTMLElement &&
        focused.isConnected &&
        !focused.matches(":disabled") &&
        !focused.closest("[inert]") &&
        focused.matches(
          'a[href],button,input,textarea,select,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]',
        );
      // Restoring data must not override a user's current control. Explicit local navigation
      // defaults to the new heading, unless focus moved to another control before this frame.
      if (interactive && (!localNavigation || focused !== focusAtSchedule)) return;
      window.scrollTo({ top: 0, behavior: "instant" });
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [displayedVersionId, historical, overlayOpen]);
  const versionEvents = arena.snapshot?.events.filter((e) => e.versionId === selected?.id) ?? [];
  const selectedSteps = arena.snapshot?.steps.filter((s) => s.versionId === selected?.id) ?? [];
  const selectedRunning = !!selected && ["running", "ready"].includes(selected.status);
  const preparationUsd =
    selected?.intake?.usage.reduce((sum, usage) => sum + (usage.estimatedUsd ?? 0), 0) ?? 0;
  const preparationCny =
    selected?.intake?.usage.reduce((sum, usage) => sum + usage.estimatedCny, 0) ?? 0;
  const parentVersion = arena.snapshot?.versions.find((v) => v.id === selected?.parentVersionId);
  const parentChanges =
    parentVersion && selected ? challengeChanges(parentVersion.challenge, selected.challenge) : [];
  return (
    <div className={`site-shell console-shell ${arena.snapshot ? "" : "home focus-home"}`}>
      <ClickFx />
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
              chooseVersion(null);
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
          {!demo && (
            <IdentityHistory
              disabled={accessRequired || arena.restoring || !arena.health}
              onIdentityChanged={() => {
                arena.changeIdentity();
                setIdentityEpoch((epoch) => epoch + 1);
              }}
              onOpenArena={async (id) => {
                await arena.openArena(id);
                chooseVersion(null);
              }}
              onOpenIntake={(id) => {
                arena.openIntake(id);
                chooseVersion(null);
                setIdentityEpoch((epoch) => epoch + 1);
              }}
            />
          )}
          <button
            type="button"
            className={`model-pill ${configured === false ? "unconfigured" : ""}`}
            onClick={() => setModelOpen(true)}
          >
            <span className={`connection-dot ${configured ? "connected" : ""}`} />
            {demo
              ? "演示内容，未调用模型"
              : configured === false
                ? "模型待配置"
                : arena.health
                  ? "真实模型推演"
                  : "连接服务中"}
            <Settings2 size={13} />
          </button>
        </div>
      </header>
      <main id="main">
        {arena.error && (
          <Leaving className="global-error" role="alert" frames={ERROR_EXIT}>
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
          </Leaving>
        )}

        {!arena.snapshot ? (
          <>
            <div className="goal-landing">
              <section className="goal-landing-center" aria-label="开始一次方案推演">
                <h1 className="sr-only">方案擂台，开始推演</h1>
                <GoalFocusStage>
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
                          <p>输入运行者提供的访问码后，就可以开始推演。</p>
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
                    {arena.restoring && (
                      <div className="home-connection-state" role="status">
                        <LoaderCircle className="spin" size={16} />
                        <span>正在连接并检查上次的任务…</span>
                      </div>
                    )}
                    {demo ? (
                      <ChallengeForm
                        demo={demo}
                        modelProviders={arena.health?.model.providers}
                        pending={arena.busy}
                        disabled={
                          arena.restoring || configured === false || !arena.health || accessRequired
                        }
                        onSubmit={async (challenge, _reason, modelMode) => {
                          if (await arena.create(challenge, modelMode)) chooseVersion(null);
                        }}
                      />
                    ) : (
                      <GuidedIntake
                        key={identityEpoch}
                        restoreReady={!arena.restoring}
                        modelProviders={arena.health?.model.models ?? arena.health?.model.providers}
                        pending={arena.busy}
                        disabled={arena.restoring || !arena.health || accessRequired}
                        onCreated={(snapshot) => {
                          arena.adopt(snapshot);
                          chooseVersion(null);
                        }}
                      />
                    )}
                    {(configured === false || arena.healthError) && (
                      <div className="configuration-notice">
                        <CircleHelp size={16} />
                        <div>
                          <strong>{arena.healthError || "配置模型后就能开始"}</strong>
                          <p>
                            {arena.healthError
                              ? "连接恢复后刷新页面即可继续。"
                              : "你可以先看已有示例。配置完成前，新的推演不会发起收费调用。"}
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
                </GoalFocusStage>
                {!demo && <RecordedExamples />}
              </section>
            </div>
          </>
        ) : (
          selected && (
            <div className="arena-view">
              <ArenaConsole
                key={selected.id}
                version={selected}
                steps={selectedSteps}
                demo={demo}
                events={versionEvents}
                historical={historical}
                busy={arena.busy}
                selectedAttack={attack?.id ?? locatedId ?? undefined}
                onEvidence={selectAttack}
                onClaim={(strategy, claimId) => {
                  beginEditableOverlay(selected);
                  setFollowUp(null);
                  setClaimTarget({
                    strategy,
                    claimId,
                    version: selected,
                    trigger:
                      document.activeElement instanceof HTMLElement ? document.activeElement : null,
                  });
                  setChallengeText("");
                  setClaimOriginalOpen(false);
                }}
                onFollowUp={
                  historical
                    ? undefined
                    : (context, trigger) => {
                        beginEditableOverlay(selected);
                        setFollowUp({ version: selected, context, trigger, returnTo: versionId });
                      }
                }
                onAdjustConditions={
                  historical ? undefined : (trigger) => openConditions(selected, trigger)
                }
                conditions={
                  <>
                    <AgentProgress
                      version={selected}
                      drafts={arena.snapshot?.drafts ?? []}
                      web={arena.snapshot?.model.tools}
                    />
                    <section className="arena-intro">
                      <div>
                        <div className="arena-conditions">
                          {selected.challenge.constraints && (
                            <button
                              type="button"
                              className="condition-trigger"
                              disabled={historical || arena.busy}
                              onClick={(event) =>
                                openConditions(selected, event.currentTarget, "constraints")
                              }
                            >
                              <strong>硬性限制</strong>
                              {selected.challenge.constraints}
                            </button>
                          )}
                          {selected.challenge.preferences && (
                            <button
                              type="button"
                              className="condition-trigger"
                              disabled={historical || arena.busy}
                              onClick={(event) =>
                                openConditions(selected, event.currentTarget, "preferences")
                              }
                            >
                              <strong>偏好</strong>
                              {selected.challenge.preferences}
                            </button>
                          )}
                          {selected.challenge.budget !== null && (
                            <button
                              type="button"
                              className="condition-trigger"
                              disabled={historical || arena.busy}
                              onClick={(event) =>
                                openConditions(selected, event.currentTarget, "budget")
                              }
                            >
                              <strong>预算上限</strong>¥{selected.challenge.budget.toLocaleString()}
                            </button>
                          )}
                          {selected.challenge.timeHours !== null && (
                            <button
                              type="button"
                              className="condition-trigger"
                              disabled={historical || arena.busy}
                              onClick={(event) =>
                                openConditions(selected, event.currentTarget, "timeHours")
                              }
                            >
                              <strong>可用时间</strong>
                              {selected.challenge.timeHours} 小时
                            </button>
                          )}
                        </div>
                        {selected.intake && <IntakeContext intake={selected.intake} />}
                        {selected.changeReason && (
                          <p className="version-reason">
                            <CornerIcon />
                            本轮改动：{selected.changeReason}
                          </p>
                        )}
                        {(parentVersion || selected.followUp) && (
                          <VersionComparison version={selected} parent={parentVersion} />
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
                        <span>{demo ? "演示费用（预设）" : "本轮费用估算"}</span>
                        <strong>
                          {selected.modelSelection?.currency === "USD"
                            ? money(selected.costUsd ?? 0, "USD")
                            : money(selected.costCny)}
                        </strong>
                        {!demo && (preparationUsd > 0 || preparationCny > 0) && (
                          <small>
                            准备阶段另计 {preparationUsd > 0 ? money(preparationUsd, "USD") : ""}
                            {preparationUsd > 0 && preparationCny > 0 ? " + " : ""}
                            {preparationCny > 0 ? money(preparationCny) : ""}
                            （含材料辨读与补问）
                          </small>
                        )}
                        {selected.toolUsage && selected.toolUsage.requests > 0 && (
                          <small>
                            联网工具估算 ${selected.toolUsage.estimatedUsd.toFixed(6)} ·{" "}
                            {selected.toolUsage.requests} 次
                            {selected.toolUsage.reservedUsd > 0
                              ? ` · 预留 $${selected.toolUsage.reservedUsd.toFixed(6)}`
                              : ""}
                          </small>
                        )}
                        {(selected.reservedCny > 0 || (selected.reservedUsd ?? 0) > 0) && (
                          <small>
                            另有{" "}
                            {selected.modelSelection?.currency === "USD"
                              ? money(selected.reservedUsd ?? 0, "USD")
                              : money(selected.reservedCny)}{" "}
                            调用中预留
                          </small>
                        )}
                        {!demo && (
                          <small>
                            {selected.modelSelection?.modelId ?? "早期记录：模型未记录"}
                            {selected.modelSelection && (
                              <>
                                <br />
                                {selected.modelSelection.reason}
                              </>
                            )}
                          </small>
                        )}
                        <small>
                          {demo
                            ? "预设用量与费用，未调用模型，实际费用为 0"
                            : "按已记录用量估算，非最终账单"}
                        </small>
                      </div>
                    </section>
                  </>
                }
                slate={
                  <>
                    <div className="arena-version-line">
                      <label className="version-select">
                        <Layers3 size={13} />
                        <select
                          aria-label="选择推演版本"
                          ref={versionSelectRef}
                          value={selected.id}
                          onChange={(e) => {
                            historyNavigation.current = true;
                            setEditing(false);
                            setClaimTarget(null);
                            setStopConfirm(false);
                            chooseVersion(e.target.value);
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
                        onClick={(event) => openConditions(selected, event.currentTarget)}
                        disabled={arena.busy || historical}
                      >
                        <Settings2 size={14} />
                        调整条件
                      </button>
                      {!demo &&
                        selected.verdict &&
                        selected.strategies.length === 3 &&
                        ["completed", "paused", "failed", "superseded"].includes(
                          selected.status,
                        ) && (
                          <DecisionReviewPanel
                            key={`review-${selected.id}`}
                            arenaId={arena.snapshot.id}
                            version={selected}
                            configured={
                              (arena.health?.model.models ?? arena.health?.model.providers)?.some(
                                (model) => model.provider === "openai" && model.configured,
                              ) ?? false
                            }
                            readOnly={historical}
                          />
                        )}
                      <button
                        type="button"
                        className="text-button"
                        disabled={!!running}
                        onClick={() => {
                          arena.reset();
                          chooseVersion(null);
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
                          onClick={() => chooseVersion(null)}
                        >
                          回到当前版本
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    )}
                    <RunNotice
                      demo={demo}
                      version={selected}
                      historical={historical}
                      busy={arena.busy}
                      onRefresh={() => arena.sync()}
                    />
                    {selected.status !== "completed" && selected.status !== "superseded" && (
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
                              onClick={() => {
                                beginVersionOverlay();
                                setStopConfirm(true);
                              }}
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
      {arena.snapshot && (
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
      )}
      {modelOpen && (
        <Modal title="模型与运行信息" onClose={() => setModelOpen(false)}>
          <div className="model-information">
            <span className={`model-state ${configured ? "configured" : ""}`}>
              <span className="connection-dot" />
              {demo
                ? "演示内容，未调用模型"
                : configured
                  ? "已读取模型配置，实际连接会在首次调用时确认"
                  : "模型尚未配置"}
            </span>
            <dl>
              <div>
                <dt>模型</dt>
                <dd>
                  {demo
                    ? "预设演示，无模型调用"
                    : selected
                      ? (selected.modelSelection?.modelId ?? "早期记录：模型未记录")
                      : arena.health?.model.id || "尚未获取"}
                </dd>
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
                <p>请让运行此服务的人配置模型 API 密钥，然后重启服务。密钥由服务端保存。</p>
                <p>
                  当前模型：<code>{arena.health?.model.id || "查看服务配置"}</code>
                </p>
              </div>
            )}
            <div className="model-cost-note">
              <strong>费用如何计算？</strong>
              <p>
                {demo
                  ? "演示中的路线、证据、裁决、Token 数和费用都是预设的，实际费用为 0。"
                  : "AI 分析问题、读图和推演方案时，都会调用所选模型。费用取决于问题长度、材料和推演步骤。运行时会根据已记录的用量估算费用，按所选模型的原始币种显示。"}
              </p>
            </div>
            <p className="muted">
              {demo
                ? "演示内容用于体验界面和流程，不能证明模型效果。"
                : "同一版本的不同思路由同一个选定模型分角色生成，不代表不同模型的独立意见。"}
            </p>
          </div>
        </Modal>
      )}
      {editing && sameOverlayVersion && editSource && (
        <Modal
          title="调整条件"
          trigger={editSource.trigger}
          side
          motionRef={editMotion}
          onClose={() => {
            releaseVersionPin();
            setEditing(false);
            setEditSource(null);
          }}
        >
          {arena.error && (
            <p className="form-error" role="alert">
              {arena.error}
            </p>
          )}
          <ConditionEditor
            demo={demo}
            initial={editSource.version.challenge}
            initialModelMode={editSource.version.modelSelection?.requestedMode ?? "deepseek"}
            initialFocus={editSource.focus}
            modelProviders={arena.health?.model.models ?? arena.health?.model.providers}
            disabled={!arena.health || accessRequired}
            pending={arena.busy}
            onCancel={() => editMotion.current?.close()}
            onSubmit={async (challenge, reason, modelMode) => {
              // Keep the old version visible while its form completes the exit.
              const motion = editMotion.current;
              const pin = versionPin.current ?? {
                previous: versionId,
                epoch: navigationEpoch.current,
              };
              versionPin.current = pin;
              setVersionId(editSource.version.id);
              if (await arena.rematch(challenge, reason, modelMode, editSource.version.id)) {
                if (navigationEpoch.current !== pin.epoch) return;
                const navigate = () => {
                  if (navigationEpoch.current !== pin.epoch) return;
                  versionPin.current = null;
                  localVersionNavigation.current = true;
                  setVersionId(null);
                  setEditing(false);
                  setEditSource(null);
                };
                if (!motion?.close(navigate)) navigate();
              }
            }}
          />
        </Modal>
      )}
      {followUp && sameOverlayVersion && (
        <StepFollowUpDialog
          key={followUpDraftKey}
          demo={demo}
          version={followUp.version}
          context={followUp.context}
          trigger={followUp.trigger}
          pending={arena.busy}
          initialDraft={supplementDrafts[followUpDraftKey]}
          onDraftChange={(draft) =>
            setSupplementDrafts((saved) => ({ ...saved, [followUpDraftKey]: draft }))
          }
          disabled={accessRequired || versionModelUnavailable(followUp.version)}
          error={
            arena.error ||
            (versionModelUnavailable(followUp.version)
              ? "本版模型尚未配置，可以在调整条件中选择可用模型。"
              : "")
          }
          onClose={() => {
            releaseVersionPin();
            setFollowUp(null);
          }}
          onAdjustConditions={() =>
            openConditions(followUp.version, followUp.trigger, undefined, followUp.returnTo)
          }
          onSubmit={async (text) => {
            const ok = await arena.rematch(
              followUp.version.challenge,
              `针对「${followUp.context.title}」补充意见`,
              followUp.version.modelSelection?.requestedMode,
              followUp.version.id,
              {
                stepId: followUp.context.stepId,
                quote: followUp.context.quote,
                text,
              },
            );
            if (ok) {
              setSupplementDrafts((saved) => {
                const next = { ...saved };
                delete next[followUpDraftKey];
                return next;
              });
              localVersionNavigation.current = true;
            }
            return ok;
          }}
        />
      )}
      {claimTarget && sameOverlayVersion && (
        <Modal
          title="质疑这条判断"
          trigger={claimTarget.trigger}
          side
          motionRef={claimMotion}
          onClose={() => {
            releaseVersionPin();
            setClaimTarget(null);
          }}
        >
          <div className="challenge-dialog">
            <div className="compact-claim-source">
              <span className="eyebrow">
                V{claimTarget.version.number} · 路线 {claimTarget.strategy.id}
              </span>
              <button
                type="button"
                className="text-button"
                aria-expanded={claimOriginalOpen}
                aria-controls={claimQuoteId}
                onClick={() => setClaimOriginalOpen(!claimOriginalOpen)}
              >
                {claimOriginalOpen ? "收起原文" : "查看原文"}
              </button>
            </div>
            <DisclosureMotion open={claimOriginalOpen} id={claimQuoteId}>
              <blockquote className="compact-claim-quote">
                {claimTarget.strategy.claims.find((c) => c.id === claimTarget.claimId)?.text}
              </blockquote>
            </DisclosureMotion>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const motion = claimMotion.current;
                const pin = versionPin.current ?? {
                  previous: versionId,
                  epoch: navigationEpoch.current,
                };
                versionPin.current = pin;
                setVersionId(selected?.id ?? null);
                if (
                  await arena.intervene(
                    claimTarget.strategy.id,
                    claimTarget.claimId,
                    challengeText,
                    claimTarget.version.id,
                    claimTarget.strategy.claims.find((claim) => claim.id === claimTarget.claimId)
                      ?.text,
                  )
                ) {
                  if (navigationEpoch.current !== pin.epoch) return;
                  const navigate = () => {
                    if (navigationEpoch.current !== pin.epoch) return;
                    versionPin.current = null;
                    localVersionNavigation.current = true;
                    setClaimTarget(null);
                    setVersionId(null);
                  };
                  if (!motion?.close(navigate)) navigate();
                }
              }}
            >
              <label className="field">
                <span>你认为哪里有问题？</span>
                <textarea
                  value={challengeText}
                  onChange={(e) => setChallengeText(e.target.value)}
                  minLength={3}
                  maxLength={1000}
                  required
                  rows={3}
                  placeholder="这里漏了什么条件，或哪一点你不认同？"
                />
              </label>
              <p className="muted">
                {demo
                  ? "演示只播放预设内容，不调用模型、不计费。"
                  : "提交后会创建新版本并重新推演，产生新的模型调用费用。"}
              </p>
              {versionModelUnavailable(claimTarget.version) && (
                <p className="form-error" role="alert">
                  本版模型尚未配置，请在调整条件中选择可用模型。
                </p>
              )}
              {arena.error && (
                <p className="form-error" role="alert">
                  {arena.error}
                </p>
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={
                  arena.busy ||
                  challengeText.trim().length < 3 ||
                  versionModelUnavailable(claimTarget.version)
                }
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
          key={selected.id}
          attack={attack}
          version={selected}
          onClose={closeAttack}
          onLocate={locateAttack}
        />
      )}
      {stopConfirm && sameOverlayVersion && (
        <Modal title="停止本轮推演？" motionRef={stopMotion} onClose={() => setStopConfirm(false)}>
          <div className="stop-dialog">
            <p>系统将停止发起后续推演步骤，保留已完成的提案与证据。</p>
            <p>
              {demo
                ? "演示内容由脚本预设，停止不会产生模型调用或费用。如果裁决尚未展示，本轮会保留为未完成状态。"
                : "已经发出的请求仍可能完成并产生费用。如果结论尚未形成，本轮会标为未完成。"}
            </p>
            <div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => stopMotion.current?.close()}
              >
                继续推演
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={arena.busy}
                onClick={async () => {
                  const motion = stopMotion.current;
                  await arena.stop();
                  motion?.close();
                }}
              >
                确认停止
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
