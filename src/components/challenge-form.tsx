"use client";

import { useState } from "react";
import { ArrowDown, ArrowRight, Plus, X, FlaskConical } from "lucide-react";
import { ChallengeSchema, type Challenge } from "@/lib/contracts";
import { videoChallenge } from "@/lib/sample";

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
  const set = <K extends keyof Challenge>(key: K, next: Challenge[K]) =>
    setValue((v) => ({ ...v, [key]: next }));
  function submit(event: React.FormEvent) {
    event.preventDefault();
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
  return (
    <form className={`challenge-form ${editing ? "editing-form" : ""}`} onSubmit={submit}>
      <div className="form-topline">
        <span className="eyebrow">
          <span className="tiny-square" />
          {editing ? "重新定义比赛条件" : "01 / 把问题放上桌"}
        </span>
        {!editing && (
          <button
            type="button"
            className="sample-button"
            onClick={() => {
              setValue(videoChallenge);
              setDetails(true);
            }}
          >
            <FlaskConical size={14} />
            试填一个视频任务
            <ArrowDown size={13} />
          </button>
        )}
      </div>
      <label className="sr-only" htmlFor={editing ? "edit-goal" : "goal"}>
        你的目标、备选方案或想法
      </label>
      <textarea
        className="goal-input"
        id={editing ? "edit-goal" : "goal"}
        value={value.goal}
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
            className={`domain-chip ${value.domain === d.id ? "selected" : ""}`}
            onClick={() => set("domain", d.id)}
            aria-pressed={value.domain === d.id}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="form-divider" />
      <div className="conditions-grid">
        <label className="field">
          <span>
            硬性限制 <small>必须遵守</small>
          </span>
          <textarea
            value={value.constraints}
            onChange={(e) => set("constraints", e.target.value)}
            maxLength={3000}
            placeholder="例如：两周内完成、不能增加人手"
            rows={2}
          />
        </label>
        <label className="field">
          <span>
            个人偏好 <small>尽量满足</small>
          </span>
          <textarea
            value={value.preferences}
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
      {details && (
        <div className="extra-fields">
          <div className="field">
            <span>
              已有备选方案 <small>最多 3 个，留空也可以</small>
            </span>
            {value.options.map((option, index) => (
              <div className="option-row" key={index}>
                <span className="option-index">{String(index + 1).padStart(2, "0")}</span>
                <input
                  aria-label={`备选方案 ${index + 1}`}
                  value={option}
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
            ))}
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
          <label className="field">
            <span>
              参考材料 <small>核验以你提供的文本为基础</small>
            </span>
            <textarea
              value={value.materials}
              onChange={(e) => set("materials", e.target.value)}
              maxLength={20000}
              rows={4}
              placeholder="粘贴背景、资料原文、价格或已有研究。没有材料时，系统会如实标记无法核验的判断。"
            />
          </label>
          <div className="conditions-grid">
            <label className="field">
              <span>
                预算上限 <small>人民币 / 元</small>
              </span>
              <input
                type="number"
                min="0"
                step="any"
                max="100000000"
                value={value.budget ?? ""}
                onChange={(e) =>
                  set("budget", e.target.value === "" ? null : Number(e.target.value))
                }
                placeholder="不限"
              />
            </label>
            <label className="field">
              <span>
                可投入时间 <small>总计 / 小时</small>
              </span>
              <input
                type="number"
                min="0.01"
                step="any"
                max="100000"
                value={value.timeHours ?? ""}
                onChange={(e) =>
                  set("timeHours", e.target.value === "" ? null : Number(e.target.value))
                }
                placeholder="不限"
              />
            </label>
          </div>
        </div>
      )}
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
        <span className="form-assurance">
          三种思路，独立出发。
          <br />
          真实调用，按用量估算费用。
        </span>
        <div className="submit-actions">
          {onCancel && (
            <button type="button" className="secondary-button" onClick={onCancel}>
              取消
            </button>
          )}
          <button className="primary-button" type="submit" disabled={pending || disabled}>
            {pending ? "正在建立擂台…" : submitLabel}
            <ArrowRight size={18} />
          </button>
        </div>
      </div>
    </form>
  );
}
