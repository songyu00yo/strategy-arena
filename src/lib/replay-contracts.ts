import type { ArenaEvent, Challenge, ModelUsage } from "./contracts";
import type { ClarificationRun, DecisionItem } from "./clarification-contracts";
import type { IntakeQuestion, RecordedAnswer } from "./intake-contracts";

export type ReplayActionKind =
  | "questions"
  | "answer"
  | "round_confirm"
  | "summary_submit"
  | "summary_confirm"
  | "handoff";

/** Evidence for a saved action. Playback timing is illustrative, never a captured click duration. */
export interface ReplayActionSource {
  kind: "api_request" | "snapshot";
  reference: string;
  sha256?: string;
  requestIndex?: number;
  method?: string;
  path?: string;
}

export interface ReplayAction {
  id: string;
  kind: ReplayActionKind;
  round: number;
  revision: number;
  versionId?: string;
  sourceRunId?: string;
  /** Keep the full original question group stable throughout its answer actions. */
  questions?: IntakeQuestion[];
  /** One saved answer for `answer`, the complete accepted group for `round_confirm`. */
  answers?: RecordedAnswer[];
  /** Exact saved content for this submission. Missing content must not borrow the final summary. */
  summary?: { challenge: Challenge; assumptions: string[] };
  createdAt?: string;
  source?: ReplayActionSource;
}

/** Structural input shared by the pure adapter and the existing console's Beat. */
export interface ReplayStep {
  id: string;
  clarificationRun?: ClarificationRun;
  replayAction?: ReplayAction;
}

export interface ReplayProjection {
  answers: RecordedAnswer[];
  items: DecisionItem[];
  retiredIds: string[];
  conflicts: string[];
  /** Titles of questions or review gaps that have appeared and remain unresolved. */
  unresolved: string[];
  calls: number;
  tokens: number;
  usage: ModelUsage[];
  logs: ArenaEvent[];
  summaryConfirmed: boolean;
  summary?: ReplayAction["summary"];
  /** Output is available. An explicitly requested draft keeps summaryConfirmed false. */
  handoffComplete: boolean;
}
