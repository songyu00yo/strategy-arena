import {
  readToolCommittedUsdMicros,
  assertToolBatchModelBudget,
  ensureToolBudgetBatchOnConnection,
  configuredToolBatchId,
} from "./tool-budget";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  assertLedgerUsagePolicy,
  BillingError,
  readLedgerUsagePolicy,
} from "./billing-usage-policy";
import { usageLimitsEnabled } from "./usage-policy";

export { BillingError } from "./billing-usage-policy";

// All amounts are integer micro units of their native currency. This fixed,
// deliberately conservative budget estimate is not a bank exchange rate.
export const BILLING_CNY_PER_USD = 6;
export const BILLING_HARD_TOTAL_USD_MICROS = 200_000_000;
export const BILLING_DEVELOPMENT_MAX_USD_MICROS = 120_000_000;
const MAX_VALUE = 1_000_000_000_000;

export interface BillingOptions {
  databasePath: string;
  usdLimit?: number;
  requestLimit?: number;
  tokenLimit?: number;
}
export interface BillingReservation {
  attemptId: string;
  provider: string;
  currency: "CNY" | "USD";
  estimatedAmount: number;
  maxTokens: number;
}
export interface BillingSettlement {
  amount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  responseId?: string;
  serviceTier?: string;
  model?: string;
  cacheWriteInputTokens?: number;
  cacheWrite30mInputTokens?: number;
  cacheWrite12hInputTokens?: number;
}
interface Settings {
  usd_limit_micros: number;
  request_limit: number;
  token_limit: number;
  schema_version: number;
  hard_total_usd_micros: number;
  cny_per_usd: number;
}
interface AttemptRow {
  attempt_id: string;
  provider: string;
  currency: "CNY" | "USD";
  state: "reserved" | "held" | "settled";
  estimated_amount_micros: number;
  reserved_usd_micros: number;
  max_tokens: number;
  amount_micros: number | null;
  settled_usd_micros: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  response_id: string | null;
  service_tier: string | null;
  model: string | null;
  cache_write_input_tokens: number | null;
  cache_write_30m_input_tokens: number | null;
  cache_write_12h_input_tokens: number | null;
}
function invalid(message: string): never {
  throw new BillingError(message, "BILLING_INVALID_CONFIG");
}
function integer(value: number, label: string, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_VALUE)
    invalid(`Invalid billing ${label}.`);
  return value;
}
function identifier(value: string, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value))
    invalid(`Invalid billing ${label}.`);
  return value;
}
function validateSettlementMetadata(settlement: BillingSettlement) {
  if (settlement.serviceTier !== undefined) identifier(settlement.serviceTier, "service tier");
  if (settlement.model !== undefined) identifier(settlement.model, "model");
  const total = settlement.cacheWriteInputTokens;
  const short = settlement.cacheWrite30mInputTokens;
  const long = settlement.cacheWrite12hInputTokens;
  for (const [value, label] of [
    [total, "cache write input tokens"],
    [short, "30m cache write input tokens"],
    [long, "12h cache write input tokens"],
  ] as const)
    if (value !== undefined) integer(value, label);
  if (total === undefined) {
    if (short !== undefined || long !== undefined)
      invalid("Cache write breakdown requires total cache write input tokens.");
    return;
  }
  if (settlement.cachedInputTokens + total > settlement.inputTokens)
    invalid("Cached and cache write input tokens exceed input tokens.");
  const breakdown = (short ?? 0) + (long ?? 0);
  if (breakdown > total || (short !== undefined && long !== undefined && breakdown !== total))
    invalid("Cache write breakdown does not match total cache write input tokens.");
}
function migrateSettlementMetadata(connection: DatabaseSync) {
  // ALTER-only migration: old settlement amounts, timestamps, and rowids stay intact.
  // Called inside the same write transaction as settings validation, so two workers
  // cannot race the schema change and a rejected open leaves the ledger unchanged.
  const columns = new Set(
    (connection.prepare("PRAGMA table_info(billing_attempts)").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  const addedColumns = [
    "service_tier",
    "model",
    "cache_write_input_tokens",
    "cache_write_30m_input_tokens",
    "cache_write_12h_input_tokens",
  ];
  const present = addedColumns.filter((column) => columns.has(column)).length;
  if (present === addedColumns.length) return;
  if (present !== 0) invalid("Incomplete billing settlement metadata schema.");
  connection.exec(
    readFileSync(resolve(process.cwd(), "migrations/billing/003_settlement_metadata.sql"), "utf8"),
  );
}
export function billingUsdMicros(amount: number, currency: "CNY" | "USD") {
  integer(amount, "amount");
  if (currency !== "CNY" && currency !== "USD") invalid("Invalid billing currency.");
  return currency === "USD" ? amount : Math.ceil(amount / BILLING_CNY_PER_USD);
}
function configuredNumber(name: string, fallback: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!value.trim()) invalid(`Invalid ${name}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) invalid(`Invalid ${name}.`);
  return parsed;
}
function configuredOptions(): BillingOptions {
  return {
    databasePath: process.env.ARENA_BILLING_DATABASE_PATH || "",
    usdLimit: configuredNumber("ARENA_BILLING_USD_LIMIT", 2),
    requestLimit: configuredNumber("ARENA_BILLING_REQUEST_LIMIT", 100),
    tokenLimit: configuredNumber("ARENA_BILLING_TOKEN_LIMIT", 2_000_000),
  };
}

/** A separate connection can share this ledger across independent workspaces.
 * No transaction remains open during an upstream request. Never remove an
 * unresolved attempt merely because its worker crashed before dispatch. */
export function openBillingLedger(options: BillingOptions) {
  validatePath(options.databasePath);
  const limitsEnabled = usageLimitsEnabled();
  const { usdMicros, requestLimit, tokenLimit } = validateLimits(options);
  mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const connection = new DatabaseSync(options.databasePath);
  const atomic = <T>(fn: () => T): T => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  };
  try {
    connection.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    atomic(() => {
      connection.exec(
        readFileSync(resolve(process.cwd(), "migrations/billing/001_initial.sql"), "utf8"),
      );
      connection.exec(
        readFileSync(resolve(process.cwd(), "migrations/billing/002_limit_audit.sql"), "utf8"),
      );
      connection
        .prepare(
          `INSERT OR IGNORE INTO billing_settings
          (id,schema_version,usd_limit_micros,request_limit,token_limit,hard_total_usd_micros,cny_per_usd,created_at)
          VALUES(1,1,?,?,?,?,?,?)`,
        )
        .run(
          usdMicros,
          requestLimit,
          tokenLimit,
          BILLING_HARD_TOTAL_USD_MICROS,
          BILLING_CNY_PER_USD,
          new Date().toISOString(),
        );
      const stored = connection.prepare("SELECT * FROM billing_settings WHERE id=1").get() as
        | Settings
        | undefined;
      if (
        !stored ||
        stored.schema_version !== 1 ||
        stored.usd_limit_micros !== usdMicros ||
        stored.request_limit !== requestLimit ||
        stored.token_limit !== tokenLimit ||
        stored.hard_total_usd_micros !== BILLING_HARD_TOTAL_USD_MICROS ||
        stored.cny_per_usd !== BILLING_CNY_PER_USD
      )
        throw new BillingError(
          "Shared billing settings differ. Existing limits cannot be changed by environment variables.",
          "BILLING_SETTINGS_MISMATCH",
        );
      migrateSettlementMetadata(connection);
      assertLedgerUsagePolicy(connection, limitsEnabled);
      const batchId = configuredToolBatchId();
      if (batchId) ensureToolBudgetBatchOnConnection(connection, batchId);
    });
  } catch (error) {
    connection.close();
    throw error;
  }
  function getAttempt(attemptId: string) {
    identifier(attemptId, "attempt ID");
    return connection
      .prepare("SELECT * FROM billing_attempts WHERE attempt_id=?")
      .get(attemptId) as AttemptRow | undefined;
  }
  function summary() {
    return readStatus(connection);
  }
  return {
    close: () => connection.close(),
    getAttempt,
    summary,
    unresolvedAttempts() {
      return connection
        .prepare(
          "SELECT attempt_id AS attemptId,state,reserved_usd_micros AS reservedUsdMicros FROM billing_attempts WHERE state IN ('reserved','held') ORDER BY attempt_id",
        )
        .all() as unknown as {
        attemptId: string;
        state: "reserved" | "held";
        reservedUsdMicros: number;
      }[];
    },
    reserve(input: BillingReservation) {
      identifier(input.attemptId, "attempt ID");
      identifier(input.provider, "provider");
      integer(input.maxTokens, "token reservation", true);
      const reservedUsdMicros = billingUsdMicros(input.estimatedAmount, input.currency);
      return atomic(() => {
        if (getAttempt(input.attemptId))
          throw new BillingError(
            "Billing attempt already exists; dispatch refused.",
            "BILLING_DUPLICATE_ATTEMPT",
          );
        assertLedgerUsagePolicy(connection, limitsEnabled);
        const totals = summary();
        if (
          totals.usdLimitMicros !== usdMicros ||
          totals.requestLimit !== requestLimit ||
          totals.tokenLimit !== tokenLimit
        )
          throw new BillingError(
            "Shared billing settings differ; restart with audited limits.",
            "BILLING_SETTINGS_MISMATCH",
          );
        const stage = totals.activeStage;
        const toolAmount = readToolCommittedUsdMicros(connection);
        const stageBoundary = stage
          ? (connection
              .prepare("SELECT changed_at FROM billing_limit_audit ORDER BY revision DESC LIMIT 1")
              .get() as { changed_at: string } | undefined)
          : undefined;
        const stageToolAmount = stageBoundary
          ? readToolCommittedUsdMicros(connection, stageBoundary.changed_at)
          : 0;
        assertToolBatchModelBudget(connection, reservedUsdMicros);
        if (
          limitsEnabled &&
          ((stage &&
            (stage.usage.requests + 1 > stage.requestLimit ||
              stage.usage.tokens + input.maxTokens > stage.tokenLimit ||
              stage.usage.committedUsdMicros + stageToolAmount + reservedUsdMicros >
                stage.usdLimitMicros)) ||
            totals.requests + 1 > requestLimit ||
            totals.tokens + input.maxTokens > tokenLimit ||
            totals.committedUsdMicros + toolAmount + reservedUsdMicros > usdMicros ||
            totals.committedUsdMicros + toolAmount + reservedUsdMicros >
              BILLING_HARD_TOTAL_USD_MICROS)
        )
          throw new BillingError(
            "Shared paid-request budget is exhausted.",
            "BILLING_LIMIT_REACHED",
          );
        connection
          .prepare(
            `INSERT INTO billing_attempts
            (attempt_id,provider,currency,state,estimated_amount_micros,reserved_usd_micros,max_tokens,created_at)
            VALUES(?,?,?,'reserved',?,?,?,?)`,
          )
          .run(
            input.attemptId,
            input.provider,
            input.currency,
            input.estimatedAmount,
            reservedUsdMicros,
            input.maxTokens,
            new Date().toISOString(),
          );
        return { ...input, reservedUsdMicros };
      });
    },
    settle(attemptId: string, settlement: BillingSettlement) {
      identifier(attemptId, "attempt ID");
      integer(settlement.amount, "settlement amount");
      integer(settlement.inputTokens, "input tokens");
      integer(settlement.outputTokens, "output tokens");
      integer(settlement.cachedInputTokens, "cached input tokens");
      if (settlement.cachedInputTokens > settlement.inputTokens)
        invalid("Cached input tokens exceed input tokens.");
      if (settlement.responseId !== undefined) identifier(settlement.responseId, "response ID");
      validateSettlementMetadata(settlement);
      return atomic(() => {
        const row = getAttempt(attemptId);
        if (!row) throw new BillingError("Unknown billing attempt.", "BILLING_ATTEMPT_NOT_FOUND");
        if (row.state === "settled") {
          if (
            row.amount_micros !== settlement.amount ||
            row.input_tokens !== settlement.inputTokens ||
            row.output_tokens !== settlement.outputTokens ||
            row.cached_input_tokens !== settlement.cachedInputTokens ||
            row.response_id !== (settlement.responseId ?? null) ||
            row.service_tier !== (settlement.serviceTier ?? null) ||
            row.model !== (settlement.model ?? null) ||
            row.cache_write_input_tokens !== (settlement.cacheWriteInputTokens ?? null) ||
            row.cache_write_30m_input_tokens !== (settlement.cacheWrite30mInputTokens ?? null) ||
            row.cache_write_12h_input_tokens !== (settlement.cacheWrite12hInputTokens ?? null)
          )
            throw new BillingError(
              "Conflicting billing settlement.",
              "BILLING_SETTLEMENT_CONFLICT",
            );
          return;
        }
        connection
          .prepare(
            `UPDATE billing_attempts SET state='settled',amount_micros=?,settled_usd_micros=?,
            input_tokens=?,output_tokens=?,cached_input_tokens=?,response_id=?,service_tier=?,model=?,
            cache_write_input_tokens=?,cache_write_30m_input_tokens=?,cache_write_12h_input_tokens=?,
            settled_at=? WHERE attempt_id=?`,
          )
          .run(
            settlement.amount,
            billingUsdMicros(settlement.amount, row.currency),
            settlement.inputTokens,
            settlement.outputTokens,
            settlement.cachedInputTokens,
            settlement.responseId ?? null,
            settlement.serviceTier ?? null,
            settlement.model ?? null,
            settlement.cacheWriteInputTokens ?? null,
            settlement.cacheWrite30mInputTokens ?? null,
            settlement.cacheWrite12hInputTokens ?? null,
            new Date().toISOString(),
            attemptId,
          );
      });
    },
    hold(attemptId: string) {
      identifier(attemptId, "attempt ID");
      atomic(() => {
        if (!getAttempt(attemptId))
          throw new BillingError("Unknown billing attempt.", "BILLING_ATTEMPT_NOT_FOUND");
        connection
          .prepare(
            "UPDATE billing_attempts SET state='held' WHERE attempt_id=? AND state='reserved'",
          )
          .run(attemptId);
      });
    },
  };
}

function validatePath(databasePath: string) {
  if (!databasePath || !isAbsolute(databasePath))
    invalid("ARENA_BILLING_DATABASE_PATH must be an absolute shared ledger path.");
}
function validateLimits(options: Omit<BillingOptions, "databasePath">) {
  const usdLimit = options.usdLimit ?? 2;
  if (!Number.isFinite(usdLimit) || usdLimit <= 0 || usdLimit > 120)
    invalid("Billing USD limit must be greater than 0 and at most 120.");
  const usdMicros = Math.round(usdLimit * 1_000_000);
  if (Math.abs(usdMicros / 1_000_000 - usdLimit) > 1e-10)
    invalid("Billing USD limit supports at most six decimal places.");
  integer(usdMicros, "USD limit", true);
  return {
    usdMicros,
    requestLimit: integer(options.requestLimit ?? 100, "request limit", true),
    tokenLimit: integer(options.tokenLimit ?? 2_000_000, "token limit", true),
  };
}
function readTotals(connection: DatabaseSync, baselineRowid = 0) {
  return connection
    .prepare(
      `SELECT COUNT(*) requests,
        COALESCE(SUM(CASE WHEN state='settled' THEN input_tokens+output_tokens ELSE max_tokens END),0) tokens,
        COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE reserved_usd_micros END),0) committedUsdMicros,
        COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE 0 END),0) settledUsdMicros,
        COALESCE(SUM(CASE WHEN state!='settled' THEN reserved_usd_micros ELSE 0 END),0) reservedUsdMicros,
        COALESCE(SUM(CASE WHEN state='held' THEN 1 ELSE 0 END),0) heldRequests,
        COALESCE(SUM(CASE WHEN state='settled' AND currency='CNY' THEN amount_micros ELSE 0 END),0) settledCnyMicros,
        COALESCE(SUM(CASE WHEN state='settled' AND currency='USD' THEN amount_micros ELSE 0 END),0) settledNativeUsdMicros
        FROM billing_attempts WHERE rowid > ?`,
    )
    .get(baselineRowid) as Record<
    | "requests"
    | "tokens"
    | "committedUsdMicros"
    | "settledUsdMicros"
    | "reservedUsdMicros"
    | "heldRequests"
    | "settledCnyMicros"
    | "settledNativeUsdMicros",
    number
  >;
}
interface AuditRow {
  revision: number;
  changed_at: string;
  reason: string;
  stage_id: string;
  previous_usd_limit_micros: number;
  previous_request_limit: number;
  previous_token_limit: number;
  usd_limit_micros: number;
  request_limit: number;
  token_limit: number;
  baseline_rowid: number;
  baseline_json: string;
  stage_usd_limit_micros: number;
  stage_request_limit: number;
  stage_token_limit: number;
}
function readSettings(connection: DatabaseSync) {
  const settings = connection.prepare("SELECT * FROM billing_settings WHERE id=1").get() as
    | Settings
    | undefined;
  if (
    !settings ||
    settings.schema_version !== 1 ||
    settings.hard_total_usd_micros !== BILLING_HARD_TOTAL_USD_MICROS ||
    settings.cny_per_usd !== BILLING_CNY_PER_USD
  )
    throw new BillingError("Unsupported billing settings.", "BILLING_SETTINGS_MISMATCH");
  validateLimits({
    usdLimit: settings.usd_limit_micros / 1_000_000,
    requestLimit: settings.request_limit,
    tokenLimit: settings.token_limit,
  });
  return settings;
}
function readStatus(connection: DatabaseSync) {
  const settings = readSettings(connection);
  const policy = readLedgerUsagePolicy(connection);
  const totals = readTotals(connection);
  const hasAudit = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_limit_audit'")
    .get();
  const audit = hasAudit
    ? (connection
        .prepare("SELECT * FROM billing_limit_audit ORDER BY revision")
        .all() as unknown as AuditRow[])
    : [];
  const latest = audit.at(-1);
  return {
    ...policy,
    ...totals,
    usdLimitMicros: settings.usd_limit_micros,
    requestLimit: settings.request_limit,
    tokenLimit: settings.token_limit,
    hardTotalUsdMicros: BILLING_HARD_TOTAL_USD_MICROS,
    developmentMaxUsdMicros: BILLING_DEVELOPMENT_MAX_USD_MICROS,
    finalReserveUsdMicros: 80_000_000,
    cnyPerUsdEstimate: BILLING_CNY_PER_USD,
    remainingUsdMicros: policy.usageLimitsEnabled
      ? Math.max(0, settings.usd_limit_micros - totals.committedUsdMicros)
      : null,
    revision: latest?.revision ?? 0,
    activeStage: latest
      ? {
          id: latest.stage_id,
          baselineRowid: latest.baseline_rowid,
          baseline: JSON.parse(latest.baseline_json) as ReturnType<typeof readTotals>,
          usdLimitMicros: latest.stage_usd_limit_micros,
          requestLimit: latest.stage_request_limit,
          tokenLimit: latest.stage_token_limit,
          usage: readTotals(connection, latest.baseline_rowid),
        }
      : null,
    audit,
  };
}
function existingLedger(databasePath: string, readOnly: boolean) {
  validatePath(databasePath);
  if (!existsSync(databasePath))
    throw new BillingError(
      "Billing ledger does not exist; status/admin never initializes a ledger.",
      "BILLING_NOT_FOUND",
    );
  const connection = new DatabaseSync(databasePath, { readOnly });
  connection.exec("PRAGMA busy_timeout=5000");
  return connection;
}
/** Offline inspection: never creates a database, applies migrations or loads environment files. */
export function readBillingStatus(databasePath: string) {
  const connection = existingLedger(databasePath, true);
  try {
    connection.exec("BEGIN");
    return readStatus(connection);
  } finally {
    connection.close();
  }
}
export interface BillingLimitChange {
  databasePath: string;
  expected: { revision: number; usdLimit: number; requestLimit: number; tokenLimit: number };
  limits: { usdLimit: number; requestLimit: number; tokenLimit: number };
  stage: { id: string; usdLimit: number; requestLimit: number; tokenLimit: number };
  reason: string;
}
/** Explicit offline operator action. Factual attempts are never edited or released. */
export function changeBillingLimits(input: BillingLimitChange) {
  const explicitLimits = (limits: BillingLimitChange["limits"]) => {
    if (
      !limits ||
      limits.usdLimit === undefined ||
      limits.requestLimit === undefined ||
      limits.tokenLimit === undefined
    )
      invalid("All administrative billing limits must be explicit.");
    return validateLimits(limits);
  };
  const next = explicitLimits(input.limits);
  const expected = explicitLimits(input.expected);
  const stage = explicitLimits(input.stage);
  identifier(input.stage.id, "stage ID");
  integer(input.expected.revision, "expected revision");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000)
    invalid("Billing limit change requires a reason of at most 1000 characters.");
  if (stage.usdMicros > 10_000_000 || stage.requestLimit > 300 || stage.tokenLimit > 5_000_000)
    invalid("Incremental stage ceilings are USD 10, 300 requests and 5000000 tokens.");
  const connection = existingLedger(input.databasePath, false);
  try {
    connection.exec("BEGIN IMMEDIATE");
    const before = readStatus(connection);
    if (
      before.revision !== input.expected.revision ||
      before.usdLimitMicros !== expected.usdMicros ||
      before.requestLimit !== expected.requestLimit ||
      before.tokenLimit !== expected.tokenLimit
    )
      throw new BillingError(
        "Stale expected billing settings; inspect status again.",
        "BILLING_STALE_SETTINGS",
      );
    if (
      next.usdMicros < before.committedUsdMicros ||
      next.requestLimit < before.requests ||
      next.tokenLimit < before.tokens
    )
      throw new BillingError(
        "New billing limits are below committed usage, including held reservations.",
        "BILLING_LIMIT_BELOW_USAGE",
      );
    connection.exec(
      readFileSync(resolve(process.cwd(), "migrations/billing/002_limit_audit.sql"), "utf8"),
    );
    if (
      connection.prepare("SELECT 1 FROM billing_limit_audit WHERE stage_id=?").get(input.stage.id)
    )
      throw new BillingError("Billing stage already exists.", "BILLING_STAGE_EXISTS");
    const baselineRowid = (
      connection.prepare("SELECT COALESCE(MAX(rowid),0) AS last FROM billing_attempts").get() as {
        last: number;
      }
    ).last;
    connection
      .prepare(
        `INSERT INTO billing_limit_audit
      (changed_at,reason,stage_id,previous_usd_limit_micros,previous_request_limit,previous_token_limit,
       usd_limit_micros,request_limit,token_limit,baseline_rowid,baseline_json,
       stage_usd_limit_micros,stage_request_limit,stage_token_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        input.reason.trim(),
        input.stage.id,
        before.usdLimitMicros,
        before.requestLimit,
        before.tokenLimit,
        next.usdMicros,
        next.requestLimit,
        next.tokenLimit,
        baselineRowid,
        JSON.stringify(readTotals(connection)),
        stage.usdMicros,
        stage.requestLimit,
        stage.tokenLimit,
      );
    connection
      .prepare(
        "UPDATE billing_settings SET usd_limit_micros=?, request_limit=?, token_limit=? WHERE id=1",
      )
      .run(next.usdMicros, next.requestLimit, next.tokenLimit);
    const after = readStatus(connection);
    connection.exec("COMMIT");
    return after;
  } catch (error) {
    if (connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  } finally {
    connection.close();
  }
}

