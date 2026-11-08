import type { DatabaseSync } from "node:sqlite";
import { usageLimitsEnabled } from "./usage-policy";

export class BillingError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export interface UsagePolicyAuditRow {
  revision: number;
  operation_id: string;
  changed_at: string;
  reason: string;
  previous_enabled: number;
  enabled: number;
  previous_policy_revision: number;
  billing_revision: number;
  previous_policy_json: string;
}

/** Historical ledgers remain capped until an explicit audited operator action. */
export function readLedgerUsagePolicy(connection: DatabaseSync) {
  const exists = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_usage_policy_audit'")
    .get();
  const audit = exists
    ? (connection
        .prepare("SELECT * FROM billing_usage_policy_audit ORDER BY revision")
        .all() as unknown as UsagePolicyAuditRow[])
    : [];
  const latest = audit.at(-1);
  return {
    usageLimitsEnabled: latest ? latest.enabled === 1 : true,
    usagePolicyRevision: latest?.revision ?? 0,
    usagePolicyAudit: audit,
  };
}

/** Every dispatch must agree with the persistent authorization, including old workers. */
export function assertLedgerUsagePolicy(connection: DatabaseSync, expected = usageLimitsEnabled()) {
  const policy = readLedgerUsagePolicy(connection);
  if (policy.usageLimitsEnabled !== expected) {
    throw new BillingError(
      "Shared billing usage policy differs; restart with the audited policy.",
      "BILLING_SETTINGS_MISMATCH",
    );
  }
  return policy.usageLimitsEnabled;
}
