/**
 * Public presentation contract for the requirements-planning workspace.
 * This file defines data only. It does not implement APIs or authorize actions.
 * Backend owns this contract; frontend consumes it without manufacturing events.
 */
export const PLANNING_CONTRACT_VERSION = "2.0.0" as const;
export const PLANNING_AGENT_IDS = ["A", "B", "D", "E", "C"] as const;
export type PlanningAgentId = (typeof PLANNING_AGENT_IDS)[number];
export type PlanningActor = PlanningAgentId | "user" | "system";
export type PlanningStatus =
  | "ready"
  | "working"
  | "awaiting_user"
  | "review_ready"
  | "completed"
  | "paused"
  | "failed"
  | "uncertain";
export type PlanningDimension =
  | "function"
  | "content"
  | "flow"
  | "style"
  | "constraints"
  | "delivery";

export type PlanningCoverageArea =
  | "goal"
  | "resources"
  | "time_cost"
  | "constraints"
  | "risks"
  | "implementation"
  | "mvp";
export interface PlanningCoverageEntry {
  area: PlanningCoverageArea;
  status: "covered" | "partial" | "unknown";
  reason: string;
  itemIds: string[];
  /** An assessment can explicitly identify unknown information without verifying it. */
  assessedBy: PlanningAgentId | null;
}
export interface PlanningProgress {
  round: number;
  questionLimit: number;
  questionsIssued: number;
  /** Unknown and skipped responses count toward this total. */
  questionsAnswered: number;
  /** Limit minus answered: includes both outstanding questions and unissued slots. */
  questionsRemaining: number;
  /** Additional question slots: withdrawn questions do not refund a slot. */
  questionSlotsRemaining: number;
  activeQuestions: number;
  stage: "understanding" | "clarifying" | "feasibility" | "production" | "synthesizing" | "report";
  budgetExhausted: boolean;
  endedEarly: boolean;
  coverage: PlanningCoverageEntry[];
}

export interface PlanningSource {
  kind: "goal" | "answer" | "note" | "material" | "analysis";
  id: string;
  /** An exact quotation for user/material sources; analysis is labeled separately. */
  quote: string;
}

export interface PlanningSourceRecord {
  id: string;
  kind: PlanningSource["kind"];
  label: string;
  text: string;
  createdAt: string;
}

export interface PlanningItem {
  id: string;
  dimension: PlanningDimension;
  title: string;
  description: string;
  status: "open" | "proposed" | "confirmed" | "needs_review" | "deferred" | "not_applicable";
  required: boolean;
  /** Item IDs, not model execution-step IDs. */
  dependsOn: string[];
  sources: PlanningSource[];
  /** Set by a server-validated user action, never by model self-certification. */
  confirmation: { answerId: string | null; eventId: string; revision: number } | null;
  reason: string;
}

export interface PlanningOption {
  id: string;
  label: string;
  description: string;
  consequences: string[];
}

export interface PlanningQuestion {
  id: string;
  version: number;
  itemIds: string[];
  title: string;
  reason: string;
  type: "single" | "multiple" | "text" | "number";
  options: PlanningOption[];
  placeholder: string;
  unit: string;
  minSelections: number | null;
  maxSelections: number | null;
  /** The actual issuing role and actual receiving role determine paper motion. */
  askedBy: PlanningAgentId;
  answerTo: PlanningAgentId;
  status: "active" | "answered" | "withdrawn";
  allowUnknown: boolean;
  allowSkip: boolean;
}

export interface PlanningAnswerInput {
  questionId: string;
  questionVersion: number;
  state: "answered" | "unknown" | "skipped";
  optionIds: string[];
  text: string;
  number: number | null;
}

export interface PlanningAnswer extends PlanningAnswerInput {
  id: string;
  /** Preserve the question the user actually answered. */
  question: PlanningQuestion;
  createdAt: string;
  revision: number;
}

