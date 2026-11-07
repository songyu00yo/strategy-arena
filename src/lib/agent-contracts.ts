import { z } from "zod";
import { ToolRequestSchema, type Stage, type StepStatus } from "./contracts";

export const AGENT_PROTOCOL = "bounded-agent-1";
export const AGENT_LIMITS = {
  modelRequests: 20,
  tools: 12,
  externalTools: 6,
  plans: 3,
  rounds: 2,
} as const;
export const AgentPlanSchema = z.object({
  summary: z.string().min(1).max(500),
  questions: z.array(z.string().min(1).max(300)).max(6),
  directions: z
    .array(z.object({ role: z.enum(["A", "B", "C"]), brief: z.string().min(1).max(300) }))
    .max(3),
  tools: z.array(ToolRequestSchema).max(6),
  next: z.enum(["discuss", "supplement", "second_round", "judge"]),
  reviseRoles: z.array(z.enum(["A", "B", "C"])).max(3),
  stopCondition: z.string().min(1).max(500),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;
export interface AgentAction {
  id: string;
  kind: "plan" | "tools" | Stage;
  role: string;
  round: number;
  dependencies: string[];
  status: StepStatus;
  inputHash?: string;
}
export interface AgentState {
  protocol: string;
  configurationHash?: string;
  limits: typeof AGENT_LIMITS;
  plans: Array<AgentPlan & { checkpoint: number; evidenceHash: string }>;
  actions: AgentAction[];
  toolsUsed: number;
  externalToolsUsed: number;
  stopReason?: string;
}
