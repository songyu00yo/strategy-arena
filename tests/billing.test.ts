import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingUsdMicros,
  getBillingSummary,
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
