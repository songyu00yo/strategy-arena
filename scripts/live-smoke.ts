/** Live model integration. Uses synthetic user material, NEVER mock model responses. */
import { getBillingSummary } from "../src/lib/server/billing";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ChallengeSchema, ModelModeSchema } from "../src/lib/contracts";
import { videoChallenge } from "../src/lib/sample";
import { createArena, advanceArena, newVersion, stopArena } from "../src/lib/server/runtime";

async function main() {
  const modelMode = ModelModeSchema.parse(process.env.ARENA_SMOKE_MODEL_MODE || "deepseek");
  getBillingSummary();
  const fixture = ChallengeSchema.parse(videoChallenge);
  const owner = `live-smoke-${randomUUID()}`;
  let snapshot = createArena(fixture, owner, modelMode);
  const started = Date.now();
  const maxSteps = process.argv.includes("--first-call") ? 1 : 32;
  async function run() {
    for (let i = 0; i < maxSteps; i++) {
      const active = snapshot.versions.find((v) => v.id === snapshot.activeVersionId)!;
      if (!["ready", "running"].includes(active.status)) break;
      snapshot = await advanceArena(snapshot.id, owner, active.id);
      const current = snapshot.versions.find((v) => v.id === snapshot.activeVersionId)!;
      console.log(
        JSON.stringify({
          version: current.number,
          stage: current.stage,
          status: current.status,
          strategies: current.strategies.length,
          attacks: current.attacks.length,
          evidence: current.evidence.length,
          revisions: current.revisions.length,
          costCny: current.costCny,
          costUsd: current.costUsd ?? 0,
          modelSelection: current.modelSelection,
          error: current.error,
        }),
      );
    }
  }
  await run();
  if (process.argv.includes("--first-call")) {
    snapshot = stopArena(snapshot.id, owner, snapshot.activeVersionId);
  }
  if (process.argv.includes("--rematch") && snapshot.versions.at(-1)?.status === "completed") {
    snapshot = newVersion(
      snapshot.id,
      owner,
      {
        ...fixture,
        constraints: `${fixture.constraints}\n所有画面必须来自真实记录，禁止生成虚构画面。`,
      },
      "新增真实画面限制",
    );
    await run();
  }
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  );
  const record = {
    kind: "live-api-on-synthetic-input",
    modelConfiguration: snapshot.versions[0].runConfiguration,
    timestamp: new Date().toISOString(),
    commit: sha,
    dirty,
    durationMs: Date.now() - started,
    fixtureSha256: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"),
    snapshot,
  };
  mkdirSync("artifacts", { recursive: true });
  const output = `artifacts/live-smoke-${Date.now()}.json`;
  writeFileSync(output, JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log(`Saved ${output}; real calls, synthetic task input; commitDirty=${dirty}`);
  if (snapshot.versions.some((v) => ["failed", "uncertain"].includes(v.status)))
    process.exitCode = 1;
}
main().catch(() => {
  console.error(
    "Live smoke failed before recording. Check local configuration or runtime; no credentials printed.",
  );
  process.exitCode = 1;
});
