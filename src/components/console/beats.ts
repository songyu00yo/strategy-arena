import { claimLabel, readableClaimText } from "@/components/claim-label";
import { STAGE_LABELS } from "@/lib/contracts";
import type {
  ArenaEvent,
  ArenaVersion,
  Attack,
  ModelUsage,
  Revision,
  Stage,
  Strategy,
  Verdict,
} from "@/lib/contracts";
import { attackMeta } from "@/components/status";
import { strategyChanges } from "@/components/text-diff";
import type { ClarificationRun } from "@/lib/clarification-contracts";

export const CLARIFICATION_ROLES = {
  A: "需求拆解",
  B: "选项与执行审查",
  C: "验收与遗漏审查",
} as const;
export const CLARIFICATION_STAGES: Record<Stage, string> = {
  propose: "需求拆解",
  attack: "选项与执行审查",
  verify: "验收与遗漏审查",
  revise: "确认与复核",
  judge: "需求交接",
};
const TOPIC_LABELS = {
  scope: "范围",
  function: "功能",
  content: "内容",
  flow: "流程",
  style: "风格",
  acceptance: "验收",
  materials: "材料",
  authorization: "授权",
} as const;

export function clarificationLines(run: ClarificationRun): string[] {
  const output = run.output;
  if ("error" in output) return [output.error];
  if ("items" in output)
    return [
      ...output.items.map(
        (item) =>
          `${item.title} — ${item.description}${item.acceptance.length ? `（验收待确认 ${item.acceptance.join("、")}）` : ""}`,
      ),
      ...output.retired.map((item) => `已排除 ${item.id} — ${item.reason}`),
      ...output.suggestions.map((text) => `AI 建议（待确认） ${text}`),
    ];
  if ("questions" in output)
    return [
      ...output.questions.map(
        (question) =>
          `${question.title}${question.options.length ? `（候选 ${question.options.join(" / ")}）` : ""}`,
      ),
      ...output.conflicts.map((conflict) => `需核对 ${conflict.description}`),
    ];
  return [
    `C 审查意见 — ${output.ready ? "可以交接" : "仍需补齐"}`,
    ...output.coverage.map(
      (entry) =>
        `${TOPIC_LABELS[entry.topic]} — ${entry.applicable ? "适用" : "本场景不适用"}，${entry.reason}`,
    ),
    ...output.gaps.map((item) => `遗漏待补 ${item.title} — ${item.description}`),
    ...output.conflicts.map((text) => `需核对 ${text}`),
  ];
}

export const stageName = (version: ArenaVersion, stage: Stage) =>
  version.workflow === "clarification" ? CLARIFICATION_STAGES[stage] : STAGE_LABELS[stage];
export const beatName = (beat: Beat) =>
  beat.clarificationRun ? CLARIFICATION_ROLES[beat.clarificationRun.role] : nameOf(beat.agent);

export const AGENTS = [
  { id: "A", name: "方案 A" },
  { id: "B", name: "方案 B" },
  { id: "C", name: "方案 C" },
  { id: "verify", name: "核验" },
  { id: "judge", name: "裁判" },
] as const;
export type AgentId = (typeof AGENTS)[number]["id"];
export const nameOf = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;

/** One recorded step. Beats only ever describe what a version has stored. */
export type Beat = {
  id: string;
  stage: Stage;
  agent: AgentId;
  /** Where the hand-off goes on the map, if this step passes work to another role. */
  to?: AgentId;
  packet?: string;
  title: string;
  /** Plain words for someone who has never seen the product. */
  plain: string;
  attack?: Attack;
  strategy?: Strategy;
  revision?: Revision;
  changes?: string[];
  verdict?: Verdict;
  clarificationRun?: ClarificationRun;
};

/** Read only the playback section already revealed to the user. */
export function latestShownRevision(shown: readonly Beat[], strategyId: string) {
  return shown.findLast((beat) => beat.revision?.strategyId === strategyId);
}