export interface PlanningAgentActivity {
  id: PlanningAgentId;
  name: string;
  responsibility: string;
  status: "idle" | "queued" | "running" | "awaiting_user" | "completed" | "failed" | "uncertain";
  taskId: string | null;
  operationId: string | null;
  taskLabel: string;
  summary: string;
  /** A readable partial output, not internal reasoning. Never treated as accepted data. */
  preview: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PlanningSection {
  id: string;
  title: string;
  content: string;
  itemIds: string[];
  sources: PlanningSource[];
}

export interface PlanningDraft {
  title: string;
  summary: string;
  sections: PlanningSection[];
  changes: { itemIds: string[]; before: string; after: string; reason: string }[];
}

export interface PlanningExpertResult {
  id: string;
  agentId: "D" | "E";
  round: number;
  basedOnRevision: number;
  contentFingerprint: string;
  summary: string;
  conclusion: "feasible" | "conditional" | "infeasible" | "insufficient_information";
  sections: PlanningSection[];
  risks: string[];
  unknowns: string[];
  nextSteps: string[];
  minimumViableVersion: string;
  createdAt: string;
}

export interface PlanningReview {
  id: string;
  basedOnRevision: number;
  /** Hash of the requirements content reviewed, not the review prose. */
  contentFingerprint: string;
  ready: boolean;
  coverage: {
    dimension: PlanningDimension;
    status: "open" | "covered" | "not_applicable";
    reason: string;
    itemIds: string[];
  }[];
  blockers: { id: string; itemIds: string[]; description: string }[];
  risks: string[];
  uncertainties: string[];
}

export interface PlanningReport {
  id: string;
  basedOnRevision: number;
  contentFingerprint: string;
  /** Hash of the exact report content offered to the user for confirmation. */
  fingerprint: string;
  status: "draft" | "confirmed";
  title: string;
  summary: string;
  sections: PlanningSection[];
  tasks: {
    id: string;
    title: string;
    instructions: string;
    dependsOn: string[];
    acceptance: string[];
  }[];
  risks: string[];
  unresolved: string[];
  acceptance: string[];
  executionPrompt: string;
  markdown: string;
  confirmedAt: string | null;
}

export interface PlanningEvent {
  id: string;
  seq: number;
  revision: number;
  operationId: string | null;
  kind:
    | "session_created"
    | "session_upgraded"
    | "round_started"
    | "questions_closed"
    | "agent_started"
    | "agent_completed"
    | "question_issued"
    | "answer_saved"
    | "note_saved"
    | "requirements_changed"
    | "review_completed"
    | "report_ready"
    | "report_confirmed"
    | "paused"
    | "failed"
    | "uncertain";
  actor: PlanningActor;
  from: PlanningActor | null;
  to: PlanningActor | null;
  questionId: string | null;
  questionVersion: number | null;
  answerId: string | null;
  itemIds: string[];
  title: string;
  detail: string;
  createdAt: string;
}

export interface PlanningCapabilities {
  canAdvance: boolean;
  canAnswer: boolean;
  canAddNote: boolean;
  canPreview: boolean;
  canConfirm: boolean;
  canStop: boolean;
  canStartRound: boolean;
  reason: string;
}

export interface PlanningSession {
  contractVersion: typeof PLANNING_CONTRACT_VERSION;
  id: string;
  /** Semantic content revision. Playback and activity progress do not increment it. */
  revision: number;
  goal: string;
  modelMode: string;
  productScope: "analysis_and_guidance";
  status: PlanningStatus;
  progress: PlanningProgress;
  agents: PlanningAgentActivity[];
  expertResults: PlanningExpertResult[];
  items: PlanningItem[];
  /** Resolve every referenced source by kind + id, including older answers and notes. */
  sourceRecords: PlanningSourceRecord[];
  questions: PlanningQuestion[];
  answers: PlanningAnswer[];
  draft: PlanningDraft | null;
  review: PlanningReview | null;
  report: PlanningReport | null;
  capabilities: PlanningCapabilities;
  nextAction: "advance" | "answer" | "review" | "confirm" | "start_round" | "none";
  activeOperationId: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningSnapshot {
  /** Monotonic per session across every visible server change, including previews. */
  snapshotVersion: number;
  session: PlanningSession;
  /** Authoritative recent events, ordered by seq. Repeated snapshots may repeat events. */
  events: PlanningEvent[];
  eventCursor: number;
}

export interface CreatePlanningInput {
  operationId: string;
  goal: string;
  modelMode: string;
}

export interface PlanningActionBase {
  operationId: string;
  revision: number;
}

export type PlanningAction = PlanningActionBase &
  (
    | { kind: "advance" }
    | { kind: "answer"; answers: PlanningAnswerInput[] }
    | { kind: "note"; text: string; itemIds: string[] }
    | { kind: "preview" }
    | { kind: "start_round" }
    | { kind: "confirm"; reportId: string; fingerprint: string }
    | { kind: "stop" }
  );

export interface PlanningApiError {
  error: string;
  code: string;
}

/** Presentation-only client state. Do not write any of these flags into the session. */
export interface PlanningClientState {
  pendingAction: PlanningAction["kind"] | "create" | null;
  refreshing: boolean;
  connectionError: string | null;
}
