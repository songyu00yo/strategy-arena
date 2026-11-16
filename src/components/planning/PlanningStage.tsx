"use client";

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { ArrowUpRight, Check, Feather, LoaderCircle } from "lucide-react";
import type { PlanningEvent, PlanningQuestion, PlanningSession } from "@/lib/planning-contracts";
import { PLANNING_AGENT_IDS } from "@/lib/planning-contracts";
import { createMotionLoop, createMotionScope, useReducedMotion } from "../console/motion-runtime";
import { flyLight, ROUTE_COLOR } from "../console/effects";
import { agentPaperAnchor } from "./paper-motion";

const STATUS = {
  idle: "尚未开始",
  queued: "等待交接",
  running: "正在工作",
  awaiting_user: "等你定夺",
  completed: "已完成这一步",
  failed: "这一步未完成",
  uncertain: "结果待核对",
};

export function PlanningStage({
  session,
  events,
  arrivals,
  onQuestion,
}: {
  session: PlanningSession;
  events: PlanningEvent[];
  arrivals: PlanningEvent[];
  onQuestion: (question: PlanningQuestion) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const live = useRef(session.agents);
  const wake = useRef<() => void>(() => {});
  const seen = useRef(new Set<string>());
  useLayoutEffect(() => {
    live.current = session.agents;
  }, [session.agents]);

  useLayoutEffect(() => {
    const scope = createMotionScope("interaction");
    if (!reduce)
      root.current?.querySelectorAll<HTMLElement>(".p-board-slot").forEach((board, index) => {
        scope.animate(
          board,
          [
            {
              transform: `translate(${(index - 1) * 42}px,48px) rotate(${(index - 1) * 5}deg) scale(.91)`,
              opacity: 0,
            },
            { transform: "translate(0,-4px) rotate(0deg) scale(1)", opacity: 1, offset: 0.76 },
            { transform: "none", opacity: 1 },
          ],
          {
            duration: 1150,
            delay: index * 140,
            easing: "cubic-bezier(.19,1,.22,1)",
            fill: "backwards",
          },
        );
      });
    return () => scope.dispose();
  }, [reduce]);

  useEffect(() => {
    const nodes = PLANNING_AGENT_IDS.map((id) =>
      root.current?.querySelector<HTMLElement>(`[data-planning-agent="${id}"]`),
    );
    if (reduce) {
      nodes.forEach((node) => {
        if (node) node.style.transform = "none";
      });
      return;
    }
    const bodies = PLANNING_AGENT_IDS.map(() => ({ y: 0, v: 0, z: 0, vz: 0 }));
    const loop = createMotionLoop((time, dt) => {
      let moving = false;
      nodes.forEach((node, index) => {
        if (!node) return;
        const active =
          live.current.find((agent) => agent.id === PLANNING_AGENT_IDS[index])?.status ===
          "running";
        const body = bodies[index];
        const target = active ? -10 + Math.sin(time / 1700) * 1.2 : 0;
        body.v += (-42 * (body.y - target) - 12 * body.v) * dt;
        body.y += body.v * dt;
        body.vz += (-38 * (body.z - (active ? 28 : 0)) - 11 * body.vz) * dt;
        body.z += body.vz * dt;
        node.style.transform = `translate3d(0,${body.y}px,${body.z}px) rotateY(${index === 0 ? 2 : index === 2 ? -2 : 0}deg)`;
        if (active || Math.abs(body.v) + Math.abs(body.vz) > 0.015) moving = true;
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
    const cleanup: (() => void)[] = [];
    for (const event of arrivals) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      if (
        !event.from ||
        !event.to ||
        event.from === event.to ||
        !["A", "B", "C"].includes(event.from) ||
        !["A", "B", "C"].includes(event.to)
      )
        continue;
      const from = agentPaperAnchor(event.from),
        to = agentPaperAnchor(event.to);
      if (from && to)
        cleanup.push(
          flyLight(
            from.getBoundingClientRect(),
            to.getBoundingClientRect(),
            ROUTE_COLOR[event.from] ?? "38,69,122",
            780,
          ),
        );
    }
    return () => cleanup.forEach((dispose) => dispose());
  }, [arrivals]);

  return (
    <div className="p-stage" ref={root} aria-label="多 Agent 工作台">
      <div className="p-stage-rule" aria-hidden="true">
        <span>观点在这里交接，决定由你落笔。</span>
      </div>
      <div className="p-paper-world">
        {PLANNING_AGENT_IDS.map((id, index) => {
          const agent = session.agents.find((entry) => entry.id === id);
          const question = session.questions.find(
            (entry) => entry.status === "active" && entry.askedBy === id,
          );
          const recent = events
            .filter(
              (event) =>
                event.actor === id && !["agent_started", "session_created"].includes(event.kind),
            )
            .at(-1);
          const running = agent?.status === "running";
          return (
            <div
              className={`p-board-slot p-slot-${id}`}
              key={id}
              style={
                {
                  "--agent-ink": (ROUTE_COLOR[id] ?? "38,69,122").replaceAll(",", " "),
                } as CSSProperties
              }
            >
              <div className="p-under-sheet p-under-one" aria-hidden="true" />
              <div className="p-under-sheet p-under-two" aria-hidden="true" />
              <section
                className={`c-board c-board-${id} p-board ${running ? "speaking" : ""} ${question ? "has-question" : ""}`}
                data-planning-agent={id}
                data-board={id}
                data-status={agent?.status ?? "idle"}
                style={
                  {
                    "--route": (ROUTE_COLOR[id] ?? "38,69,122").replaceAll(",", " "),
                  } as CSSProperties
                }
                aria-label={`${id} · ${agent?.name ?? `Agent ${id}`}`}
              >
                <div className="p-registration" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <header>
                  <b>{id}</b>
                  <span>{agent?.name ?? `Agent ${id}`}</span>
                  <em>{String(index + 1).padStart(2, "0")}</em>
                </header>
                <div className="p-agent-intro">
                  <p>{agent?.responsibility || "等待任务安排"}</p>
                  <span className={`p-agent-status is-${agent?.status ?? "idle"}`}>
                    {running ? (
                      <LoaderCircle size={12} className="spin" />
                    ) : agent?.status === "completed" ? (
                      <Check size={12} />
                    ) : (
                      <i />
                    )}
                    {STATUS[agent?.status ?? "idle"]}
                  </span>
                </div>
                <div className="p-agent-paper" data-paper-origin={id}>
                  <span className="p-paper-tab">
                    {running
                      ? "正在写下"
                      : question
                        ? "待你回复"
                        : recent
                          ? "这一步留下的记录"
                          : "工作手记"}
                  </span>
                  <h3>{agent?.taskLabel || "从你的想法开始"}</h3>
                  {agent?.preview && running ? (
                    <p className="p-live-preview">{agent.preview}</p>
                  ) : agent?.summary ? (
                    <p className="p-agent-summary">{agent.summary}</p>
                  ) : recent ? (
                    <p>{recent.detail || recent.title}</p>
                  ) : (
                    <div className="p-unwritten">
                      <Feather size={24} />
                      <p>尚无产出。实际工作开始后，记录会留在这里。</p>
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                  {running && (
                    <span className="p-writing-rule" aria-hidden="true">
                      <i />
                    </span>
                  )}
                </div>
                <footer>
                  {question ? (
                    <button
                      type="button"
                      className="p-question-link"
                      onClick={() => onQuestion(question)}
                    >
                      <span>有一个问题，请你定夺</span>
                      <ArrowUpRight size={17} />
                    </button>
                  ) : (
                    <>
                      <span>
                        {agent?.finishedAt
                          ? "这一页已留档"
                          : running
                            ? "工作仍在继续"
                            : "保留每一次交接"}
                      </span>
                      <span className="p-ink-mark" aria-hidden="true">
                        {id}
                      </span>
                    </>
                  )}
                </footer>
              </section>
            </div>
          );
        })}
      </div>
      <div className="p-stage-caption">
        <span>
          <i />
          同一份想法，逐步写清。
        </span>
        <span>
          {session.answers.length} 次真实回答 · {session.items.length} 项需求
        </span>
      </div>
    </div>
  );
}