export function beatsOf(version: ArenaVersion): Beat[] {
  if (version.workflow === "clarification" && version.clarification) {
    const stages = { A: "propose", B: "attack", C: "verify" } as const;
    return version.clarification.runs.map((run) => ({
      id: `clarification:${run.id}`,
      stage: stages[run.role],
      agent: run.role,
      title: `${CLARIFICATION_ROLES[run.role]} · 第 ${run.round} 轮`,
      plain: run.summary,
      clarificationRun: run,
    }));
  }
  const beats: Beat[] = [];
  for (const s of version.strategies)
    beats.push({
      id: `p:${s.id}`,
      stage: "propose",
      agent: s.id,
      title: s.title,
      plain: `方案 ${s.id} 独立提出一条路线，还看不到另外两条。`,
      strategy: s,
    });
  for (const a of version.attacks)
    beats.push({
      id: `a:${a.id}`,
      stage: "attack",
      agent: a.from as AgentId,
      to: a.targetStrategyId,
      packet: `质疑${claimLabel(version, a.targetStrategyId, a.targetClaimId)}`,
      title: a.reason,
      plain: `${a.from} 认为 ${a.targetStrategyId} 的这句话站不住：「${a.claimQuote}」`,
      attack: a,
    });
  for (const a of version.attacks) {
    const evidence = version.evidence.filter((e) => e.attackId === a.id);
    if (!evidence.length && a.status === "pending") continue;
    beats.push({
      id: `v:${a.id}`,
      stage: "verify",
      agent: "verify",
      to: a.targetStrategyId,
      packet: attackMeta[a.status].label,
      title: `${a.from} 对 ${a.targetStrategyId} 的质疑：${attackMeta[a.status].label}`,
      plain: "根据材料、公开来源和计算记录核验这项质疑。",
      attack: a,
    });
  }
  const previousStrategies = new Map(version.strategies.map((strategy) => [strategy.id, strategy]));
  for (const r of version.revisions) {
    const previous = previousStrategies.get(r.strategyId);
    const changes = previous ? strategyChanges(previous, r.strategy).map((c) => c.label) : [];
    beats.push({
      id: `r:${r.revisionId ?? r.strategyId}`,
      stage: "revise",
      agent: r.strategyId,
      title: readableClaimText(version, r.summary),
      plain: changes.length
        ? `方案 ${r.strategyId} 回应质疑后改了：${changes.join("、")}。`
        : `方案 ${r.strategyId} 复核后没有改动。`,
      revision: r,
      changes,
    });
    previousStrategies.set(r.strategyId, r.strategy);
  }
  if (version.verdict)
    beats.push({
      id: "judge",
      stage: "judge",
      agent: "judge",
      title: version.verdict.headline,
      plain: "裁判看完全部质疑和证据后，给出有条件的结论。",
      verdict: version.verdict,
    });
  if (!version.agent) return beats;
  const byId = new Map(beats.map((beat) => [beat.id, beat]));
  const ordered: Beat[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const beat = byId.get(id);
    if (beat && !seen.has(id)) {
      ordered.push(beat);
      seen.add(id);
    }
  };
  for (const action of version.agent.actions) {
    if (action.kind === "propose") push(`p:${action.role}`);
    if (action.kind === "attack") push(`a:attack-${action.id}`);
    if (action.kind === "revise") push(`r:${action.id}`);
    if (action.kind === "tools")
      for (const attack of version.attacks) {
        if (
          version.evidence.some(
            (evidence) => evidence.attackId === attack.id && evidence.actionId === action.id,
          )
        )
          push(`v:${attack.id}`);
      }
    if (action.kind === "judge") push("judge");
  }
  for (const beat of beats) push(beat.id);
  return ordered;
}

type EventData = { usage?: ModelUsage | null; modelOutput?: unknown } | null;
export const usageOf = (event: ArenaEvent) => (event.data as EventData)?.usage ?? null;
export const outputOf = (event: ArenaEvent) => (event.data as EventData)?.modelOutput;
export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
