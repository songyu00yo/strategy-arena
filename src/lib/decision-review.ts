import { z } from "zod";
import type { ModelUsage } from "./contracts";

export const DECISION_REVIEW_MODEL = "gpt-6-luna" as const;
export const DECISION_ROUTE_CHOICES = ["conditional", "violates", "unknown"] as const;
export const DECISION_PREFERENCE_CHOICES = [
  "A",
  "B",
  "C",
  "tie",
  "insufficient",
  "infeasible",
] as const;
export const DECISION_QUESTION_NAMES = ["route_a", "route_b", "route_c", "preference"] as const;
export type DecisionQuestionName = (typeof DECISION_QUESTION_NAMES)[number];
export interface DecisionChoiceAnswer {
  type: "choice";
  name: DecisionQuestionName;
  choice: string;
  confidence: number;
  probabilities: Array<{ value: string; probability: number }>;
}
export interface DecisionRefusalAnswer {
  type: "refusal";
  name: DecisionQuestionName;
}
export type DecisionAnswer = DecisionChoiceAnswer | DecisionRefusalAnswer;
export interface DecisionReviewUsage extends ModelUsage {
  cacheWriteInputTokens?: number;
}
export interface DecisionReview {
  id: string;
  arenaId: string;
  versionId: string;
  operationId: string;
  model: typeof DECISION_REVIEW_MODEL;
  status: "pending" | "completed" | "failed" | "uncertain";
  inputHash: string;
  configurationHash: string;
  stale: boolean;
  answers: DecisionAnswer[];
  usage: DecisionReviewUsage | null;
  responseIdSource: "x-request-id" | "local-call-id" | null;
  reservedUsd: number;
  error: string | null;
  errorCode: string | null;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
}
export const DecisionReviewRequestSchema = z.object({
  versionId: z.string().uuid(),
  operationId: z.string().uuid(),
});
export const DecisionReviewQuerySchema = z.object({ versionId: z.string().uuid() });
