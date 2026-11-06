import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingUsdMicros,
  changeBillingLimits,
  readBillingStatus,
  type BillingLimitChange,
  getBillingSummary,
  getUnresolvedBillingAttempts,
  openBillingLedger,
  reserveBilling,
  type BillingReservation,
} from "../src/lib/server/billing";

let directory: string;
let databasePath: string;
const connections: ReturnType<typeof openBillingLedger>[] = [];
function open(usdLimit = 2, requestLimit = 100, tokenLimit = 2_000_000) {
  const ledger = openBillingLedger({ databasePath, usdLimit, requestLimit, tokenLimit });
  connections.push(ledger);
  return ledger;
}
const request = (attemptId: string, estimatedAmount = 1_000_000): BillingReservation => ({
  attemptId,
  provider: "openai",
  currency: "USD",
  estimatedAmount,
  maxTokens: 100,
});
const usage = { amount: 500_000, inputTokens: 30, outputTokens: 20, cachedInputTokens: 10 };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "arena-billing-test-"));
  databasePath = join(directory, "shared.sqlite");
});
afterEach(() => {
  for (const ledger of connections.splice(0)) ledger.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("future-only shared paid-request budget", () => {
  it("requires an absolute shared path, without creating a per-workspace fallback", () => {
    vi.stubEnv("ARENA_BILLING_DATABASE_PATH", "");
    expect(() => reserveBilling(request("missing"))).toThrow(/absolute shared ledger path/);
    expect(() => openBillingLedger({ databasePath: "relative.sqlite" })).toThrow(/absolute/);
    expect(() => openBillingLedger({ databasePath: ":memory:" })).toThrow(/absolute/);
  });

  it("pins cumulative smoke ceilings centrally and rejects conflicting environment changes", () => {
    const ledger = open();
    ledger.reserve(request("first"));
    expect(ledger.summary()).toMatchObject({
      usdLimitMicros: 2_000_000,
      hardTotalUsdMicros: 200_000_000,
      finalReserveUsdMicros: 80_000_000,
      requests: 1,
      tokens: 100,
      remainingUsdMicros: 1_000_000,
    });
    expect(() => open(3)).toThrow(/settings differ/);
    expect(() => open(1)).toThrow(/settings differ/);
    expect(() => open(2, 101)).toThrow(/settings differ/);
    expect(() => open(2, 100, 3_000_000)).toThrow(/settings differ/);
    expect(() => openBillingLedger({ databasePath, usdLimit: 121 })).toThrow(/at most 120/);
    expect(open().summary().requests).toBe(1);
  });

  it("refuses duplicate dispatch even when the first reservation is settled", () => {
    const ledger = open();
    ledger.reserve(request("duplicate"));
    expect(() => ledger.reserve(request("duplicate"))).toThrow(/already exists/);
    ledger.settle("duplicate", usage);
    expect(() => ledger.reserve(request("duplicate"))).toThrow(/already exists/);
    expect(ledger.summary().requests).toBe(1);
  });

  it("keeps an unknown request charged across connections and permits later factual settlement", () => {
    const first = open();
    const second = open();
    first.reserve(request("unknown", 2_000_000));
    first.hold("unknown");
    second.hold("unknown");
    expect(second.summary()).toMatchObject({ heldRequests: 1, reservedUsdMicros: 2_000_000 });
    expect(() => second.reserve(request("blocked", 1))).toThrow(/budget is exhausted/);
    second.settle("unknown", usage);
    expect(first.summary()).toMatchObject({
      heldRequests: 0,
      reservedUsdMicros: 0,
      settledUsdMicros: 500_000,
    });
  });

  it("returns stable unresolved IDs and states without changing attempts or their reservations", () => {
    const ledger = open();
    ledger.reserve(request("z-reserved", 250000));
    ledger.reserve(request("a-held", 22700));
    ledger.hold("a-held");
    ledger.reserve(request("m-settled", 100000));
    ledger.settle("m-settled", { ...usage, amount: 100 });
    const attempts = ["z-reserved", "a-held", "m-settled"].map(ledger.getAttempt);
    const summary = ledger.summary();
    vi.stubEnv("ARENA_BILLING_DATABASE_PATH", databasePath);
    vi.stubEnv("ARENA_BILLING_USD_LIMIT", "2");
    vi.stubEnv("ARENA_BILLING_REQUEST_LIMIT", "100");
    vi.stubEnv("ARENA_BILLING_TOKEN_LIMIT", "2000000");
    const expected = [
      { attemptId: "a-held", state: "held", reservedUsdMicros: 22700 },
      { attemptId: "z-reserved", state: "reserved", reservedUsdMicros: 250000 },
    ];
    expect(getUnresolvedBillingAttempts()).toEqual(expected);
    expect(getUnresolvedBillingAttempts()).toEqual(expected);
    expect(["z-reserved", "a-held", "m-settled"].map(ledger.getAttempt)).toEqual(attempts);
    expect(ledger.summary()).toEqual(summary);
    vi.stubEnv("ARENA_BILLING_USD_LIMIT", "3");
    expect(() => getUnresolvedBillingAttempts()).toThrow(/settings differ/);
    expect(ledger.getAttempt("a-held")?.state).toBe("held");
  });

  it("settles idempotently but rejects any conflicting cost, usage, cache count, or response", () => {
    const first = open();
    const second = open();
    first.reserve(request("settle"));
    const settlement = { ...usage, responseId: "resp_fixture" };
    first.settle("settle", settlement);
    second.settle("settle", settlement);
    for (const changed of [
      { ...settlement, amount: 1 },
      { ...settlement, inputTokens: 31 },
      { ...settlement, outputTokens: 21 },
      { ...settlement, cachedInputTokens: 9 },
      { ...settlement, responseId: "resp_other" },
    ])
      expect(() => first.settle("settle", changed)).toThrow(/Conflicting/);
    first.hold("settle");
    expect(second.summary()).toMatchObject({ requests: 1, tokens: 50, settledUsdMicros: 500_000 });
  });

  it("accounts native CNY and USD separately using the pinned conservative estimate", () => {
    const ledger = open();
    ledger.reserve({ ...request("deepseek", 6_000_000), provider: "deepseek", currency: "CNY" });
    ledger.settle("deepseek", { ...usage, amount: 3_000_001 });
    ledger.reserve(request("openai", 1_000_000));
    ledger.settle("openai", usage);
    expect(ledger.summary()).toMatchObject({
      cnyPerUsdEstimate: 6,
      settledCnyMicros: 3_000_001,
      settledNativeUsdMicros: 500_000,
      settledUsdMicros: 1_000_001,
    });
    expect(billingUsdMicros(1, "CNY")).toBe(1);
    expect(billingUsdMicros(6, "CNY")).toBe(1);
    expect(billingUsdMicros(7, "CNY")).toBe(2);
  });

  it("preserves unexpected actual overage and refuses further requests", () => {
    const ledger = open();
    ledger.reserve(request("overrun", 1));
    ledger.settle("overrun", { ...usage, amount: 3_000_000 });
    expect(ledger.summary()).toMatchObject({
      committedUsdMicros: 3_000_000,
      remainingUsdMicros: 0,
    });
    expect(() => ledger.reserve(request("after", 0))).toThrow(/budget is exhausted/);
  });

  it("enforces aggregate request and total token caps, including unknown holds", () => {
    const ledger = open(2, 2, 150);
    ledger.reserve(request("first", 1));
    ledger.hold("first");
    expect(() => ledger.reserve(request("too-many-tokens", 1))).toThrow(/budget is exhausted/);
    ledger.settle("first", { ...usage, amount: 0 });
    ledger.reserve(request("second", 1));
    ledger.settle("second", { ...usage, amount: 0 });
    expect(() => ledger.reserve({ ...request("third", 0), maxTokens: 1 })).toThrow(
      /budget is exhausted/,
    );
  });

  it("rejects invalid financial inputs rather than coercing or silently defaulting", () => {
    const ledger = open();
    for (const value of [NaN, Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => ledger.reserve(request("invalid", value))).toThrow(/Invalid billing/);
      expect(() => ledger.reserve({ ...request("invalid"), maxTokens: value })).toThrow(
        /Invalid billing/,
      );
    }
    expect(() => ledger.reserve({ ...request("bad"), currency: "EUR" as "USD" })).toThrow(
      /currency/,
    );
    expect(() => ledger.reserve({ ...request("bad"), maxTokens: 0 })).toThrow(/Invalid billing/);
    ledger.reserve(request("valid"));
    expect(() => ledger.settle("valid", { ...usage, amount: -1 })).toThrow(/Invalid billing/);
    expect(() => ledger.settle("valid", { ...usage, cachedInputTokens: 31 })).toThrow(/exceed/);
    expect(() => ledger.hold("missing")).toThrow(/Unknown billing attempt/);
    expect(() => ledger.settle("missing", usage)).toThrow(/Unknown billing attempt/);
    vi.stubEnv("ARENA_BILLING_DATABASE_PATH", databasePath);
    for (const value of ["", "NaN", "-1", "Infinity", "120.000001", "0.0000001"]) {
      vi.stubEnv("ARENA_BILLING_USD_LIMIT", value);
      expect(() => getBillingSummary()).toThrow();
    }
  });

  it("admits only one of two independent processes competing for the final allowance", async () => {
    open();
    const children: ChildProcess[] = [];
    const code = `
      import { openBillingLedger } from './src/lib/server/billing.ts';
      const ledger = openBillingLedger({databasePath:process.env.TEST_BILLING_PATH});
      process.send('ready');
      process.once('message', () => {
        try {
          ledger.reserve({attemptId:process.env.TEST_BILLING_ID,provider:'openai',currency:'USD',estimatedAmount:2000000,maxTokens:100});
          process.send('reserved');
        } catch (error) { process.send(error.code); }
        finally { ledger.close(); process.disconnect(); }
      });
    `;
    try {
      const ready = ["process-a", "process-b"].map((attemptId) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code],
          {
            cwd: process.cwd(),
            env: { ...process.env, TEST_BILLING_PATH: databasePath, TEST_BILLING_ID: attemptId },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        children.push(child);
        return new Promise<void>((resolve, reject) => {
          let errors = "";
          child.stderr?.on("data", (chunk) => (errors += String(chunk)));
          child.once("error", reject);
          child.once("exit", (status) => status !== 0 && reject(new Error(errors)));
          child.once("message", () => resolve());
        });
      });
      await Promise.all(ready);
      const results = children.map(
        (child) =>
          new Promise<string>((resolve) =>
            child.once("message", (message) => resolve(String(message))),
          ),
      );
      children.forEach((child) => child.send("go"));
      expect((await Promise.all(results)).sort()).toEqual(["BILLING_LIMIT_REACHED", "reserved"]);
      expect(open().summary()).toMatchObject({ requests: 1, committedUsdMicros: 2_000_000 });
    } finally {
      children.forEach((child) => child.kill());
    }
  }, 15_000);
});

function limitChange(overrides: Partial<BillingLimitChange> = {}): BillingLimitChange {
  return {
    databasePath,
    expected: { revision: 0, usdLimit: 2, requestLimit: 100, tokenLimit: 2_000_000 },
    limits: { usdLimit: 12, requestLimit: 400, tokenLimit: 7_000_000 },
    stage: { id: "session-fixture", usdLimit: 10, requestLimit: 300, tokenLimit: 5_000_000 },
    reason: "Offline fixture authorization, no provider requests",
    ...overrides,
  };
}

describe("offline audited limit administration (temporary test ledgers)", () => {
  it("does not initialize missing ledgers or mutate a legacy ledger during status", () => {
    expect(() => readBillingStatus(databasePath)).toThrow(/does not exist/);
    expect(() => changeBillingLimits(limitChange())).toThrow(/does not exist/);
    expect(existsSync(databasePath)).toBe(false);
    const raw = new DatabaseSync(databasePath);
    raw.exec(readFileSync("migrations/billing/001_initial.sql", "utf8"));
    raw.exec("INSERT INTO billing_settings VALUES(1,1,2000000,100,2000000,200000000,6,'fixture')");
    raw.close();
    const bytes = readFileSync(databasePath);
    expect(readBillingStatus(databasePath)).toMatchObject({
      revision: 0,
      audit: [],
      activeStage: null,
      requests: 0,
    });
    expect(readFileSync(databasePath)).toEqual(bytes);
    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      check.prepare("SELECT 1 FROM sqlite_master WHERE name='billing_limit_audit'").get(),
    ).toBeUndefined();
    check.close();
  });

  it("atomically audits expected settings and baseline while preserving every attempt", () => {
    const ledger = open();
    ledger.reserve(request("settled-fixture", 500000));
    ledger.settle("settled-fixture", usage);
    ledger.reserve(request("held-fixture", 500000));
    ledger.hold("held-fixture");
    const original = [ledger.getAttempt("settled-fixture"), ledger.getAttempt("held-fixture")];
    const after = changeBillingLimits(limitChange());
    expect(after).toMatchObject({
      revision: 1,
      requests: 2,
      committedUsdMicros: 1000000,
      usdLimitMicros: 12000000,
      activeStage: {
        id: "session-fixture",
        baselineRowid: 2,
        baseline: { requests: 2, heldRequests: 1, committedUsdMicros: 1000000 },
        usage: { requests: 0, tokens: 0 },
      },
    });
    expect(after.audit[0]).toMatchObject({
      previous_usd_limit_micros: 2000000,
      usd_limit_micros: 12000000,
      stage_usd_limit_micros: 10000000,
      reason: limitChange().reason,
    });
    expect([ledger.getAttempt("settled-fixture"), ledger.getAttempt("held-fixture")]).toEqual(
      original,
    );
    expect(() => ledger.reserve(request("stale-process", 0))).toThrow(/settings differ/);
    expect(() => open()).toThrow(/settings differ/);
    const fresh = open(12, 400, 7000000);
    fresh.settle("held-fixture", { ...usage, amount: 0 });
    fresh.reserve(request("new-failed-fixture", 10000000));
    fresh.hold("new-failed-fixture");
    expect(fresh.summary().activeStage?.usage).toMatchObject({
      requests: 1,
      heldRequests: 1,
      committedUsdMicros: 10000000,
    });
    expect(() => fresh.reserve(request("stage-usd-over", 1))).toThrow(/budget is exhausted/);
    expect(fresh.summary().requests).toBe(3);
    const raw = new DatabaseSync(databasePath);
    expect(() => raw.exec("UPDATE billing_limit_audit SET reason='changed'")).toThrow(/immutable/);
    expect(() => raw.exec("DELETE FROM billing_limit_audit")).toThrow(/immutable/);
    raw.close();
  });

  it("rejects stale changes and rolls back rejected audits", () => {
    open();
    changeBillingLimits(limitChange());
    expect(() =>
      changeBillingLimits(limitChange({ stage: { ...limitChange().stage, id: "other" } })),
    ).toThrow(/Stale/);
    expect(() =>
      changeBillingLimits(
        limitChange({
          expected: { revision: 1, usdLimit: 12, requestLimit: 400, tokenLimit: 7000000 },
        }),
      ),
    ).toThrow(/already exists/);
    expect(readBillingStatus(databasePath).audit).toHaveLength(1);
  });

  it.each(["USD", "requests", "tokens"])(
    "refuses lowering %s below held commitments",
    (dimension) => {
      const ledger = open();
      ledger.reserve(request("held", 1500000));
      ledger.hold("held");
      ledger.reserve(request("second", 1));
      const limits = { usdLimit: 2, requestLimit: 100, tokenLimit: 2000000 };
      if (dimension === "USD") limits.usdLimit = 1;
      if (dimension === "requests") limits.requestLimit = 1;
      if (dimension === "tokens") limits.tokenLimit = 199;
      expect(() => changeBillingLimits(limitChange({ limits }))).toThrow(/below committed usage/);
      expect(readBillingStatus(databasePath)).toMatchObject({
        revision: 0,
        requests: 2,
        heldRequests: 1,
      });
    },
  );

  it.each(["requests", "tokens"])(
    "enforces incremental %s independently of cumulative headroom",
    (dimension) => {
      open();
      const stage = { ...limitChange().stage };
      if (dimension === "requests") stage.requestLimit = 1;
      else stage.tokenLimit = 100;
      changeBillingLimits(limitChange({ stage }));
      const ledger = open(12, 400, 7000000);
      ledger.reserve(request("new-held", 1));
      ledger.hold("new-held");
      expect(() => ledger.reserve({ ...request("denied", 1), maxTokens: 1 })).toThrow(
        /budget is exhausted/,
      );
      expect(ledger.summary().activeStage?.usage).toMatchObject({ requests: 1, tokens: 100 });
    },
  );

  it("keeps the development/global/final-reserve ceilings and bounds every stage cap", () => {
    open();
    for (const usdLimit of [120.000001, 200, 201])
      expect(() =>
        changeBillingLimits(limitChange({ limits: { ...limitChange().limits, usdLimit } })),
      ).toThrow(/at most 120/);
    for (const stage of [
      { ...limitChange().stage, usdLimit: 10.000001 },
      { ...limitChange().stage, requestLimit: 301 },
      { ...limitChange().stage, tokenLimit: 5000001 },
    ])
      expect(() => changeBillingLimits(limitChange({ stage }))).toThrow(
        /Incremental stage ceilings/,
      );
    expect(readBillingStatus(databasePath)).toMatchObject({
      revision: 0,
      developmentMaxUsdMicros: 120000000,
      hardTotalUsdMicros: 200000000,
      finalReserveUsdMicros: 80000000,
    });
    changeBillingLimits(limitChange({ limits: { ...limitChange().limits, usdLimit: 120 } }));
    expect(readBillingStatus(databasePath).usdLimitMicros).toBe(120000000);
  });

  it("requires every API limit and a meaningful reason explicitly", () => {
    open();
    for (const group of ["expected", "limits", "stage"] as const) {
      const input = limitChange();
      input[group].tokenLimit = undefined as unknown as number;
      expect(() => changeBillingLimits(input)).toThrow(/must be explicit/);
    }
    expect(() => changeBillingLimits(limitChange({ reason: "  " }))).toThrow(/requires a reason/);
    expect(readBillingStatus(databasePath).revision).toBe(0);
  });

  it("successfully runs the explicit audited CLI change against a temporary ledger", () => {
    open();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/billing-admin.ts",
        "set-limits",
        "--database",
        databasePath,
        "--confirm-offline",
        "--expected-revision",
        "0",
        "--expected-usd-limit",
        "2",
        "--expected-request-limit",
        "100",
        "--expected-token-limit",
        "2000000",
        "--usd-limit",
        "10",
        "--request-limit",
        "300",
        "--token-limit",
        "5000000",
        "--stage-id",
        "cli-fixture",
        "--stage-usd-limit",
        "10",
        "--stage-request-limit",
        "300",
        "--stage-token-limit",
        "5000000",
        "--reason",
        "Offline CLI fixture",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      revision: 1,
      usdLimitMicros: 10000000,
      requestLimit: 300,
      tokenLimit: 5000000,
      activeStage: { id: "cli-fixture", usage: { requests: 0 } },
    });
    expect(readBillingStatus(databasePath).audit).toHaveLength(1);
  });

  it("requires explicit offline CLI confirmation and prints only status without loading env files", () => {
    open();
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/billing-admin.ts", "status", "--database", databasePath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ revision: 0, requests: 0 });
    const denied = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/billing-admin.ts", "set-limits", "--database", databasePath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(/confirm-offline/);
    expect(readBillingStatus(databasePath).revision).toBe(0);
  });

  it("serializes independent administrator processes and accepts exactly one expected revision", async () => {
    open();
    const code = `
      import { changeBillingLimits } from './src/lib/server/billing.ts';
      process.send('ready');
      process.once('message', () => {
        try { changeBillingLimits(JSON.parse(process.env.TEST_CHANGE)); process.send('changed'); }
        catch (error) { process.send(error.code); }
        finally { process.disconnect(); }
      });
    `;
    const children: ChildProcess[] = [];
    try {
      await Promise.all(
        ["one", "two"].map(
          (id) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                ["--import", "tsx", "--input-type=module", "-e", code],
                {
                  cwd: process.cwd(),
                  env: {
                    ...process.env,
                    TEST_CHANGE: JSON.stringify(
                      limitChange({ stage: { ...limitChange().stage, id } }),
                    ),
                  },
                  stdio: ["ignore", "ignore", "pipe", "ipc"],
                },
              );
              children.push(child);
              let errors = "";
              child.stderr?.on("data", (chunk) => (errors += String(chunk)));
              child.once("error", reject);
              child.once("exit", (status) => status !== 0 && reject(new Error(errors)));
              child.once("message", () => resolve());
            }),
        ),
      );
      const results = children.map(
        (child) =>
          new Promise<string>((resolve) =>
            child.once("message", (message) => resolve(String(message))),
          ),
      );
      children.forEach((child) => child.send("go"));
      expect((await Promise.all(results)).sort()).toEqual(["BILLING_STALE_SETTINGS", "changed"]);
      expect(readBillingStatus(databasePath).audit).toHaveLength(1);
    } finally {
      children.forEach((child) => child.kill());
    }
  }, 15000);
});
