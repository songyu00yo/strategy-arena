import { z } from "zod";
import { QuestionSchema, type RecordedAnswer } from "./intake-contracts";
import type { ModelUsage } from "./contracts";

export const ClarificationTopicSchema = z.enum([
  "scope",
  "function",
  "content",
  "flow",
  "style",
  "acceptance",
  "materials",
  "authorization",
]);
export type ClarificationTopic = z.infer<typeof ClarificationTopicSchema>;
const decisionId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const DecisionItemSchema = z.object({
  id: decisionId,
  topic: ClarificationTopicSchema,
  title: z.string().min(1).max(160),
  description: z.string().max(800),
  dependsOn: z.array(decisionId).max(12),
  required: z.boolean(),
  acceptance: z.array(z.string().min(1).max(300)).max(6),
  sourceRefs: z.array(z.string().max(160)).max(12),
  provided: z.object({ sourceRef: z.string().max(160), quote: z.string().max(1000) }).optional(),
});
export type DecisionItem = z.infer<typeof DecisionItemSchema>;
export const DecompositionSchema = z.object({
  summary: z.string().min(1).max(800),
  items: z.array(DecisionItemSchema).min(1).max(40),
  retired: z
    .array(
      z.object({
        id: decisionId,
        reason: z.string().min(1).max(300),
        answerIds: z.array(decisionId).min(1).max(8),
      }),
    )
    .max(20),
  suggestions: z.array(z.string().max(500)).max(12),
});
export const OptionReviewSchema = z.object({
  summary: z.string().min(1).max(800),
  questions: z.array(QuestionSchema.extend({ decisionId })).max(3),
  conflicts: z
    .array(
      z.object({
        decisionIds: z.array(decisionId).min(1).max(8),
        description: z.string().min(1).max(500),
      }),
    )
    .max(12),
});
export const HandoffReviewSchema = z.object({
  summary: z.string().min(1).max(500),
  ready: z.boolean(),
  projectOverview: z.string().max(1600).optional(),
  deliveryPlan: z
    .object({
      deliverables: z.array(z.string().min(1).max(200)).max(6),
      acceptanceStrategy: z.array(z.string().min(1).max(300)).max(6),
    })
    .optional(),
  coverage: z
    .array(
      z.object({
        topic: ClarificationTopicSchema,
        applicable: z.boolean(),
        reason: z.string().min(1).max(160),
        decisionIds: z.array(decisionId).max(20),
      }),
    )
    .max(8),
  gaps: z.array(DecisionItemSchema).max(12),
  conflicts: z.array(z.string().min(1).max(500)).max(8),
  feasibility: z
    .array(
      z.object({
        dimension: z.enum(["technical", "resource", "data", "security", "delivery", "integration"]),
        status: z.enum(["supported", "conditional", "unknown", "blocked"]),
        assessment: z.string().min(1).max(240),
        basis: z.string().min(1).max(220),
        uncertainty: z.string().min(1).max(160),
        validation: z.string().min(1).max(180),
      }),
    )
    .max(8)
    .default([]),
  implementationPlan: z
    .array(
      z.object({
        phase: z.string().min(1).max(80),
        objective: z.string().min(1).max(180),
        tasks: z.array(z.string().min(1).max(140)).min(1).max(6),
        dependencies: z.array(z.string().min(1).max(200)).max(6),
        deliverables: z.array(z.string().min(1).max(200)).max(6),
        acceptance: z.array(z.string().min(1).max(300)).max(6),
        estimate: z.string().min(1).max(60),
        estimateBasis: z.string().min(1).max(180),
        estimateUncertainty: z.string().min(1).max(160),
      }),
    )
    .max(8)
    .default([]),
  tradeoffs: z
    .array(
      z.object({
        decision: z.string().min(1).max(200),
        options: z
          .array(
            z.object({
              option: z.string().min(1).max(120),
              benefit: z.string().min(1).max(200),
              cost: z.string().min(1).max(200),
            }),
          )
          .min(2)
          .max(3),
        recommendation: z.string().min(1).max(300),
        basis: z.string().min(1).max(400),
        uncertainty: z.string().min(1).max(160),
      }),
    )
    .max(6)
    .default([]),
  risks: z
    .array(
      z.object({
        risk: z.string().min(1).max(300),
        likelihood: z.enum(["low", "medium", "high", "unknown"]),
        impact: z.enum(["low", "medium", "high", "unknown"]),
        basis: z.string().min(1).max(180),
        mitigation: z.string().min(1).max(180),
        uncertainty: z.string().min(1).max(160),
      }),
    )
    .max(8)
    .default([]),
});
export type Decomposition = z.infer<typeof DecompositionSchema>;
export type OptionReview = z.infer<typeof OptionReviewSchema>;
// Stored reviews can predate the report fields. Model responses are parsed with defaults above.
export type HandoffReview = z.input<typeof HandoffReviewSchema>;
export interface ClarificationRun {
  id: string;
  operationId: string;
  role: "A" | "B" | "C";
  round: number;
  basedOnRevision: number;
  status: "completed" | "failed" | "uncertain";
  summary: string;
  output:
    | Decomposition
    | OptionReview
    | HandoffReview
    | {
        error: string;
        repair?: { feedback: string; rejectedOutput: string };
      };
  usage: ModelUsage[];
  repairOf?: string;
  callIds?: string[];
  promptHash?: string;
  inputFingerprint?: string;
  createdAt: string;
}
export interface ClarificationRound {
  round: number;
  revision: number;
  questions: z.infer<typeof OptionReviewSchema>["questions"];
  answers: RecordedAnswer[];
  changes: { added: string[]; retired: string[]; changed: string[]; triggerAnswerIds: string[] };
  runIds: string[];
  createdAt: string;
}
export interface ClarificationState {
  protocol: "clarification-1";
  items: DecisionItem[];
  retiredIds: string[];
  runs: ClarificationRun[];
  rounds: ClarificationRound[];
  suggestions: string[];
  conflicts: string[];
  review: (HandoffReview & { fingerprint: string; basedOnRevision: number }) | null;
  next: "questions" | "summary" | "completed";
  draftOnly: boolean;
  requestedDraft?: boolean;
  analysisFingerprint?: string;
  specification: string;
  executionPrompt: string;
  feedback?: Array<{
    kind: "executor_question" | "user_adoption" | "user_change";
    text: string;
    createdAt: string;
    source: string;
  }>;
}
