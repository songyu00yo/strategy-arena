import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChallengeSchema } from "../src/lib/contracts";
import {
  addVersion,
  atomic,
  closeDb,
  db,
  getEvents,
  getVersion,
  id,
  now,
  saveVersion,
} from "../src/lib/server/db";
import { reconcileUncertain, type ReconciliationInput } from "../src/lib/server/reconcile";
import { reserveCall } from "../src/lib/server/runtime";
let directory: string;
const receiptContents = "SYNTHETIC_RECEIPT_CONTENT_MUST_NOT_ENTER_DATABASE";
function fixture(
  status = "uncertain",
  versionStatus: "uncertain" | "paused" | "superseded" = "uncertain",
) {
  return atomic(() => {
    const arenaId = id();
    db()
      .prepare("INSERT INTO arenas(id,owner,active_version_id,created_at) VALUES(?,?,?,?)")
      .run(arenaId, "test-owner", "", now());
    const version = addVersion(
      arenaId,
      ChallengeSchema.parse({ goal: "核账合成测试：完成课程并制作一个项目" }),
      "测试",
      null,
    );
    version.status = versionStatus;
    version.costCny = 0.1;
    version.reservedCny = 0.2;
    saveVersion(version);
    const step = db()
      .prepare("SELECT id FROM steps WHERE version_id=? AND stage='propose' AND role='A'")
      .get(version.id) as { id: string };
    db().prepare("UPDATE steps SET status=?,reservation=0.2 WHERE id=?").run(status, step.id);
    return { stepId: step.id, versionId: version.id, arenaId };
  });
}
function input(stepId: string, confirmedCny = 0): ReconciliationInput {
  return {
    stepId,
    resolution: confirmedCny === 0 ? "no-charge" : "settled",
    confirmedCny,
    proof: join(directory, "provider-receipt.txt"),
    acknowledgeProviderConfirmation: true,
  };
}
beforeEach(() => {
  closeDb();
  vi.stubEnv("ARENA_DATABASE_PATH", ":memory:");
  vi.stubEnv("ARENA_RUN_BUDGET_CNY", "1.5");
  vi.stubEnv("ARENA_GLOBAL_BUDGET_CNY", "90");
  directory = mkdtempSync(join(tmpdir(), "arena-receipt-fixture-"));
  writeFileSync(join(directory, "provider-receipt.txt"), receiptContents);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No provider request allowed")));
});
afterEach(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("explicit offline operator reconciliation", () => {
  it("releases a confirmed no-charge hold without replaying and stores only receipt hash/name", () => {
    const run = fixture();
    const result = reconcileUncertain(input(run.stepId));
    expect(getVersion(run.versionId)).toMatchObject({
      status: "failed",
      costCny: 0.1,
      reservedCny: 0,
    });
    const step = db()
      .prepare("SELECT status,reservation,usage,error FROM steps WHERE id=?")
      .get(run.stepId) as { status: string; reservation: number; usage: string; error: string };
    expect(step).toMatchObject({ status: "failed", reservation: 0 });
    expect(JSON.parse(step.usage)).toMatchObject({
      kind: "operator-confirmed",
      confirmedCny: 0,
      proofFilename: "provider-receipt.txt",
    });
    expect(JSON.parse(step.usage)).not.toHaveProperty("inputTokens");
    expect(result.proofSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(step.usage + JSON.stringify(getEvents(run.arenaId))).not.toContain(receiptContents);
    expect(step.error).toContain("不会重放");
    expect(fetch).not.toHaveBeenCalled();
    expect(
      db()
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE status IN ('running','uncertain')")
        .get(),
    ).toMatchObject({ count: 0 });
  });
  it("charges actual amount once even above the hold and lets the normal budget gate block future calls", () => {
    const run = fixture();
    reconcileUncertain(input(run.stepId, 2));
    const charged = getVersion(run.versionId);
    expect(charged).toMatchObject({ costCny: 2.1, reservedCny: 0 });
    const events = getEvents(run.arenaId).length;
    expect(() => reconcileUncertain(input(run.stepId, 2))).toThrow("已核账");
    expect(getVersion(run.versionId).costCny).toBe(2.1);
    expect(getEvents(run.arenaId)).toHaveLength(events);
    expect(() => atomic(() => reserveCall(charged, 0.1))).toThrow("费用上限");
    vi.stubEnv("ARENA_RUN_BUDGET_CNY", "100");
    vi.stubEnv("ARENA_RUN_BUDGET_USD", "100");
    vi.stubEnv("ARENA_GLOBAL_BUDGET_CNY", "2.15");
    expect(() => atomic(() => reserveCall(charged, 0.1))).toThrow("服务总费用额度");
  });
  it.each(["paused", "superseded"] as const)("preserves %s version status", (status) => {
    const run = fixture("uncertain", status);
    reconcileUncertain(input(run.stepId, 0.03));
    expect(getVersion(run.versionId)).toMatchObject({ status, reservedCny: 0, costCny: 0.13 });
  });
  it("protects running steps and requires acknowledgement and valid resolution amounts", () => {
    const run = fixture("running");
    expect(() => reconcileUncertain(input(run.stepId))).toThrow("运行中");
    expect(() =>
      reconcileUncertain({ ...input(run.stepId), acknowledgeProviderConfirmation: false }),
    ).toThrow("人工核对");
    for (const changes of [
      { resolution: "no-charge" as const, confirmedCny: 1 },
      { resolution: "settled" as const, confirmedCny: 0 },
      { confirmedCny: Number.NaN },
      { confirmedCny: -1 },
    ])
      expect(() => reconcileUncertain({ ...input(run.stepId), ...changes })).toThrow("金额");
    expect(getVersion(run.versionId)).toMatchObject({ reservedCny: 0.2, costCny: 0.1 });
  });
  it.each(["USD", "CNY"] as const)(
    "refuses centrally billed %s holds even without a saved usage record",
    (currency) => {
      const run = fixture();
      const version = getVersion(run.versionId);
      version.modelSelection = {
        requestedMode: currency === "USD" ? "gpt" : "deepseek",
        provider: currency === "USD" ? "openai" : "deepseek",
        modelId: "synthetic-new-provider",
        currency,
        policyVersion: "fixture",
        reason: "synthetic accounting test",
      };
      if (currency === "USD") {
        version.reservedCny = 0;
        version.reservedUsd = 0.2;
      }
      saveVersion(version);
      expect(() => reconcileUncertain(input(run.stepId))).toThrow("共享费用账本");
      expect(getVersion(run.versionId)).toMatchObject({
        reservedCny: currency === "USD" ? 0 : 0.2,
        ...(currency === "USD" ? { reservedUsd: 0.2 } : {}),
        status: "uncertain",
      });
      expect(
        db().prepare("SELECT status,reservation FROM steps WHERE id=?").get(run.stepId),
      ).toMatchObject({ status: "uncertain", reservation: 0.2 });
    },
  );
  it("refuses secret paths and symlink receipts without touching the ledger", () => {
    const run = fixture();
    for (const name of [".env", "private-key.txt", "id_ed25519.txt", "secret.json", "key.txt"]) {
      const proof = join(directory, name);
      writeFileSync(proof, receiptContents);
      expect(() => reconcileUncertain({ ...input(run.stepId), proof })).toThrow();
    }
    const proof = join(directory, "receipt-link.txt");
    symlinkSync(join(directory, "provider-receipt.txt"), proof);
    expect(() => reconcileUncertain({ ...input(run.stepId), proof })).toThrow("符号链接");
    expect(getVersion(run.versionId)).toMatchObject({
      status: "uncertain",
      reservedCny: 0.2,
      costCny: 0.1,
    });
  });
});
