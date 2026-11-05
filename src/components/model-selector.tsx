"use client";

import { useId } from "react";
import type { Challenge, ModelMode, ModelOption } from "@/lib/contracts";
import { routeModel } from "@/lib/model-routing";
import styles from "./model-selector.module.css";

export function ModelSelector({
  mode,
  onChange,
  challenge,
  providers,
  disabled,
}: {
  mode: ModelMode;
  onChange: (mode: ModelMode) => void;
  challenge: Challenge;
  providers?: ModelOption[];
  disabled?: boolean;
}) {
  const id = useId();
  const route = routeModel(challenge, mode);
  const selected = providers?.find((p) => p.provider === route.provider);
  return (
    <fieldset className={styles.selector} disabled={disabled} aria-describedby={`${id}-reason`}>
      <legend>本轮使用的模型</legend>
      <div className={styles.options}>
        {(
          [
            ["auto", "自动", "费用优先"],
            ["deepseek", "DeepSeek", "手动指定"],
            ["gpt", "GPT", "6.1 Terra"],
          ] as const
        ).map(([value, label, note]) => (
          <label key={value} className={mode === value ? styles.selected : ""}>
            <input
              type="radio"
              name={id}
              value={value}
              checked={mode === value}
              onChange={() => onChange(value)}
            />
            <span>
              {label}
              <small>{note}</small>
            </span>
          </label>
        ))}
      </div>
      <p id={`${id}-reason`} aria-live="polite">
        {route.reason}
      </p>
      {selected && (
        <p className={styles.detail}>将使用 {selected.id}；本轮所有角色固定使用同一模型。</p>
      )}
      {selected?.configured === false && (
        <p className={styles.unavailable} role="status">
          {selected.error || "所选模型尚未配置，请选择已配置的模型，或请运行者完成配置。"}
          系统不会自动换用另一家。
        </p>
      )}
      <details className={styles.detail}>
        <summary>自动选择依据</summary>
        <p>
          参考材料达到 6000 字符，或明确限制达到 4 项时使用 GPT；其他任务使用
          DeepSeek。限制按换行或分号计数，已填写的预算和时间各计一项。这是可查看的选择规则，尚未证明能判断任务难度或哪家模型更好；选择过程不调用模型。
        </p>
      </details>
    </fieldset>
  );
}
