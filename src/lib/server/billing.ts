import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

// All amounts are integer micro units of their native currency. This fixed,
// deliberately conservative budget estimate is not a bank exchange rate.
export const BILLING_CNY_PER_USD = 6;
export const BILLING_HARD_TOTAL_USD_MICROS = 200_000_000;
export const BILLING_DEVELOPMENT_MAX_USD_MICROS = 120_000_000;
const MAX_VALUE = 1_000_000_000_000;

export class BillingError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}
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
  if (!options.databasePath || !isAbsolute(options.databasePath))
    invalid("ARENA_BILLING_DATABASE_PATH must be an absolute shared ledger path.");
  const usdLimit = options.usdLimit ?? 2;
  if (!Number.isFinite(usdLimit) || usdLimit <= 0 || usdLimit > 120)
    invalid("Billing USD limit must be greater than 0 and at most 120.");
  const usdMicros = Math.round(usdLimit * 1_000_000);
  if (Math.abs(usdMicros / 1_000_000 - usdLimit) > 1e-10)
    invalid("Billing USD limit supports at most six decimal places.");
  integer(usdMicros, "USD limit", true);
  const requestLimit = integer(options.requestLimit ?? 100, "request limit", true);
  const tokenLimit = integer(options.tokenLimit ?? 2_000_000, "token limit", true);
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
    const totals = connection
      .prepare(
        `SELECT COUNT(*) requests,
        COALESCE(SUM(CASE WHEN state='settled' THEN input_tokens+output_tokens ELSE max_tokens END),0) tokens,
        COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE reserved_usd_micros END),0) committedUsdMicros,
        COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd_micros ELSE 0 END),0) settledUsdMicros,
        COALESCE(SUM(CASE WHEN state!='settled' THEN reserved_usd_micros ELSE 0 END),0) reservedUsdMicros,
        COALESCE(SUM(CASE WHEN state='held' THEN 1 ELSE 0 END),0) heldRequests,
        COALESCE(SUM(CASE WHEN state='settled' AND currency='CNY' THEN amount_micros ELSE 0 END),0) settledCnyMicros,
        COALESCE(SUM(CASE WHEN state='settled' AND currency='USD' THEN amount_micros ELSE 0 END),0) settledNativeUsdMicros
        FROM billing_attempts`,
      )
      .get() as Record<
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
    return {
      ...totals,
      usdLimitMicros: usdMicros,
      requestLimit,
      tokenLimit,
      hardTotalUsdMicros: BILLING_HARD_TOTAL_USD_MICROS,
      finalReserveUsdMicros: 80_000_000,
      cnyPerUsdEstimate: BILLING_CNY_PER_USD,
      remainingUsdMicros: Math.max(0, usdMicros - totals.committedUsdMicros),
    };
  }
  return {
    close: () => connection.close(),
    getAttempt,
    summary,
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
        const totals = summary();
        if (
          totals.requests + 1 > requestLimit ||
          totals.tokens + input.maxTokens > tokenLimit ||
          totals.committedUsdMicros + reservedUsdMicros > usdMicros ||
          totals.committedUsdMicros + reservedUsdMicros > BILLING_HARD_TOTAL_USD_MICROS
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
      return atomic(() => {
        const row = getAttempt(attemptId);
        if (!row) throw new BillingError("Unknown billing attempt.", "BILLING_ATTEMPT_NOT_FOUND");
        if (row.state === "settled") {
          if (
            row.amount_micros !== settlement.amount ||
            row.input_tokens !== settlement.inputTokens ||
            row.output_tokens !== settlement.outputTokens ||
            row.cached_input_tokens !== settlement.cachedInputTokens ||
            row.response_id !== (settlement.responseId ?? null)
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
            input_tokens=?,output_tokens=?,cached_input_tokens=?,response_id=?,settled_at=? WHERE attempt_id=?`,
          )
          .run(
            settlement.amount,
            billingUsdMicros(settlement.amount, row.currency),
            settlement.inputTokens,
            settlement.outputTokens,
            settlement.cachedInputTokens,
            settlement.responseId ?? null,
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
