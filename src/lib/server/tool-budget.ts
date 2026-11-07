import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Both official tariff references are retained. Six CNY/USD is the existing budget
// estimate, not an exchange rate or a statement about the account's native charge.
export const DEEPSEEK_WEB_PRICE_ESTIMATE = {
  usdPerRequest: 0.00075,
  cnyPerRequest: 0.005,
  cnyPerUsdBudgetEstimate: 6,
  reservedUsdMicros: Math.max(750, Math.ceil(5000 / 6)),
  estimated: true as const,
};

export class ToolBudgetError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "ToolBudgetError";
  }
}
export interface ToolReservation {
  attemptId: string;
  versionId: string;
  batchId: string;
  tool: "tavily_search" | "tavily_extract" | "deepseek_search" | "deepseek_fetch";
  provider?: "tavily" | "deepseek";
  request: Record<string, unknown>;
  usdPerCredit?: number;
}
export interface ToolAttempt {
  attempt_id: string;
  version_id: string;
  batch_id: string;
  tool: string;
  provider: "tavily" | "deepseek";
  unit: "credit" | "request";
  state: "reserved" | "held" | "settled";
  credits: number;
  reserved_usd_micros: number;
  settled_usd_micros: number | null;
  estimated: number;
  request_json: string;
  result_json: string | null;
  created_at: string;
  finished_at: string | null;
}
const schema = `
CREATE TABLE IF NOT EXISTS tool_budget_batches (
  batch_id TEXT PRIMARY KEY,
  model_baseline_rowid INTEGER NOT NULL,
  max_credits INTEGER NOT NULL CHECK(max_credits=20),
  max_usd_micros INTEGER NOT NULL CHECK(max_usd_micros=2000000),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_budget_authorizations (
  batch_id TEXT PRIMARY KEY REFERENCES tool_budget_batches(batch_id),
  model_requests INTEGER NOT NULL CHECK(model_requests BETWEEN 1 AND 100),
  web_requests INTEGER NOT NULL CHECK(web_requests BETWEEN 1 AND 40),
  usd_micros INTEGER NOT NULL CHECK(usd_micros BETWEEN 1 AND 3000000)
);
CREATE TABLE IF NOT EXISTS tool_attempts (
  attempt_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES tool_budget_batches(batch_id),
  tool TEXT NOT NULL CHECK(tool IN ('tavily_search','tavily_extract','deepseek_search','deepseek_fetch')),
  provider TEXT NOT NULL CHECK(provider IN ('tavily','deepseek')),
  unit TEXT NOT NULL CHECK(unit IN ('credit','request')),
  state TEXT NOT NULL CHECK(state IN ('reserved','held','settled')),
  credits INTEGER NOT NULL CHECK(credits BETWEEN 0 AND 1),
  reserved_usd_micros INTEGER NOT NULL CHECK(reserved_usd_micros>0),
  settled_usd_micros INTEGER,
  estimated INTEGER NOT NULL DEFAULT 1 CHECK(estimated=1),
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS tool_attempts_version ON tool_attempts(version_id);
CREATE INDEX IF NOT EXISTS tool_attempts_batch ON tool_attempts(batch_id);
`;
/** Additive identity migration. Historical amounts and result bodies are copied verbatim. */
function initializeToolSchema(connection: DatabaseSync) {
  const exists = hasTable(connection, "tool_attempts");
  if (exists) {
    const columns = connection.prepare("PRAGMA table_info(tool_attempts)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "provider")) {
      connection.exec(
        "ALTER TABLE tool_attempts RENAME TO tool_attempts_legacy; DROP INDEX IF EXISTS tool_attempts_version; DROP INDEX IF EXISTS tool_attempts_batch;",
      );
      connection.exec(schema);
      connection.exec(`INSERT INTO tool_attempts(rowid,attempt_id,version_id,batch_id,tool,provider,unit,state,credits,reserved_usd_micros,settled_usd_micros,estimated,request_json,result_json,created_at,finished_at)
        SELECT rowid,attempt_id,version_id,batch_id,tool,'tavily','credit',state,credits,reserved_usd_micros,settled_usd_micros,estimated,request_json,result_json,created_at,finished_at FROM tool_attempts_legacy;
        DROP TABLE tool_attempts_legacy;`);
    }
  }
  connection.exec(schema);
}
function identifier(value: string) {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(value))
    throw new ToolBudgetError("工具调用标识无效。", "TOOL_INVALID_ID");
}
function hasTable(connection: DatabaseSync, table: string) {
  return Boolean(
    connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}
/** May be called inside the model ledger write transaction, without opening another connection. */
export function readToolCommittedUsdMicros(
  connection: DatabaseSync,
  sinceCreatedAt?: string,
): number {
  if (!hasTable(connection, "tool_attempts")) return 0;
  const filter = sinceCreatedAt ? " WHERE created_at>=?" : "";
  const statement = connection.prepare(
    `SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE reserved_usd_micros END),0) AS total FROM tool_attempts${filter}`,
  );
  return (statement.get(...(sinceCreatedAt ? [sinceCreatedAt] : [])) as { total: number }).total;
}
function modelTotals(connection: DatabaseSync, baseline = 0) {
  return connection
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE reserved_usd_micros END),0) AS amount FROM billing_attempts WHERE rowid>?`,
    )
    .get(baseline) as { requests: number; amount: number };
}
export interface ToolBatchLimits {
  modelRequests: number;
  webRequests: number;
  usdMicros: number;
}
function batchLimits(connection: DatabaseSync, batchId: string): ToolBatchLimits {
  const approved = hasTable(connection, "tool_budget_authorizations")
    ? (connection
        .prepare("SELECT * FROM tool_budget_authorizations WHERE batch_id=?")
        .get(batchId) as
        | { model_requests: number; web_requests: number; usd_micros: number }
        | undefined)
    : undefined;
  return {
    modelRequests: approved?.model_requests ?? 20,
    webRequests: approved?.web_requests ?? 20,
    usdMicros: approved?.usd_micros ?? 2_000_000,
  };
}
export function configuredToolBatchId() {
  return process.env.ARENA_ACCEPTANCE_BATCH_ID || process.env.ARENA_TOOL_BATCH_ID || "";
}
/** Call from model.reserve inside its existing BEGIN IMMEDIATE transaction. */
export function assertToolBatchModelBudget(
  connection: DatabaseSync,
  additionalUsdMicros: number,
  batchId = configuredToolBatchId(),
) {
  if (!batchId) return;
  if (!hasTable(connection, "tool_budget_batches"))
    throw new ToolBudgetError("工具验收批次尚未初始化。", "TOOL_BATCH_NOT_INITIALIZED");
  const batch = connection
    .prepare("SELECT * FROM tool_budget_batches WHERE batch_id=?")
    .get(batchId) as { model_baseline_rowid: number; max_usd_micros: number } | undefined;
  if (!batch) throw new ToolBudgetError("工具验收批次尚未初始化。", "TOOL_BATCH_NOT_INITIALIZED");
  const models = modelTotals(connection, batch.model_baseline_rowid);
  const limits = batchLimits(connection, batchId);
  const tools = connection
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE reserved_usd_micros END),0) AS total FROM tool_attempts WHERE batch_id=?",
    )
    .get(batchId) as { total: number };
  if (
    models.requests + 1 > limits.modelRequests ||
    models.amount + tools.total + additionalUsdMicros > limits.usdMicros
  )
    throw new ToolBudgetError("本批次模型与工具共享额度已用尽。", "TOOL_BATCH_LIMIT_REACHED");
}
function withLedger<T>(databasePath: string | undefined, fn: (connection: DatabaseSync) => T): T {
  const path = databasePath ?? process.env.ARENA_BILLING_DATABASE_PATH ?? "";
  if (!path || !isAbsolute(path) || !existsSync(path))
    throw new ToolBudgetError("请先配置并初始化中央费用账本。", "TOOL_LEDGER_NOT_CONFIGURED");
  const connection = new DatabaseSync(path);
  try {
    connection.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
    if (!hasTable(connection, "billing_attempts") || !hasTable(connection, "billing_settings"))
      throw new ToolBudgetError("中央模型账本尚未初始化。", "TOOL_LEDGER_NOT_CONFIGURED");
    initializeToolSchema(connection);
    const value = fn(connection);
    connection.exec("COMMIT");
    return value;
  } catch (error) {
    if (connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  } finally {
    connection.close();
  }
}
/** Explicit batch identity must be stable across restarts. Invoke before the first model call. */
export function ensureToolBudgetBatch(
  batchId: string,
  databasePath?: string,
  approvedLimits?: ToolBatchLimits,
) {
  identifier(batchId);
  return withLedger(databasePath, (connection) =>
    ensureToolBudgetBatchOnConnection(connection, batchId, approvedLimits),
  );
}
/** Reuses the caller's write transaction. Never opens a second connection to a locked ledger. */
export function ensureToolBudgetBatchOnConnection(
  connection: DatabaseSync,
  batchId: string,
  approvedLimits?: ToolBatchLimits,
) {
  identifier(batchId);
  if (!connection.isTransaction)
    throw new ToolBudgetError("批次初始化须在账本写入事务内执行。", "TOOL_TRANSACTION_REQUIRED");
  initializeToolSchema(connection);
  const existing = connection
    .prepare("SELECT * FROM tool_budget_batches WHERE batch_id=?")
    .get(batchId);
  if (approvedLimits) {
    if (
      !Number.isSafeInteger(approvedLimits.modelRequests) ||
      approvedLimits.modelRequests < 1 ||
      approvedLimits.modelRequests > 100 ||
      !Number.isSafeInteger(approvedLimits.webRequests) ||
      approvedLimits.webRequests < 1 ||
      approvedLimits.webRequests > 40 ||
      !Number.isSafeInteger(approvedLimits.usdMicros) ||
      approvedLimits.usdMicros < 1 ||
      approvedLimits.usdMicros > 3_000_000
    )
      throw new ToolBudgetError("批次授权额度无效。", "TOOL_BATCH_INVALID_LIMITS");
    const stored = batchLimits(connection, batchId);
    if (existing && JSON.stringify(stored) !== JSON.stringify(approvedLimits))
      throw new ToolBudgetError("已有批次授权不可修改或重置。", "TOOL_BATCH_LIMITS_MISMATCH");
  }
  const baseline = (
    connection.prepare("SELECT COALESCE(MAX(rowid),0) AS baseline FROM billing_attempts").get() as {
      baseline: number;
    }
  ).baseline;
  connection
    .prepare(
      "INSERT OR IGNORE INTO tool_budget_batches(batch_id,model_baseline_rowid,max_credits,max_usd_micros,created_at) VALUES(?,?,20,2000000,?)",
    )
    .run(batchId, baseline, new Date().toISOString());
  if (!existing && approvedLimits)
    connection
      .prepare(
        "INSERT INTO tool_budget_authorizations(batch_id,model_requests,web_requests,usd_micros) VALUES(?,?,?,?)",
      )
      .run(
        batchId,
        approvedLimits.modelRequests,
        approvedLimits.webRequests,
        approvedLimits.usdMicros,
      );
  return connection.prepare("SELECT * FROM tool_budget_batches WHERE batch_id=?").get(batchId);
}
export function reserveToolAttempt(input: ToolReservation, databasePath?: string) {
  for (const value of [input.attemptId, input.versionId, input.batchId]) identifier(value);
  const provider = input.provider ?? (input.tool.startsWith("deepseek_") ? "deepseek" : "tavily");
  const price =
    provider === "deepseek"
      ? DEEPSEEK_WEB_PRICE_ESTIMATE.reservedUsdMicros / 1_000_000
      : (input.usdPerCredit ?? Number(process.env.TAVILY_USD_PER_CREDIT ?? "0.008"));
  const credits = provider === "tavily" ? 1 : 0;
  const amount = Math.round(price * 1_000_000);
  if (!Number.isSafeInteger(amount) || amount < 1 || Math.abs(price - amount / 1_000_000) > 1e-10)
    throw new ToolBudgetError("Tavily每credit费用估计配置无效。", "TOOL_PRICE_INVALID");
  return withLedger(databasePath, (connection) => {
    if (connection.prepare("SELECT 1 FROM tool_attempts WHERE attempt_id=?").get(input.attemptId))
      throw new ToolBudgetError("此工具调用已有记录，禁止重复发送。", "TOOL_DUPLICATE_ATTEMPT");
    const batch = connection
      .prepare("SELECT * FROM tool_budget_batches WHERE batch_id=?")
      .get(input.batchId) as
      | { model_baseline_rowid: number; max_credits: number; max_usd_micros: number }
      | undefined;
    if (!batch) throw new ToolBudgetError("工具验收批次尚未初始化。", "TOOL_BATCH_NOT_INITIALIZED");
    const count = (
      connection
        .prepare("SELECT COUNT(*) AS count FROM tool_attempts WHERE version_id=?")
        .get(input.versionId) as { count: number }
    ).count;
    const tools = connection
      .prepare(
        "SELECT COUNT(*) AS calls,COALESCE(SUM(credits),0) AS credits,COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE reserved_usd_micros END),0) AS amount FROM tool_attempts WHERE batch_id=?",
      )
      .get(input.batchId) as { calls: number; credits: number; amount: number };
    const models = modelTotals(connection, batch.model_baseline_rowid);
    const limits = batchLimits(connection, input.batchId);
    const settings = connection
      .prepare("SELECT usd_limit_micros,hard_total_usd_micros FROM billing_settings WHERE id=1")
      .get() as { usd_limit_micros: number; hard_total_usd_micros: number };
    const allAmount =
      modelTotals(connection).amount + readToolCommittedUsdMicros(connection) + amount;
    const stage = hasTable(connection, "billing_limit_audit")
      ? (connection
          .prepare(
            "SELECT baseline_rowid,changed_at,stage_usd_limit_micros FROM billing_limit_audit ORDER BY revision DESC LIMIT 1",
          )
          .get() as
          | { baseline_rowid: number; changed_at: string; stage_usd_limit_micros: number }
          | undefined)
      : undefined;
    const stageAmount = stage
      ? modelTotals(connection, stage.baseline_rowid).amount +
        readToolCommittedUsdMicros(connection, stage.changed_at) +
        amount
      : 0;
    if (
      count >= 6 ||
      tools.calls >= limits.webRequests ||
      tools.credits + credits > limits.webRequests ||
      models.requests > limits.modelRequests ||
      (stage && stageAmount > stage.stage_usd_limit_micros) ||
      tools.amount + models.amount + amount > limits.usdMicros ||
      allAmount > Math.min(settings.usd_limit_micros, settings.hard_total_usd_micros)
    )
      throw new ToolBudgetError(
        "工具调用次数或模型与工具共享费用额度已用尽。",
        "TOOL_LIMIT_REACHED",
      );
    connection
      .prepare(
        "INSERT INTO tool_attempts(attempt_id,version_id,batch_id,tool,provider,unit,state,credits,reserved_usd_micros,estimated,request_json,created_at) VALUES(?,?,?,?,?,?,'reserved',?,?,1,?,?)",
      )
      .run(
        input.attemptId,
        input.versionId,
        input.batchId,
        input.tool,
        provider,
        provider === "tavily" ? "credit" : "request",
        credits,
        amount,
        JSON.stringify(input.request),
        new Date().toISOString(),
      );
    return connection
      .prepare("SELECT * FROM tool_attempts WHERE attempt_id=?")
      .get(input.attemptId) as unknown as ToolAttempt;
  });
}
/** Unknown outcomes keep their reservation. Successful costs remain explicitly estimated. */
export function finishToolAttempt(
  attemptId: string,
  state: "held" | "settled",
  result: unknown,
  databasePath?: string,
  settledUsdMicros?: number,
) {
  identifier(attemptId);
  return withLedger(databasePath, (connection) => {
    const row = connection
      .prepare("SELECT * FROM tool_attempts WHERE attempt_id=?")
      .get(attemptId) as unknown as ToolAttempt | undefined;
    if (!row) throw new ToolBudgetError("未找到工具调用记录。", "TOOL_ATTEMPT_NOT_FOUND");
    const settlement = settledUsdMicros ?? row.reserved_usd_micros;
    if (!Number.isSafeInteger(settlement) || settlement < 0 || settlement > row.reserved_usd_micros)
      throw new ToolBudgetError("工具结算金额超出预留或无效。", "TOOL_SETTLEMENT_INVALID");
    const resultJson = JSON.stringify(result);
    if (row.state !== "reserved") {
      if (
        row.state === state &&
        row.result_json === resultJson &&
        (state !== "settled" || row.settled_usd_micros === settlement)
      )
        return;
      throw new ToolBudgetError("不能覆盖已有工具执行结果。", "TOOL_RESULT_CONFLICT");
    }
    connection
      .prepare(
        "UPDATE tool_attempts SET state=?,settled_usd_micros=?,result_json=?,finished_at=? WHERE attempt_id=?",
      )
      .run(
        state,
        state === "settled" ? settlement : null,
        resultJson,
        new Date().toISOString(),
        attemptId,
      );
  });
}
export function getToolAttempt(attemptId: string, databasePath?: string): ToolAttempt | undefined {
  identifier(attemptId);
  return withLedger(
    databasePath,
    (connection) =>
      connection
        .prepare("SELECT * FROM tool_attempts WHERE attempt_id=?")
        .get(attemptId) as unknown as ToolAttempt | undefined,
  );
}
