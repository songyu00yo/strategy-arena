import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changeBillingUsagePolicy,
  changeBillingLimits,
  openBillingLedger,
  readBillingStatus,
  type BillingUsagePolicyChange,
} from "../src/lib/server/billing";
import {
  ensureToolBudgetBatch,
  finishToolAttempt,
  getToolAttempt,
  reserveToolAttempt,
} from "../src/lib/server/tool-budget";

let directory: string;
let databasePath: string;
const connections: ReturnType<typeof openBillingLedger>[] = [];
const open = () => {
  const ledger = openBillingLedger({
    databasePath,
    usdLimit: 0.01,
    requestLimit: 1,
    tokenLimit: 1,
  });
  connections.push(ledger);
  return ledger;
};
const model = (attemptId: string) => ({
  attemptId,
  provider: "openai",
  currency: "USD" as const,
  estimatedAmount: 10_000,
  maxTokens: 1,
});
const change = (): BillingUsagePolicyChange => ({
  databasePath,
  operationId: "unlimited-fixture",
  expected: {
    revision: 0,
    usdLimit: 0.01,
    requestLimit: 1,
    tokenLimit: 1,
    usagePolicyRevision: 0,
    usageLimitsEnabled: true,
  },
  usageLimitsEnabled: false,
  reason: "Explicit unlimited authorization on a synthetic ledger",
});
beforeEach(() => {
  vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "true");
  directory = mkdtempSync(join(tmpdir(), "arena-usage-policy-"));
  databasePath = join(directory, "central.sqlite");
});
afterEach(() => {
  for (const ledger of connections.splice(0)) ledger.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("audited unlimited usage policy on synthetic ledgers", () => {
  it("defaults old and new ledgers to capped usage and requires matching explicit authorization", () => {
    const raw = new DatabaseSync(databasePath);
    raw.exec(readFileSync("migrations/billing/001_initial.sql", "utf8"));
    raw.exec("INSERT INTO billing_settings VALUES(1,1,10000,1,1,200000000,6,'fixture')");
    raw.close();
    const bytes = readFileSync(databasePath);
    expect(readBillingStatus(databasePath)).toMatchObject({
      usageLimitsEnabled: true,
      usagePolicyRevision: 0,
      usagePolicyAudit: [],
    });
    expect(readFileSync(databasePath)).toEqual(bytes);
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "false");
    expect(open).toThrow(/usage policy differs/);
    expect(readBillingStatus(databasePath).usageLimitsEnabled).toBe(true);
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "true");
    open();
    changeBillingUsagePolicy(change());
    expect(open).toThrow(/usage policy differs/);
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "false");
    expect(open().summary()).toMatchObject({
      usageLimitsEnabled: false,
      usagePolicyRevision: 1,
      remainingUsdMicros: null,
    });
  });

  it("preserves held reservations and all historical ceilings while bypassing cumulative caps", () => {
    const old = open();
    old.reserve(model("old-held"));
    old.hold("old-held");
    const held = old.getAttempt("old-held");
    changeBillingUsagePolicy(change());
    expect(() => old.reserve(model("stale-worker"))).toThrow(/usage policy differs/);
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "false");
    const fresh = open();
    fresh.reserve({ ...model("huge-new"), estimatedAmount: 201_000_000, maxTokens: 5_000_001 });
    fresh.settle("huge-new", {
      amount: 202_000_000,
      inputTokens: 3_000_000,
      outputTokens: 3_000_000,
      cachedInputTokens: 0,
    });
    fresh.reserve(model("third"));
    expect(fresh.getAttempt("old-held")).toEqual(held);
    expect(fresh.summary()).toMatchObject({
      requests: 3,
      heldRequests: 1,
      tokens: 6_000_002,
      committedUsdMicros: 202_020_000,
      usdLimitMicros: 10_000,
      requestLimit: 1,
      tokenLimit: 1,
      revision: 0,
    });
    expect(() => fresh.reserve(model("old-held"))).toThrow(/already exists/);
    expect(() => fresh.reserve(model("huge-new"))).toThrow(/already exists/);
    expect(() =>
      fresh.settle("huge-new", {
        amount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      }),
    ).toThrow(/Conflicting/);
  });

  it("bypasses tool batch totals while preserving per-version bounds, unknown results and attempts", () => {
    open();
    ensureToolBudgetBatch("batch", databasePath);
    changeBillingUsagePolicy(change());
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "false");
    vi.stubEnv("ARENA_TOOL_BATCH_ID", "batch");
    const ledger = open();
    for (let index = 0; index < 45; index++) {
      ledger.reserve(model(`model-${index}`));
      reserveToolAttempt(
        {
          attemptId: `tool-${index}`,
          versionId: `version-${index}`,
          batchId: "batch",
          tool: "tavily_search",
          request: { query: "synthetic" },
        },
        databasePath,
      );
    }
    finishToolAttempt("tool-0", "held", { status: "uncertain" }, databasePath);
    const unknown = getToolAttempt("tool-0", databasePath);
    expect(unknown).toMatchObject({
      state: "held",
      reserved_usd_micros: 8000,
      settled_usd_micros: null,
    });
    const tool = {
      attemptId: "tool-0",
      versionId: "version-0",
      batchId: "batch",
      tool: "tavily_search" as const,
      request: { query: "synthetic" },
    };
    expect(() => reserveToolAttempt(tool, databasePath)).toThrow(/重复/);
    expect(() => finishToolAttempt("tool-0", "settled", { status: "found" }, databasePath)).toThrow(
      /覆盖/,
    );
    expect(() =>
      reserveToolAttempt({ ...tool, attemptId: "missing-batch", batchId: "missing" }, databasePath),
    ).toThrow(/初始化/);
    for (let index = 0; index < 6; index++)
      reserveToolAttempt(
        { ...tool, attemptId: `bounded-${index}`, versionId: "bounded" },
        databasePath,
      );
    expect(() =>
      reserveToolAttempt({ ...tool, attemptId: "bounded-7", versionId: "bounded" }, databasePath),
    ).toThrow(/额度/);
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "true");
    expect(() => reserveToolAttempt({ ...tool, attemptId: "drift" }, databasePath)).toThrow(
      /usage policy differs/,
    );
    expect(getToolAttempt("tool-0", databasePath)).toEqual(unknown);
  });

  it("makes identical audit operations idempotent and rejects stale or conflicting operations", () => {
    open();
    const input = change();
    const after = changeBillingUsagePolicy(input);
    expect(changeBillingUsagePolicy(input)).toEqual(after);
    expect(after.usagePolicyAudit[0]).toMatchObject({
      previous_enabled: 1,
      enabled: 0,
      previous_policy_revision: 0,
      billing_revision: 0,
    });
    expect(JSON.parse(after.usagePolicyAudit[0].previous_policy_json)).toMatchObject({
      usageLimitsEnabled: true,
      usdLimitMicros: 10000,
      requestLimit: 1,
      tokenLimit: 1,
    });
    for (const conflicting of [
      { ...input, reason: "different" },
      { ...input, operationId: "new-stale-operation" },
      { ...input, usageLimitsEnabled: true },
      { ...input, expected: { ...input.expected, requestLimit: 2 } },
    ])
      expect(() => changeBillingUsagePolicy(conflicting)).toThrow(/conflicts|Stale/);
    const raw = new DatabaseSync(databasePath);
    expect(() => raw.exec("UPDATE billing_usage_policy_audit SET reason='changed'")).toThrow(
      /immutable/,
    );
    expect(() => raw.exec("DELETE FROM billing_usage_policy_audit")).toThrow(/immutable/);
    raw.close();
    changeBillingLimits({
      databasePath,
      expected: input.expected,
      limits: { usdLimit: 1, requestLimit: 100, tokenLimit: 100 },
      stage: { id: "after-policy", usdLimit: 1, requestLimit: 100, tokenLimit: 100 },
      reason: "Synthetic settings drift",
    });
    expect(() => changeBillingUsagePolicy(input)).toThrow(/Stale/);
    expect(readBillingStatus(databasePath).usagePolicyAudit).toHaveLength(1);
  });

  it("runs the offline CLI policy audit safely twice without loading environment files", () => {
    open();
    const args = [
      "--import",
      "tsx",
      "scripts/billing-admin.ts",
      "set-usage-policy",
      "--database",
      databasePath,
      "--confirm-offline",
      "--expected-revision",
      "0",
      "--expected-usd-limit",
      "0.01",
      "--expected-request-limit",
      "1",
      "--expected-token-limit",
      "1",
      "--expected-policy-revision",
      "0",
      "--expected-limits-enabled",
      "true",
      "--usage-limits-enabled",
      "false",
      "--operation-id",
      "cli-fixture",
      "--reason",
      "Synthetic CLI authorization",
    ];
    for (let index = 0; index < 2; index++) {
      const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        usageLimitsEnabled: false,
        usagePolicyRevision: 1,
        revision: 0,
        usdLimitMicros: 10000,
      });
    }
    expect(readBillingStatus(databasePath).usagePolicyAudit).toHaveLength(1);
  });

  it("can re-enable historical ceilings through another audited policy change", () => {
    open();
    changeBillingUsagePolicy(change());
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "false");
    const unlimited = open();
    unlimited.reserve({ ...model("above-old-ceiling"), estimatedAmount: 20_000 });
    unlimited.hold("above-old-ceiling");
    changeBillingUsagePolicy({
      ...change(),
      operationId: "reenable-fixture",
      expected: { ...change().expected, usageLimitsEnabled: false, usagePolicyRevision: 1 },
      usageLimitsEnabled: true,
    });
    expect(() => unlimited.reserve(model("stale-unlimited"))).toThrow(/usage policy differs/);
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "true");
    const capped = open();
    expect(() => capped.reserve(model("capped-again"))).toThrow(/budget is exhausted/);
    expect(capped.getAttempt("above-old-ceiling")).toMatchObject({
      state: "held",
      reserved_usd_micros: 20_000,
    });
    expect(capped.summary()).toMatchObject({
      usageLimitsEnabled: true,
      usagePolicyRevision: 2,
      remainingUsdMicros: 0,
      requests: 1,
    });
    expect(() => changeBillingUsagePolicy(change())).toThrow(/conflicts/);
  });

  it("rejects invalid or incomplete administration without creating policy records", () => {
    open();
    const original = readBillingStatus(databasePath);
    for (const invalid of [
      { ...change(), reason: " " },
      { ...change(), operationId: "invalid operation" },
      { ...change(), usageLimitsEnabled: undefined as unknown as boolean },
      { ...change(), expected: { ...change().expected, usagePolicyRevision: 1 } },
      {
        ...change(),
        expected: { ...change().expected, tokenLimit: undefined as unknown as number },
      },
      { ...change(), usageLimitsEnabled: true },
    ])
      expect(() => changeBillingUsagePolicy(invalid)).toThrow();
    expect(readBillingStatus(databasePath)).toEqual(original);
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      raw.prepare("SELECT 1 FROM sqlite_master WHERE name='billing_usage_policy_audit'").get(),
    ).toBeUndefined();
    raw.close();
  });
});
