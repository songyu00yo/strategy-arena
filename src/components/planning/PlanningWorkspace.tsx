"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { PlanningAgentId, PlanningEvent, PlanningQuestion } from "@/lib/planning-contracts";
import type { PlanningController } from "../use-planning";
import { activePlanningQuestion } from "./client-utils";
import { PlanningStage } from "./PlanningStage";
import { QuestionPaper } from "./QuestionPaper";
import { NotePaper } from "./NotePaper";
import { ReportPaper } from "./ReportPaper";

const STATUS = {
  ready: "准备继续",
  working: "分析进行中",
  awaiting_user: "等你回答",
  review_ready: "分析已生成",
  completed: "已采用分析",
  paused: "已暂停",
  failed: "当前步骤未完成",
  uncertain: "正在核对结果",
};
const ITEM_STATUS = {
  open: "信息待补",
  proposed: "AI 分析",
  confirmed: "已明确",
  needs_review: "待核对",
  deferred: "暂缓",
  not_applicable: "不适用",
};
const DIMENSION = {
  function: "功能",
  content: "内容",
  flow: "流程",
  style: "风格",
  constraints: "条件",
  delivery: "制作",
};
const COVERAGE = {
  goal: "目标与范围",
  resources: "资源与能力",
  time_cost: "时间与成本",
  constraints: "限制条件",
  risks: "主要风险",
  implementation: "制作路径",
  mvp: "最小可做版本",
};
const PHASES = [
  { id: "understanding", label: "理解想法" },
  { id: "clarifying", label: "澄清关键项" },
  { id: "feasibility", label: "可行性分析" },
  { id: "production", label: "制作路径" },
  { id: "synthesizing", label: "归纳与查漏" },
  { id: "report", label: "分析与指引" },
] as const;
const CONCLUSION = {
  feasible: "可行",
  conditional: "有条件可行",
  infeasible: "当前条件下不可行",
  insufficient_information: "信息不足",
};
const EVENT_KIND: Record<PlanningEvent["kind"], string> = {
  session_created: "开始",
  session_upgraded: "更新",
  round_started: "新一轮",
  questions_closed: "结束提问",
  agent_started: "分析中",
  agent_completed: "分析完成",
  question_issued: "问题",
  answer_saved: "回答",
  note_saved: "补充",
  requirements_changed: "理解更新",
  review_completed: "查漏",
  report_ready: "分析报告",
  report_confirmed: "已采用",
  paused: "暂停",
  failed: "未完成",
  uncertain: "待核对",
};
const clock = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
const scrollTo = (id: string) =>
  requestAnimationFrame(() =>
    document.getElementById(id)?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      block: "start",
    }),
  );

