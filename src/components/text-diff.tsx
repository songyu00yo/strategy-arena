"use client";
import { useMemo } from "react";
import type { Strategy } from "@/lib/contracts";

const claimLabels = {
  user: "用户提供",
  estimate: "估算",
  unknown: "待核验",
  supported: "有材料支持",
};

/** Field-by-field comparison of what actually changed between a proposal and its revision. */
export function strategyChanges(before: Strategy, after: Strategy) {
  const lines = (items: string[]) => items.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const claims = (s: Strategy) =>
    s.claims.map((c) => `【${claimLabels[c.status]}】${c.text}`).join("\n");
  const cost = (s: Strategy) =>
    s.estimatedCost === null ? "未提供估算" : `¥${s.estimatedCost.toLocaleString()}`;
  const hours = (s: Strategy) =>
    s.estimatedHours === null ? "未提供估算" : `${s.estimatedHours} 小时`;
  return [
    { label: "路线标题", before: before.title, after: after.title },
    { label: "核心思路", before: before.thesis, after: after.thesis },
    { label: "关键判断", before: claims(before), after: claims(after) },
    { label: "行动步骤", before: lines(before.steps), after: lines(after.steps) },
    { label: "所需资源", before: before.resources, after: after.resources },
    { label: "第一步行动", before: before.firstAction, after: after.firstAction },
    { label: "失效条件", before: before.failureCondition, after: after.failureCondition },
    { label: "费用估算", before: cost(before), after: cost(after) },
    { label: "时间估算", before: hours(before), after: hours(after) },
  ].filter((change) => change.before !== change.after);
}

type Part = { text: string; kind: "same" | "change" };
const TOKEN = /[㐀-鿿]|[A-Za-z0-9.]+|\s+|[^]/gu;
const MAX_CELLS = 250_000;

/** Longest-common-subsequence token diff. Very long text falls back to a whole-text change. */
export function diffParts(before: string, after: string): { before: Part[]; after: Part[] } {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length * b.length > MAX_CELLS)
    return {
      before: [{ text: before, kind: "change" }],
      after: [{ text: after, kind: "change" }],
    };
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const push = (parts: Part[], text: string, kind: Part["kind"]) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ text, kind });
  };
  const left: Part[] = [];
  const right: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(left, a[i++], "same");
      push(right, b[j++], "same");
    } else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) {
      push(right, b[j++], "change");
    } else {
      push(left, a[i++], "change");
    }
  }
  return { before: left, after: right };
}

/** Removed text is struck through and added text underlined, so the change survives without colour. */
export function TextDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffParts(before, after), [before, after]);
  return (
    <>
      <div className="diff-side diff-before">
        <span>修订前</span>
        <p>
          {parts.before.map((part, i) =>
            part.kind === "same" ? part.text : <del key={i}>{part.text}</del>,
          )}
        </p>
      </div>
      <div className="diff-side diff-after">
        <span>修订后</span>
        <p>
          {parts.after.map((part, i) =>
            part.kind === "same" ? part.text : <ins key={i}>{part.text}</ins>,
          )}
        </p>
      </div>
    </>
  );
}
