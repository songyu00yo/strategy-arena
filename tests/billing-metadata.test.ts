import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBillingLedger, type BillingSettlement } from "../src/lib/server/billing";

// Offline fixtures only: every ledger lives in a fresh temporary directory.
let directory: string;
let databasePath: string;
const connections: ReturnType<typeof openBillingLedger>[] = [];
const usage: BillingSettlement = {
  amount: 500_000,
  inputTokens: 30,
  outputTokens: 20,
  cachedInputTokens: 10,
  responseId: "response_fixture",
};
const metadata: BillingSettlement = {
  ...usage,
  serviceTier: "priority",
  model: "claude-sonnet-4-6",
  cacheWriteInputTokens: 6,
  cacheWrite30mInputTokens: 2,
  cacheWrite12hInputTokens: 4,
};
function open() {
  const ledger = openBillingLedger({ databasePath });
  connections.push(ledger);
  return ledger;
}
function reserve(ledger: ReturnType<typeof open>, attemptId = "fixture") {
  ledger.reserve({
    attemptId,
    provider: "decisions",
    currency: "USD",
    estimatedAmount: 500_000,
    maxTokens: 100,
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "arena-billing-metadata-test-"));
  databasePath = join(directory, "ledger.sqlite");
});
afterEach(() => {
  for (const ledger of connections.splice(0)) ledger.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("forward-only optional settlement metadata (temporary offline ledgers)", () => {
  it("persists metadata across connections without changing financial or token totals", () => {
    const ledger = open();
    reserve(ledger);
    ledger.settle("fixture", metadata);
    const reopened = open();
    expect(reopened.getAttempt("fixture")).toMatchObject({
      state: "settled",
      amount_micros: 500_000,
      settled_usd_micros: 500_000,
      service_tier: "priority",
      model: "claude-sonnet-4-6",
      cache_write_input_tokens: 6,
      cache_write_30m_input_tokens: 2,
      cache_write_12h_input_tokens: 4,
    });
    expect(reopened.summary()).toMatchObject({
      requests: 1,
      tokens: 50,
      settledUsdMicros: 500_000,
      committedUsdMicros: 500_000,
    });
    expect(() => reopened.settle("fixture", metadata)).not.toThrow();
  });

  it("adds nullable columns without rewriting historical rows, rowids, settings, or holds", () => {
    const raw = new DatabaseSync(databasePath);
    raw.exec(readFileSync("migrations/billing/001_initial.sql", "utf8"));
    raw.exec(readFileSync("migrations/billing/002_limit_audit.sql", "utf8"));
    raw.exec(`
      INSERT INTO billing_settings VALUES(1,1,2000000,100,2000000,200000000,6,'original-settings');
      INSERT INTO billing_attempts
        (rowid,attempt_id,provider,currency,state,estimated_amount_micros,reserved_usd_micros,
         max_tokens,amount_micros,settled_usd_micros,input_tokens,output_tokens,
         cached_input_tokens,response_id,created_at,settled_at)
      VALUES(7,'historical','openai','USD','settled',900000,900000,100,
        500000,500000,30,20,10,'response_fixture','original-created','original-settled'),
        (9,'unknown','openai','USD','held',1000000,1000000,100,
        NULL,NULL,NULL,NULL,NULL,NULL,'original-held',NULL);
    `);
    const rows = raw.prepare("SELECT rowid,* FROM billing_attempts ORDER BY rowid").all();
    const settings = raw.prepare("SELECT * FROM billing_settings").all();
    raw.close();
    const ledger = open();
    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const migrated = check.prepare("SELECT rowid,* FROM billing_attempts ORDER BY rowid").all();
      for (const [index, row] of migrated.entries()) {
        expect(row).toMatchObject(rows[index]);
        expect(row).toMatchObject({
          service_tier: null,
          model: null,
          cache_write_input_tokens: null,
          cache_write_30m_input_tokens: null,
          cache_write_12h_input_tokens: null,
        });
      }
      expect(check.prepare("SELECT * FROM billing_settings").all()).toEqual(settings);
      expect(ledger.summary()).toMatchObject({
        requests: 2,
        tokens: 150,
        heldRequests: 1,
        settledUsdMicros: 500_000,
        reservedUsdMicros: 1_000_000,
      });
      expect(() => ledger.settle("historical", usage)).not.toThrow();
      expect(() => ledger.settle("historical", metadata)).toThrow(/Conflicting/);
      expect(() => ledger.settle("historical", { ...usage, cacheWriteInputTokens: 0 })).toThrow(
        /Conflicting/,
      );
      expect(check.prepare("SELECT rowid,* FROM billing_attempts ORDER BY rowid").all()).toEqual(
        migrated,
      );
    } finally {
      check.close();
    }
  });

  it("rejects any conflicting model, tier, or cache write facts on replay", () => {
    const ledger = open();
    reserve(ledger);
    ledger.settle("fixture", metadata);
    const row = ledger.getAttempt("fixture");
    for (const changed of [
      { ...metadata, model: "claude-opus-4-6" },
      { ...metadata, model: undefined },
      { ...metadata, serviceTier: "standard" },
      { ...metadata, serviceTier: undefined },
      { ...metadata, cacheWriteInputTokens: 7, cacheWrite30mInputTokens: 3 },
      { ...metadata, cacheWrite30mInputTokens: undefined },
      { ...metadata, cacheWrite12hInputTokens: undefined },
      { ...metadata, cacheWrite30mInputTokens: 3, cacheWrite12hInputTokens: 3 },
      usage,
    ])
      expect(() => ledger.settle("fixture", changed)).toThrow(/Conflicting billing settlement/);
    expect(ledger.getAttempt("fixture")).toEqual(row);
  });

  it("does not migrate rejected settings and refuses an incomplete metadata schema", () => {
    const raw = new DatabaseSync(databasePath);
    raw.exec(readFileSync("migrations/billing/001_initial.sql", "utf8"));
    raw.exec("INSERT INTO billing_settings VALUES(1,1,2000000,100,2000000,200000000,6,'fixture')");
    expect(() => openBillingLedger({ databasePath, usdLimit: 3 })).toThrow(/settings differ/);
    expect(
      raw
        .prepare("PRAGMA table_info(billing_attempts)")
        .all()
        .map((column) => column.name),
    ).not.toContain("service_tier");
    raw.exec("ALTER TABLE billing_attempts ADD COLUMN service_tier TEXT");
    try {
      expect(() => open()).toThrow(/Incomplete billing settlement metadata schema/);
      expect(
        raw
          .prepare("PRAGMA table_info(billing_attempts)")
          .all()
          .map((column) => column.name),
      ).not.toContain("cache_write_input_tokens");
      expect(raw.prepare("SELECT usd_limit_micros FROM billing_settings").get()).toMatchObject({
        usd_limit_micros: 2_000_000,
      });
    } finally {
      raw.close();
    }
  });

  it("distinguishes unknown optional counts from known zero and accepts partial breakdowns", () => {
    const ledger = open();
    const breakdowns: Partial<BillingSettlement>[] = [
      {},
      { cacheWriteInputTokens: 0 },
      { cacheWriteInputTokens: 6, cacheWrite30mInputTokens: 2 },
      { cacheWriteInputTokens: 6, cacheWrite12hInputTokens: 4 },
      { cacheWriteInputTokens: 20, cacheWrite30mInputTokens: 0, cacheWrite12hInputTokens: 20 },
    ];
    for (const [index, counts] of breakdowns.entries()) {
      const attemptId = `partial-${index}`;
      reserve(ledger, attemptId);
      ledger.settle(attemptId, { ...usage, amount: 0, ...counts });
      expect(ledger.getAttempt(attemptId)).toMatchObject({
        cache_write_input_tokens: counts.cacheWriteInputTokens ?? null,
        cache_write_30m_input_tokens: counts.cacheWrite30mInputTokens ?? null,
        cache_write_12h_input_tokens: counts.cacheWrite12hInputTokens ?? null,
      });
    }
  });

  it("rejects malformed identifiers, optional counts, and inconsistent cache totals before writing", () => {
    const ledger = open();
    reserve(ledger);
    const original = ledger.getAttempt("fixture");
    for (const field of ["model", "serviceTier"] as const)
      for (const value of ["", " contains spaces", "model/newline\n", "x".repeat(201), null, 4])
        expect(() =>
          ledger.settle("fixture", { ...metadata, [field]: value } as BillingSettlement),
        ).toThrow(/Invalid billing/);
    for (const field of [
      "cacheWriteInputTokens",
      "cacheWrite30mInputTokens",
      "cacheWrite12hInputTokens",
    ] as const)
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "2"])
        expect(() =>
          ledger.settle("fixture", { ...metadata, [field]: value } as BillingSettlement),
        ).toThrow(/Invalid billing/);
    for (const changed of [
      { ...usage, cacheWrite30mInputTokens: 0 },
      { ...usage, cacheWrite12hInputTokens: 1 },
      { ...usage, cacheWriteInputTokens: 21 },
      { ...metadata, cacheWrite30mInputTokens: 7, cacheWrite12hInputTokens: undefined },
      { ...metadata, cacheWrite12hInputTokens: 7, cacheWrite30mInputTokens: undefined },
      { ...metadata, cacheWrite30mInputTokens: 1 },
      { ...metadata, cacheWrite12hInputTokens: 5 },
    ])
      expect(() => ledger.settle("fixture", changed)).toThrow(/cache write/i);
    expect(ledger.getAttempt("fixture")).toEqual(original);
    expect(ledger.summary()).toMatchObject({ requests: 1, reservedUsdMicros: 500_000 });
  });
});