export interface BillingUsagePolicyChange {
  databasePath: string;
  operationId: string;
  expected: BillingLimitChange["expected"] & {
    usagePolicyRevision: number;
    usageLimitsEnabled: boolean;
  };
  usageLimitsEnabled: boolean;
  reason: string;
}

/** Audits a policy switch without changing historical ceilings, baselines or attempts. */
export function changeBillingUsagePolicy(input: BillingUsagePolicyChange) {
  identifier(input.operationId, "operation ID");
  if (
    !input.expected ||
    input.expected.usdLimit === undefined ||
    input.expected.requestLimit === undefined ||
    input.expected.tokenLimit === undefined
  )
    invalid("All administrative billing limits must be explicit.");
  integer(input.expected.revision, "expected revision");
  integer(input.expected.usagePolicyRevision, "expected usage policy revision");
  const expectedLimits = validateLimits(input.expected);
  if (
    typeof input.expected.usageLimitsEnabled !== "boolean" ||
    typeof input.usageLimitsEnabled !== "boolean"
  )
    invalid("Usage policy values must be explicit booleans.");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000)
    invalid("Billing usage policy change requires a reason of at most 1000 characters.");
  const expectedPolicy = {
    usageLimitsEnabled: input.expected.usageLimitsEnabled,
    usagePolicyRevision: input.expected.usagePolicyRevision,
    billingRevision: input.expected.revision,
    usdLimitMicros: expectedLimits.usdMicros,
    requestLimit: expectedLimits.requestLimit,
    tokenLimit: expectedLimits.tokenLimit,
  };
  const connection = existingLedger(input.databasePath, false);
  try {
    connection.exec("BEGIN IMMEDIATE");
    const before = readStatus(connection);
    if (
      before.revision !== input.expected.revision ||
      before.usdLimitMicros !== expectedLimits.usdMicros ||
      before.requestLimit !== expectedLimits.requestLimit ||
      before.tokenLimit !== expectedLimits.tokenLimit
    )
      throw new BillingError(
        "Stale expected billing settings; inspect status again.",
        "BILLING_STALE_SETTINGS",
      );
    const previous = before.usagePolicyAudit.find(
      (entry) => entry.operation_id === input.operationId,
    );
    if (previous) {
      if (
        previous.previous_policy_json !== JSON.stringify(expectedPolicy) ||
        previous.enabled !== Number(input.usageLimitsEnabled) ||
        previous.reason !== input.reason.trim() ||
        before.usagePolicyRevision !== previous.revision ||
        before.usageLimitsEnabled !== input.usageLimitsEnabled
      )
        throw new BillingError(
          "Usage policy operation conflicts or settings have drifted.",
          "BILLING_STALE_SETTINGS",
        );
      connection.exec("COMMIT");
      return before;
    }
    if (
      before.usagePolicyRevision !== input.expected.usagePolicyRevision ||
      before.usageLimitsEnabled !== input.expected.usageLimitsEnabled
    )
      throw new BillingError(
        "Stale expected usage policy; inspect status again.",
        "BILLING_STALE_SETTINGS",
      );
    if (before.usageLimitsEnabled === input.usageLimitsEnabled)
      invalid("Usage policy change must change the current policy.");
    connection.exec(
      readFileSync(resolve(process.cwd(), "migrations/billing/004_usage_policy.sql"), "utf8"),
    );
    connection
      .prepare(
        `INSERT INTO billing_usage_policy_audit
      (operation_id,changed_at,reason,previous_enabled,enabled,previous_policy_revision,billing_revision,previous_policy_json)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.operationId,
        new Date().toISOString(),
        input.reason.trim(),
        Number(before.usageLimitsEnabled),
        Number(input.usageLimitsEnabled),
        before.usagePolicyRevision,
        before.revision,
        JSON.stringify(expectedPolicy),
      );
    const after = readStatus(connection);
    connection.exec("COMMIT");
    return after;
  } catch (error) {
    if (connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  } finally {
    connection.close();
  }
}

function withLedger<T>(fn: (ledger: ReturnType<typeof openBillingLedger>) => T): T {
  const ledger = openBillingLedger(configuredOptions());
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}
export const reserveBilling = (input: BillingReservation) =>
  withLedger((ledger) => ledger.reserve(input));
export const settleBilling = (attemptId: string, settlement: BillingSettlement) =>
  withLedger((ledger) => ledger.settle(attemptId, settlement));
export const holdBilling = (attemptId: string) => withLedger((ledger) => ledger.hold(attemptId));
export const getBillingSummary = () => withLedger((ledger) => ledger.summary());
export const getBillingAttempt = (attemptId: string) =>
  withLedger((ledger) => ledger.getAttempt(attemptId));

/** Inspect unresolved identities without settling, releasing, retrying or changing any attempt. */
export const getUnresolvedBillingAttempts = () =>
  withLedger((ledger) => ledger.unresolvedAttempts());
