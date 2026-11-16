"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  LoaderCircle,
} from "lucide-react";
import type {
  PlanningAgentId,
  PlanningEvent,
  PlanningQuestion,
  PlanningSession,
} from "@/lib/planning-contracts";
import { createMotionLoop, createMotionScope, useReducedMotion } from "../console/motion-runtime";
import { flyLight } from "../console/effects";
import { agentPaperAnchor } from "./paper-motion";
import { reportPresentation } from "./report-presentation";

const ORDER = ["A", "B", "D", "E", "C"] as const;
const INK: Record<string, string> = {
  A: "38,69,122",
  B: "177,54,39",
  D: "49,96,78",
  E: "105,77,115",
  C: "151,105,31",
};
const ROLE: Record<string, string> = {
  A: "理解与梳理",
  B: "选择与澄清",
  D: "可行性分析",
  E: "制作路径",
  C: "归纳与查漏",
};
const STATUS = {
  idle: "未开始",
  queued: "等待资料",
  running: "分析中",
  awaiting_user: "等你回答",
  completed: "本次已完成",
  failed: "未完成",
  uncertain: "待核对",
};
const CONCLUSION = {
  feasible: "可行",
  conditional: "有条件可行",
  infeasible: "当前条件下不可行",
  insufficient_information: "信息不足",
};
type Geometry = { width: number; height: number; nodes: Record<string, { x: number; y: number }> };
const clock = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const actorName = (id: string | null, session: PlanningSession) =>
  id === "user"
    ? "你"
    : id === "system"
      ? "工作台"
      : (session.agents.find((agent) => agent.id === id)?.name ?? id);

