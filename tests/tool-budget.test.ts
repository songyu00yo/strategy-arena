import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBillingLedger, changeBillingLimits } from "../src/lib/server/billing";
import {
  assertToolBatchModelBudget,
  ensureToolBudgetBatch,
  finishToolAttempt,
  getToolAttempt,
  readToolCommittedUsdMicros,
  reserveToolAttempt,
} from "../src/lib/server/tool-budget";

let directory: string;
let databasePath: string;
let ledger: ReturnType<typeof openBillingLedger>;
const reserve = (attemptId: string, versionId = "version", batchId = "batch") =>
  reserveToolAttempt(
    { attemptId, versionId, batchId, tool: "tavily_search", request: { query: "公开信息" } },
    databasePath,
  );
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "arena-tool-budget-"));
  databasePath = join(directory, "central.sqlite");
  ledger = openBillingLedger({ databasePath });
  ensureToolBudgetBatch("batch", databasePath);
});
afterEach(() => {
  ledger.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
describe("persistent tool ledger", () => {
  it("requires an existing absolute central ledger and an explicitly initialized batch", () => {
    expect(() => ensureToolBudgetBatch("batch", "relative.sqlite")).toThrow(/中央/);
    expect(() => ensureToolBudgetBatch("batch", join(directory, "missing.sqlite"))).toThrow(/中央/);
    expect(() => reserve("attempt", "version", "unknown")).toThrow(/初始化/);
    expect(ledger.summary().requests).toBe(0);
  });
  it("persists attempt IDs, counts unknown outcomes and prevents redispatch after restart", () => {
    reserve("one");
    finishToolAttempt("one", "held", { status: "uncertain" }, databasePath);
    expect(getToolAttempt("one", databasePath)).toMatchObject({
      state: "held",
      credits: 1,
      reserved_usd_micros: 8000,
      settled_usd_micros: null,
    });
    expect(() => reserve("one")).toThrow(/重复/);
    expect(() => finishToolAttempt("one", "settled", { status: "found" }, databasePath)).toThrow(
      /覆盖/,
    );
    for (let i = 2; i <= 6; i++) reserve(`call-${i}`);
    expect(() => reserve("seventh")).toThrow(/额度/);
    expect(ledger.summary().requests).toBe(0);
    expect(ledger.summary().tokens).toBe(0);
  });
  it("settles a conservative estimate idempotently without forging model billing rows", () => {
    reserve("one");
    finishToolAttempt("one", "settled", { status: "found", estimated: true }, databasePath);
    finishToolAttempt("one", "settled", { status: "found", estimated: true }, databasePath);
    expect(getToolAttempt("one", databasePath)).toMatchObject({
      state: "settled",
      estimated: 1,
      settled_usd_micros: 8000,
    });
    const connection = new DatabaseSync(databasePath);
    try {
      expect(readToolCommittedUsdMicros(connection)).toBe(8000);
      expect(
        (
          connection.prepare("SELECT COUNT(*) AS count FROM billing_attempts").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
    } finally {
      connection.close();
    }
  });
  it("enforces twenty conservative credits per batch across versions", () => {
    for (let i = 0; i < 20; i++) reserve(`call-${i}`, `version-${i}`);
    expect(() => reserve("twenty-first", "new-version")).toThrow(/额度/);
    ensureToolBudgetBatch("batch", databasePath);
    expect(() => reserve("still-blocked", "new-version")).toThrow(/额度/);
  });
  it("combines model reservations with tool cost and preserves the batch baseline", () => {
    ledger.reserve({
      attemptId: "model",
      provider: "openai",
      currency: "USD",
      estimatedAmount: 1_999_000,
      maxTokens: 10,
    });
    expect(() => reserve("tool")).toThrow(/额度/);
    const original = ensureToolBudgetBatch("batch", databasePath);
    expect(original).toMatchObject({ model_baseline_rowid: 0 });
    expect(ensureToolBudgetBatch("batch", databasePath)).toEqual(original);
  });
  it("provides same-transaction checks for model reservations and ignores historical batch IDs", () => {
    reserve("tool");
    const connection = new DatabaseSync(databasePath);
    try {
      connection.exec("BEGIN IMMEDIATE");
      expect(() => assertToolBatchModelBudget(connection, 1_992_001, "batch")).toThrow(/共享额度/);
      expect(() => assertToolBatchModelBudget(connection, 1_992_000, "batch")).not.toThrow();
      expect(() => assertToolBatchModelBudget(connection, 3_000_000, "")).not.toThrow();
      connection.exec("ROLLBACK");
    } finally {
      connection.close();
    }
  });
  it("reads old ledgers without a tool table and enforces the model request cap", () => {
    const empty = new DatabaseSync(":memory:");
    expect(readToolCommittedUsdMicros(empty)).toBe(0);
    empty.close();
    for (let i = 0; i < 20; i++)
      ledger.reserve({
        attemptId: `model-${i}`,
        provider: "openai",
        currency: "USD",
        estimatedAmount: 1,
        maxTokens: 1,
      });
    const connection = new DatabaseSync(databasePath);
    expect(() => assertToolBatchModelBudget(connection, 1, "batch")).toThrow(/共享额度/);
    connection.close();
  });
  it("counts DeepSeek requests without claiming Tavily credits, even for known zero-cost failures", () => {
    for (let index = 0; index < 20; index++) {
      const attemptId = `deepseek-${index}`;
      reserveToolAttempt(
        {
          attemptId,
          versionId: `version-${index}`,
          batchId: "batch",
          tool: "deepseek_search",
          request: { query: "公开资料" },
        },
        databasePath,
      );
      finishToolAttempt(attemptId, "settled", { status: "unavailable" }, databasePath, 0);
    }
    expect(getToolAttempt("deepseek-0", databasePath)).toMatchObject({
      provider: "deepseek",
      unit: "request",
      credits: 0,
      settled_usd_micros: 0,
    });
    expect(() => reserve("twenty-first", "another-version")).toThrow(/额度/);
  });
  it("migrates historical Tavily rows without changing their amounts, IDs, timestamps or results", () => {
    const connection = new DatabaseSync(databasePath);
    connection.exec(`DROP TABLE tool_attempts;
      CREATE TABLE tool_attempts (
        attempt_id TEXT PRIMARY KEY,version_id TEXT,batch_id TEXT,tool TEXT,state TEXT,credits INTEGER,
        reserved_usd_micros INTEGER,settled_usd_micros INTEGER,estimated INTEGER,request_json TEXT,
        result_json TEXT,created_at TEXT,finished_at TEXT
      );
      INSERT INTO tool_attempts VALUES('historical','old-version','batch','tavily_search','held',1,8000,NULL,1,'{"query":"old"}','{"status":"uncertain"}','2026-01-01',NULL);`);
    connection.close();
    ensureToolBudgetBatch("batch", databasePath);
    expect(getToolAttempt("historical", databasePath)).toMatchObject({
      attempt_id: "historical",
      provider: "tavily",
      unit: "credit",
      state: "held",
      credits: 1,
      reserved_usd_micros: 8000,
      settled_usd_micros: null,
      created_at: "2026-01-01",
      request_json: '{"query":"old"}',
      result_json: '{"status":"uncertain"}',
    });
    const after = new DatabaseSync(databasePath);
    expect(readToolCommittedUsdMicros(after)).toBe(8000);
    after.close();
  });
  it("applies the latest audited stage dollar ceiling to combined model and tool reservations", () => {
    changeBillingLimits({
      databasePath,
      expected: { revision: 0, usdLimit: 2, requestLimit: 100, tokenLimit: 2_000_000 },
      limits: { usdLimit: 2, requestLimit: 100, tokenLimit: 2_000_000 },
      stage: { id: "small-stage", usdLimit: 0.008, requestLimit: 100, tokenLimit: 1000 },
      reason: "Synthetic stage budget regression",
    });
    ledger.reserve({
      attemptId: "stage-model",
      provider: "openai",
      currency: "USD",
      estimatedAmount: 7500,
      maxTokens: 10,
    });
    expect(() =>
      reserveToolAttempt(
        {
          attemptId: "stage-tool",
          versionId: "stage-version",
          batchId: "batch",
          tool: "deepseek_search",
          request: { query: "公开资料" },
        },
        databasePath,
      ),
    ).toThrow(/额度/);
    expect(getToolAttempt("stage-tool", databasePath)).toBeUndefined();
    expect(ledger.summary().remainingUsdMicros).toBe(1_992_500);
  });
});
