"use client";
import {
  Check,
  CircleCheck,
  CircleHelp,
  CircleX,
  FileSearch,
  Calculator,
  Hourglass,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Attack, Evidence, Revision, Verdict } from "@/lib/contracts";

/**
 * Every state carries a label and a distinct glyph, so nothing depends on colour alone.
 * `tone` only selects styling; the meaning stays in `label`.
 */
export type Tone = "alert" | "good" | "open" | "waiting";
type Meta = { label: string; Icon: LucideIcon; tone: Tone };

export const attackMeta: Record<Attack["status"], Meta> = {
  pending: { label: "待核验", Icon: Hourglass, tone: "waiting" },
  supported: { label: "质疑成立", Icon: TriangleAlert, tone: "alert" },
  refuted: { label: "质疑已反驳", Icon: ShieldCheck, tone: "good" },
  unresolved: { label: "尚无定论", Icon: CircleHelp, tone: "open" },
};

type Decision = Revision["responses"][number]["decision"];
export const decisionMeta: Record<Decision, Meta> = {
  accept: { label: "接受质疑", Icon: Check, tone: "alert" },
  reject: { label: "反驳质疑", Icon: ShieldX, tone: "good" },
  unresolved: { label: "保留未决", Icon: CircleHelp, tone: "open" },
};

export const evidenceMeta: Record<Evidence["status"], Meta> = {
  found: { label: "找到材料", Icon: FileSearch, tone: "good" },
  calculated: { label: "计算完成", Icon: Calculator, tone: "good" },
  unavailable: { label: "无可用证据", Icon: CircleHelp, tone: "open" },
  error: { label: "核验失败", Icon: CircleX, tone: "alert" },
};

type Comparison = Verdict["comparisons"][number]["status"];
export const comparisonMeta: Record<Comparison, Meta> = {
  eligible: { label: "符合条件", Icon: CircleCheck, tone: "good" },
  violates: { label: "触及限制", Icon: TriangleAlert, tone: "alert" },
  unknown: { label: "待确认", Icon: CircleHelp, tone: "open" },
};

type Finding = Verdict["attackFindings"][number]["status"];
export const findingMeta: Record<Finding, Meta> = {
  supported: { label: "成立", Icon: TriangleAlert, tone: "alert" },
  refuted: { label: "已反驳", Icon: ShieldCheck, tone: "good" },
  unresolved: { label: "未决", Icon: CircleHelp, tone: "open" },
};

export function StatusTag({ meta, className = "" }: { meta: Meta; className?: string }) {
  const { Icon, label, tone } = meta;
  return (
    <span className={`status-tag tone-${tone} ${className}`}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </span>
  );
}
