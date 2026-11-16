"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import type { PlanningQuestion } from "@/lib/planning-contracts";
import type { PlanningController } from "../use-planning";
import { activePlanningQuestion } from "./client-utils";
import { PlanningStage } from "./PlanningStage";
import { QuestionPaper } from "./QuestionPaper";
import { NotePaper } from "./NotePaper";
import { ReportPaper } from "./ReportPaper";

const STATUS = {
  ready: "准备继续",
  working: "正在共同拟定",
  awaiting_user: "轮到你定夺",
  review_ready: "请审阅方案",
  completed: "方案已确认",
  paused: "已暂停",
  failed: "需要处理",
  uncertain: "结果待核对",
};
const ITEM_STATUS = {
  open: "尚未明确",
  proposed: "AI 提议",
  confirmed: "你的决定",
  needs_review: "需要重看",
  deferred: "暂缓",
  not_applicable: "不适用",
};
const DIMENSION = {
  function: "功能",
  content: "内容",
  flow: "流程",
  style: "风格",
  constraints: "条件",
  delivery: "交付",
};

export function PlanningWorkspace({ controller }: { controller: PlanningController }) {
  const snapshot = controller.snapshot!;
  const session = snapshot.session;
  const [question, setQuestion] = useState<PlanningQuestion | null>(null);
  const [noteItems, setNoteItems] = useState<string[] | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const seen = useRef(new Set<string>());
  const pendingQuestions = useRef(new Map<string, PlanningQuestion>());
  const deliveredQuestions = useRef(new Set<string>());
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const active = session.questions.filter((entry) => entry.status === "active");
  const unresolved = session.items.filter((item) =>
    ["open", "needs_review", "proposed"].includes(item.status),
  );
  const decided = session.items.filter((item) => item.status === "confirmed").length;
  const latestEvent = snapshot.events.at(-1);
  const working = session.status === "working";
  const busy = controller.pendingAction !== null;

  useEffect(() => {
    for (const event of controller.arrivals) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      if (event.kind === "question_issued") {
        const incoming = activePlanningQuestion(snapshot, event);
        if (incoming && !deliveredQuestions.current.has(`${incoming.id}:${incoming.version}`)) {
          pendingQuestions.current.set(`${incoming.id}:${incoming.version}`, incoming);
        }
      }
    }
    for (const [key, candidate] of pendingQuestions.current) {
      if (
        !session.questions.some(
          (entry) =>
            entry.id === candidate.id &&
            entry.version === candidate.version &&
            entry.status === "active",
        )
      )
        pendingQuestions.current.delete(key);
    }
    if (question || noteItems !== null || reportOpen) return;
    const selected = pendingQuestions.current.values().next().value as PlanningQuestion | undefined;
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      const current = sessionRef.current.questions.find(
        (entry) =>
          entry.id === selected.id &&
          entry.version === selected.version &&
          entry.status === "active",
      );
      if (!current) return;
      const key = `${current.id}:${current.version}`;
      pendingQuestions.current.delete(key);
      deliveredQuestions.current.add(key);
      setQuestion(current);
    });
    // A refreshed snapshot may cancel this frame; the queued question survives it.
    return () => cancelAnimationFrame(frame);
  }, [controller.arrivals, snapshot, session.questions, question, noteItems, reportOpen]);

  const openQuestion = (entry: PlanningQuestion) => {
    const key = `${entry.id}:${entry.version}`;
    deliveredQuestions.current.add(key);
    pendingQuestions.current.delete(key);
    setQuestion(entry);
  };

  const closeQuestion = () => {
    const previous =
      question &&
      sessionRef.current.questions.find(
        (entry) => entry.id === question.id && entry.version === question.version,
      );
    // Keep the submitted paper mounted until its return flight completes. A manually
    // closed active question stays available on the shelf, without reopening itself.
    const next =
      previous?.status === "answered"
        ? sessionRef.current.questions.find((entry) => entry.status === "active")
        : null;
    if (next) openQuestion(next);
    else setQuestion(null);
  };
  const preview = async () => {
    if (session.report || session.draft) setReportOpen(true);
    if (session.capabilities.canPreview && !busy) {
      const result = await controller.act({ kind: "preview" });
      if (result) setReportOpen(true);
    }
  };

  return (
    <main id="main" className="p-workspace c-root" data-motion-origin="story">
      <section className="p-work-heading">
        <div>
          <p className="p-eyebrow">
            <span className={`p-status-dot is-${session.status}`} />
            {STATUS[session.status]}
            <span className="p-revision">第 {session.revision + 1} 稿</span>
          </p>
          <h1>{session.goal}</h1>
        </div>
        <div className="p-work-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!session.capabilities.canAddNote || busy}
            onClick={() => setNoteItems([])}
          >
            <MessageSquarePlus size={15} />
            补充或纠正
          </button>
          <button
            type="button"
            className={session.report ? "primary-button" : "secondary-button"}
            disabled={
              (!session.report && !session.draft && !session.capabilities.canPreview) || busy
            }
            onClick={() => (session.report ? setReportOpen(true) : void preview())}
          >
            <FileText size={15} />
            {session.report?.status === "confirmed" ? "打开执行方案" : "看方案"}
          </button>
        </div>
      </section>
      {(controller.error ||
        controller.connectionError ||
        session.error ||
        controller.unknownRequest) && (
        <div className="p-work-notice" role="alert">
          <div>
            <strong>
              {controller.unknownRequest ? "这次请求还在核对，内容已保留。" : "已有内容仍在这里。"}
            </strong>
            <p>{controller.error || controller.connectionError || session.error?.message}</p>
          </div>
          <div>
            <button
              type="button"
              className="text-button"
              onClick={() => void controller.refresh()}
              disabled={controller.refreshing}
            >
              <RefreshCw size={14} />
              核对状态
            </button>
            {controller.unknownRequest && (
              <button
                type="button"
                className="text-button"
                onClick={() => void controller.retryUnknown()}
                disabled={busy || working || session.status === "uncertain"}
              >
                检查原请求结果
              </button>
            )}
          </div>
        </div>
      )}
      <div className="p-desk-layout">
        <PlanningStage
          session={session}
          events={snapshot.events}
          arrivals={controller.arrivals}
          onQuestion={openQuestion}
        />
        <aside className="p-desk-rail">
          <section
            className={`p-next-slip ${active.length ? "needs-you" : ""}`}
            aria-label="接下来"
          >
            <div className="p-slip-rule">
              <span>{active.length ? "递给你的纸" : "此刻"}</span>
              <i />
            </div>
            <span className="p-slip-symbol" aria-hidden="true">
              {active.length ? "？" : session.status === "completed" ? "印" : "拟"}
            </span>
            <h2>
              {active.length
                ? "这一步，请你落笔。"
                : session.status === "completed"
                  ? "就从这份方案开始。"
                  : working
                    ? "想法正在被写清。"
                    : session.nextAction === "review"
                      ? "一起看看，还漏了什么。"
                      : "每一个决定，都有来处。"}
            </h2>
            <p>
              {active[0]?.title ||
                session.draft?.summary ||
                latestEvent?.detail ||
                "工作台已经建立。接下来依据你的目标，逐步讨论具体做法。"}
            </p>
            {active.length > 0 ? (
              <div className="p-pending-questions">
                {active.map((entry, index) => (
                  <button
                    type="button"
                    key={`${entry.id}:${entry.version}`}
                    onClick={() => openQuestion(entry)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{entry.title}</strong>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
              </div>
            ) : session.capabilities.canPreview && session.nextAction === "review" ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void preview()}
              >
                <FileText size={15} />
                查漏并整理方案
              </button>
            ) : session.report ? (
              <button type="button" className="primary-button" onClick={() => setReportOpen(true)}>
                展开方案
                <ArrowUpRight size={15} />
              </button>
            ) : null}
            {working && (
              <div className="p-working-label" role="status">
                <LoaderCircle size={14} className="spin" />
                {session.agents.find((agent) => agent.status === "running")?.taskLabel ||
                  "正在执行当前工作"}
              </div>
            )}
            {session.capabilities.canAdvance &&
            (["paused", "failed"].includes(session.status) ||
              controller.blocked ||
              (session.status === "review_ready" && session.nextAction === "advance")) ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || controller.unknownRequest}
                onClick={() => void controller.act({ kind: "advance" })}
              >
                <Play size={14} />
                {session.status === "review_ready" ? "继续补全方案" : "继续下一步"}
              </button>
            ) : null}
          </section>
          <section className="p-mini-ledger">
            <p className="p-eyebrow">已有轮廓</p>
            <dl>
              <div>
                <dt>你已决定</dt>
                <dd>{String(decided).padStart(2, "0")}</dd>
              </div>
              <div>
                <dt>继续讨论</dt>
                <dd>{String(unresolved.length).padStart(2, "0")}</dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() => {
                setLedgerOpen(true);
                requestAnimationFrame(() =>
                  document
                    .getElementById("planning-ledger")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" }),
                );
              }}
            >
              翻看需求底稿
              <ArrowDown size={13} />
            </button>
          </section>
        </aside>
      </div>
      <section className="p-record-band" aria-label="真实工作记录">
        <div className="p-record-heading">
          <div>
            <span className="p-eyebrow">纸面上的来往</span>
            <h2>每一步，都留下记录。</h2>
          </div>
          <div className="p-record-controls">
            <span>{snapshot.events.length} 条记录</span>
            {session.capabilities.canStop && (
              <button
                type="button"
                className="text-button"
                onClick={() => void controller.act({ kind: "stop" })}
                disabled={controller.stopPending}
              >
                <Pause size={13} />
                {controller.stopPending ? "正在暂停" : "暂停后续"}
              </button>
            )}
          </div>
        </div>
        <ol className="p-event-deck">
          {snapshot.events.slice(-12).map((event) => (
            <li key={event.id} className={`p-event-paper is-${event.kind}`}>
              <div>
                <span>
                  {event.from && event.to
                    ? `${event.from === "user" ? "你" : event.from} → ${event.to === "user" ? "你" : event.to}`
                    : event.actor === "user"
                      ? "你的决定"
                      : event.actor === "system"
                        ? "工作台"
                        : event.actor}
                </span>
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </time>
              </div>
              <strong>{event.title}</strong>
              <p>{event.detail}</p>
              {event.kind === "answer_saved" && <Check size={14} className="p-event-check" />}
            </li>
          ))}
        </ol>
      </section>
      <section id="planning-ledger" className={`p-ledger ${ledgerOpen ? "is-open" : ""}`}>
        <button
          type="button"
          className="p-ledger-heading"
          aria-expanded={ledgerOpen}
          onClick={() => setLedgerOpen(!ledgerOpen)}
        >
          <span>
            <span className="p-eyebrow">随讨论变化的底稿</span>
            <strong>已经想清楚的，和还没定下的。</strong>
          </span>
          <span>
            {session.items.length} 项<ArrowDown size={18} />
          </span>
        </button>
        {ledgerOpen && (
          <div className="p-ledger-body">
            {session.items.length ? (
              session.items.map((item) => (
                <article key={item.id} className={`p-item is-${item.status}`}>
                  <header>
                    <small>{DIMENSION[item.dimension]}</small>
                    <span>{ITEM_STATUS[item.status]}</span>
                  </header>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                  {item.reason && <p className="p-item-reason">{item.reason}</p>}
                  {item.dependsOn.length > 0 && (
                    <small>
                      取决于：
                      {item.dependsOn
                        .map((id) => session.items.find((entry) => entry.id === id)?.title ?? id)
                        .join("、")}
                    </small>
                  )}
                  {item.sources.length > 0 && (
                    <details className="p-source-details">
                      <summary>依据与原话</summary>
                      {item.sources.map((source, index) => (
                        <blockquote key={`${source.kind}:${source.id}:${index}`}>
                          <small>
                            {source.kind === "analysis"
                              ? "AI 分析"
                              : source.kind === "material"
                                ? "参考材料"
                                : "用户原话"}
                          </small>
                          {source.quote}
                        </blockquote>
                      ))}
                    </details>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={!session.capabilities.canAddNote || busy}
                    onClick={() => setNoteItems([item.id])}
                  >
                    这项我想补充
                    <ArrowUpRight size={13} />
                  </button>
                </article>
              ))
            ) : (
              <p className="p-empty-ledger">尚未形成需求事项。这里不会预填替你作出的决定。</p>
            )}
          </div>
        )}
      </section>
      {question && (
        <QuestionPaper
          key={`${question.id}:${question.version}`}
          question={question}
          controller={controller}
          onClose={closeQuestion}
        />
      )}
      {noteItems !== null && (
        <NotePaper controller={controller} itemIds={noteItems} onClose={() => setNoteItems(null)} />
      )}
      {reportOpen && <ReportPaper controller={controller} onClose={() => setReportOpen(false)} />}
    </main>
  );
}
