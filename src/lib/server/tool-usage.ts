import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface ToolUsage {
  estimatedUsd: number;
  reservedUsd: number;
  requests: number;
}
/** Read-only projection. Model amounts and tokens keep their original ledger identities. */
export function toolUsage(versionIds?: string[]): ToolUsage {
  const empty = { estimatedUsd: 0, reservedUsd: 0, requests: 0 };
  const path = process.env.ARENA_BILLING_DATABASE_PATH;
  if (!path || !existsSync(path) || versionIds?.length === 0) return empty;
  const connection = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      !connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_attempts'")
        .get()
    )
      return empty;
    const where = versionIds ? ` WHERE version_id IN (${versionIds.map(() => "?").join(",")})` : "";
    const row = connection
      .prepare(
        `SELECT COUNT(*) AS requests,COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE 0 END),0) AS settled,COALESCE(SUM(CASE WHEN state!='settled' THEN reserved_usd_micros ELSE 0 END),0) AS reserved FROM tool_attempts${where}`,
      )
      .get(...(versionIds ?? [])) as { requests: number; settled: number; reserved: number };
    return {
      requests: row.requests,
      estimatedUsd: row.settled / 1e6,
      reservedUsd: row.reserved / 1e6,
    };
  } finally {
    connection.close();
  }
}
