"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ChevronDown, Plus, X } from "lucide-react";
import { ChallengeSchema, type Challenge, type ModelMode, type ModelOption } from "@/lib/contracts";
import { challengeChanges, changeReason } from "@/lib/challenge-changes";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { routeModel } from "@/lib/model-routing";
import { DisclosureMotion } from "./disclosure-motion";
import { ModelSelector } from "./model-selector";
import "./condition-editor.css";

const domains = [
  ["general", "不限领域"],
  ["learning", "学习成长"],
  ["life", "生活决策"],
  ["work", "工作业务"],
  ["creation", "内容创作"],
] as const;

export function ConditionEditor({
  initial,
  initialModelMode,
  modelProviders,
  pending,
  disabled = false,
  demo = false,
  initialFocus = "budget",
  onCancel,
  onSubmit,
}: {
  initial: Challenge;
  initialModelMode: ModelMode;
  modelProviders?: ModelOption[];
  pending: boolean;
  disabled?: boolean;
  demo?: boolean;
  initialFocus?: "budget" | "timeHours" | "constraints" | "preferences";
  onCancel: () => void;
  onSubmit: (challenge: Challenge, reason: string, modelMode: ModelMode) => void;
}) {
  const id = useId();
  const [value, setValue] = useState<Challenge>(() => ({
    ...initial,
    options: [...initial.options],
  }));
  const [modelMode, setModelMode] = useState(initialModelMode);
  const [complete, setComplete] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current
      ?.querySelector<HTMLElement>("[data-overlay-autofocus]")
      ?.focus({ preventScroll: true });
  }, [initialFocus]);
  const busy = pending || disabled;
  const changes = challengeChanges(initial, value);
  const modelChanged = modelMode !== initialModelMode;
  const changed = changes.length > 0 || modelChanged;
  const route = routeModel(value, modelMode);
  const previousRoute = routeModel(initial, initialModelMode);
  const modelUnavailable =
    !demo &&
    (
      modelProviders?.find((model) => model.id === route.modelId) ??
      modelProviders?.find((model) => model.provider === route.provider)
    )?.configured === false;
  const modelLabel = (mode: ModelMode, modelId: string) =>
    mode === "auto"
      ? "自动选择"
      : (MODEL_CATALOG.find((model) => model.id === modelId)?.label ?? mode);
  const set = <K extends keyof Challenge>(key: K, next: Challenge[K]) => {
    if (busy) return;
    setValue((current) => ({ ...current, [key]: next }));
    setError("");
  };
  const focus = (key: typeof initialFocus) =>
    initialFocus === key ? { "data-overlay-autofocus": true } : {};

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || modelUnavailable || !changed) return;
    const result = ChallengeSchema.safeParse(value);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "请检查输入内容");
      setComplete(true);
      return;
    }
    setError("");
    onSubmit(result.data, changeReason(changes, note, modelChanged), modelMode);
  }

  return (
    <form ref={form} className="condition-editor" onSubmit={submit} noValidate aria-busy={pending}>
      <p className="condition-editor-intro">直接修改条件，确认后会保留旧版本，再推演一轮。</p>
      <fieldset className="condition-editor-fields" disabled={busy}>
        <legend className="sr-only">本轮条件</legend>
        <div className="condition-editor-grid">
          <label className="field">
            <span>
              预算上限 <small>元</small>
            </span>
            <input
              {...focus("budget")}
              type="number"
              min="0"
              max="100000000"
              step="any"
              value={value.budget ?? ""}
              onChange={(event) =>
                set("budget", event.target.value === "" ? null : Number(event.target.value))
              }
              placeholder="不限"
            />
          </label>
          <label className="field">
            <span>
              可投入时间 <small>总计 / 小时</small>
            </span>
            <input
              {...focus("timeHours")}
              type="number"
              min="0.01"
              max="100000"
              step="any"
              value={value.timeHours ?? ""}
              onChange={(event) =>
                set("timeHours", event.target.value === "" ? null : Number(event.target.value))
              }
              placeholder="不限"
            />
          </label>
          <label className="field">
            <span>
              硬性限制 <small>必须遵守</small>
            </span>
            <textarea
              {...focus("constraints")}
              value={value.constraints}
              onChange={(event) => set("constraints", event.target.value)}
              maxLength={3000}
              rows={2}
              placeholder="例如：两周内完成、不能增加人手"
            />
          </label>
          <label className="field">
            <span>
              更看重什么 <small>尽量满足</small>
            </span>
            <textarea
              {...focus("preferences")}
              value={value.preferences}
              onChange={(event) => set("preferences", event.target.value)}
              maxLength={1500}
              rows={2}
              placeholder="例如：更看重长期收益、希望简单上手"
            />
          </label>
        </div>
        <button
          type="button"
          className="condition-editor-toggle"
          onClick={() => setComplete(!complete)}
          aria-expanded={complete}
          aria-controls={`${id}-complete`}
        >
          <span>
            完整编辑 <small>目标、方案、材料和模型</small>
          </span>
          <ChevronDown size={16} className={complete ? "is-open" : ""} aria-hidden="true" />
        </button>
        <DisclosureMotion open={complete} id={`${id}-complete`}>
          <div className="condition-editor-complete">
            <label className="field">
              <span>目标</span>
              <textarea
                value={value.goal}
                onChange={(event) => set("goal", event.target.value)}
                minLength={8}
                maxLength={3000}
                rows={3}
              />
            </label>
            <div className="field">
              <span>
                已有备选方案 <small>最多 3 个</small>
              </span>
              {value.options.map((option, index) => (
                <div className="option-row" key={index}>
                  <span className="option-index">{String(index + 1).padStart(2, "0")}</span>
                  <input
                    aria-label={`备选方案 ${index + 1}`}
                    value={option}
                    onChange={(event) =>
                      set(
                        "options",
                        value.options.map((item, at) => (at === index ? event.target.value : item)),
                      )
                    }
                    maxLength={300}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`删除备选方案 ${index + 1}`}
                    onClick={() =>
                      set(
                        "options",
                        value.options.filter((_, at) => at !== index),
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
                参考材料 <small>包含已填写的个人处境</small>
              </span>
              <textarea
                value={value.materials}
                onChange={(event) => set("materials", event.target.value)}
                maxLength={20000}
                rows={4}
              />
            </label>
            <div className="field">
              <span>问题领域</span>
              <div className="domain-row" role="group" aria-label="问题领域">
                {domains.map(([domain, label]) => (
                  <button
                    type="button"
                    key={domain}
                    className={`domain-chip ${value.domain === domain ? "selected" : ""}`}
                    aria-pressed={value.domain === domain}
                    onClick={() => set("domain", domain)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {!demo && (
              <ModelSelector
                mode={modelMode}
                onChange={setModelMode}
                challenge={value}
                providers={modelProviders}
                disabled={busy}
              />
            )}
          </div>
        </DisclosureMotion>
      </fieldset>

      <section
        className="condition-editor-preview"
        aria-label="本次修改"
        aria-live="polite"
        aria-atomic="true"
      >
        <h3>本次修改{changed && <span>{changes.length + Number(modelChanged)} 项</span>}</h3>
        {!changed ? (
          <p>修改任一条件后，这里会显示前后变化。</p>
        ) : (
          <ul>
            {changes.map((change) => (
              <li key={change.key}>
                <strong>{change.label}</strong>
                <div className="condition-editor-diff">
                  <span>
                    <small>原来</small>
                    <span>{change.before || "未填写"}</span>
                  </span>
                  <ArrowRight size={14} aria-hidden="true" />
                  <span>
                    <small>现在</small>
                    <span>{change.after || "未填写"}</span>
                  </span>
                </div>
              </li>
            ))}
            {modelChanged && (
              <li>
                <strong>本轮模型</strong>
                <p>
                  {modelLabel(initialModelMode, previousRoute.modelId)} →{" "}
                  {modelLabel(modelMode, route.modelId)}
                </p>
              </li>
            )}
          </ul>
        )}
      </section>
      <label className="field condition-editor-note">
        <span>
          补充说明 <small>选填</small>
        </span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={busy}
          maxLength={600}
          placeholder="还有什么需要说明的？"
        />
      </label>
      {modelUnavailable && (
        <p className="form-error" role="alert">
          当前模型未配置。请在“完整编辑”中选择可用模型。
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="condition-editor-bottom">
        <p className="form-assurance">
          {demo ? "演示模式，不调用模型。" : "确认后会调用模型，产生本轮费用。"}
        </p>
        <div className="submit-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || modelUnavailable || !changed}
          >
            {pending ? "正在开始新一轮…" : "按新条件重新推演"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  );
}
