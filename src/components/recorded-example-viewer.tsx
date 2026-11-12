"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, FileText, History, Pause, Play } from "lucide-react";
import type { Attack, ArenaVersion, Strategy } from "@/lib/contracts";
import type { StepContext } from "@/lib/step-context";
import type { RecordedExamplePayload } from "@/lib/recorded-examples";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { ArenaConsole } from "./console/ArenaConsole";
import { EvidenceDrawer } from "./evidence-drawer";
import { Modal } from "./modal";
import { ClickFx, reducedMotion } from "./console/effects";
import { readMotionOrigin } from "./motion-origin";
import { RecordedConditionEditor } from "./recorded-condition-editor";
import { RecordedChallenge } from "./recorded-challenge";
import { supplementDraftKey, type SupplementDraft } from "./supplement-draft";
import { createMotionLoop, createMotionScope, motionNow } from "./console/motion-runtime";
import { initialPaperFrames, initialPaperReceiverReady, PAPER_MOTION } from "./console/paper-stage";
import "./console/console.css";
import "./recorded-example-viewer.css";
import "./console/paper-console.css";
import "./console/press.css";
import "./console/paper-stage.css";

/** Keep the original input on paper until the mounted A card can receive it at a measured position. */
function handoffInitialPaper(form: HTMLFormElement, onStart: () => void) {
  const source = form.getBoundingClientRect();
  const paper = form.cloneNode(true) as HTMLElement;
  paper.classList.add("initial-paper-transfer");
  paper.inert = true;
  paper.setAttribute("aria-hidden", "true");
  paper.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  Object.assign(paper.style, {
    left: `${source.left}px`,
    top: `${source.top}px`,
    width: `${source.width}px`,
    height: `${source.height}px`,
  });
  document.body.appendChild(paper);
  const scope = createMotionScope();
  scope.own(paper);
  const route = location.pathname;
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  let animation: Animation | undefined;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    loop?.dispose();
    preference.removeEventListener("change", settle);
    removeEventListener("pagehide", cleanup);
    removeEventListener("popstate", cleanup);
    scope.dispose();
  };
  const settle = () => {
    if (preference.matches) {
      if (animation) animation.finish();
      else cleanup();
    }
  };
  preference.addEventListener("change", settle);
  addEventListener("pagehide", cleanup, { once: true });
  addEventListener("popstate", cleanup, { once: true });
  const began = motionNow();
  const loop = createMotionLoop((now) => {
    if (location.pathname !== route || (!animation && now - began >= 2000)) {
      cleanup();
      return false;
    }
    if (animation) return true;
    const target = document.querySelector<HTMLElement>('[data-board="A"]');
    const activeStep = document.querySelector('.c-time [aria-current="step"]');
    if (activeStep && activeStep.getAttribute("aria-label") !== "第 1 步") {
      cleanup();
      return false;
    }
    if (!initialPaperReceiverReady(target, activeStep)) return true;
    const frames = target && initialPaperFrames(source, target.getBoundingClientRect());
    if (!frames || reducedMotion()) {
      cleanup();
      return false;
    }
    animation = scope.animate(paper, frames, {
      duration: PAPER_MOTION.transfer,
      easing: "cubic-bezier(.2,.75,.25,1)",
      fill: "both",
    });
    animation.onfinish = cleanup;
    return true;
  });
  onStart();
}

