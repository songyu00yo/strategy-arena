import type { Challenge } from "./contracts";

export interface ChallengeChange {
  key: keyof Challenge;
  label: string;
  before: string;
  after: string;
  detail: string;
}

const domains: Record<Challenge["domain"], string> = {
  general: "不限领域",
  learning: "学习成长",
  life: "生活决策",
  work: "工作业务",
  creation: "内容创作",
};
const fields: [keyof Challenge, string][] = [
  ["budget", "预算上限"],
  ["timeHours", "可投入时间"],
  ["constraints", "硬性限制"],
  ["preferences", "更看重什么"],
  ["goal", "目标"],
  ["options", "备选方案"],
  ["materials", "参考材料"],
  ["domain", "问题领域"],
];

function display(challenge: Challenge, key: keyof Challenge): string {
  if (key === "budget") return challenge.budget === null ? "不限" : `${challenge.budget} 元`;
  if (key === "timeHours")
    return challenge.timeHours === null ? "不限" : `${challenge.timeHours} 小时`;
  if (key === "domain") return domains[challenge.domain];
  if (key === "options")
    return challenge.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  return challenge[key];
}

/** Compare saved values without trimming, splitting or rewriting user materials. */
export function challengeChanges(before: Challenge, after: Challenge): ChallengeChange[] {
  return fields.flatMap(([key, label]) => {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) return [];
    const previous = display(before, key);
    const next = display(after, key);
    const detail =
      previous.length + next.length <= 80 && !/[\r\n]/.test(previous + next)
        ? `${previous || "未填写"} → ${next || "未填写"}`
        : "内容已修改";
    return [{ key, label, before: previous, after: next, detail }];
  });
}

/** The reason is a bounded summary; the actual Challenge always remains complete. */
export function changeReason(changes: ChallengeChange[], note = "", modelChanged = false): string {
  const parts = changes.map((change) => `${change.label}：${change.detail}`);
  if (modelChanged) parts.push("已更换本轮模型");
  const summary = parts.join("；");
  const extra = note.trim();
  if (!extra) return summary.slice(0, 1000);
  const prefix = summary ? `${summary}。补充说明：` : "补充说明：";
  return `${prefix}${extra.slice(0, Math.max(0, 1000 - prefix.length))}`.slice(0, 1000);
}