export function PlanningStage({
  session,
  events,
  arrivals,
  onQuestion,
  onInspectItem,
  onInspectAgent,
}: {
  session: PlanningSession;
  events: PlanningEvent[];
  arrivals: PlanningEvent[];
  onQuestion: (question: PlanningQuestion) => void;
  onInspectItem: (itemId: string) => void;
  onInspectAgent: (agentId: PlanningAgentId) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const live = useRef(session.agents);
  const wake = useRef<() => void>(() => {});
  const seen = useRef(new Set<string>());
  const flights = useRef(new Set<() => void>());
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  useLayoutEffect(() => {
    live.current = session.agents;
  }, [session.agents]);

  useLayoutEffect(() => {
    const scope = createMotionScope("interaction");
    if (!reduce)
      root.current
        ?.querySelectorAll<HTMLElement>(".p-board-slot, .p-manuscript")
        .forEach((board, index) => {
          scope.animate(
            board,
            [
              {
                transform: `translateY(${22 + index * 3}px) rotate(${index % 2 ? 1 : -1}deg) scale(.982)`,
                opacity: 0,
              },
              { transform: "translateY(-1px) rotate(0deg) scale(1)", opacity: 1, offset: 0.82 },
              { transform: "none", opacity: 1 },
            ],
            {
              duration: 920,
              delay: index * 64,
              easing: "cubic-bezier(.16,1,.3,1)",
              fill: "backwards",
            },
          );
        });
    return () => scope.dispose();
  }, [reduce]);

  useEffect(() => {
    const host = world.current;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = host.getBoundingClientRect();
        const nodes: Geometry["nodes"] = {};
        host.querySelectorAll<HTMLElement>("[data-planning-agent]").forEach((node) => {
          const slot = node.closest<HTMLElement>(".p-board-slot");
          nodes[node.dataset.planningAgent!] = {
            // Layout coordinates stay stable while the papers enter and gently move.
            x: (slot?.offsetLeft ?? node.offsetLeft) + node.offsetWidth / 2,
            y: (slot?.offsetTop ?? node.offsetTop) + node.offsetHeight / 2,
          };
        });
        setGeometry({ width: box.width, height: box.height, nodes });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const nodes = ORDER.map((id) =>
      root.current?.querySelector<HTMLElement>(`[data-planning-agent="${id}"]`),
    );
    if (reduce) {
      nodes.forEach((node) => {
        if (node) node.style.transform = "none";
      });
      return;
    }
    const bodies = ORDER.map(() => ({ y: 0, v: 0 }));
    const loop = createMotionLoop((time, dt) => {
      let moving = false;
      nodes.forEach((node, index) => {
        if (!node) return;
        const running =
          live.current.find((agent) => agent.id === ORDER[index])?.status === "running";
        const body = bodies[index];
        const target = running ? -2.6 + Math.sin(time / 1900) * 0.55 : 0;
        body.v += (-44 * (body.y - target) - 13 * body.v) * dt;
        body.y += body.v * dt;
        node.style.transform = `translate3d(0,${body.y}px,0) rotateY(${index % 3 === 0 ? 0.35 : index % 3 === 2 ? -0.35 : 0}deg)`;
        if (running || Math.abs(body.v) > 0.015) moving = true;
      });
      return moving;
    });
    wake.current = loop.wake;
    return () => {
      loop.dispose();
      wake.current = () => {};
    };
  }, [reduce]);
  useEffect(() => {
    wake.current();
  }, [session.agents]);

  useEffect(() => {
    for (const event of arrivals) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      if (!event.from || !event.to || event.from === event.to || !INK[event.from] || !INK[event.to])
        continue;
      const from = agentPaperAnchor(event.from),
        to = agentPaperAnchor(event.to);
      if (!from || !to || reduce) continue;
      const release = flyLight(
        from.getBoundingClientRect(),
        to.getBoundingClientRect(),
        INK[event.from],
        1100,
      );
      // Polling must not cancel a handoff that has already begun.
      const timer = setTimeout(() => {
        release();
        flights.current.delete(dispose);
      }, 1400);
      const dispose = () => {
        clearTimeout(timer);
        release();
      };
      flights.current.add(dispose);
    }
  }, [arrivals, reduce]);
  useEffect(() => {
    const current = flights.current;
    return () => {
      current.forEach((dispose) => dispose());
      current.clear();
    };
  }, []);

  const exchanges = events.filter(
    (event) =>
      event.from && event.to && event.from !== event.to && INK[event.from] && INK[event.to],
  );
  const latestExchange = exchanges.at(-1);
  const edges = [
    ...new Map(exchanges.map((event) => [`${event.from}:${event.to}`, event])).values(),
  ].slice(-8);
  const currentReport =
    session.report?.basedOnRevision === session.revision ? session.report : null;
  const latestDraft =
    currentReport || session.draft ? reportPresentation(currentReport, session.draft) : null;
  const activeAgent = session.agents.find((agent) => agent.status === "running");

  return (
    <section className="p-stage" ref={root} aria-label="多 Agent 工作台">
      <div className="p-stage-heading">
        <div>
          <span className="p-section-number">01</span>
          <h2>项目分析室</h2>
          <span className="p-small-label">五个视角 · 同一份项目资料</span>
        </div>
        {session.status === "working" && activeAgent ? (
          <button
            type="button"
            className="p-live-legend p-current-agent-link"
            aria-label={`查看正在分析的${activeAgent.name}`}
            onClick={() => {
              const paper = root.current?.querySelector<HTMLElement>(
                `[data-planning-agent="${activeAgent.id}"]`,
              );
              paper?.focus({ preventScroll: true });
              paper?.scrollIntoView({ behavior: reduce ? "instant" : "smooth", block: "center" });
            }}
          >
            <i className="is-live" />
            正在分析 · {activeAgent.id}
            <ArrowDownRight size={11} />
          </button>
        ) : (
          <span className="p-live-legend">
            <i />工作记录
          </span>
        )}
      </div>
      <div className="p-collaboration-strip" aria-label="最近协作">
        <span className="p-strip-label">最近交接</span>
        {latestExchange ? (
          <>
            <b>{actorName(latestExchange.from, session)}</b>
            <ArrowRight size={13} />
            <b>{actorName(latestExchange.to, session)}</b>
            <span className="p-exchange-title">{latestExchange.title}</span>
            <time dateTime={latestExchange.createdAt}>{clock(latestExchange.createdAt)}</time>
          </>
        ) : (
          <>
            <span className="p-exchange-title">
              {session.agents.find((agent) => agent.status === "running")?.taskLabel ||
                "已收到你的想法"}
            </span>
            <span className="p-strip-note">理解 → 澄清 → 可行性 → 制作路径 → 汇总</span>
          </>
        )}
      </div>
      <div className="p-paper-world" ref={world}>
        {geometry && (
          <svg
            className="p-collaboration-lines"
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {edges.map((event) => {
              const from = geometry.nodes[event.from!],
                to = geometry.nodes[event.to!];
              if (!from || !to) return null;
              const middle = (from.y + to.y) / 2;
              const path =
                Math.abs(from.y - to.y) < 80
                  ? `M ${from.x} ${from.y} L ${to.x} ${to.y}`
                  : `M ${from.x} ${from.y} C ${from.x} ${middle}, ${to.x} ${middle}, ${to.x} ${to.y}`;
              const running =
                event.id === latestExchange?.id &&
                session.agents.some((agent) => agent.id === event.to && agent.status === "running");
              return (
                <g key={`${event.from}:${event.to}`} className={running ? "is-live" : ""}>
                  <path d={path} />
                  <path d={path} className="p-link-ink" />
                </g>
              );
            })}
          </svg>
        )}
        {ORDER.map((id, index) => {
          const agent = session.agents.find((entry) => entry.id === id);
          const question = session.questions.find(
            (entry) => entry.status === "active" && entry.askedBy === id,
          );
          const history = events.filter(
            (event) => event.actor === id || event.from === id || event.to === id,
          );
          const records = history
            .filter((event) => event.kind !== "agent_started")
            .slice()
            .reverse();
          const latest = records[0];
          const expert = session.expertResults
            .filter(
              (entry) =>
                entry.agentId === id &&
                entry.round === session.progress.round &&
                entry.basedOnRevision === session.revision,
            )
            .at(-1);
          const itemIds = new Set([
            ...history.flatMap((event) => event.itemIds),
            ...(question?.itemIds ?? []),
            ...(expert?.sections.flatMap((section) => section.itemIds) ?? []),
          ]);
          const items = session.items.filter((item) => itemIds.has(item.id));
          const running = agent?.status === "running";
          const summary = expert?.summary || agent?.summary;
          const preview = running && agent?.preview ? agent.preview : "";
          const output = preview || summary;
          const previousAnalysis = history
            .filter((event) => event.kind === "agent_completed" && event.actor === id)
            .at(-1);
          const olderSummary =
            !!summary && !!previousAnalysis && previousAnalysis.revision < session.revision;
          const sourceCount = new Set(
            items.flatMap((item) => item.sources.map((source) => `${source.kind}:${source.id}`)),
          ).size;
          const count = history.filter(
            (event) => event.kind === "agent_completed" && event.actor === id,
          ).length;
          return (
            <div
              className={`p-board-slot p-slot-${id}`}
              key={id}
              style={{ "--agent-ink": INK[id].replaceAll(",", " ") } as CSSProperties}
            >
              <div className="p-under-sheet p-under-one" aria-hidden="true" />
              <div className="p-under-sheet p-under-two" aria-hidden="true" />
              <section
                className={`p-board ${running ? "speaking" : ""} ${question ? "has-question" : ""}`}
                data-planning-agent={id}
                data-board={id}
                data-status={agent?.status ?? "idle"}
                aria-label={`${id} · ${agent?.name ?? ROLE[id]}`}
                tabIndex={-1}
              >
                <div className="p-registration" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <header className="p-agent-header">
                  <b className="p-agent-letter">{id}</b>
                  <div>
                    <h3>{agent?.name ?? ROLE[id]}</h3>
                    <span>{agent?.responsibility || ROLE[id]}</span>
                  </div>
                  <span className="p-agent-folio">{String(index + 1).padStart(2, "0")}</span>
                </header>
                <div className="p-agent-meta">
                  <span className={`p-agent-status is-${agent?.status ?? "idle"}`}>
                    {running ? (
                      <LoaderCircle size={11} className="spin" />
                    ) : agent?.status === "completed" ? (
                      <Check size={11} />
                    ) : (
                      <i />
                    )}
                    {STATUS[agent?.status ?? "idle"]}
                  </span>
                  <span>
                    {count ? `${count} 次分析` : "等待首份摘要"}
                    {agent?.finishedAt ? ` · ${clock(agent.finishedAt)}` : ""}
                  </span>
                </div>
                <div className="p-agent-paper" data-paper-origin={id}>
                  <div className="p-output-label">
                    <span>
                      {preview ? "当前分析" : olderSummary ? "上一次分析摘要" : "项目理解"}
                    </span>
                    {expert && (
                      <span className={`p-conclusion is-${expert.conclusion}`}>
                        {CONCLUSION[expert.conclusion]}
                      </span>
                    )}
                  </div>
                  {agent?.taskLabel &&
                    agent.taskLabel !== agent.name &&
                    agent.taskLabel !== agent.responsibility && <h4>{agent.taskLabel}</h4>}
                  {output ? (
                    <div
                      className={`p-agent-output ${preview ? "p-live-preview" : ""}`}
                      tabIndex={0}
                      aria-label={`${agent?.name ?? ROLE[id]}的${preview ? "当前输出" : "摘要"}`}
                    >
                      <p>{output}</p>
                    </div>
                  ) : (
                    <p className="p-agent-empty">
                      {running
                        ? "正在分析你的项目。摘要返回后在此更新。"
                        : id === "D"
                          ? "澄清结束后，评估资源、成本与风险。"
                          : id === "E"
                            ? "结合分析，整理可操作的制作步骤。"
                            : id === "C"
                              ? "汇总可行性、制作指引与待核对项。"
                              : "尚无分析结果。"}
                    </p>
                  )}
                  {preview && summary && (
                    <div className="p-prior-summary">
                      <span>上一份摘要</span>
                      <p>{summary}</p>
                    </div>
                  )}
                  {expert?.minimumViableVersion && id === "E" && (
                    <div className="p-agent-findings">
                      <span>最小可做版本</span>
                      <p>{expert.minimumViableVersion}</p>
                    </div>
                  )}
                  {expert && (expert.risks.length > 0 || expert.unknowns.length > 0) && (
                    <div className="p-agent-findings">
                      <span>{expert.risks.length ? "主要风险" : "尚待核对"}</span>
                      <p>{expert.risks[0] || expert.unknowns[0]}</p>
                    </div>
                  )}
                  {running && (
                    <span className="p-writing-rule" aria-hidden="true">
                      <i />
                    </span>
                  )}
                </div>
                {items.length > 0 && (
                  <div className="p-agent-items">
                    <span>相关事项</span>
                    <div>
                      {items.slice(0, 3).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onInspectItem(item.id)}
                          title={item.description}
                        >
                          {item.title}
                          <ArrowUpRight size={10} />
                        </button>
                      ))}
                    </div>
                    {items.length > 3 && <small>另有 {items.length - 3} 项</small>}
                  </div>
                )}
                <section
                  className="p-agent-history"
                  aria-label={`${agent?.name ?? ROLE[id]}的工作记录`}
                >
                  <div className="p-agent-history-heading">
                    <span>
                      最近记录 <b>{history.length}</b>
                    </span>
                    <span>{sourceCount > 0 && `${sourceCount} 份依据`}</span>
                  </div>
                  {records.length ? (
                    <ol className="p-history-recent">
                      {records.slice(0, 2).map((event) => (
                        <li key={event.id}>
                          <time dateTime={event.createdAt}>{clock(event.createdAt)}</time>
                          <strong title={event.detail}>{event.title}</strong>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="p-history-empty">尚无工作记录</p>
                  )}
                  {records.length > 2 && (
                    <details className="p-more-history">
                      <summary>
                        <span>较早的 {records.length - 2} 条记录</span>
                        <ChevronDown size={11} />
                      </summary>
                      <ol>
                        {records.slice(2, 6).map((event) => (
                          <li key={event.id}>
                            <time dateTime={event.createdAt}>{clock(event.createdAt)}</time>
                            <div>
                              <strong>{event.title}</strong>
                              {event.detail && <p>{event.detail}</p>}
                            </div>
                          </li>
                        ))}
                      </ol>
                      {history.length > 6 && (
                        <button
                          type="button"
                          className="p-inline-link"
                          onClick={() => onInspectAgent(id)}
                        >
                          查看全部记录
                          <ArrowUpRight size={11} />
                        </button>
                      )}
                    </details>
                  )}
                </section>
                <footer className="p-agent-footer">
                  {question ? (
                    <button
                      type="button"
                      className="p-question-link"
                      onClick={() => onQuestion(question)}
                    >
                      <span>{question.title}</span>
                      <ArrowUpRight size={14} />
                    </button>
                  ) : (
                    <>
                      <ArrowDownRight size={12} />
                      <span>
                        {latest?.from && latest.to && latest.from !== latest.to
                          ? `${actorName(latest.from, session)} → ${actorName(latest.to, session)}`
                          : items.length
                            ? `关联 ${items.length} 项项目事项`
                            : running
                              ? "接收项目资料，开始分析"
                              : "等待项目资料"}
                      </span>
                    </>
                  )}
                </footer>
              </section>
            </div>
          );
        })}
        <article className="p-manuscript" aria-label="当前项目摘要">
          <header>
            <span className="p-manuscript-mark">摘</span>
            <div>
              <span className="p-small-label">当前项目摘要</span>
              <h3>{latestDraft ? latestDraft.title || "项目分析" : "原始想法"}</h3>
            </div>
            <span className="p-manuscript-state">
              {currentReport
                ? currentReport.status === "confirmed"
                  ? "已采用"
                  : "分析已生成"
                : session.draft
                  ? "整理中"
                  : "已记录"}
            </span>
          </header>
          <div className="p-manuscript-body">
            {latestDraft ? (
              latestDraft.summary && <p>{latestDraft.summary}</p>
            ) : (
              <p>{session.goal}</p>
            )}
            {latestDraft?.sections.length ? (
              <div className="p-manuscript-sections">
                {latestDraft.sections.map((section) => (
                  <details key={section.id}>
                    <summary>
                      <span>{section.title}</span>
                      <ChevronDown size={12} />
                    </summary>
                    <p>{section.content}</p>
                  </details>
                ))}
              </div>
            ) : (
              !latestDraft && (
                <div className="p-manuscript-origin">
                  <span>来自你的原话</span>
                  <time dateTime={session.createdAt}>{clock(session.createdAt)}</time>
                </div>
              )
            )}
            {!!latestDraft?.changes.length && (
              <details className="p-draft-changes">
                <summary>
                  最近一次更新
                  <ChevronDown size={12} />
                </summary>
                {latestDraft.changes.slice(-3).map((change, index) => (
                  <div key={index}>
                    {change.before && <p className="p-change-before">{change.before}</p>}
                    <p>{change.after}</p>
                    <small>{change.reason}</small>
                  </div>
                ))}
              </details>
            )}
          </div>
          <footer>
            <span>{session.items.length} 项关键事项</span>
            <span>
              {session.sourceRecords.filter((source) => source.kind !== "analysis").length}{" "}
              份原始依据
            </span>
          </footer>
        </article>
      </div>
    </section>
  );
}
