import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0";
export const STAGES = ["propose", "attack", "verify", "revise", "judge"] as const;
export type Stage = typeof STAGES[number];
export const STAGE_LABELS: Record<Stage, string> = { propose: "独立提案", attack: "交叉质疑", verify: "证据核验", revise: "策略修订", judge: "条件裁决" };
const short = z.string().min(1).max(500);
export const ChallengeSchema = z.object({
  goal: z.string().min(8, "请用至少 8 个字描述你的目标").max(3000),
  constraints: z.string().max(3000).default(""),
  preferences: z.string().max(1500).default(""),
  options: z.array(z.string().min(1).max(300)).max(3).default([]),
  materials: z.string().max(20000).default(""),
  domain: z.enum(["learning", "life", "work", "creation", "general"]).default("general"),
  budget: z.number().min(0).max(100000000).nullable().default(null),
  timeHours: z.number().min(0.01).max(100000).nullable().default(null)
});
export type Challenge = z.infer<typeof ChallengeSchema>;
export const ClaimSchema = z.object({ id: short, text: short, status: z.enum(["user", "estimate", "unknown", "supported"]).default("unknown"), sourceIds: z.array(z.string()).default([]) });
export const StrategySchema = z.object({
  id: z.enum(["A", "B", "C"]), title: z.string().min(1).max(50), thesis: short,
  steps: z.array(short).min(1).max(6), claims: z.array(ClaimSchema).min(1).max(3),
  resources: short, firstAction: short, failureCondition: short,
  estimatedCost: z.number().nonnegative().nullable().default(null),
  estimatedHours: z.number().nonnegative().nullable().default(null)
});
export type Strategy = z.infer<typeof StrategySchema>;
export const ToolRequestSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search_materials"), query: z.string().min(1).max(300) }),
  z.object({ tool: z.literal("calculate"), expression: z.string().min(1).max(300), assumptions: z.string().min(1).max(700) })
]);
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export const AttackSchema = z.object({
  id: short, from: z.string().min(1).max(30), targetStrategyId: z.enum(["A", "B", "C"]), targetClaimId: short,
  claimQuote: short, reason: short, impact: short, verification: short,
  requests: z.array(ToolRequestSchema).max(2),
  status: z.enum(["pending", "supported", "refuted", "unresolved"]).default("pending")
});
export type Attack = z.infer<typeof AttackSchema>;
export const EvidenceSchema = z.object({
  id: short, attackId: short, tool: z.enum(["search_materials", "calculate", "constraint_check"]),
  status: z.enum(["found", "calculated", "unavailable", "error"]), title: short,
  content: z.string().max(6000), source: short, sourceIds: z.array(z.string()).default([]),
  expression: z.string().nullable().default(null), result: z.number().nullable().default(null),
  assumptions: z.string().default(""), createdAt: z.string()
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export const RevisionSchema = z.object({
  strategyId: z.enum(["A", "B", "C"]), strategy: StrategySchema,
  responses: z.array(z.object({ attackId: short, decision: z.enum(["accept", "reject", "unresolved"]), reason: short, evidenceIds: z.array(z.string()), change: z.string().max(800) })).max(6),
  summary: short, changed: z.boolean()
});
export type Revision = z.infer<typeof RevisionSchema>;
export const VerdictSchema = z.object({
  outcome: z.enum(["recommendation", "tie", "insufficient", "infeasible", "partial"]),
  preferred: z.enum(["A", "B", "C"]).nullable(), headline: short, rationale: short,
  conditions: z.array(short).max(5), uncertainties: z.array(short).max(6),
  nextActions: z.array(short).min(1).max(5), exitCondition: short,
  evidenceIds: z.array(z.string()),
  comparisons: z.array(z.object({ strategyId: z.enum(["A", "B", "C"]), status: z.enum(["eligible", "violates", "unknown"]), reason: short })).max(3),
  attackFindings: z.array(z.object({ attackId: short, status: z.enum(["supported", "refuted", "unresolved"]), reason: short, evidenceIds: z.array(z.string()) })).default([])
});
export type Verdict = z.infer<typeof VerdictSchema>;
export type RunStatus = "ready" | "running" | "completed" | "paused" | "failed" | "uncertain" | "superseded";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "uncertain" | "skipped";
export interface ArenaStep { id: string; versionId: string; stage: Stage; role: string; status: StepStatus; error: string | null; startedAt: string | null; finishedAt: string | null }
export interface ArenaEvent { seq: number; arenaId: string; versionId: string; type: string; stage: Stage | null; actor: string | null; message: string; data: unknown; createdAt: string }
export interface ArenaVersion {
  id: string; number: number; challenge: Challenge; status: RunStatus; stage: Stage;
  strategies: Strategy[]; attacks: Attack[]; evidence: Evidence[]; revisions: Revision[];
  verdict: Verdict | null; costCny: number; reservedCny: number; createdAt: string;
  changeReason: string; parentVersionId: string | null; error: string | null;
}
export interface ArenaSnapshot {
  id: string; activeVersionId: string; createdAt: string;
  versions: ArenaVersion[]; steps: ArenaStep[]; events: ArenaEvent[];
  model: { id: string; configured: boolean; promptVersion: string; schemaVersion: string };
}
export interface ModelUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; estimatedCny: number; model: string; responseId: string; durationMs: number }
export interface ModelResult<T> { value: T; usage: ModelUsage }
export interface StageInput {
  challenge: Challenge; role: string; strategies: Strategy[]; attacks: Attack[]; evidence: Evidence[];
  revisions: Revision[]; userChallenges: string[]; previousStrategy?: Strategy; duplicateHint?: string;
  repairFeedback?: string; rejectedOutput?: string;
  evaluationMode?: "strong-single" | "independent" | "arena"; contextHistory?: string[];
}
export const InterventionSchema = z.object({ targetStrategyId: z.enum(["A", "B", "C"]), targetClaimId: short, text: z.string().min(3).max(1000) });
export const VersionRequestSchema = z.object({ challenge: ChallengeSchema, changeReason: z.string().min(1).max(1000) });
