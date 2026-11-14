/** Real model acceptance on frozen synthetic inputs. Never resumes or overwrites a run. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChallengeSchema, ModelModeSchema, type ArenaSnapshot } from "../src/lib/contracts";
import { sourceIdentity } from "./build.mjs";
import { readBillingStatus, getUnresolvedBillingAttempts } from "../src/lib/server/billing";
import { ensureToolBudgetBatch } from "../src/lib/server/tool-budget";
import { advanceArena, createArena } from "../src/lib/server/runtime";
import { closeDb } from "../src/lib/server/db";

export const cases = [
  {
    id: "graduate-or-job",
    challenge: {
      goal: "大学毕业后选择考研还是就业，比较全职备考、直接就业、先就业再准备三条路线，给出当前建议和第一步。",
      constraints:
        "不能借贷。未来6个月所有必要现金支出合计不超过18000元。每周最多投入40小时，6个月按24周计，共960小时。任何方案都不能假定已有录取通知或已通过考试。",
      preferences: "重视现金安全和长期成长，可以接受明确条件下的建议。",
      options: ["全职备考", "直接就业", "先就业再准备"],
      materials:
        "这是验收专用合成案例，人物、报价和收入均为虚构设定，不能当作公开事实。现有存款18000元，未来24周生活费每月2000元，6个月12000元。全职备考课程和报名材料总计3000元，学习每周35小时，共840小时，录取结果未知。已有一个真实存在于本案例设定内的本地工作书面offer，税后每月5500元，工作每周32小时，24周768小时，入职一次性交通和材料费500元，6个月生活费仍12000元。入职第一个月末发工资，起始存款可覆盖此前支出。先就业再准备使用同一个offer和同一组生活开支，备考每周8小时，24周192小时，课程资料总计1000元。生活开支每条路线只计一次，不用未来工资抵扣题设的总支出上限。岗位没有要求研究生学历。",
      domain: "learning",
      budget: 18000,
      timeHours: 960,
    },
  },
  {
    id: "choose-offer",
    challenge: {
      goal: "应届生在两份offer与继续求职之间选择，比较实际可支配收入、工时与成长，给出建议和第一步。",
      constraints:
        "不能借贷。6个月生活与迁移必要现金支出总和不超过26000元。每周工作与求职总投入不得超过40小时，6个月按24周算最多960小时。不得把未知奖金、晋升或尚未收到的offer当作确定收入。",
      preferences: "优先较稳定的现金结余，再看导师与工作成长。",
      options: ["接受本地offer", "接受异地offer", "暂缓offer继续求职"],
      materials:
        "这是验收用合成材料，offer、金额及个人条件均为虚构。现有存款26000元。A本地offer税后每月6500元，固定周工时36小时，24周864小时，有书面导师安排；6个月每月生活费2000元总12000元，无迁移费。B异地offer税后每月9000元，固定周工时38小时，24周912小时；每月生活费3500元，6个月21000元，搬迁费2000元，总支出23000元；导师尚未确认。两个offer均在首月末发薪，不要求同时持有。继续求职可先用4周，每周30小时，再就业时间和收入未知；全6个月生活费仍12000元，求职交通材料费总500元，不能假定一定找到更好工作。比较总额用6个月同一时间口径，生活和迁移费用不可重复计算，未来工资不抵扣题设总支出限额。两份offer都须在7天内回复，延长期限未获批准。",
      domain: "work",
      budget: 26000,
      timeHours: 960,
    },
  },
  {
    id: "used-car",
    challenge: {
      goal: "大学毕业生是否买二手车，比较两辆候选车与暂缓购车，所有必要费用与安全门槛都要算清。",
      constraints:
        "所有路线必要现金支出总额不得超过30000元，不能贷款，不能期待卖家降价。任何试驾之前须由独立合格机构静态检查车架、制动和轮胎并确认可安全试驾，不通过就停止，不付购车款。购车前必须核验过户资格与全部费用。",
      preferences: "优先人身安全和现金余量，暂缓购车也可作为正式选择。",
      options: ["买候选A", "买候选B", "暂缓购车"],
      materials:
        "本案例全部为验收合成设定，车况均未经过本系统或机构实际核验。候选A固定售价24000元，合格机构静态检测费500元（检测不通过也支付），过户500元，保险2000元，首轮必要保养1000元，明确必要总支出28000元。候选B固定售价28500元，同样检测500元、过户500元、保险2000元、保养1000元，总32500元，超出30000元硬限制，不假定降价或删除必要项目。两辆车均无已知车况结论，须先静态检测通过才能试驾，产权与过户核验通过后才付款购买。暂缓方案使用现有公共交通，6个月交通总费2400元，无额外购买或检验费用，不依赖未经检查的旧车。若A检测不通过，则检测费500元已经发生，转公共交通时总支出2900元。现有现金30000元，无其他已承诺支出。这些金额仅用于案例内部推理，不代表市场行情。",
      domain: "life",
      budget: 30000,
      timeHours: null,
    },
  },
] as const;

async function main() {
  const selected = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
  const modelMode = ModelModeSchema.parse(
    process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? "deepseek-flash",
  );
  const fixture = cases.find((item) => item.id === selected);
  if (!fixture) throw new Error("Use --case=graduate-or-job|choose-offer|used-car");
  const challenge = ChallengeSchema.parse(fixture.challenge);
  if (!process.argv.includes("--run")) {
    console.log(JSON.stringify({ mode: "dry-run", case: fixture.id, modelMode, challenge }));
    return;
  }
  const ledgerPath = process.env.ARENA_BILLING_DATABASE_PATH ?? "";
  const batchId = process.env.ARENA_ACCEPTANCE_BATCH_ID ?? "";
  if (!isAbsolute(ledgerPath) || !existsSync(ledgerPath) || !batchId)
    throw new Error("Existing central ledger and persistent batch ID required");
  const root = resolve("artifacts/deployment-acceptance");
  const baseline = JSON.parse(readFileSync(resolve(root, "baseline.json"), "utf8"));
  if (baseline.ledgerPath !== ledgerPath) throw new Error("Ledger identity differs from baseline");
  const before = readBillingStatus(ledgerPath);
  if (before.activeStage?.id !== batchId) throw new Error("Audited stage differs from batch ID");
  process.env.ARENA_BILLING_USD_LIMIT = String(before.usdLimitMicros / 1e6);
  process.env.ARENA_BILLING_REQUEST_LIMIT = String(before.requestLimit);
  process.env.ARENA_BILLING_TOKEN_LIMIT = String(before.tokenLimit);
  ensureToolBudgetBatch(batchId, ledgerPath, {
    modelRequests: 100,
    webRequests: 40,
    usdMicros: 3_000_000,
  });
  const unresolvedBefore = getUnresolvedBillingAttempts();
  const originalIds = new Set(
    baseline.unresolved.map((item: { attempt_id: string }) => item.attempt_id),
  );
  const assertNoNewUnknown = () => {
    if (getUnresolvedBillingAttempts().some((item) => !originalIds.has(item.attemptId)))
      throw new Error("New unresolved model request. Stop this entire acceptance batch.");
    const connection = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      if (
        connection
          .prepare("SELECT 1 FROM tool_attempts WHERE batch_id=? AND state!='settled'")
          .get(batchId)
      )
        throw new Error("New unresolved web request. Stop this entire acceptance batch.");
    } finally {
      connection.close();
    }
  };
  assertNoNewUnknown();
  const out = resolve(root, `${fixture.id}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  mkdirSync(out, { mode: 0o700 });
  process.env.ARENA_DATABASE_PATH = resolve(root, "cases.sqlite");
  process.env.ARENA_WORKER_ENABLED = "false";
  process.env.ARENA_RUN_BUDGET_USD = "1";
  process.env.ARENA_RUN_BUDGET_CNY = "6";
  const owner = randomUUID();
  const record: Record<string, unknown> = {
    kind: "real-agent-flow-on-synthetic-input",
    modelMode,
    case: fixture.id,
    challenge,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDiffSha256: createHash("sha256")
      .update(execFileSync("git", ["diff", "HEAD"]))
      .digest("hex"),
    sourceIdentity: sourceIdentity(),
    startedAt: new Date().toISOString(),
    before,
    unresolvedBefore,
    owner,
    semanticReview: "pending-independent-review",
  };
  let snapshot: ArenaSnapshot | undefined;
  let sequence = 0;
  const save = () =>
    writeFileSync(
      resolve(out, `${String(sequence++).padStart(3, "0")}.json`),
      JSON.stringify(record, null, 2),
      { mode: 0o600, flag: "wx" },
    );
  save();
  try {
    snapshot = createArena(challenge, owner, modelMode, undefined, "agent");
    record.arenaId = snapshot.id;
    for (let step = 0; step < 80; step++) {
      const version = snapshot.versions.at(-1)!;
      if (!["ready", "running"].includes(version.status)) break;
      assertNoNewUnknown();
      snapshot = await advanceArena(snapshot.id, owner, version.id);
      record.snapshot = snapshot;
      save();
      const current = snapshot.versions.at(-1)!;
      console.log(
        JSON.stringify({
          case: fixture.id,
          step: step + 1,
          stage: current.stage,
          status: current.status,
          batchRequests: readBillingStatus(ledgerPath).activeStage?.usage.requests,
        }),
      );
      assertNoNewUnknown();
    }
    if (snapshot.versions.at(-1)?.status !== "completed") process.exitCode = 1;
  } catch (error) {
    record.failure =
      error instanceof Error ? { name: error.name, message: error.message } : "unknown";
    process.exitCode = 1;
  } finally {
    record.snapshot = snapshot;
    record.finishedAt = new Date().toISOString();
    record.after = readBillingStatus(ledgerPath);
    record.unresolvedAfter = getUnresolvedBillingAttempts();
    save();
    closeDb();
    console.log(
      JSON.stringify({
        output: out,
        status: snapshot?.versions.at(-1)?.status,
        failure: record.failure,
      }),
    );
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Acceptance preflight failed");
  process.exitCode = 1;
});
