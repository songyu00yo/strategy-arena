"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, FileText, History, Pause, Play } from "lucide-react";
import type { Attack, ArenaVersion, Strategy } from "@/lib/contracts";
import type { RecordedExamplePayload } from "@/lib/recorded-examples";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { ArenaConsole } from "./console/ArenaConsole";
import { EvidenceDrawer } from "./evidence-drawer";
import { Modal } from "./modal";
import { ClickFx, reducedMotion } from "./console/effects";
import { readMotionOrigin } from "./motion-origin";
import { RecordedChallenge } from "./recorded-challenge";
import "./console/console.css";
import "./recorded-example-viewer.css";

function RecordedExampleEntry({
  title,
  version,
  modelId,
  onStart,
}: {
  title: string;
  version: ArenaVersion;
  modelId: string;
  onStart: () => void;
}) {
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
  const fields = [
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
        <span>真实案例回放 · 新增用量为 0</span>
      </header>
      <main className="recorded-entry-main">
        <p className="recorded-entry-eyebrow">先看当时填写的内容</p>
        <h1>{title}</h1>
        <p>接下来会自动触发“开始分析”，从第一步播放当时的真实推演。</p>
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
            <span>你想解决什么问题？</span>
            <textarea readOnly value={challenge.goal} rows={4} onFocus={() => setPaused(true)} />
          </label>
          <dl className="recorded-entry-fields">
            {fields.map(([label, value], index) => (
              <div key={label} style={{ animationDelay: `${180 + index * 100}ms` }}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {(challenge.budget !== null || challenge.timeHours !== null) && (
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
              <ArrowRight size={17} /> 开始分析
            </button>
          </footer>
        </form>
        <p className="recorded-entry-footnote">播放已保存的内容，新增模型调用与 Token 均为 0。</p>
      </main>
    </div>
  );
}

export function RecordedExampleViewer({ payload }: { payload: RecordedExamplePayload }) {
  const { metadata, arena } = payload;
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
  const replayRoot = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (started) replayRoot.current?.focus({ preventScroll: true });
  }, [started]);
  const version = arena.versions.find((item) => item.id === versionId) ?? arena.versions[0];
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
        title={metadata.title}
        version={version}
        modelId={metadata.modelId}
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
  const estimate = cost == null ? "未记录" : `${usd ? "$" : "¥"}${cost.toFixed(6)}`;
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
        跳到推演记录
      </a>
      <main
        ref={replayRoot}
        id="recorded-replay"
        className="recorded-replay-main"
        tabIndex={-1}
        aria-label="真实案例回放"
      >
        <ArenaConsole
          key={version.id}
          version={version}
          steps={arena.steps.filter((step) => step.versionId === version.id)}
          events={arena.events.filter((event) => event.versionId === version.id)}
          demo={false}
          historical
          startFromBeginning
          allowRecordedChallenges
          busy={false}
          selectedAttack={located}
          onEvidence={openEvidence}
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
                onClick={(event) => setDetails(event.currentTarget)}
              >
                <FileText size={13} /> 原题与记录
              </button>
            </>
          }
          conditions={
            <div className="recorded-replay-meta">
              <strong>真实生成记录 · 回看不调用模型</strong>
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
              <span>生成时的旧估算 {estimate}</span>
            </div>
          }
          notices={
            <p className="recorded-replay-notice">
              回放新增用量为 0。点击判断旁的“挑战”，可以提出自己的质疑。
            </p>
          }
        />
      </main>
      {claimTarget?.versionId === version.id && (
        <RecordedChallenge
          metadata={metadata}
          version={version}
          target={claimTarget}
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
        <Modal title="原题与生成记录" trigger={details} onClose={() => setDetails(null)} wide>
          <div className="recorded-source-details">
            <p className="recorded-source-label">真实生成记录 · 回看不调用模型</p>
            <p>这里只播放已保存的内容，切换版本、查看证据和播放步骤都不会发起模型调用。</p>
            <dl>
              <div>
                <dt>示例说明</dt>
                <dd>示例问题为预设，方案来自真实模型。</dd>
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
                  <code>{metadata.sourceCommit}</code>
                </dd>
              </div>
              <div>
                <dt>记录的适用范围</dt>
                <dd>{metadata.qualityNote}</dd>
              </div>
              <div>
                <dt>生成时的旧估算</dt>
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
                <dt>目标</dt>
                <dd>{version.challenge.goal}</dd>
              </div>
              <div>
                <dt>硬性限制</dt>
                <dd>{version.challenge.constraints || "未填写"}</dd>
              </div>
              <div>
                <dt>偏好</dt>
                <dd>{version.challenge.preferences || "未填写"}</dd>
              </div>
              <div>
                <dt>备选方案</dt>
                <dd>{version.challenge.options.join("\n") || "未填写"}</dd>
              </div>
              <div>
                <dt>提供的材料</dt>
                <dd>{version.challenge.materials || "未提供材料"}</dd>
              </div>
              <div>
                <dt>预算与时间</dt>
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