export function PlanningWorkspace({ controller }: { controller: PlanningController }) {
  const snapshot = controller.snapshot!;
  const session = snapshot.session;
  const progress = session.progress;
  const [question, setQuestion] = useState<PlanningQuestion | null>(null);
  const [continuation, setContinuation] = useState(false);
  const [noteItems, setNoteItems] = useState<string[] | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [actorFilter, setActorFilter] = useState("all");
  const [visibleEvents, setVisibleEvents] = useState(24);
  const [focusedItem, setFocusedItem] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const pendingQuestions = useRef(new Map<string, PlanningQuestion>());
  const deliveredQuestions = useRef(new Set<string>());
  const continueNext = useRef(false);
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const active = session.questions.filter((entry) => entry.status === "active");
  const working = session.status === "working";
  const busy = controller.pendingAction !== null;
  const currentAgent = session.agents.find((agent) => agent.status === "running");
  const questionsClosed =
    progress.endedEarly || !["understanding", "clarifying"].includes(progress.stage);
  const feasibility = session.expertResults
    .filter(
      (entry) =>
        entry.agentId === "D" &&
        entry.round === progress.round &&
        entry.basedOnRevision === session.revision,
    )
    .at(-1);
  const unknownItems = session.items.filter((item) =>
    ["open", "needs_review", "deferred"].includes(item.status),
  );
  const userSources = session.sourceRecords.filter((source) => source.kind !== "analysis");
  const search = query.trim().toLocaleLowerCase();
  const filteredEvents = snapshot.events
    .filter(
      (event) =>
        (actorFilter === "all" ||
          event.actor === actorFilter ||
          event.from === actorFilter ||
          event.to === actorFilter) &&
        (!search || `${event.title} ${event.detail}`.toLocaleLowerCase().includes(search)),
    )
    .slice()
    .reverse();
  const filteredItems = session.items.filter(
    (item) =>
      !search ||
      `${item.title} ${item.description} ${item.reason}`.toLocaleLowerCase().includes(search),
  );
  const arrivals = new Set(controller.arrivals.map((event) => event.id));
  const name = (id: string | null) =>
    id === "user"
      ? "你"
      : id === "system"
        ? "工作台"
        : (session.agents.find((agent) => agent.id === id)?.name ?? id);
  const canResume =
    session.capabilities.canAdvance &&
    (["paused", "failed"].includes(session.status) ||
      controller.blocked ||
      (session.status === "review_ready" && session.nextAction === "advance"));

  useEffect(() => {
    for (const event of controller.arrivals) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      if (event.kind === "question_issued") {
        const incoming = activePlanningQuestion(snapshot, event);
        if (incoming && !deliveredQuestions.current.has(`${incoming.id}:${incoming.version}`))
          pendingQuestions.current.set(`${incoming.id}:${incoming.version}`, incoming);
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
      setContinuation(continueNext.current);
      continueNext.current = false;
      setQuestion(current);
    });
    // A new snapshot may cancel this frame; the queued question is consumed only on display.
    return () => cancelAnimationFrame(frame);
  }, [controller.arrivals, snapshot, session.questions, question, noteItems, reportOpen]);

  const openQuestion = (entry: PlanningQuestion, next = false) => {
    const key = `${entry.id}:${entry.version}`;
    deliveredQuestions.current.add(key);
    pendingQuestions.current.delete(key);
    continueNext.current = false;
    setContinuation(next);
    setQuestion(entry);
  };
  const closeQuestion = () => {
    const previous =
      question &&
      sessionRef.current.questions.find(
        (entry) => entry.id === question.id && entry.version === question.version,
      );
    const answered = previous?.status === "answered";
    const next = answered
      ? sessionRef.current.questions.find((entry) => entry.status === "active")
      : null;
    // The saved paper remains mounted until its receipt has completed.
    if (next) openQuestion(next, true);
    else {
      if (!answered) {
        // Putting a question away returns to the desk, including when B issued a batch.
        // These questions stay available in the margin without immediately reopening.
        pendingQuestions.current.clear();
        for (const entry of sessionRef.current.questions) {
          if (entry.status === "active")
            deliveredQuestions.current.add(`${entry.id}:${entry.version}`);
        }
      }
      continueNext.current = answered;
      setQuestion(null);
    }
  };
  const preview = async () => {
    if (!session.capabilities.canPreview || busy) return;
    // This starts real D → E → C work. Do not open a blank report while it is running.
    const result = await controller.act({ kind: "preview" });
    if (result?.session.report && result.session.progress.stage === "report") setReportOpen(true);
  };
  const inspectItem = (id: string) => {
    setQuery("");
    setFocusedItem(id);
    requestAnimationFrame(() => {
      const item = document.getElementById(`planning-item-${id}`);
      item?.setAttribute("open", "");
      item?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        block: "center",
      });
    });
  };
  const inspectAgent = (id: PlanningAgentId) => {
    setQuery("");
    setActorFilter(id);
    setVisibleEvents(24);
    scrollTo("planning-archive");
  };

  return (
    <main id="main" className="p-workspace" data-motion-origin="story">
      <section className="p-work-heading">
        <div className="p-project-heading">
          <p className="p-eyebrow">
            <span className={`p-status-dot is-${session.status}`} />
            {STATUS[session.status]}
            <span className="p-revision">第 {progress.round} 轮</span>
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
            <MessageSquarePlus size={14} />
            补充
          </button>
          {session.report && progress.stage === "report" ? (
            <button type="button" className="primary-button" onClick={() => setReportOpen(true)}>
              <FileText size={14} />
              查看分析
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={!session.capabilities.canPreview || busy || controller.unknownRequest}
              onClick={() => void preview()}
            >
              {controller.pendingAction === "preview" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <FileText size={14} />
              )}
              现在生成分析
            </button>
          )}
        </div>
      </section>
      <section className="p-progress-sheet" aria-label="分析进展">
        <ol className="p-phase-track" aria-label="当前阶段">
          {PHASES.map((phase, index) => (
            <li
              key={phase.id}
              className={progress.stage === phase.id ? "is-current" : ""}
              aria-current={progress.stage === phase.id ? "step" : undefined}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{phase.label}</strong>
              {progress.stage === phase.id && working && <i className="p-phase-pulse" />}
            </li>
          ))}
        </ol>
        <div
          className={`p-question-budget ${questionsClosed ? "is-closed" : ""}`}
          aria-label={`第${progress.round}轮，已回答${progress.questionsAnswered}题，上限${progress.questionLimit}题`}
        >
          <div>
            <span>本轮问答</span>
            <strong>
              {progress.questionsAnswered}
              <small> / {progress.questionLimit}</small>
            </strong>
            <span>
              {questionsClosed
                ? "提问已结束"
                : `待答 ${progress.activeQuestions} · 尚可问 ${progress.questionSlotsRemaining}`}
            </span>
          </div>
          <div className="p-budget-marks" aria-hidden="true">
            {Array.from({ length: progress.questionLimit }, (_, index) => (
              <i
                key={index}
                className={
                  index < progress.questionsAnswered
                    ? "is-answered"
                    : index < progress.questionsAnswered + progress.activeQuestions
                      ? "is-pending"
                      : ""
                }
              />
            ))}
          </div>
        </div>
      </section>
      {(controller.error ||
        controller.connectionError ||
        session.error ||
        controller.unknownRequest) && (
        <div className="p-work-notice" role="alert">
          <div>
            <strong>
              {controller.unknownRequest ? "正在核对上次操作，内容已保留。" : "当前操作未完成。"}
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
              <RefreshCw size={13} />
              刷新状态
            </button>
            {controller.unknownRequest && (
              <button
                type="button"
                className="text-button"
                onClick={() => void controller.retryUnknown()}
                disabled={busy || working || session.status === "uncertain"}
              >
                检查上次结果
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
          onInspectItem={inspectItem}
          onInspectAgent={inspectAgent}
        />
        <aside className="p-desk-rail" aria-label="项目概览">
          <div className="p-rail-heading">
            <span className="p-section-number">02</span>
            <h2>案头记录</h2>
          </div>
          <section className={`p-next-action ${active.length ? "needs-you" : ""}`}>
            <div className="p-rail-section-label">
              <span>{active.length ? "需要你的判断" : working ? "当前工作" : "下一步"}</span>
              {working && <LoaderCircle size={12} className="spin" />}
            </div>
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
                    <ArrowUpRight size={13} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="p-next-copy">
                {currentAgent?.taskLabel ||
                  (session.report
                    ? "分析与制作指引已整理好。"
                    : questionsClosed
                      ? "正在整理可行性分析和制作指引。"
                      : "根据你的想法，梳理影响项目的关键条件。")}
              </p>
            )}
            {!questionsClosed && (
              <p className="p-budget-note">
                本轮最多 {progress.questionLimit} 题，也可以随时生成分析。
              </p>
            )}
            {canResume && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || controller.unknownRequest}
                onClick={() => void controller.act({ kind: "advance" })}
              >
                <Play size={13} />
                继续分析
              </button>
            )}
            {session.capabilities.canStartRound && (
              <button
                type="button"
                className="secondary-button p-extend-round"
                disabled={busy || controller.unknownRequest}
                onClick={() => void controller.act({ kind: "start_round" })}
              >
                <Plus size={13} />
                再问 3 题
              </button>
            )}
            {session.capabilities.canStop && (
              <button
                type="button"
                className="p-pause-link"
                onClick={() => void controller.act({ kind: "stop" })}
                disabled={controller.stopPending}
              >
                <Pause size={11} />
                {controller.stopPending ? "正在暂停" : "暂停后续分析"}
              </button>
            )}
          </section>
          <section className="p-feasibility-slip">
            <div className="p-rail-section-label">
              <span>可行性结论</span>
              <span>D</span>
            </div>
            <strong className={feasibility ? `is-${feasibility.conclusion}` : "is-unassessed"}>
              {feasibility ? CONCLUSION[feasibility.conclusion] : "尚未评估"}
            </strong>
            {feasibility ? (
              <p>
                {feasibility.unknowns[0] ||
                  feasibility.risks[0] ||
                  feasibility.nextSteps[0] ||
                  "依据本轮已有资料得出。"}
              </p>
            ) : (
              <p>问题结束后，结合资源、成本与风险评估。</p>
            )}
          </section>
          <section className="p-coverage-sheet">
            <div className="p-rail-section-label">
              <span>项目要点</span>
              <span>{session.items.length} 项事项</span>
            </div>
            <div className="p-coverage-list">
              {progress.coverage.map((entry) => (
                <details
                  key={entry.area}
                  className={`is-${entry.assessedBy ? entry.status : "unassessed"}`}
                >
                  <summary>
                    <i />
                    <strong>{COVERAGE[entry.area]}</strong>
                    <span>
                      {!entry.assessedBy
                        ? "未分析"
                        : entry.status === "covered"
                          ? "已有依据"
                          : entry.status === "partial"
                            ? "部分明确"
                            : "待核对"}
                    </span>
                    <ChevronDown size={10} />
                  </summary>
                  <p>{entry.reason || "尚无分析依据。"}</p>
                  {entry.itemIds.length > 0 && (
                    <div>
                      {entry.itemIds.map((id) => {
                        const item = session.items.find((value) => value.id === id);
                        return item ? (
                          <button key={id} type="button" onClick={() => inspectItem(id)}>
                            {item.title}
                            <ArrowUpRight size={10} />
                          </button>
                        ) : null;
                      })}
                    </div>
                  )}
                </details>
              ))}
            </div>
          </section>
          <div className="p-rail-foot">
            <span>
              关键事项 <b>{session.items.length}</b>
            </span>
            <button type="button" onClick={() => scrollTo("planning-ledger")}>
              待核对 <b>{unknownItems.length}</b>
              <ArrowUpRight size={11} />
            </button>
          </div>
        </aside>
      </div>
      <section id="planning-archive" className="p-archive" aria-label="项目档案">
        <header className="p-archive-heading">
          <div>
            <span className="p-section-number">03</span>
            <h2>项目档案</h2>
            <span className="p-small-label">过程、依据与变化</span>
          </div>
          <label className="p-archive-search">
            <Search size={13} />
            <span className="sr-only">查找记录和事项</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleEvents(24);
              }}
              placeholder="查找记录和事项"
            />
          </label>
        </header>
        <div className="p-archive-columns">
          <section className="p-logbook" aria-label="工作时间日志">
            <header className="p-archive-subheading">
              <h3>
                工作日志 <span>{filteredEvents.length}</span>
              </h3>
              <label>
                <span className="sr-only">按角色筛选日志</span>
                <select
                  aria-label="按角色筛选日志"
                  value={actorFilter}
                  onChange={(event) => {
                    setActorFilter(event.target.value);
                    setVisibleEvents(24);
                  }}
                >
                  <option value="all">全部角色</option>
                  {session.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                  <option value="user">我的回答与补充</option>
                  <option value="system">工作台</option>
                </select>
              </label>
            </header>
            <div className="p-log-column-head" aria-hidden="true">
              <span>时间</span>
              <span>来源</span>
              <span>记录</span>
            </div>
            <ol className="p-log-list">
              {filteredEvents.slice(0, visibleEvents).map((event) => (
                <li key={event.id}>
                  <details
                    className={`p-log-entry is-${event.kind} ${arrivals.has(event.id) ? "is-new" : ""}`}
                  >
                    <summary>
                      <time dateTime={event.createdAt}>{clock(event.createdAt)}</time>
                      <span
                        className={`p-log-actor actor-${event.actor}`}
                        title={name(event.actor) ?? ""}
                      >
                        {event.actor === "user"
                          ? "你"
                          : event.actor === "system"
                            ? "工作台"
                            : event.actor}
                      </span>
                      <div className="p-log-summary">
                        <strong>{event.title}</strong>
                        {event.detail && <span>{event.detail}</span>}
                      </div>
                      <span className="p-log-kind">{EVENT_KIND[event.kind]}</span>
                      <ChevronDown size={12} />
                    </summary>
                    <div className="p-log-detail">
                      {event.from && event.to && event.from !== event.to && (
                        <p className="p-log-route">
                          <span>{name(event.from)}</span>
                          <ArrowRight size={12} />
                          <span>{name(event.to)}</span>
                        </p>
                      )}
                      {event.detail && <p>{event.detail}</p>}
                      {event.itemIds.length > 0 && (
                        <div className="p-log-references">
                          {event.itemIds.map((id) => {
                            const item = session.items.find((entry) => entry.id === id);
                            return item ? (
                              <button type="button" key={id} onClick={() => inspectItem(id)}>
                                {item.title}
                                <ArrowUpRight size={10} />
                              </button>
                            ) : null;
                          })}
                        </div>
                      )}
                      {event.kind === "answer_saved" && (
                        <span className="p-saved-record">
                          <Check size={11} />
                          回答已保存
                        </span>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
            {!filteredEvents.length && (
              <p className="p-empty-record">
                {search || actorFilter !== "all" ? "没有找到匹配的记录。" : "尚无工作记录。"}
              </p>
            )}
            {filteredEvents.length > visibleEvents && (
              <button
                type="button"
                className="p-more-records"
                onClick={() => setVisibleEvents((value) => value + 24)}
              >
                再展开 {Math.min(24, filteredEvents.length - visibleEvents)} 条
                <ChevronDown size={12} />
              </button>
            )}
          </section>
          <section id="planning-ledger" className="p-item-ledger" aria-label="关键事项">
            <header className="p-archive-subheading">
              <h3>
                关键事项 <span>{filteredItems.length}</span>
              </h3>
              <span>区分事实、建议与未知</span>
            </header>
            <div className="p-item-list">
              {filteredItems.map((item) => (
                <details
                  id={`planning-item-${item.id}`}
                  key={item.id}
                  className={`p-item-sheet is-${item.status} ${focusedItem === item.id ? "is-focused" : ""}`}
                >
                  <summary>
                    <span className="p-item-dimension">{DIMENSION[item.dimension]}</span>
                    <strong>{item.title}</strong>
                    <span className="p-item-status">{ITEM_STATUS[item.status]}</span>
                    <ChevronDown size={12} />
                  </summary>
                  <div className="p-item-content">
                    <p>{item.description}</p>
                    {item.reason && <p className="p-item-reason">{item.reason}</p>}
                    {item.dependsOn.length > 0 && (
                      <p className="p-item-dependencies">
                        取决于：
                        {item.dependsOn
                          .map((id) => session.items.find((entry) => entry.id === id)?.title)
                          .filter(Boolean)
                          .join("、")}
                      </p>
                    )}
                    {item.sources.length > 0 && (
                      <div className="p-item-sources">
                        {item.sources.map((source, index) => (
                          <blockquote key={`${source.kind}:${source.id}:${index}`}>
                            <span>
                              {source.kind === "analysis"
                                ? "AI 分析"
                                : source.kind === "material"
                                  ? "参考材料"
                                  : "你的原话"}
                            </span>
                            <p>{source.quote}</p>
                          </blockquote>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="p-inline-link"
                      disabled={!session.capabilities.canAddNote || busy}
                      onClick={() => setNoteItems([item.id])}
                    >
                      补充这项
                      <ArrowUpRight size={11} />
                    </button>
                  </div>
                </details>
              ))}
            </div>
            {!filteredItems.length && (
              <p className="p-empty-record">
                {search ? "没有找到匹配的事项。" : "项目事项将在首次分析后列入。"}
              </p>
            )}
          </section>
        </div>
        {userSources.length > 0 && (
          <details className="p-source-ledger">
            <summary>
              <span>
                你的原话与补充 <b>{userSources.length}</b>
              </span>
              <span>
                查看依据
                <ChevronDown size={12} />
              </span>
            </summary>
            <div>
              {userSources.map((source) => (
                <article key={`${source.kind}:${source.id}`}>
                  <header>
                    <strong>{source.label}</strong>
                    <time dateTime={source.createdAt}>{clock(source.createdAt)}</time>
                  </header>
                  <p>{source.text}</p>
                </article>
              ))}
            </div>
          </details>
        )}
      </section>
      <footer className="p-workspace-footer">
        <span>方案擂台 · 项目分析与制作指引</span>
        <span>
          {new Date(session.updatedAt).toLocaleDateString("zh-CN")} · 最近更新{" "}
          {clock(session.updatedAt)}
        </span>
      </footer>
      {question && (
        <QuestionPaper
          key={`${question.id}:${question.version}`}
          question={question}
          controller={controller}
          continuation={continuation}
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
