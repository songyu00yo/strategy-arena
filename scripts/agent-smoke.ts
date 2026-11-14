/** Bounded real-service acceptance on explicitly synthetic input. Environment is supplied by the caller. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChallengeSchema, type ArenaSnapshot } from "../src/lib/contracts";
import {
  readBillingStatus,
  getBillingSummary,
  getUnresolvedBillingAttempts,
} from "../src/lib/server/billing";
import { ensureToolBudgetBatch } from "../src/lib/server/tool-budget";
import { createArena, advanceArena, getArena } from "../src/lib/server/runtime";
import { generateStrategy, getModelConfig } from "../src/lib/server/model";
import { closeDb, db } from "../src/lib/server/db";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function main() {
  const run = process.argv.includes("--run");
  const databasePath = process.env.ARENA_BILLING_DATABASE_PATH;
  if (!databasePath || !isAbsolute(databasePath) || !existsSync(databasePath))
    throw new Error("Existing shared ledger required");
  const batchId = process.env.ARENA_ACCEPTANCE_BATCH_ID;
  if (!batchId) throw new Error("Persistent approved acceptance batch ID required");
  const initial = readBillingStatus(databasePath);
  // Use the audited settings already stored in this ledger. This does not change its limits.
  process.env.ARENA_BILLING_USD_LIMIT = String(initial.usdLimitMicros / 1e6);
  process.env.ARENA_BILLING_REQUEST_LIMIT = String(initial.requestLimit);
  process.env.ARENA_BILLING_TOKEN_LIMIT = String(initial.tokenLimit);
  const deepseek = getModelConfig("deepseek");
  const openai = getModelConfig("openai", "gpt-6.1-terra");
  if (!run) {
    console.log(
      JSON.stringify({
        mode: "dry-run",
        models: { deepseek: deepseek.configured, openai: openai.configured },
        searchProvider: process.env.ARENA_SEARCH_PROVIDER || "deepseek",
        caps: { models: 20, web: 20, estimatedUsd: 2 },
        ledgerRevision: initial.revision,
        existingRequests: initial.requests,
        existingHeld: initial.heldRequests,
      }),
    );
    return;
  }
  if (!deepseek.configured) throw new Error("DeepSeek configuration required for this acceptance");
  const out = resolve("artifacts", `agent-smoke-${Date.now()}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  process.env.ARENA_DATABASE_PATH = resolve(out, "arena.sqlite");
  process.env.ARENA_WORKER_ENABLED = "false";
  process.env.ARENA_RUN_BUDGET_USD = "2";
  process.env.ARENA_RUN_BUDGET_CNY = "12";
  getBillingSummary();
  ensureToolBudgetBatch(batchId);
  const beforeHeld = getUnresolvedBillingAttempts();
  const ledger = new DatabaseSync(databasePath, { readOnly: true });
  const beforeRows = ledger.prepare("SELECT * FROM billing_attempts ORDER BY rowid").all();
  const oldMaxRowid = (
    ledger.prepare("SELECT COALESCE(MAX(rowid),0) AS id FROM billing_attempts").get() as {
      id: number;
    }
  ).id;
  ledger.close();
  const record: Record<string, unknown> = {
    kind: "real-services-on-synthetic-task",
    batchId,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    startedAt: new Date().toISOString(),
    before: initial,
    beforeHeldHash: digest(beforeHeld),
    oldRowsHash: digest(beforeRows),
    capabilities: {
      deepseekStream: "pending",
      openaiStream: "pending",
      web: "pending",
      autonomousFlow: "pending",
    },
  };
  const save = () =>
    writeFileSync(resolve(out, "record.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
  const challenge = ChallengeSchema.parse({
    goal: "为 Node.js 24 的周末入门演示选择 SQLite 路线，比较内置 node:sqlite、better-sqlite3 和 sqlite3，核对当前官方文档，并说明离线备用演示的准备要求。",
    constraints:
      "只做隔离环境软件演示，保留完整未知项。请先检索材料和 Node.js 官方公开文档，再确定演示方案。",
    preferences: "优先依赖少、容易解释的方案。",
    options: ["内置 node:sqlite", "better-sqlite3", "sqlite3"],
    materials:
      "本次为功能验收的合成任务，以下均为设定。可用本机 Node.js 24 环境，课前须准备离线数据库和已安装的依赖。离线备用演示应提前下载官方文档并准备只读数据库副本。演示不处理真实个人资料。",
    domain: "learning",
  });
  const owner = randomUUID();
  let snapshot: ArenaSnapshot | undefined;
  let deepseekPreview = false;
  try {
    snapshot = createArena(challenge, owner, "deepseek-flash", undefined, "agent");
    for (let index = 0; index < 60; index++) {
      const current = snapshot.versions.at(-1)!;
      if (!["ready", "running"].includes(current.status)) break;
      snapshot = await advanceArena(snapshot.id, owner, current.id);
      record.snapshot = snapshot;
      deepseekPreview ||= (snapshot.drafts ?? []).some(
        (draft) => Object.keys(draft.fields).length > 0,
      );
      save();
      console.log(
        JSON.stringify({
          step: index + 1,
          status: snapshot.versions.at(-1)!.status,
          plans: snapshot.versions.at(-1)!.agent?.plans.length,
          requests: getBillingSummary().requests - initial.requests,
        }),
      );
    }
    snapshot = getArena(snapshot.id, owner);
    const current = snapshot.versions.at(-1)!;
    const capabilities = record.capabilities as Record<string, string>;
    capabilities.deepseekStream = deepseekPreview ? "received-readable-preview" : "not-observed";
    capabilities.autonomousFlow =
      current.status === "completed"
        ? "protocol-completed-semantic-review-pending"
        : current.status;
    capabilities.web = current.evidence.some((item) => item.provenance === "web")
      ? "received-external-source"
      : "not-observed";
    record.snapshot = snapshot;
    if (current.status !== "uncertain" && openai.configured) {
      const beforeOpenai = getBillingSummary();
      const additionalRequests = beforeOpenai.requests - initial.requests;
      if (additionalRequests < 20) {
        let firstPreviewAt: string | undefined;
        const startedAt = new Date().toISOString();
        const result = await generateStrategy(
          {
            challenge,
            role: "A",
            strategies: [],
            attacks: [],
            evidence: [],
            revisions: [],
            userChallenges: [],
          },
          openai,
          `agent-openai-${randomUUID()}`,
          () => {
            firstPreviewAt ??= new Date().toISOString();
          },
        );
        record.openai = {
          startedAt,
          firstPreviewAt,
          completedAt: new Date().toISOString(),
          result,
        };
        capabilities.openaiStream = firstPreviewAt ? "received-readable-preview" : "not-observed";
      }
    }
  } catch (error) {
    record.failure =
      error instanceof Error
        ? {
            name: error.name,
            message: "Real acceptance stopped. See recorded state and ledger status.",
          }
        : { message: "Unknown failure" };
    process.exitCode = 1;
  } finally {
    record.finishedAt = new Date().toISOString();
    record.after = getBillingSummary();
    record.streamTiming = db()
      .prepare(
        "SELECT s.id AS stepId,s.started_at AS startedAt,MIN(e.created_at) AS firstPreviewAt,s.finished_at AS finishedAt FROM steps s JOIN events e ON json_extract(e.data,'$.stepId')=s.id AND e.type='draft_updated' GROUP BY s.id ORDER BY s.ordinal",
      )
      .all();
    const check = new DatabaseSync(databasePath, { readOnly: true });
    record.oldRowsUnchanged =
      digest(
        check
          .prepare("SELECT * FROM billing_attempts WHERE rowid<=? ORDER BY rowid")
          .all(oldMaxRowid),
      ) === digest(beforeRows);
    record.tools = check
      .prepare(
        "SELECT attempt_id,provider,unit,state,credits,reserved_usd_micros,settled_usd_micros FROM tool_attempts WHERE batch_id=? ORDER BY created_at",
      )
      .all(batchId);
    check.close();
    record.originalHeldUnchanged = beforeHeld.every((previous) =>
      getUnresolvedBillingAttempts().some(
        (current) =>
          current.attemptId === previous.attemptId &&
          current.reservedUsdMicros === previous.reservedUsdMicros &&
          current.state === previous.state,
      ),
    );
    save();
    closeDb();
    console.log(
      JSON.stringify({
        output: out,
        oldRowsUnchanged: record.oldRowsUnchanged,
        originalHeldUnchanged: record.originalHeldUnchanged,
        capabilities: record.capabilities,
      }),
    );
    if (snapshot?.versions.at(-1)?.status !== "completed") process.exitCode = 1;
  }
}
main().catch(() => {
  console.error("Acceptance preflight failed. No credential values printed.");
  process.exitCode = 1;
});
