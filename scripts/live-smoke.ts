/** Live model integration. Uses synthetic user material, NEVER mock model responses. */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ChallengeSchema } from "../src/lib/contracts";
import { createArena, advanceArena, newVersion } from "../src/lib/server/runtime";

async function main() {
  const fixture = ChallengeSchema.parse({
    domain: "creation", goal: "七天内用已有的十二张照片制作一支九十秒、1080p、有字幕且无水印的视频。比较模板、本地剪辑和 AI 镜头三条路线。",
    constraints: "只有八小时，包含等待、重试、学习和返工。七天内交付。必须 1080p、有字幕且无水印。",
    preferences: "优先保证按时交付，再考虑画面丰富。",
    options: ["模板制作", "本地剪辑", "AI 生成镜头"], budget: 300, timeHours: 8,
    materials: "【开发测试夹具，非用户实测】\n三个合格 AI 镜头分别经历了 2、3、4 次尝试。每次尝试八分钟。\n后期处理估计需要 120 分钟；此数字不是实际测量。\n原始照片 12 张，都有合法使用权。目标是 90 秒成片。\n当前软件的无水印导出权限、1080p 导出条件、模板订阅价格尚未核实。\n样本只有三个，不代表未来成功率；不得把均值当作必然结果。"
  });
  const owner = `live-smoke-${randomUUID()}`;
  let snapshot = createArena(fixture, owner);
  const started = Date.now();
  const maxSteps = process.argv.includes("--first-call") ? 1 : 16;
  async function run() {
    for (let i = 0; i < maxSteps; i++) {
      const active = snapshot.versions.find(v => v.id === snapshot.activeVersionId)!;
      if (!["ready", "running"].includes(active.status)) break;
      snapshot = await advanceArena(snapshot.id, owner, active.id);
      const current = snapshot.versions.find(v => v.id === snapshot.activeVersionId)!;
      console.log(JSON.stringify({ version: current.number, stage: current.stage, status: current.status, strategies: current.strategies.length, attacks: current.attacks.length, evidence: current.evidence.length, revisions: current.revisions.length, costCny: current.costCny, error: current.error }));
    }
  }
  await run();
  if (process.argv.includes("--rematch") && snapshot.versions.at(-1)?.status === "completed") {
    snapshot = newVersion(snapshot.id, owner, { ...fixture, constraints: `${fixture.constraints}\n所有画面必须来自真实记录，禁止生成虚构画面。` }, "新增真实画面限制");
    await run();
  }
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
  const record = { kind: "live-api-on-synthetic-input", timestamp: new Date().toISOString(), commit: sha, dirty, durationMs: Date.now() - started, fixtureSha256: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"), snapshot };
  mkdirSync("artifacts", { recursive: true });
  const output = `artifacts/live-smoke-${Date.now()}.json`;
  writeFileSync(output, JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log(`Saved ${output}; real calls, synthetic task input; commitDirty=${dirty}`);
  if (snapshot.versions.some(v => ["failed", "uncertain"].includes(v.status))) process.exitCode = 1;
}
main().catch(() => { console.error("Live smoke failed before recording. Check local configuration or runtime; no credentials printed."); process.exitCode = 1; });
