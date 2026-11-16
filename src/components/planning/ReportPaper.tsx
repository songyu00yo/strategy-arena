"use client";

import { useRef, useState } from "react";
import { Check, Copy, Download, FileText, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { PlanningController } from "../use-planning";
import { agentPaperAnchor } from "./paper-motion";
import { usePaperDialog } from "./use-paper-dialog";

/** Internal execution instructions are never a reader-facing report section. */
const internalSection = /prompt|提示词|系统指令|开发者指令|给\s*AI|供\s*AI|AI\s*执行说明/iu;

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
  const [copyMessage, setCopyMessage] = useState("");
  const [adopting, setAdopting] = useState(false);
  const submitting = useRef(false);
  const { dialog, close } = usePaperDialog({ anchor: () => agentPaperAnchor("C"), onClose });
  const confirmed = report?.status === "confirmed";
  const outdated = !!report && report.basedOnRevision !== session.revision;
  const sections = (report?.sections ?? draft?.sections ?? []).filter(
    (section) => !internalSection.test(section.title),
  );
  const title = report?.title || draft?.title || "项目分析";
  const summary = report?.summary || draft?.summary || "当前已整理的项目理解。";
  const unresolved = [
    ...new Set([
      ...(report?.unresolved ?? []),
      ...(session.review?.uncertainties ?? []),
      ...(session.review?.blockers.map((blocker) => blocker.description) ?? []),
    ]),
  ];
  // Build a reader document from presentation fields, never executionPrompt,
  // raw markdown, source IDs, revisions, fingerprints or request metadata.
  const documentText = [
    `# ${title}`,
    summary,
    ...sections.map((section) => `## ${section.title}\n\n${section.content}`),
    report?.tasks.length
      ? `## 建议步骤\n\n${report.tasks.map((task, index) => `${index + 1}. ${task.title}\n${task.instructions}${task.acceptance.length ? `\n检查要点：${task.acceptance.join("；")}` : ""}`).join("\n\n")}`
      : "",
    report?.risks.length
      ? `## 风险与取舍\n\n${report.risks.map((risk) => `- ${risk}`).join("\n")}`
      : "",
    unresolved.length
      ? `## 待确认事项\n\n${unresolved.map((value) => `- ${value}`).join("\n")}`
      : "",
    report?.acceptance.length
      ? `## 检查要点\n\n${report.acceptance.map((value) => `- ${value}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(documentText);
      setCopyMessage("已复制分析");
    } catch {
      setCopyMessage("复制失败，可下载分析。");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([documentText], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "项目分析.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const adopt = async () => {
    if (
      !report ||
      submitting.current ||
      adopting ||
      controller.pendingAction ||
      controller.unknownRequest ||
      !session.capabilities.canConfirm ||
      outdated
    )
      return;
    submitting.current = true;
    setAdopting(true);
    try {
      await controller.act({
        kind: "confirm",
        reportId: report.id,
        fingerprint: report.fingerprint,
      });
    } finally {
      submitting.current = false;
      setAdopting(false);
    }
  };
  return (
    <dialog
      className="p-report"
      ref={dialog}
      aria-labelledby="planning-report-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="p-report-toolbar">
        <div>
          <FileText size={16} />
          <span>{outdated ? "分析待更新" : confirmed ? "已采用的分析" : "项目分析"}</span>
        </div>
        <div>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!documentText}
            aria-label="复制分析"
          >
            <Copy size={16} />
          </button>
          <button type="button" onClick={download} disabled={!documentText} aria-label="下载分析">
            <Download size={16} />
          </button>
          <button type="button" onClick={() => close()} aria-label="收起分析">
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="p-report-scroll">
        {confirmed && !outdated && (
          <span className="p-report-seal" aria-label="已采用当前分析">
            已采用
          </span>
        )}
        <h2 id="planning-report-title" data-paper-focus tabIndex={-1}>
          {title}
        </h2>
        <section className="p-report-overview">
          <h3>项目理解</h3>
          <p className="p-report-intro">{summary}</p>
        </section>
        {outdated && <p className="p-inline-error">要求已变化，请先更新这份分析。</p>}
        {sections.map((section, index) => (
          <section className="p-report-section" key={section.id}>
            <h3>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {section.title}
            </h3>
            <div className="p-report-prose">{section.content}</div>
            {section.sources.length > 0 && (
              <details className="p-source-details">
                <summary>参考依据</summary>
                {section.sources.map((source, i) => (
                  <blockquote key={i}>
                    <small>
                      {source.kind === "analysis"
                        ? "分析摘要"
                        : source.kind === "material"
                          ? "参考材料"
                          : "你的原话"}
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
            <h3>建议步骤</h3>
            <ol className="p-report-tasks">
              {report.tasks.map((task) => (
                <li key={task.id}>
                  <h4>{task.title}</h4>
                  <p>{task.instructions}</p>
                  {task.dependsOn.length > 0 && (
                    <small>
                      先完成：
                      {task.dependsOn
                        .map((itemId) => report.tasks.find((entry) => entry.id === itemId)?.title)
                        .filter(Boolean)
                        .join("、")}
                    </small>
                  )}
                  {task.acceptance.length > 0 && (
                    <ul>
                      {task.acceptance.map((value, index) => (
                        <li key={index}>{value}</li>
                      ))}
                    </ul>
                  )}
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
        {unresolved.length > 0 && (
          <section className="p-report-section p-report-uncertainties">
            <h3>待确认事项</h3>
            <ul>
              {unresolved.map((value, index) => (
                <li key={index}>{value}</li>
              ))}
            </ul>
          </section>
        )}
        {!!report?.acceptance.length && (
          <section className="p-report-section">
            <h3>检查要点</h3>
            <ul>
              {report.acceptance.map((value, index) => (
                <li key={index}>{value}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <footer className="p-report-bottom">
        {copyMessage && <span role="status">{copyMessage}</span>}
        {controller.error && (
          <p className="p-inline-error" role="alert">
            {controller.error}
          </p>
        )}
        {confirmed && !outdated ? (
          <p role="status">
            <Check size={16} />
            已采用，待确认事项仍保留。
          </p>
        ) : (
          <>
            {session.capabilities.canPreview && (outdated || !report) && (
              <button
                type="button"
                className="secondary-button"
                disabled={controller.pendingAction !== null || controller.unknownRequest}
                onClick={() => void controller.act({ kind: "preview" })}
              >
                更新分析
              </button>
            )}
            {controller.unknownRequest ? (
              <button
                type="button"
                className="secondary-button"
                disabled={controller.pendingAction !== null}
                onClick={() => void controller.retryUnknown()}
              >
                <RefreshCw size={14} />
                核对保存状态
              </button>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={
                  !report ||
                  !session.capabilities.canConfirm ||
                  outdated ||
                  adopting ||
                  controller.pendingAction !== null
                }
                onClick={() => void adopt()}
              >
                {adopting || controller.pendingAction === "confirm" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Check size={16} />
                )}
                {adopting || controller.pendingAction === "confirm" ? "保存中" : "采用这份分析"}
              </button>
            )}
            {!session.capabilities.canConfirm && (
              <small>{session.capabilities.reason || "分析完成后可采用。"}</small>
            )}
          </>
        )}
      </footer>
    </dialog>
  );
}
