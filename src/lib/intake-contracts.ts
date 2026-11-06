import { z } from "zod";
import {
  ChallengeSchema,
  ModelModeSchema,
  type Challenge,
  type ModelMode,
  type ModelUsage,
} from "./contracts";

export const QuestionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  title: z.string().min(1).max(160),
  reason: z.string().min(1).max(240),
  placeholder: z.string().max(200),
  type: z.enum(["text", "single", "multiple", "number"]),
  options: z.array(z.string().min(1).max(100)).max(6),
  unit: z.string().max(30),
});
export type IntakeQuestion = z.infer<typeof QuestionSchema>;
export const AnswerSchema = z.object({
  questionId: z.string().min(1).max(40),
  state: z.enum(["answered", "unknown", "skipped"]),
  value: z.union([z.string().max(3000), z.array(z.string().max(100)).max(6)]),
});
export type IntakeAnswer = z.infer<typeof AnswerSchema>;
export type RecordedAnswer = IntakeAnswer & { question: IntakeQuestion };
export interface MaterialSource {
  id: string;
  attachmentId: string;
  filename: string;
  location: string;
  text: string;
  interpretation: boolean;
  origin?: "document" | "model_transcription" | "model_interpretation";
}
export interface IntakeAttachment {
  id: string;
  name: string;
  size: number;
  state: "reading" | "ready" | "needs_pages" | "failed";
  pageCount?: number;
  imageCount: number;
  interpreted: boolean;
  locations: string[];
  warnings: string[];
  error?: string;
}
export interface IntakeDraft {
  id: string;
  revision: number;
  goal: string;
  modelMode: ModelMode;
  status: "input" | "analyzing" | "questions" | "summary" | "failed" | "uncertain" | "submitted";
  round: number;
  questions: IntakeQuestion[];
  answers: RecordedAnswer[];
  challenge: Challenge | null;
  assumptions: string[];
  attachments: IntakeAttachment[];
  sources: MaterialSource[];
  usedSourceIds: string[];
  usage: ModelUsage[];
  reservedCny?: number;
  reservedUsd?: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  arenaId: string | null;
}
export const CreateIntakeSchema = z.object({
  goal: z.string().max(3000).default(""),
  modelMode: ModelModeSchema.default("gpt-6.1-terra"),
});
export const UpdateIntakeSchema = z.object({
  revision: z.number().int().nonnegative(),
  goal: z.string().max(3000).optional(),
  modelMode: ModelModeSchema.optional(),
  answers: z.array(AnswerSchema).max(3).optional(),
  summary: z
    .object({
      challenge: ChallengeSchema,
      assumptions: z.array(z.string().max(500)).max(6),
    })
    .optional(),
});
export const AnalyzeIntakeSchema = z.object({
  revision: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
  finish: z.boolean().default(false),
});
export const SubmitIntakeSchema = z.object({
  revision: z.number().int().nonnegative(),
  challenge: ChallengeSchema,
  assumptions: z.array(z.string().max(500)).max(6).default([]),
});
export const SelectPagesSchema = z.object({
  pages: z.array(z.number().int().positive()).min(1).max(20),
});

// Numeric -1 represents an unspecified resource. It is converted to null before creating a Challenge.
export const IntakeAnalysisSchema = z.object({
  ready: z.boolean(),
  goal: z.string().min(8).max(3000),
  constraints: z.string().max(3000),
  preferences: z.string().max(1500),
  options: z.array(z.string().min(1).max(300)).max(3),
  domain: z.enum(["learning", "life", "work", "creation", "general"]),
  budget: z.number().min(-1).max(100000000),
  budgetQuote: z.string().max(300),
  timeHours: z.number().min(-1).max(100000),
  timeQuote: z.string().max(300),
  assumptions: z.array(z.string().max(500)).max(6),
  questions: z.array(QuestionSchema).max(3),
});
export const VisualReadingSchema = z.object({
  readings: z
    .array(
      z.object({
        location: z.string().min(1).max(200),
        transcription: z.string().max(12000),
        interpretation: z.string().max(3000),
        uncertain: z.string().max(1000),
      }),
    )
    .min(1)
    .max(3),
});
