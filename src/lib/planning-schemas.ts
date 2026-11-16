import { z } from "zod";
import { ModelModeSchema } from "./contracts";

const identifier = z.string().min(1).max(100);
const text = z.string().max(6000);
export const PlanningDimensionSchema = z.enum([
  "function",
  "content",
  "flow",
  "style",
  "constraints",
  "delivery",
]);
export const PlanningSourceSchema = z.object({
  kind: z.enum(["goal", "answer", "note", "material", "analysis"]),
  id: identifier,
  quote: z.string().max(4000),
});
export const CreatePlanningSchema = z
  .object({
    operationId: z.string().uuid(),
    goal: z.string().trim().min(2).max(6000),
    modelMode: ModelModeSchema,
  })
  .strict();
export const PlanningAnswerInputSchema = z
  .object({
    questionId: identifier,
    questionVersion: z.number().int().positive(),
    state: z.enum(["answered", "unknown", "skipped"]),
    optionIds: z.array(identifier).max(12),
    text: z.string().max(6000),
    number: z.number().finite().nullable(),
  })
  .strict();
const actionBase = {
  operationId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
};
export const PlanningActionSchema = z.discriminatedUnion("kind", [
  z.object({ ...actionBase, kind: z.literal("advance") }).strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("answer"),
      answers: z.array(PlanningAnswerInputSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("note"),
      text: z.string().trim().min(1).max(6000),
      itemIds: z.array(identifier).max(60),
    })
    .strict(),
  z.object({ ...actionBase, kind: z.literal("preview") }).strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("confirm"),
      reportId: identifier,
      fingerprint: z.string().min(1).max(128),
    })
    .strict(),
  z.object({ ...actionBase, kind: z.literal("stop") }).strict(),
]);

export const PlanningAnalysisOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  items: z
    .array(
      z.object({
        id: identifier,
        dimension: PlanningDimensionSchema,
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(3000),
        status: z.enum(["open", "proposed", "not_applicable"]).default("open"),
        required: z.boolean(),
        dependsOn: z.array(identifier).max(30).default([]),
        sources: z.array(PlanningSourceSchema).max(16).default([]),
        reason: z.string().max(1500).default(""),
      }),
    )
    .min(1)
    .max(40),
});
export const PlanningQuestionsOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  questions: z
    .array(
      z.object({
        id: identifier,
        itemIds: z.array(identifier).min(1).max(6),
        title: z.string().min(1).max(400),
        reason: z.string().max(1000),
        type: z.enum(["single", "multiple", "text", "number"]),
        options: z
          .array(
            z.object({
              id: identifier,
              label: z.string().min(1).max(150),
              description: z.string().max(1600),
              consequences: z.array(z.string().max(600)).max(6).default([]),
            }),
          )
          .max(8),
        placeholder: z.string().max(300).default(""),
        unit: z.string().max(40).default(""),
        minSelections: z.number().int().min(0).max(8).default(1),
        maxSelections: z.number().int().min(1).max(8).default(1),
        allowUnknown: z.boolean().default(true),
        allowSkip: z.boolean().default(true),
      }),
    )
    .max(3),
});
export const PlanningSectionOutputSchema = z.object({
  id: identifier,
  title: z.string().min(1).max(200),
  content: text,
  itemIds: z.array(identifier).max(40).default([]),
  sources: z.array(PlanningSourceSchema).max(20).default([]),
});
export const PlanningReviewOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  ready: z.boolean(),
  coverage: z
    .array(
      z.object({
        dimension: PlanningDimensionSchema,
        status: z.enum(["open", "covered", "not_applicable"]),
        reason: z.string().max(2000),
        itemIds: z.array(identifier).max(40),
      }),
    )
    .max(6),
  blockers: z
    .array(
      z.object({
        id: identifier,
        itemIds: z.array(identifier).max(40),
        description: z.string().max(2000),
      }),
    )
    .max(30),
  risks: z.array(z.string().max(2000)).max(20),
  uncertainties: z.array(z.string().max(2000)).max(20),
  report: z.object({
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(3000),
    sections: z.array(PlanningSectionOutputSchema).min(1).max(16),
    tasks: z
      .array(
        z.object({
          id: identifier,
          title: z.string().min(1).max(300),
          instructions: z.string().min(1).max(4000),
          dependsOn: z.array(identifier).max(30),
          acceptance: z.array(z.string().max(1000)).max(12),
        }),
      )
      .max(30),
    risks: z.array(z.string().max(2000)).max(20),
    unresolved: z.array(z.string().max(2000)).max(30),
    acceptance: z.array(z.string().max(1000)).max(20),
    executionPrompt: z.string().min(1).max(16000),
  }),
});
export type PlanningAnalysisOutput = z.infer<typeof PlanningAnalysisOutputSchema>;
export type PlanningQuestionsOutput = z.infer<typeof PlanningQuestionsOutputSchema>;
export type PlanningReviewOutput = z.infer<typeof PlanningReviewOutputSchema>;
