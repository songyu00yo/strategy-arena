"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Clock3, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import type { ModelMode } from "@/lib/contracts";
import { DEFAULT_MODEL_ID } from "@/lib/model-catalog";
import { usePlanning } from "../use-planning";
import { ModelSelector } from "../model-selector";
import { GoalFocusStage } from "../goal-focus-stage";
import { AccessGate } from "../access-gate";
import { ClickFx } from "../console/effects";
import { PlanningWorkspace } from "./PlanningWorkspace";
import "../console/console.css";
import "../focused-home.css";
import "../console/paper-console.css";
import "../console/press.css";
import "./planning.css";

const GOAL_KEY = "strategy-arena:planning:goal";

export function PlanningPage() {
  const controller = usePlanning();
  const [goal, setGoal] = useState("");
  const [modelMode, setModelMode] = useState<ModelMode>(DEFAULT_MODEL_ID);
  const [historyOpen, setHistoryOpen] = useState(false);
  const typedModel = useRef(false);
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const providers = controller.health?.model.models ?? controller.health?.model.providers;
  const requiresAccess =
    !!controller.health?.requiresAccessCode && !controller.health?.accessGranted;
  const selectedModel = providers?.find((model) => model.id === modelMode);
  const unavailable = selectedModel
    ? !selectedModel.configured
    : controller.health?.model.configured === false;
  const pending = controller.pendingAction !== null;
  const session = controller.snapshot?.session;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const saved = sessionStorage.getItem(GOAL_KEY);
        if (saved) setGoal(saved);
      } catch {}
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (typedModel.current || !providers) return;
    const selected = providers.find((model) => model.id === DEFAULT_MODEL_ID && model.configured);
    const available = selected ?? providers.find((model) => model.configured);
    if (available) queueMicrotask(() => setModelMode(available.id as ModelMode));
  }, [providers]);

  const create = async () => {
    if (
      goal.trim().length < 2 ||
      pending ||
      controller.restoring ||
      !controller.health ||
      requiresAccess ||
      unavailable ||
      controller.unknownRequest
    )
      return;
    if (await controller.create(goal, modelMode)) {
      try {
        sessionStorage.removeItem(GOAL_KEY);
      } catch {}
    }
  };
  const fresh = () => {
    if (controller.reset()) {
      setGoal("");
      requestAnimationFrame(() => goalInput.current?.focus());
    }
  };

  return (
    <div className={`site-shell console-shell planning-shell ${session ? "" : "home focus-home"}`}>
      <ClickFx />
      <a href="#main" className="skip-link">
        跳转到主要内容
      </a>
      <header className="site-header p-site-header">
        <button
          type="button"
          className="wordmark"
          onClick={session ? fresh : () => goalInput.current?.focus()}
          disabled={pending || controller.unknownRequest}
          aria-label="方案擂台首页"
        >
          <span className="brand-symbol">
            <i />
            <i />
            <i />
          </span>
          <span>方案擂台</span>
        </button>
        <span className="p-header-section">{session ? "项目工作台" : "想法簿"}</span>
        <nav className="header-right" aria-label="工作台导航">
          {session && (
            <button
              type="button"
              className="text-button"
              disabled={pending || controller.unknownRequest || session.status === "working"}
              onClick={fresh}
            >
              <Plus size={14} />
              新想法
            </button>
          )}
          <Link href="/?legacy=1" className="text-button">
            旧版记录
            <ArrowUpRight size={13} />
          </Link>
        </nav>
      </header>
      <AccessGate
        open={requiresAccess}
        busy={pending}
        error={controller.error}
        onUnlock={controller.unlock}
      />
      {session ? (
        <PlanningWorkspace key={session.id} controller={controller} />
      ) : (
        <main id="main" className="p-home-main">
          <div className="goal-landing p-goal-landing">
            <section className="goal-landing-center">
              <div className="home-intro">
                <h1>你想做些什么？</h1>
              </div>
              <GoalFocusStage>
                <form
                  className="p-goal-form h-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                >
                  <label htmlFor="planning-goal" className="sr-only">
                    你想做些什么？
                  </label>
                  <div className="p-goal-margin" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                  <textarea
                    id="planning-goal"
                    ref={goalInput}
                    value={goal}
                    rows={4}
                    maxLength={6000}
                    placeholder="写下你的想法…"
                    disabled={pending || controller.restoring}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void create();
                      }
                    }}
                    onChange={(event) => {
                      setGoal(event.target.value);
                      try {
                        sessionStorage.setItem(GOAL_KEY, event.target.value);
                      } catch {}
                    }}
                  />
                  <div className="p-goal-tools">
                    <ModelSelector
                      mode={modelMode}
                      onChange={(value) => {
                        typedModel.current = true;
                        setModelMode(value);
                      }}
                      providers={providers}
                      challenge={{
                        goal,
                        constraints: "",
                        preferences: "",
                        options: [],
                        materials: "",
                        domain: "general",
                        budget: null,
                        timeHours: null,
                      }}
                      disabled={pending || controller.restoring}
                    />
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={
                        goal.trim().length < 2 ||
                        pending ||
                        controller.restoring ||
                        !controller.health ||
                        requiresAccess ||
                        unavailable ||
                        controller.unknownRequest
                      }
                    >
                      {pending ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <ArrowRight size={17} />
                      )}
                      {pending ? "正在打开" : "开始分析"}
                    </button>
                  </div>
                  <div className="p-goal-caption">
                    <span>⌘ / Ctrl + Enter</span>
                    <span>{goal.length} / 6000</span>
                  </div>
                  {controller.restoring && (
                    <p className="p-home-status" role="status">
                      <LoaderCircle size={14} className="spin" />
                      正在找回你的工作台…
                    </p>
                  )}
                  {(controller.error || controller.connectionError) && (
                    <div className="p-home-error" role="alert">
                      <p>{controller.error || controller.connectionError}</p>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void controller.refresh()}
                      >
                        <RefreshCw size={14} />
                        重新核对
                      </button>
                    </div>
                  )}
                  {controller.unknownRequest && (
                    <div className="p-home-error">
                      <p>上次创建的结果尚未核实，原始想法与请求已保留。</p>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending}
                        onClick={() => void controller.retryUnknown()}
                      >
                        检查上次创建结果
                      </button>
                    </div>
                  )}
                  {unavailable && !controller.restoring && (
                    <p className="p-home-status">
                      当前模型尚未配置。可以在下方选择已配置模型；配置完成后再开始。
                    </p>
                  )}
                </form>
              </GoalFocusStage>
              {controller.history.length > 0 && (
                <section className="p-history">
                  <button
                    type="button"
                    className="text-button"
                    aria-expanded={historyOpen}
                    onClick={() => setHistoryOpen(!historyOpen)}
                  >
                    <Clock3 size={14} />
                    最近的想法<span>{controller.history.length}</span>
                  </button>
                  {historyOpen && (
                    <ul>
                      {controller.history.map((item, index) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            disabled={pending || controller.unknownRequest}
                            onClick={() => void controller.load(item.id)}
                          >
                            <span className="p-history-number">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span>{item.goal}</span>
                            <time dateTime={item.updatedAt}>
                              {new Date(item.updatedAt).toLocaleDateString("zh-CN", {
                                month: "2-digit",
                                day: "2-digit",
                              })}
                            </time>
                            <ArrowUpRight size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </section>
          </div>
        </main>
      )}
    </div>
  );
}
