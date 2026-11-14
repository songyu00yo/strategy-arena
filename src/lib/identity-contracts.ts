import { z } from "zod";

export interface IdentityState {
  identityTag: string;
  hasRecoveryCode: boolean;
}
export const RecoveryCodeRequestSchema = z.object({
  expectedIdentityTag: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ActivateRecoveryCodeRequestSchema = RecoveryCodeRequestSchema.extend({
  code: z.string().min(1).max(160),
});
export const RecoverIdentityRequestSchema = z.object({
  code: z.string().min(1).max(160),
  expectedIdentityTag: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export interface RecoveryCodeResult extends IdentityState {
  recoveryCode: string;
}
export interface ArenaHistoryItem {
  id: string;
  goal: string;
  createdAt: string;
  activeVersionId: string;
  status: string;
  stage: string;
  versionCount: number;
}
export interface IntakeHistoryItem {
  id: string;
  goal: string;
  updatedAt: number;
  status: string;
}
export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
}
