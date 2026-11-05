"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowRight, Plus, X, FlaskConical } from "lucide-react";
import { ChallengeSchema, type Challenge } from "@/lib/contracts";
import { samples } from "@/lib/sample";
import { flyLight, reducedMotion, ROUTE_COLOR } from "@/components/console/effects";

export const emptyChallenge: Challenge = {
  goal: "",
  constraints: "",
  preferences: "",
  options: [],
  materials: "",
  domain: "general",
  budget: null,
  timeHours: null,
};
const domains = [
  { id: "general", label: "不限领域" },
  { id: "learning", label: "学习成长" },
  { id: "life", label: "生活决策" },
  { id: "work", label: "工作业务" },
  { id: "creation", label: "内容创作" },
] as const;

/** One field being written during a sample fill. */
type Fill = { key: string; text: string; start: number; end: number; color: string };
const LIGHT = [ROUTE_COLOR.A, ROUTE_COLOR.B, ROUTE_COLOR.C];

/** The order and pace of a sample fill, so each field starts as the last one is finishing. */
function fillPlan(sample: Challenge): Fill[] {
  const fields: [string, string, number][] = [
    ["goal", sample.goal, 820],
    ["constraints", sample.constraints, 430],
    ["preferences", sample.preferences, 340],
    ...sample.options.map((o, i): [string, string, number] => [`option${i}`, o, 170]),
    ["materials", sample.materials, 560],
    ["budget", sample.budget === null ? "" : String(sample.budget), 160],
    ["timeHours", sample.timeHours === null ? "" : String(sample.timeHours), 160],
  ];
  let at = 420;
  return fields
    .filter(([, text]) => text)
    .map(([key, text, ms], i) => {
      const step = { key, text, start: at, end: at + ms, color: LIGHT[i % LIGHT.length] };
      at += ms * 0.82;
      return step;
    });
}

