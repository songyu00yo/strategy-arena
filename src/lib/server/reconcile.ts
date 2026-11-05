import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";
import { ArenaError, atomic, db, event, getVersion, now, saveVersion, type StepRow } from "./db";

export interface ReconciliationInput {
  stepId: string;
  resolution: "no-charge" | "settled";
  confirmedCny: number;
  proof: string;
  acknowledgeProviderConfirmation: boolean;
}
function fail(message: string): never {
  throw new ArenaError(message, 400, "RECONCILIATION_REFUSED");
}
function receipt(path: string) {
  const forbidden = (value: string) =>
    value
      .split(/[\\/]/)
      .some(
        (part) =>
          /^\.env(?:\.|$)/i.test(part) ||
          /api[_-]?key|private[_-]?key|\.pem(?:\.|$)/i.test(part) ||
          /(?:^|[._-])(?:keys?|private[_-]?keys?|credentials?|secrets?)(?:[._-]|$)/i.test(part) ||
          /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/i.test(part),
      );
  const requested = resolve(path);
  if (forbidden(requested)) fail("凭证路径不能指向环境文件、密钥或私密凭据目录。");
  const requestedStat = lstatSync(requested);
  if (requestedStat.isSymbolicLink()) fail("凭证必须是普通文件，不能使用符号链接。");
  if (!requestedStat.isFile()) fail("凭证必须是普通文件。");
  const actual = realpathSync(requested);
  if (
    forbidden(actual) ||
    ![".json", ".pdf", ".png", ".jpg", ".txt"].includes(extname(actual).toLowerCase())
  )
    fail("凭证只接受 JSON、PDF、PNG、JPG 或 TXT 普通文件。");
  const filename = basename(actual);
  if (filename.length > 180 || /[\x00-\x1f\x7f]/.test(filename))
    fail("凭证文件名过长或包含控制字符。");
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024)
      fail("凭证必须是非空普通文件，大小不超过 20 MB。");
    return {
      proofFilename: filename,
      proofSha256: createHash("sha256").update(readFileSync(fd)).digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}
/** Offline operator trust boundary: checks ledger consistency, not the truth of a provider receipt. */
export function reconcileUncertain(input: ReconciliationInput) {
  if (!input.acknowledgeProviderConfirmation) fail("必须先人工核对服务商账单，并明确确认核账。");
  if (!/^[a-f0-9-]{36}$/i.test(input.stepId)) fail("请提供有效的步骤 ID。");
  if (
    !["no-charge", "settled"].includes(input.resolution) ||
    !Number.isFinite(input.confirmedCny) ||
    input.confirmedCny < 0 ||
    (input.resolution === "no-charge" ? input.confirmedCny !== 0 : input.confirmedCny === 0)
  )
    fail("no-charge 金额必须为 0；settled 金额必须是服务商确认的正数。");
  const proof = receipt(input.proof);
  return atomic(() => {
    const step = db().prepare("SELECT * FROM steps WHERE id=?").get(input.stepId) as unknown as
      | StepRow
      | undefined;
    if (!step || step.status !== "uncertain")
      fail("仅结果未知的步骤可以核账；已核账、运行中或其他状态均不接受。");
    const version = getVersion(step.version_id);
    if (
      version.modelSelection ||
      version.runConfiguration?.provider ||
      (step.usage && JSON.parse(step.usage).billingAttemptId)
    )
      fail(
        "此步骤使用新模型或共享费用账本；旧人民币核账命令不支持跨账本核账，费用预留保持不变。请使用经审计的共享账本核账流程。",
      );
    if (
      !Number.isFinite(step.reservation) ||
      step.reservation < 0 ||
      !Number.isFinite(version.reservedCny) ||
      version.reservedCny < step.reservation ||
      !Number.isFinite(version.costCny + input.confirmedCny)
    )
      fail("账本金额不一致，请先人工检查数据库。");
    const audit = {
      kind: "operator-confirmed",
      resolution: input.resolution,
      confirmedCny: input.confirmedCny,
      releasedCny: step.reservation,
      ...proof,
      confirmedAt: now(),
      providerConfirmation: "operator-attested",
    };
    const message = "管理员已核对服务商账单；原响应不可用，本步骤已终止，不会重放。";
    version.reservedCny -= step.reservation;
    version.costCny += input.confirmedCny;
    if (!["paused", "superseded"].includes(version.status)) {
      version.status = "failed";
      version.error = message;
    }
    db()
      .prepare(
        "UPDATE steps SET status='failed',reservation=0,lease_until=NULL,finished_at=?,error=?,usage=? WHERE id=? AND status='uncertain'",
      )
      .run(audit.confirmedAt, message, JSON.stringify(audit), step.id);
    saveVersion(version);
    event(step.arena_id, step.version_id, "operator_reconciled", message, step.stage, "operator", {
      stepId: step.id,
      ...audit,
    });
    return { stepId: step.id, ...audit };
  });
}
