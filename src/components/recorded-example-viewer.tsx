"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, History } from "lucide-react";
import type { Attack } from "@/lib/contracts";
import type { RecordedExamplePayload } from "@/lib/recorded-examples";
import { ArenaConsole } from "./console/ArenaConsole";
import { EvidenceDrawer } from "./evidence-drawer";
import { Modal } from "./modal";
import { ClickFx, reducedMotion } from "./console/effects";
import "./console/console.css";
import "./recorded-example-viewer.css";

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
  const version = arena.versions.find((item) => item.id === versionId) ?? arena.versions[0];
  if (!version)
    return (
      <main className="recorded-missing">
        <h1>这份示例没有可回看的版本</h1>
        <Link href="/">返回首页</Link>
      </main>
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
      <main id="recorded-replay" className="recorded-replay-main">
        <ArenaConsole
          key={version.id}
          version={version}
          steps={arena.steps.filter((step) => step.versionId === version.id)}
          events={arena.events.filter((event) => event.versionId === version.id)}
          demo={false}
          historical
          busy={false}
          selectedAttack={located}
          onEvidence={openEvidence}
          onClaim={() => {}}
          slate={
            <>
              <Link className="recorded-back" href="/examples" aria-label="返回示例">
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
              示例问题为预设，方案来自真实模型。用播放按钮回看当时的步骤。
            </p>
          }
        />
      </main>
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
