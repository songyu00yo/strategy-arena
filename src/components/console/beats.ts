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
};

export function beatsOf(version: ArenaVersion): Beat[] {
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
      packet: `质疑 ${a.targetClaimId}`,
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
      plain: "用你给的材料和计算工具查证，不靠模型自己说。",
      attack: a,
    });
  }
  for (const r of version.revisions) {
    const proposal = version.strategies.find((s) => s.id === r.strategyId);
    const changes = proposal ? strategyChanges(proposal, r.strategy).map((c) => c.label) : [];
    beats.push({
      id: `r:${r.strategyId}`,
      stage: "revise",
      agent: r.strategyId,
      title: r.summary,
      plain: changes.length
        ? `方案 ${r.strategyId} 被质疑后改了：${changes.join("、")}。`
        : `方案 ${r.strategyId} 复核后没有改动。`,
      revision: r,
      changes,
    });
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
  return beats;
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
