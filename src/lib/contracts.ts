import { z } from "zod";
import { MODEL_IDS } from "./model-catalog";

export const SCHEMA_VERSION = "1.3.1";
export const STAGES = ["propose", "attack", "verify", "revise", "judge"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  propose: "独立提案",
  attack: "交叉质疑",
  verify: "证据核验",
  revise: "策略修订",
  judge: "条件裁决",
};
const short = z.string().min(1).max(500);
export const ChallengeSchema = z.object({
  goal: z.string().min(8, "请用至少 8 个字描述你的目标").max(3000),
  constraints: z.string().max(3000).default(""),
  preferences: z.string().max(1500).default(""),
  options: z.array(z.string().min(1).max(300)).max(3).default([]),
  materials: z.string().max(20000).default(""),
  domain: z.enum(["learning", "life", "work", "creation", "general"]).default("general"),
  budget: z.number().min(0).max(100000000).nullable().default(null),
  timeHours: z.number().min(0.01).max(100000).nullable().default(null),
});
export type Challenge = z.infer<typeof ChallengeSchema>;
export const ModelModeSchema = z.enum([...MODEL_IDS, "auto", "deepseek", "gpt"]);
export type ModelMode = z.infer<typeof ModelModeSchema>;
export type ModelProvider = "deepseek" | "openai";
export type Currency = "CNY" | "USD";
export interface ModelSelection {
  requestedMode: ModelMode;
  provider: ModelProvider;
  modelId: string;
  currency: Currency;
  policyVersion: string;
  reason: string;
}
export interface ModelOption {
  provider: ModelProvider;
  id: string;
  configured: boolean;
  currency: Currency;
  error?: string;
}
export interface ModelCatalogOption extends ModelOption {
  label: string;
  inputPrice: number;
  outputPrice: number;
}
export const ExecutionModeSchema = z.enum(["fixed", "agent"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export const CreateArenaRequestSchema = ChallengeSchema.extend({
  executionMode: ExecutionModeSchema.default("agent"),
  modelMode: ModelModeSchema.default("auto"),
});
export const ClaimSchema = z.object({
  id: short,
  text: short,
  status: z.enum(["user", "estimate", "unknown", "supported"]).default("unknown"),
  sourceIds: z.array(z.string()).default([]),
});
export const CostPlanSchema = z.object({
  complete: z.boolean(),
  items: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,16}$/),
        label: z.string().min(1).max(24),
        amount: z.number().nonnegative().max(100000000).nullable(),
        basis: z.enum(["user", "assumption", "unknown"]),
        quote: z.string().max(200),
      }),
    )
    .max(8),
});
export type CostPlan = z.infer<typeof CostPlanSchema>;
export const StrategySchema = z.object({
  id: z.enum(["A", "B", "C"]),
  title: z.string().min(1).max(50),
  thesis: short,
  steps: z.array(short).min(1).max(6),
  claims: z.array(ClaimSchema).min(1).max(3),
  resources: short,
  costPlan: CostPlanSchema.optional(),
  firstAction: short,
  failureCondition: short,
  estimatedCost: z.number().nonnegative().nullable().default(null),
  estimatedHours: z.number().nonnegative().nullable().default(null),
});
export type Strategy = z.infer<typeof StrategySchema>;
export const ToolRequestSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search_materials"), query: z.string().min(1).max(300) }),
  z.object({ tool: z.literal("search_web"), query: z.string().min(1).max(300) }),
  z.object({ tool: z.literal("read_web"), url: z.string().url().max(2000) }),
  z.object({
    tool: z.literal("calculate"),
    expression: z.string().min(1).max(300),
    assumptions: z.string().min(1).max(700),
  }),
]);
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export const AttackSchema = z.object({
  id: short,
  from: z.string().min(1).max(30),
  targetStrategyId: z.enum(["A", "B", "C"]),
  targetClaimId: short,
  claimQuote: short,
  reason: short,
  impact: short,
  verification: short,
  requests: z.array(ToolRequestSchema).max(2),
  status: z.enum(["pending", "supported", "refuted", "unresolved"]).default("pending"),
});
export type Attack = z.infer<typeof AttackSchema> & { round?: number; targetRevisionHash?: string };
export const EvidenceSchema = z.object({
  id: short,
  attackId: short,
  tool: z.enum(["search_materials", "calculate", "constraint_check", "search_web", "read_web"]),
  status: z.enum(["found", "calculated", "unavailable", "error"]),
  title: short,
  content: z.string().max(6000),
  source: short,
  sourceIds: z.array(z.string()).default([]),
  provenance: z
    .enum([
      "user_text",
      "document",
      "model_transcription",
      "model_interpretation",
      "unknown",
      "web",
    ])
    .optional(),
  references: z
    .array(
      z.object({
        id: z.string(),
        location: z.string(),
        url: z.string().optional(),
        contentHash: z.string(),
        corpusHash: z.string().optional(),
        accessedAt: z.string().optional(),
      }),
    )
    .optional(),
  query: z.string().optional(),
  actionId: z.string().optional(),
  estimateScope: z.enum(["proposal", "final"]).optional(),
  expression: z.string().nullable().default(null),
  result: z.number().nullable().default(null),
  assumptions: z.string().default(""),
  createdAt: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export const RevisionSchema = z.object({
  strategyId: z.enum(["A", "B", "C"]),
  strategy: StrategySchema,
  responses: z
    .array(
      z.object({
        attackId: short,
        decision: z.enum(["accept", "reject", "unresolved"]),
        reason: short,
        evidenceIds: z.array(z.string()),
        change: z.string().max(800),
      }),
    )
    .max(6),
  summary: short,
  changed: z.boolean(),
});
export type Revision = z.infer<typeof RevisionSchema> & { revisionId?: string; round?: number };
export const VerdictSchema = z.object({
  outcome: z.enum(["recommendation", "tie", "insufficient", "infeasible", "partial"]),
  preferred: z.enum(["A", "B", "C"]).nullable(),
  headline: short,
  rationale: short,
  conditions: z.array(short).max(5),
  uncertainties: z.array(short).max(6),
  nextActions: z.array(short).min(1).max(5),
  exitCondition: short,
  evidenceIds: z.array(z.string()),
  comparisons: z
    .array(
      z.object({
        strategyId: z.enum(["A", "B", "C"]),
        status: z.enum(["eligible", "violates", "unknown"]),
        reason: short,
        basis: z.enum(["user", "assumption", "unknown"]).optional(),
        quote: z.string().max(300).optional(),
      }),
    )
    .max(3),
  attackFindings: z
    .array(
      z.object({
        attackId: short,
        status: z.enum(["supported", "refuted", "unresolved"]),
        reason: short,
        evidenceIds: z.array(z.string()),
      }),
    )
    .default([]),
});
export const GeneratedStrategySchema = StrategySchema.required({ costPlan: true });
export const GeneratedRevisionSchema = RevisionSchema.extend({ strategy: GeneratedStrategySchema });
export const GeneratedVerdictSchema = VerdictSchema.extend({
  comparisons: z
    .array(
      VerdictSchema.shape.comparisons.element
        .extend({
          reason: z.string().min(1).max(320),
        })
        .required({ basis: true, quote: true }),
    )
    .max(3),
});
export type Verdict = z.infer<typeof VerdictSchema>;
export type RunStatus =
  | "ready"
  | "running"
  | "completed"
  | "paused"
  | "failed"
  | "uncertain"
  | "superseded";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "uncertain" | "skipped";
export interface ArenaStep {
  kind?: import("./agent-contracts").AgentAction["kind"];
  round?: number;
  id: string;
  versionId: string;
  stage: Stage;
  role: string;
  status: StepStatus;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ArenaEvent {
  seq: number;
  arenaId: string;
  versionId: string;
  type: string;
  stage: Stage | null;
  actor: string | null;
  message: string;
  data: unknown;
  createdAt: string;
}
export interface ArenaVersion {
  executionMode?: ExecutionMode;
  agent?: import("./agent-contracts").AgentState;
  corpusHash?: string;
  toolCostUsd?: number;
  toolReservedUsd?: number;
  toolUsage?: { estimatedUsd: number; reservedUsd: number; requests: number };
  id: string;
  number: number;
  challenge: Challenge;
  status: RunStatus;
  stage: Stage;
  strategies: Strategy[];
  attacks: Attack[];
  evidence: Evidence[];
  revisions: Revision[];
  verdict: Verdict | null;
  costCny: number;
  reservedCny: number;
  costUsd?: number;
  reservedUsd?: number;
  modelSelection?: ModelSelection;
  intake?: {
    id: string;
    originalGoal: string;
    answers: import("./intake-contracts").RecordedAnswer[];
    assumptions: string[];
    usedSources: import("./intake-contracts").MaterialSource[];
    usage: ModelUsage[];
  };
  createdAt: string;
  changeReason: string;
  parentVersionId: string | null;
  followUp?: FollowUpInput & { sourceVersionId: string };
  error: string | null;
  runConfiguration?: Record<string, unknown>;
  configurationHash?: string;
}
export interface ArenaSnapshot {
  id: string;
  activeVersionId: string;
  createdAt: string;
  versions: ArenaVersion[];
  steps: ArenaStep[];
  events: ArenaEvent[];
  eventCursor?: number;
  drafts?: ModelDraft[];
  model: {
    id: string;
    configured: boolean;
    promptVersion: string;
    schemaVersion: string;
    providers?: ModelOption[];
    models?: ModelCatalogOption[];
    tools?: { webConfigured: boolean; protocol: string; provider?: "deepseek" | "tavily" };
  };
}
export interface ModelDraft {
  stepId: string;
  versionId: string;
  stage: Stage;
  role: string;
  revision: number;
  fields: Record<string, string>;
  status: "generating" | "committed" | "rejected" | "interrupted";
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  serviceTier?: string;
  cacheWriteInputTokens?: number;
  cacheWrite30mInputTokens?: number;
  cacheWrite12hInputTokens?: number;
  estimatedCny: number;
  estimatedUsd?: number;
  currency?: Currency;
  provider?: ModelProvider;
  billingAttemptId?: string;
  model: string;
  responseId: string;
  durationMs: number;
}
export interface ModelFormatNormalization {
  kind: "single-redundant-trailing-object-brace";
  originalOutput: string;
  originalOutputSha256: string;
  removedSuffix: "}";
  removedOffset: number;
}
export interface ModelResult<T> {
  value: T;
  usage: ModelUsage;
  formatNormalization?: ModelFormatNormalization;
}
export interface StageInput {
  researchContext?: Evidence[];
  routeBrief?: string;
  toolCapabilities?: string[];
  challenge: Challenge;
  role: string;
  strategies: Strategy[];
  attacks: Attack[];
  evidence: Evidence[];
  revisions: Revision[];
  userChallenges: string[];
  assumptions?: string[];
  previousStrategy?: Strategy;
  duplicateHint?: string;
  repairFeedback?: string;
  rejectedOutput?: string;
  evaluationMode?: "strong-single" | "independent" | "arena";
  contextHistory?: string[];
}
export const InterventionSchema = z.object({
  targetStrategyId: z.enum(["A", "B", "C"]),
  targetClaimId: short,
  text: z.string().min(3).max(1000),
  baseVersionId: z.string().min(1).max(200).optional(),
  quote: short.optional(),
});
export const FollowUpSchema = z.object({
  stepId: z.string().min(1).max(600),
  quote: z.string().min(1).max(30000),
  text: z.string().trim().min(3).max(1000),
});
export type FollowUpInput = z.infer<typeof FollowUpSchema>;
export const VersionRequestSchema = z
  .object({
    challenge: ChallengeSchema,
    changeReason: z.string().min(1).max(1000),
    modelMode: ModelModeSchema.optional(),
    executionMode: ExecutionModeSchema.default("agent"),
    baseVersionId: z.string().min(1).max(200).optional(),
    followUp: FollowUpSchema.optional(),
  })
  .refine((value) => !value.followUp || !!value.baseVersionId, {
    message: "请指定补充意见对应的原版本。",
    path: ["baseVersionId"],
  });
