"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, Download, FileText, LoaderCircle, X } from "lucide-react";
import type { PlanningController } from "../use-planning";
import { acquireMotionHold, createMotionScope } from "../console/motion-runtime";
import { reducedMotion } from "../console/effects";

export function ReportPaper({
  controller,
  onClose,
}: {
  controller: PlanningController;
  onClose: () => void;
}) {
  const session = controller.snapshot!.session;
  const report = session.report;
  const draft = session.draft;
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"report" | "prompt">("report");
  const [copyMessage, setCopyMessage] = useState("");
  const [acknowledgedFingerprint, setAcknowledgedFingerprint] = useState<string | null>(null);
  const readConfirmation = !!report && acknowledgedFingerprint === report.fingerprint;
  const confirmed = report?.status === "confirmed";
  const outdated = !!report && report.basedOnRevision !== session.revision;
  const originalText =
    tab === "prompt"
      ? (report?.executionPrompt ?? "")
      : (report?.markdown ??
        [
          draft?.title,
          draft?.summary,
          ...(draft?.sections.map((section) => `## ${section.title}\n\n${section.content}`) ?? []),
        ]
          .filter(Boolean)
          .join("\n\n"));
  // This receipt is outside the immutable, fingerprinted model-authored body.
  const documentText =
    originalText && report
      ? [
          "## 文档确认记录",
          `- 状态：${outdated ? "历史版本，不代表当前需求" : confirmed ? "用户已确认" : "阶段草稿，尚未经用户正式确认"}`,
          `- 确认时间：${report.confirmedAt ?? "尚未确认"}`,
          `- 报告编号：${report.id}`,
          `- 报告正文指纹：${report.fingerprint}`,
          `- 对应需求版本：${report.basedOnRevision}`,
          "",
          "---",
          "",
          originalText,
        ].join("\n")
      : originalText;

  useLayoutEffect(() => {
    const paper = dialog.current;
    if (!paper) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = acquireMotionHold();
    const scope = createMotionScope("interaction");
    paper.showModal();
    if (!reducedMotion())
      scope.animate(
        paper,
        [
          { opacity: 0, transform: "translateY(52px) rotate(1.2deg)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 900, easing: "cubic-bezier(.19,1,.22,1)" },
      );
    return () => {
      scope.dispose();
      release();
      paper.close();
      queueMicrotask(() => {
        if (before?.isConnected) before.focus({ preventScroll: true });
      });
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(documentText);
      setCopyMessage("已复制");
    } catch {
      setCopyMessage("未能复制，请选中文本后复制。");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([documentText], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `方案擂台-${tab === "prompt" ? "执行提示词" : confirmed ? "确认方案" : "方案草稿"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <dialog
      className="p-report"
      ref={dialog}
      aria-labelledby="planning-report-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="p-report-toolbar">
        <div>
          <FileText size={16} />
          <span>{confirmed ? "正式方案" : outdated ? "历史草稿 · 需要更新" : "方案审阅"}</span>
        </div>
        <div>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!documentText}
            aria-label="复制当前文档"
          >
            <Copy size={16} />
          </button>
          <button
            type="button"
            onClick={download}
            disabled={!documentText}
            aria-label="下载当前文档"
          >
            <Download size={16} />
          </button>
          <button type="button" onClick={onClose} aria-label="收起方案">
            <X size={18} />
          </button>
        </div>
      </header>
      <nav className="p-report-tabs" aria-label="方案内容">
        <button type="button" aria-pressed={tab === "report"} onClick={() => setTab("report")}>
          执行方案
        </button>
        <button
          type="button"
          aria-pressed={tab === "prompt"}
          disabled={!report?.executionPrompt}
          onClick={() => setTab("prompt")}
        >
          执行提示词
        </button>
        <span role="status">{copyMessage}</span>
      </nav>
      <div className="p-report-scroll">
        {confirmed && (
          <span className="p-report-seal" aria-label="用户已确认">
            确认
            <br />
            归档
          </span>
        )}
        <p className="p-eyebrow">方案擂台 · {confirmed ? "经你确认的版本" : "仍可修改与补充"}</p>
        <h2 id="planning-report-title">{report?.title || draft?.title || "方案正在成形"}</h2>
        {tab === "prompt" ? (
          <>
            <p className="p-report-intro">把这份提示词交给下一位执行者，作为具体实施的起点。</p>
            <pre className="p-execution-prompt">{report?.executionPrompt}</pre>
          </>
        ) : (
          <>
            <p className="p-report-intro">
              {report?.summary || draft?.summary || "已有需求会在这里逐步组织成完整方案。"}
            </p>
            {outdated && (
              <p className="p-inline-error">
                需求已经改变。这份草稿保留供你对照，不能作为当前方案确认。
              </p>
            )}
            {(report?.sections ?? draft?.sections ?? []).map((section, index) => (
              <section className="p-report-section" key={section.id}>
                <h3>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {section.title}
                </h3>
                <div className="p-report-prose">{section.content}</div>
                {section.sources.length > 0 && (
                  <details className="p-source-details">
                    <summary>这部分依据什么</summary>
                    {section.sources.map((source, i) => (
                      <blockquote key={`${source.kind}:${source.id}:${i}`}>
                        <small>
                          {source.kind === "analysis"
                            ? "AI 分析"
                            : source.kind === "material"
                              ? "材料"
                              : "用户提供"}
                        </small>
                        {source.quote}
                      </blockquote>
                    ))}
                  </details>
                )}
              </section>
            ))}
            {!!report?.tasks.length && (
              <section className="p-report-section">
                <h3>实施安排</h3>
                <ol className="p-report-tasks">
                  {report.tasks.map((task) => (
                    <li key={task.id}>
                      <h4>{task.title}</h4>
                      <p>{task.instructions}</p>
                      {task.dependsOn.length > 0 && (
                        <small>
                          先完成：
                          {task.dependsOn
                            .map((id) => report.tasks.find((entry) => entry.id === id)?.title ?? id)
                            .join("、")}
                        </small>
                      )}
                      <ul>
                        {task.acceptance.map((value, index) => (
                          <li key={index}>{value}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {!!report?.risks.length && (
              <section className="p-report-section">
                <h3>风险与取舍</h3>
                <ul>
                  {report.risks.map((risk, index) => (
                    <li key={index}>{risk}</li>
                  ))}
                </ul>
              </section>
            )}
            {!!report?.unresolved.length && (
              <section className="p-report-section">
                <h3>仍需核实</h3>
                <ul>
                  {report.unresolved.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </section>
            )}
            {!!report?.acceptance.length && (
              <section className="p-report-section">
                <h3>怎样才算做好</h3>
                <ul>
                  {report.acceptance.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </section>
            )}
            {session.review && !confirmed && (
              <section className="p-report-section p-review-result">
                <h3>{session.review.ready ? "查漏结果" : "还需要一起定下"}</h3>
                {session.review.blockers.length ? (
                  <ul>
                    {session.review.blockers.map((blocker) => (
                      <li key={blocker.id}>{blocker.description}</li>
                    ))}
                  </ul>
                ) : (
                  <p>当前查漏没有列出阻断事项；是否采用这份方案，仍由你确认。</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
      <footer className="p-report-bottom">
        {controller.error && (
          <p className="p-inline-error" role="alert">
            {controller.error}
          </p>
        )}
        {confirmed ? (
          <p>
            <Check size={16} />
            已按你的确认归档。复制或下载后即可交给执行者。
          </p>
        ) : (
          <>
            {session.capabilities.canAdvance && session.nextAction === "advance" && (
              <button
                type="button"
                className="secondary-button"
                disabled={controller.pendingAction !== null || controller.unknownRequest}
                onClick={() => {
                  void controller.act({ kind: "advance" });
                  onClose();
                }}
              >
                继续补全方案
              </button>
            )}
            {session.capabilities.canPreview && (outdated || !report) && (
              <button
                type="button"
                className="secondary-button"
                disabled={controller.pendingAction !== null}
                onClick={() => void controller.act({ kind: "preview" })}
              >
                根据当前需求整理方案
              </button>
            )}
            <label className="p-confirm-reading">
              <input
                type="checkbox"
                checked={readConfirmation}
                onChange={(event) =>
                  setAcknowledgedFingerprint(
                    event.target.checked ? (report?.fingerprint ?? null) : null,
                  )
                }
                disabled={!session.capabilities.canConfirm || outdated}
              />
              我已读过当前方案，确认它表达了我的决定。
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={
                !report ||
                !session.capabilities.canConfirm ||
                outdated ||
                !readConfirmation ||
                controller.pendingAction !== null
              }
              onClick={() =>
                report &&
                void controller.act({
                  kind: "confirm",
                  reportId: report.id,
                  fingerprint: report.fingerprint,
                })
              }
            >
              {controller.pendingAction === "confirm" ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Check size={16} />
              )}
              确认这份方案
            </button>
            {!session.capabilities.canConfirm && (
              <small>
                {session.capabilities.reason || "当前为阶段草稿，继续补齐待定事项后再确认。"}
              </small>
            )}
          </>
        )}
      </footer>
    </dialog>
  );
}