function RecordedExampleEntry({
  metadata,
  version,
  onStart,
}: {
  metadata: RecordedExamplePayload["metadata"];
  version: ArenaVersion;
  onStart: () => void;
}) {
  const { title, modelId } = metadata;
  const clarification = version.workflow === "clarification";
  const simulated = metadata.caseType === "simulated_real_model";
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const started = useRef(false);
  const remaining = useRef(5200);
  const exit = useRef<Animation | null>(null);
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (paused || hidden || leaving) return;
    const began = performance.now();
    const timer = setTimeout(() => startButton.current?.click(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - began));
    };
  }, [paused, hidden, leaving]);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => {
      if (preference.matches) exit.current?.finish();
    };
    preference.addEventListener("change", settle);
    return () => {
      preference.removeEventListener("change", settle);
      exit.current?.cancel();
    };
  }, []);
  const begin = () => {
    if (started.current) return;
    started.current = true;
    setLeaving(true);
    if (!form.current || reducedMotion()) return onStart();
    if (clarification) return handoffInitialPaper(form.current, onStart);
    const animation = form.current.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-30px) scale(.97)" },
      ],
      { duration: 620, easing: "cubic-bezier(.7,0,.2,1)", fill: "forwards" },
    );
    exit.current = animation;
    animation.onfinish = onStart;
  };
  const { challenge } = version;
  const originalGoal = clarification ? (version.intake?.originalGoal ?? "") : challenge.goal;
  const fields = clarification
    ? metadata.initialMaterials === undefined
      ? []
      : [["原始提交材料", metadata.initialMaterials || "原始提交未附材料。"]]
    : [
        ["硬性限制", challenge.constraints],
        ["偏好", challenge.preferences],
        ["备选方案", challenge.options.join("\n")],
        ["提供的材料", challenge.materials],
      ].filter(([, value]) => value);
  return (
    <div className="console-shell home recorded-entry-shell">
      <ClickFx />
      <header className="site-header">
        <Link href="/?examples=open" className="text-button">
          <ArrowLeft size={16} /> 返回案例
        </Link>
        <span>
          {simulated ? "真实模型运行的模拟案例 · 回看新增调用为 0" : "真实案例回放 · 新增用量为 0"}
        </span>
      </header>
      <main className="recorded-entry-main">
        <p className="recorded-entry-eyebrow">
          {clarification ? "先看最初的模糊目标" : "先看当时填写的内容"}
        </p>
        <h1>{title}</h1>
        <p>
          {clarification
            ? "接下来从第一轮回看已保存的提问、模拟回答和模型审查记录。"
            : "接下来会自动触发“开始分析”，从第一步播放当时的真实推演。"}
        </p>
        <form
          ref={form}
          className="recorded-entry-form"
          onSubmit={(event) => {
            event.preventDefault();
            begin();
          }}
          aria-label="案例原始填写内容"
          aria-busy={leaving}
        >
          <label className="recorded-entry-goal">
            <span>{clarification ? "你想做什么" : "你想解决什么问题？"}</span>
            <textarea readOnly value={originalGoal} rows={4} onFocus={() => setPaused(true)} />
          </label>
          <dl className="recorded-entry-fields">
            {fields.map(([label, value], index) => (
              <div key={label} style={{ animationDelay: `${180 + index * 100}ms` }}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {!clarification && (challenge.budget !== null || challenge.timeHours !== null) && (
            <p className="recorded-entry-limits">
              {challenge.budget !== null && <span>预算上限 ¥{challenge.budget}</span>}
              {challenge.timeHours !== null && <span>可用时间 {challenge.timeHours} 小时</span>}
            </p>
          )}
          <footer className="recorded-entry-actions">
            <span>{MODEL_CATALOG.find((model) => model.id === modelId)?.label ?? modelId}</span>
            <button
              type="button"
              className="text-button"
              disabled={leaving}
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? "继续自动开始" : "暂停自动开始"}
            </button>
            <button
              ref={startButton}
              type="submit"
              className={`primary-button recorded-entry-start ${paused || hidden ? "is-paused" : ""}`}
              disabled={leaving}
            >
              <ArrowRight size={17} /> {clarification ? "开始回看" : "开始分析"}
            </button>
          </footer>
        </form>
        <p className="recorded-entry-footnote">
          {simulated
            ? `用户回答由${metadata.simulationActor ?? "模拟答题方"}模拟提交，未执行任务，也没有真实执行反馈。回看新增模型调用与 Token 均为 0。`
            : "播放已保存的内容，新增模型调用与 Token 均为 0。"}
        </p>
      </main>
    </div>
  );
}

export function RecordedExampleViewer({ payload }: { payload: RecordedExamplePayload }) {
  const { metadata, arena, replayActions } = payload;
  const [versionId, setVersionId] = useState(arena.versions.at(-1)?.id);
  const [evidence, setEvidence] = useState<{
    versionId: string;
    attack: Attack;
    trigger: HTMLElement | null;
  } | null>(null);
  const [details, setDetails] = useState<HTMLButtonElement | null>(null);
  const [located, setLocated] = useState<string>();
  const [started, setStarted] = useState(false);
  const [claimTarget, setClaimTarget] = useState<{
    versionId: string;
    strategy: Strategy;
    claimId: string;
    trigger: HTMLElement | null;
  } | null>(null);
  const [stepTarget, setStepTarget] = useState<{
    versionId: string;
    context: StepContext;
    trigger: HTMLElement | null;
  } | null>(null);
  const [conditionTarget, setConditionTarget] = useState<{
    versionId: string;
    trigger: HTMLElement | null;
  } | null>(null);
  const replayRoot = useRef<HTMLElement>(null);
  const [supplementDrafts, setSupplementDrafts] = useState<Record<string, SupplementDraft>>({});
  useLayoutEffect(() => {
    if (started) replayRoot.current?.focus({ preventScroll: true });
  }, [started]);
  const version = arena.versions.find((item) => item.id === versionId) ?? arena.versions[0];
  const clarification = version?.workflow === "clarification";
  const simulated = metadata.caseType === "simulated_real_model";
  const stepDraftKey = stepTarget
    ? supplementDraftKey(
        stepTarget.versionId,
        `step:${stepTarget.context.stepId}`,
        stepTarget.context.quote,
      )
    : "";
  const claimDraftKey = claimTarget
    ? supplementDraftKey(
        claimTarget.versionId,
        `claim:${claimTarget.strategy.id}:${claimTarget.claimId}`,
        claimTarget.strategy.claims.find((claim) => claim.id === claimTarget.claimId)?.text ?? "",
      )
    : "";
  if (!version)
    return (
      <main className="recorded-missing">
        <h1>这份示例没有可回看的版本</h1>
        <Link href="/">返回首页</Link>
      </main>
    );
  if (!started)
    return (
      <RecordedExampleEntry
        metadata={metadata}
        version={version}
        onStart={() => setStarted(true)}
      />
    );
  const activeEvidence = evidence?.versionId === version.id ? evidence : null;
  const date = new Date(metadata.generatedAt).toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const usd = version.modelSelection?.currency === "USD";
  const cost = usd ? version.costUsd : version.costCny;
  const recordedUsd =
    metadata.recordedCostUsd ??
    (clarification && version.intake
      ? (version.costUsd ?? 0) +
        version.intake.usage.reduce((total, usage) => total + (usage.estimatedUsd ?? 0), 0)
      : undefined);
  const recordedCny =
    metadata.recordedCostCny ??
    (clarification && version.intake
      ? version.costCny +
        version.intake.usage.reduce((total, usage) => total + usage.estimatedCny, 0)
      : undefined);
  const recordedCosts = [
    ["$", recordedUsd],
    ["¥", recordedCny],
  ] as const;
  const positiveCosts = recordedCosts.filter(([, value]) => value !== undefined && value > 0);
  const displayedCosts = positiveCosts.length
    ? positiveCosts
    : recordedCosts.filter(([, value]) => value !== undefined).slice(0, 1);
  const estimate = displayedCosts.length
    ? displayedCosts.map(([symbol, value]) => `${symbol}${value!.toFixed(6)}`).join(" · ")
    : cost == null
      ? "未记录"
      : `${usd ? "$" : "¥"}${cost.toFixed(6)}`;
  const simulatedAnswers =
    version.clarification?.rounds
      .flatMap((round, index, rounds) =>
        round.answers
          .filter(
            (answer) =>
              !rounds[index - 1]?.answers.some(
                (prior) => JSON.stringify(prior) === JSON.stringify(answer),
              ),
          )
          .map(
            (answer) =>
              `第 ${round.round} 轮前提交 · ${answer.question.title}\n${answer.state === "unknown" ? "不知道" : answer.state === "skipped" ? "跳过" : Array.isArray(answer.value) ? answer.value.join("、") : answer.value}\n${answer.confirmation === "confirmed" && !answer.needsReconfirmation ? "已确认" : "待确认"}`,
          ),
      )
      .join("\n\n") || "未记录模拟回答。";
  const openEvidence = (attack: Attack) =>
    setEvidence({
      versionId: version.id,
      attack,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  const locate = (attack: Attack) => {
    setEvidence(null);
    setLocated(attack.id);
    const claim = document.querySelector<HTMLElement>(
      `[data-claim="${CSS.escape(`${attack.targetStrategyId}:${attack.targetClaimId}`)}"]`,
    );
    claim?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  };
  return (
    <div className="console-shell recorded-replay-shell">
      <ClickFx />
      <a href="#recorded-replay" className="skip-link">
        {clarification ? "跳到需求梳理记录" : "跳到推演记录"}
      </a>
      <main
        ref={replayRoot}
        id="recorded-replay"
        className="recorded-replay-main"
        tabIndex={-1}
        aria-label={simulated ? "需求梳理模拟案例回放" : "真实案例回放"}
      >
        <ArenaConsole
          key={version.id}
          version={version}
          steps={arena.steps.filter((step) => step.versionId === version.id)}
          events={arena.events.filter((event) => event.versionId === version.id)}
          demo={false}
          historical
          startFromBeginning
          replayActions={replayActions}
          allowRecordedChallenges
          busy={false}
          selectedAttack={located}
          onEvidence={openEvidence}
          onFollowUp={(context, trigger) =>
            setStepTarget({ versionId: version.id, context, trigger })
          }
          onAdjustConditions={(trigger) => setConditionTarget({ versionId: version.id, trigger })}
          onClaim={(strategy, claimId) =>
            setClaimTarget({
              versionId: version.id,
              strategy,
              claimId,
              trigger:
                readMotionOrigin()?.element ??
                (document.activeElement instanceof HTMLElement ? document.activeElement : null),
            })
          }
          slate={
            <>
              <Link className="recorded-back" href="/?examples=open" aria-label="返回示例">
                <ArrowLeft size={17} />
              </Link>
              <h1>{metadata.title}</h1>
              <span className="recorded-replay-badge">
                <History size={12} /> 只读回看
              </span>
              <button
                type="button"
                className="text-button"
                onClick={(event) =>
                  setConditionTarget({ versionId: version.id, trigger: event.currentTarget })
                }
              >
                调整条件
              </button>
              <button
                type="button"
                className="text-button"
                onClick={(event) => setDetails(event.currentTarget)}
              >
                <FileText size={13} /> 原题与记录
              </button>
            </>
          }
          conditions={
            <div className="recorded-replay-meta">
              <strong>
                {simulated ? "真实模型运行的模拟案例" : "真实生成记录 · 回看不调用模型"}
              </strong>
              <span>
                {metadata.modelId} · {date}
              </span>
              {arena.versions.length > 1 ? (
                <label>
                  已存版本{" "}
                  <select
                    value={version.id}
                    onChange={(event) => {
                      setVersionId(event.target.value);
                      setLocated(undefined);
                      setEvidence(null);
                      setClaimTarget(null);
                      setStepTarget(null);
                      setConditionTarget(null);
                    }}
                  >
                    {arena.versions.map((item) => (
                      <option key={item.id} value={item.id}>
                        V{item.number}
                        {item.changeReason ? ` · ${item.changeReason}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span>原记录 V{version.number}</span>
              )}
              <span>
                {clarification ? "原记录费用估算" : "生成时的旧估算"} {estimate}
              </span>
            </div>
          }
          notices={
            <p className="recorded-replay-notice">
              {simulated
                ? `按保存记录重建操作，动画节奏为演示编排。回看新增调用为0。${metadata.simulationActor ?? "模拟答题方"}模拟回答，尚无执行反馈。原补充或调整入口在明确提交后创建自己的需求草稿，模型调用由后续“开始梳理”触发。`
                : "回放新增用量为0。打开步骤后可以补充或质疑，也可以调整条件；确认重新推演才会产生模型费用。"}
            </p>
          }
        />
      </main>
      {conditionTarget?.versionId === version.id && (
        <RecordedConditionEditor
          key={`conditions:${version.id}`}
          metadata={metadata}
          version={version}
          trigger={conditionTarget.trigger}
          onClose={() => setConditionTarget(null)}
        />
      )}
      {stepTarget?.versionId === version.id && (
        <RecordedChallenge
          key={stepDraftKey}
          metadata={metadata}
          version={version}
          target={stepTarget}
          initialDraft={supplementDrafts[stepDraftKey]}
          onDraftChange={(draft) =>
            setSupplementDrafts((saved) => ({ ...saved, [stepDraftKey]: draft }))
          }
          onSubmitted={() =>
            setSupplementDrafts((saved) => {
              const next = { ...saved };
              delete next[stepDraftKey];
              return next;
            })
          }
          onClose={() => setStepTarget(null)}
          onAdjustConditions={() =>
            setConditionTarget({ versionId: version.id, trigger: stepTarget.trigger })
          }
        />
      )}
      {claimTarget?.versionId === version.id && (
        <RecordedChallenge
          key={claimDraftKey}
          metadata={metadata}
          version={version}
          target={claimTarget}
          initialDraft={supplementDrafts[claimDraftKey]}
          onDraftChange={(draft) =>
            setSupplementDrafts((saved) => ({ ...saved, [claimDraftKey]: draft }))
          }
          onSubmitted={() =>
            setSupplementDrafts((saved) => {
              const next = { ...saved };
              delete next[claimDraftKey];
              return next;
            })
          }
          onClose={() => setClaimTarget(null)}
        />
      )}
      {activeEvidence && (
        <EvidenceDrawer
          attack={activeEvidence.attack}
          version={version}
          trigger={activeEvidence.trigger}
          onClose={() => setEvidence(null)}
          onLocate={locate}
        />
      )}
      {details && (
        <Modal
          title={clarification ? "原始目标与需求梳理记录" : "原题与生成记录"}
          trigger={details}
          onClose={() => setDetails(null)}
          wide
        >
          <div className="recorded-source-details">
            <p className="recorded-source-label">
              {simulated ? "真实模型运行的模拟案例" : "真实生成记录 · 回看不调用模型"}
            </p>
            <p>这里只播放已保存的内容，切换版本、查看证据和播放步骤都不会发起模型调用。</p>
            <dl>
              <div>
                <dt>示例说明</dt>
                <dd>
                  {simulated
                    ? `本案例由${metadata.simulationActor ?? "模拟答题方"}模拟用户提交回答，A/B/C输出来自真实模型调用。未执行任务，没有真实执行反馈。`
                    : "示例问题为预设，方案来自真实模型。"}
                </dd>
              </div>
              <div>
                <dt>当时使用的模型</dt>
                <dd>{metadata.modelId}</dd>
              </div>
              <div>
                <dt>生成日期</dt>
                <dd>{date}</dd>
              </div>
              <div>
                <dt>来源提交</dt>
                <dd>
                  <code>
                    {clarification
                      ? metadata.sourceCommits?.join(" → ") || metadata.sourceCommit
                      : metadata.sourceCommit}
                  </code>
                </dd>
              </div>
              <div>
                <dt>记录的适用范围</dt>
                <dd>{metadata.qualityNote}</dd>
              </div>
              <div>
                <dt>{clarification ? "原记录费用估算" : "生成时的旧估算"}</dt>
                <dd>{estimate}，这是当时记录的估算，回看不会产生新的模型费用。</dd>
              </div>
              <div>
                <dt>当前记录</dt>
                <dd>
                  V{version.number}
                  {version.changeReason ? ` · ${version.changeReason}` : ""}
                </dd>
              </div>
              <div>
                <dt>{clarification ? "最初的模糊目标" : "目标"}</dt>
                <dd>
                  {clarification
                    ? version.intake?.originalGoal || "原始目标未记录"
                    : version.challenge.goal}
                </dd>
              </div>
              <div>
                <dt>{clarification ? "本版本限制" : "硬性限制"}</dt>
                <dd>{version.challenge.constraints || "未填写"}</dd>
              </div>
              <div>
                <dt>{clarification ? "本版本偏好" : "偏好"}</dt>
                <dd>{version.challenge.preferences || "未填写"}</dd>
              </div>
              <div>
                <dt>{clarification ? "Codex模拟回答" : "备选方案"}</dt>
                <dd>
                  {clarification
                    ? simulatedAnswers
                    : version.challenge.options.join("\n") || "未填写"}
                </dd>
              </div>
              <div>
                <dt>{clarification ? "原始提交材料" : "提供的材料"}</dt>
                <dd>
                  {clarification
                    ? metadata.initialMaterials === undefined
                      ? "未记录原始材料"
                      : metadata.initialMaterials || "原始提交未附材料。"
                    : version.challenge.materials || "未提供材料"}
                </dd>
              </div>
              <div>
                <dt>{clarification ? "本版本资源约定" : "预算与时间"}</dt>
                <dd>
                  {version.challenge.budget == null
                    ? "未填写预算"
                    : `预算上限 ¥${version.challenge.budget}`}{" "}
                  ·{" "}
                  {version.challenge.timeHours == null
                    ? "未填写时间"
                    : `可用时间 ${version.challenge.timeHours} 小时`}
                </dd>
              </div>
            </dl>
          </div>
        </Modal>
      )}
    </div>
  );
}