/** Drives one sample fill and returns how to stop it. */
function runFill(
  plan: Fill[],
  button: HTMLElement,
  form: HTMLFormElement | null,
  on: {
    open: () => void;
    light: (key: string, color: string) => void;
    type: (counts: Record<string, number>) => void;
    done: () => void;
    arrive: () => void;
  },
) {
  const began = performance.now();
  const lit = new Set<string>();
  const finishAt = plan[plan.length - 1].end;
  let previous = button.getBoundingClientRect();
  let frame = 0;
  let painted = 0;
  let opened = false;
  let arrival: ReturnType<typeof setTimeout> | undefined;
  const tick = (now: number) => {
    const elapsed = now - began;
    if (elapsed >= 300 && !opened) {
      opened = true;
      on.open();
    }
    // Light leaves the last field and lands on the next, so the whole form reads as one gesture.
    for (const step of plan) {
      if (elapsed < step.start - 240 || lit.has(step.key)) continue;
      lit.add(step.key);
      const target = form?.querySelector(`[data-fill="${step.key}"]`);
      if (target) {
        // The page follows the writing, so the field in progress is always on screen.
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        const box = target.getBoundingClientRect();
        flyLight(previous, box, step.color, 300);
        previous = box;
      }
      on.light(step.key, step.color);
    }
    if (elapsed >= finishAt) {
      on.done();
      const submit = form?.querySelector(".primary-button");
      if (submit) {
        submit.scrollIntoView({ block: "center", behavior: "smooth" });
        flyLight(previous, submit.getBoundingClientRect(), "11,13,16", 340);
        arrival = setTimeout(on.arrive, 300);
      }
      return;
    }
    if (now - painted >= 33) {
      painted = now;
      const counts: Record<string, number> = {};
      for (const step of plan) {
        const k = Math.max(0, Math.min(1, (elapsed - step.start) / (step.end - step.start)));
        counts[step.key] = Math.ceil(step.text.length * k);
      }
      on.type(counts);
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(arrival);
  };
}

export function ChallengeForm({
  initial,
  submitLabel = "让方案上场",
  pending,
  disabled = false,
  editing = false,
  onSubmit,
  onCancel,
}: {
  initial?: Challenge;
  submitLabel?: string;
  pending: boolean;
  disabled?: boolean;
  editing?: boolean;
  onSubmit: (challenge: Challenge, reason: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState<Challenge>(initial ?? emptyChallenge);
  const [details, setDetails] = useState(editing);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // While a sample fills, `value` already holds it in full; `typed` only decides how much is on screen.
  const [typed, setTyped] = useState<Record<string, number> | null>(null);
  const [active, setActive] = useState<{ key: string; color: string } | null>(null);
  const [ready, setReady] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const stopFill = useRef<(() => void) | null>(null);
  useEffect(() => () => stopFill.current?.(), []);

  const settle = () => {
    stopFill.current?.();
    stopFill.current = null;
    setTyped(null);
    setActive(null);
  };
  const set = <K extends keyof Challenge>(key: K, next: Challenge[K]) => {
    settle();
    setPicked(null);
    setValue((v) => ({ ...v, [key]: next }));
  };
  const shown = (key: string, text: string) => (typed ? text.slice(0, typed[key] ?? 0) : text);
  const glow = (key: string) =>
    active?.key === key
      ? {
          className: "fill-on",
          style: { "--route": active.color.replaceAll(",", " ") } as CSSProperties,
        }
      : { className: "" };

  function fillSample(id: string, button: HTMLElement) {
    const sample = samples.find((s) => s.id === id)?.challenge;
    if (!sample) return;
    settle();
    setValue(sample);
    setPicked(id);
    setError("");
    if (reducedMotion()) {
      setDetails(true);
      return;
    }
    setTyped({});
    stopFill.current = runFill(fillPlan(sample), button, form.current, {
      open: () => setDetails(true),
      light: (key, color) => setActive({ key, color }),
      type: setTyped,
      done: () => {
        stopFill.current = null;
        setTyped(null);
        setActive(null);
      },
      arrive: () => setReady((n) => n + 1),
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    settle();
    const result = ChallengeSchema.safeParse({
      ...value,
      options: value.options.map((o) => o.trim()).filter(Boolean),
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "请检查输入内容");
      return;
    }
    if (editing && !reason.trim()) {
      setError("请说明这次修改了什么，让新一轮有据可循。");
      return;
    }
    setError("");
    onSubmit(result.data, reason.trim());
  }
  const domainShown = typed && (typed.goal ?? 0) < value.goal.length ? "general" : value.domain;
  const goalGlow = glow("goal");
  const constraintsGlow = glow("constraints");
  const preferencesGlow = glow("preferences");
  const materialsGlow = glow("materials");
  const budgetGlow = glow("budget");
  const timeGlow = glow("timeHours");
  return (
    <form
      ref={form}
      className={`challenge-form ${editing ? "editing-form" : ""}`}
      // Mid-fill the boxes show partial text while the form already holds the whole sample,
      // so the browser must not judge what is on screen.
      noValidate={!!typed}
      onSubmit={submit}
    >
      <div className="form-topline">
        <span className="eyebrow">{editing ? "重新定义条件" : "把问题放上桌"}</span>
        {!editing && (
          <div className="sample-row" role="group" aria-label="试填示例">
            {samples.map((sample, i) => (
              <button
                key={sample.id}
                type="button"
                className={`sample-button ${picked === sample.id ? "picked" : ""}`}
                aria-pressed={picked === sample.id}
                onClick={(event) => fillSample(sample.id, event.currentTarget)}
              >
                {i === 0 && <FlaskConical size={14} />}
                {sample.label}
                {i === 0 && <ArrowDown size={13} />}
              </button>
            ))}
          </div>
        )}
      </div>
      <label className="sr-only" htmlFor={editing ? "edit-goal" : "goal"}>
        你的目标、备选方案或想法
      </label>
      <textarea
        className={`goal-input ${goalGlow.className}`}
        style={goalGlow.style}
        data-fill="goal"
        id={editing ? "edit-goal" : "goal"}
        value={shown("goal", value.goal)}
        onChange={(e) => set("goal", e.target.value)}
        placeholder={"说说你的目标、纠结的选项，\n或一个还不成熟的想法。"}
        minLength={8}
        maxLength={3000}
        required
        rows={3}
      />
      <div className="domain-row" role="group" aria-label="问题领域">
        {domains.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`domain-chip ${domainShown === d.id ? "selected" : ""}`}
            onClick={() => set("domain", d.id)}
            aria-pressed={value.domain === d.id}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="form-divider" />
      <div className="conditions-grid">
        <label className={`field ${constraintsGlow.className}`} style={constraintsGlow.style}>
          <span>
            硬性限制 <small>必须遵守</small>
          </span>
          <textarea
            data-fill="constraints"
            value={shown("constraints", value.constraints)}
            onChange={(e) => set("constraints", e.target.value)}
            maxLength={3000}
            placeholder="例如：两周内完成、不能增加人手"
            rows={2}
          />
        </label>
        <label className={`field ${preferencesGlow.className}`} style={preferencesGlow.style}>
          <span>
            个人偏好 <small>尽量满足</small>
          </span>
          <textarea
            data-fill="preferences"
            value={shown("preferences", value.preferences)}
            onChange={(e) => set("preferences", e.target.value)}
            maxLength={1500}
            placeholder="例如：更看重长期收益、希望简单上手"
            rows={2}
          />
        </label>
      </div>
      <button
        type="button"
        className="details-toggle"
        onClick={() => setDetails(!details)}
        aria-expanded={details}
      >
        {details ? <X size={14} /> : <Plus size={14} />}
        {details ? "收起补充信息" : "添加备选方案、材料或预算"}
        <span>选填</span>
      </button>
      <div className={`extra-wrap ${details ? "open" : ""}`} inert={!details}>
        <div className="extra-fields">
          <div className="field">
            <span>
              已有备选方案 <small>最多 3 个，留空也可以</small>
            </span>
            {value.options.map((option, index) => {
              const optionGlow = glow(`option${index}`);
              return (
                <div
                  className={`option-row ${optionGlow.className}`}
                  style={optionGlow.style}
                  key={index}
                >
                  <span className="option-index">{String(index + 1).padStart(2, "0")}</span>
                  <input
                    data-fill={`option${index}`}
                    aria-label={`备选方案 ${index + 1}`}
                    value={shown(`option${index}`, option)}
                    onChange={(e) =>
                      set(
                        "options",
                        value.options.map((o, i) => (i === index ? e.target.value : o)),
                      )
                    }
                    maxLength={300}
                    placeholder="一句话描述你的选项"
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`删除备选方案 ${index + 1}`}
                    onClick={() =>
                      set(
                        "options",
                        value.options.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
              );
            })}
            {value.options.length < 3 && (
              <button
                type="button"
                className="text-button"
                onClick={() => set("options", [...value.options, ""])}
              >
                <Plus size={14} />
                添加一个选项
              </button>
            )}
          </div>
          <label className={`field ${materialsGlow.className}`} style={materialsGlow.style}>
            <span>
              参考材料 <small>核验以你提供的文本为基础</small>
            </span>
            <textarea
              data-fill="materials"
              value={shown("materials", value.materials)}
              onChange={(e) => set("materials", e.target.value)}
              maxLength={20000}
              rows={4}
              placeholder="粘贴背景、资料原文、价格或已有研究。没有材料时，系统会如实标记无法核验的判断。"
            />
          </label>
          <div className="conditions-grid">
            <label className={`field ${budgetGlow.className}`} style={budgetGlow.style}>
              <span>
                预算上限 <small>人民币 / 元</small>
              </span>
              <input
                data-fill="budget"
                type="number"
                min="0"
                step="any"
                max="100000000"
                value={typed ? shown("budget", String(value.budget ?? "")) : (value.budget ?? "")}
                onChange={(e) =>
                  set("budget", e.target.value === "" ? null : Number(e.target.value))
                }
                placeholder="不限"
              />
            </label>
            <label className={`field ${timeGlow.className}`} style={timeGlow.style}>
              <span>
                可投入时间 <small>总计 / 小时</small>
              </span>
              <input
                data-fill="timeHours"
                type="number"
                min="0.01"
                step="any"
                max="100000"
                value={
                  typed
                    ? shown("timeHours", String(value.timeHours ?? ""))
                    : (value.timeHours ?? "")
                }
                onChange={(e) =>
                  set("timeHours", e.target.value === "" ? null : Number(e.target.value))
                }
                placeholder="不限"
              />
            </label>
          </div>
        </div>
      </div>
      {editing && (
        <label className="field reason-field">
          <span>
            这次为什么修改？<small>必填</small>
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            placeholder="例如：新增了预算限制，原有路线需要重新验证"
            required
          />
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-bottom">
        <span className="form-assurance">真实调用模型，按用量估算费用。</span>
        <div className="submit-actions">
          {onCancel && (
            <button type="button" className="secondary-button" onClick={onCancel}>
              取消
            </button>
          )}
          <button
            key={ready}
            className={`primary-button ${ready ? "ready" : ""}`}
            type="submit"
            disabled={pending || disabled}
          >
            {pending ? "正在建立擂台…" : submitLabel}
            <ArrowRight size={18} />
          </button>
        </div>
      </div>
    </form>
  );
}
