import type {
  ArenaSnapshot,
  ArenaVersion,
  Challenge,
  InterventionSchema,
  ModelResult,
  ModelUsage,
  StageInput,
  Strategy,
  Attack,
  Revision,
  Verdict,
} from "@/lib/contracts";
import type { z } from "zod";
import {
  getModelConfig,
  estimateCallCost,
  generateStrategy,
  generateAttack,
  generateRevision,
  generateVerdict,
  ModelCallError,
} from "./model";
import {
  executeAttackTools,
  checkConstraints,
  validateAttack,
  validateRevision,
  validateVerdict,
  strategiesDuplicate,
} from "./tools";
import {
  addVersion,
  ArenaError,
  assertOwner,
  atomic,
  consumeRun,
  db,
  event,
  getVersion,
  id,
  now,
  positiveEnv,
  saveVersion,
  snapshot,
  type StepRow,
} from "./db";

export function modelInfo(): ArenaSnapshot["model"] {
  const c = getModelConfig();
  return {
    id: c.id,
    configured: c.configured,
    promptVersion: c.promptVersion,
    schemaVersion: c.schemaVersion,
  };
}
export function getArena(arenaId: string, owner: string) {
  atomic(() => {
    assertOwner(arenaId, owner);
    expireLeases();
  });
  return snapshot(arenaId, owner, modelInfo());
}
export function createArena(challenge: Challenge, owner: string) {
  const arenaId = atomic(() => {
    consumeRun(owner);
    const arenaId = id();
    db()
      .prepare("INSERT INTO arenas(id,owner,active_version_id,created_at) VALUES(?,?,?,?)")
      .run(arenaId, owner, "", now());
    addVersion(arenaId, challenge, "首次讨论", null);
    return arenaId;
  });
  return getArena(arenaId, owner);
}
function userChallenges(versionId: string): string[] {
  const rows = db()
    .prepare("SELECT body FROM interventions WHERE version_id=? ORDER BY rowid")
    .all(versionId) as { body: string }[];
  return rows.map((row) => row.body);
}
export function newVersion(
  arenaId: string,
  owner: string,
  challenge: Challenge,
  reason: string,
  intervention?: string,
) {
  atomic(() => {
    const arena = assertOwner(arenaId, owner);
    consumeRun(owner);
    const previous = getVersion(arena.active_version_id);
    if (["ready", "running"].includes(previous.status)) {
      previous.status = "superseded";
      saveVersion(previous);
      db()
        .prepare(
          "UPDATE steps SET status='skipped',finished_at=? WHERE version_id=? AND status='pending'",
        )
        .run(now(), previous.id);
      event(
        arenaId,
        previous.id,
        "superseded",
        "条件已变化，尚未开始的步骤已取消；已发出的请求仍记录到原版本。",
        previous.stage,
      );
    }
    const version = addVersion(arenaId, challenge, reason, previous.id);
    for (const text of [...userChallenges(previous.id), ...(intervention ? [intervention] : [])])
      db()
        .prepare("INSERT INTO interventions(id,version_id,body) VALUES(?,?,?)")
        .run(id(), version.id, text);
  });
  return getArena(arenaId, owner);
}
export function intervene(
  arenaId: string,
  owner: string,
  input: z.infer<typeof InterventionSchema>,
) {
  const arena = assertOwner(arenaId, owner);
  const current = getVersion(arena.active_version_id);
  const strategy =
    current.revisions.find((r) => r.strategyId === input.targetStrategyId)?.strategy ||
    current.strategies.find((s) => s.id === input.targetStrategyId);
  const claim = strategy?.claims.find((c) => c.id === input.targetClaimId);
  if (!claim) throw new ArenaError("这条观点不属于当前版本，请刷新后重试。", 409, "STALE_CLAIM");
  return newVersion(
    arenaId,
    owner,
    current.challenge,
    "用户针对观点补充质疑",
    `针对方案 ${strategy!.id} 的观点「${claim.text}」：${input.text}`,
  );
}
export function partialVerdict(version: ArenaVersion): Verdict {
  return {
    outcome: "partial",
    preferred: null,
    headline: "讨论已停止，现有信息不足以给出完整建议。",
    rationale: `已保留 ${version.strategies.length} 个提案、${version.attacks.length} 条质疑及 ${version.evidence.length} 条核验记录。尚未完成的核验不能视为通过。`,
    conditions: [],
    uncertainties: ["讨论提前结束，未完成的质疑、核验和修订仍待处理。"],
    nextActions: version.strategies.length
      ? [
          ...version.strategies.map(
            (s) =>
              `方案 ${s.id} 可先验证：${(version.revisions.find((r) => r.strategyId === s.id)?.strategy || s).firstAction}`,
          ),
          "补充尚缺材料后开启新版本继续比较。",
        ].slice(0, 5)
      : ["补充材料或修改条件后开启新版本，先生成可比较的提案。"],
    exitCondition: "关键成本、时间或事实前提未核实前，暂不据此作不可逆决定。",
    evidenceIds: version.evidence
      .filter((e) => e.status === "found" || e.status === "calculated")
      .map((e) => e.id),
    comparisons: version.strategies.map((s) => ({
      strategyId: s.id,
      status: "unknown" as const,
      reason: "讨论提前结束，约束与证据尚未完整核验。",
    })),
    attackFindings: version.attacks.map((a) => ({
      attackId: a.id,
      status: "unresolved" as const,
      reason: "讨论提前结束，请检查已有证据和未完成步骤。",
      evidenceIds: version.evidence
        .filter((e) => e.attackId === a.id && (e.status === "found" || e.status === "calculated"))
        .map((e) => e.id),
    })),
  };
}
function syncAttackStatuses(version: ArenaVersion) {
  if (!version.verdict) return;
  version.attacks = version.attacks.map((attack) => ({
    ...attack,
    status:
      version.verdict!.attackFindings.find((finding) => finding.attackId === attack.id)?.status ||
      "unresolved",
  }));
}
export function stopArena(arenaId: string, owner: string, versionId: string) {
  atomic(() => {
    assertOwner(arenaId, owner);
    requireVersion(arenaId, versionId);
    const version = getVersion(versionId);
    if (version.status === "completed" || version.status === "superseded") return;
    version.status = "paused";
    version.verdict = partialVerdict(version);
    syncAttackStatuses(version);
    saveVersion(version);
    db()
      .prepare(
        "UPDATE steps SET status='skipped',finished_at=? WHERE version_id=? AND status='pending'",
      )
      .run(now(), versionId);
    event(
      arenaId,
      versionId,
      "stopped",
      "已停止启动后续步骤。已发出的请求仍会归档，当前显示已有材料的部分结论。",
      version.stage,
    );
  });
  return getArena(arenaId, owner);
}
function requireVersion(arenaId: string, versionId: string) {
  if (!db().prepare("SELECT id FROM versions WHERE id=? AND arena_id=?").get(versionId, arenaId))
    throw new ArenaError("未找到这个版本。", 404, "NOT_FOUND");
}
export function expireLeases() {
  const expired = db()
    .prepare("SELECT * FROM steps WHERE status='running' AND lease_until<?")
    .all(Date.now()) as unknown as StepRow[];
  for (const step of expired) {
    const message = "请求执行时间已超出记录期限，服务方是否已完成未知；费用预留保留，不自动重试。";
    db()
      .prepare(
        "UPDATE steps SET status='uncertain',error=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(message, now(), step.id);
    const version = getVersion(step.version_id);
    if (!["paused", "superseded"].includes(version.status)) {
      version.status = "uncertain";
      version.error = message;
    }
    saveVersion(version);
    event(step.arena_id, step.version_id, "step_uncertain", message, step.stage, step.role);
  }
}
function inputFor(version: ArenaVersion, step: StepRow): StageInput {
  const independent = step.stage === "propose";
  let previousStrategy: Strategy | undefined;
  if (independent && version.parentVersionId) {
    const parent = getVersion(version.parentVersionId);
    previousStrategy =
      parent.revisions.find((r) => r.strategyId === step.role.split(":")[0])?.strategy ||
      parent.strategies.find((s) => s.id === step.role.split(":")[0]);
  }
  if (step.role.includes(":retry")) {
    const previous = db()
      .prepare(
        "SELECT data FROM events WHERE version_id=? AND type='step_completed' AND stage='propose' AND actor=? ORDER BY seq DESC LIMIT 1",
      )
      .get(version.id, step.role.split(":")[0]) as { data: string } | undefined;
    if (previous) previousStrategy = JSON.parse(previous.data).result as Strategy;
  }
  let repair: { feedback: string; rejectedOutput: string } | undefined;
  if (step.role.includes(":repair")) {
    const row = db()
      .prepare(
        "SELECT data FROM events WHERE version_id=? AND stage=? AND type='protocol_repair_scheduled' AND actor=? ORDER BY seq DESC LIMIT 1",
      )
      .get(version.id, step.stage, step.role.split(":")[0]) as { data: string } | undefined;
    if (row) repair = JSON.parse(row.data);
  }
  return {
    challenge: version.challenge,
    role: step.role.split(":")[0],
    strategies: independent ? [] : version.strategies,
    attacks: independent ? [] : version.attacks,
    evidence: independent ? [] : version.evidence,
    revisions: independent ? [] : version.revisions,
    userChallenges: userChallenges(version.id),
    ...(previousStrategy ? { previousStrategy } : {}),
    ...(step.role.includes(":retry")
      ? { duplicateHint: "上次方案与其他方案实质重复。请换一种机制、资源分配与执行路径。" }
      : {}),
    ...(repair ? { repairFeedback: repair.feedback, rejectedOutput: repair.rejectedOutput } : {}),
  };
}
export function reserveCall(version: ArenaVersion, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0)
    throw new ArenaError("模型费用配置无效。", 503, "INVALID_COST_CONFIG");
  const arena = db().prepare("SELECT arena_id FROM versions WHERE id=?").get(version.id) as {
    arena_id: string;
  };
  const related = db()
    .prepare("SELECT body FROM versions WHERE arena_id=?")
    .all(arena.arena_id) as { body: string }[];
  const arenaSpent = related.reduce((sum, row) => {
    const v = JSON.parse(row.body) as ArenaVersion;
    return sum + v.costCny + v.reservedCny;
  }, 0);
  if (arenaSpent + amount > positiveEnv("ARENA_RUN_BUDGET_CNY", 1.5))
    throw new ArenaError(
      "这场讨论及其历史版本的费用上限不足以启动下一步，请联系管理员或缩短材料。",
      429,
      "RUN_BUDGET",
    );
  const all = db().prepare("SELECT body FROM versions").all() as { body: string }[];
  const spent = all.reduce((sum, row) => {
    const v = JSON.parse(row.body) as ArenaVersion;
    return sum + v.costCny + v.reservedCny;
  }, 0);
  if (spent + amount > positiveEnv("ARENA_GLOBAL_BUDGET_CNY", 70))
    throw new ArenaError("服务总费用额度已用完，请联系管理员。", 429, "GLOBAL_BUDGET");
  version.reservedCny += amount;
}
function claim(
  arenaId: string,
  owner: string,
  versionId: string,
): { step: StepRow; input: StageInput } | null {
  return atomic(() => {
    const arena = assertOwner(arenaId, owner);
    requireVersion(arenaId, versionId);
    expireLeases();
    const version = getVersion(versionId);
    if (arena.active_version_id !== versionId || !["ready", "running"].includes(version.status))
      return null;
    if (db().prepare("SELECT id FROM steps WHERE version_id=? AND status='running'").get(versionId))
      return null;
    let step: StepRow | undefined;
    while (
      (step = db()
        .prepare(
          "SELECT * FROM steps WHERE version_id=? AND status='pending' ORDER BY ordinal LIMIT 1",
        )
        .get(versionId) as unknown as StepRow | undefined)
    ) {
      if (
        (step.stage === "attack" || step.stage === "revise") &&
        (!version.strategies.some((s) => s.id === step!.role.split(":")[0]) ||
          (step.stage === "attack" && version.strategies.length < 2))
      ) {
        db()
          .prepare("UPDATE steps SET status='skipped',finished_at=? WHERE id=?")
          .run(now(), step.id);
        event(
          arenaId,
          versionId,
          "step_skipped",
          "缺少可用的对应方案，已明确跳过这一步。",
          step.stage,
          step.role,
        );
      } else break;
    }
    if (!step) return null;
    const input = inputFor(version, step);
    if (step.stage !== "verify") {
      if (!getModelConfig().configured)
        throw new ArenaError(
          "尚未配置模型密钥。请在本地环境配置 MODEL_API_KEY 后重新启动。",
          503,
          "MODEL_NOT_CONFIGURED",
        );
      const concurrent = db()
        .prepare(
          "SELECT COUNT(*) AS count FROM steps WHERE status IN ('running','uncertain') AND stage!='verify'",
        )
        .get() as { count: number };
      if (concurrent.count >= positiveEnv("ARENA_MAX_CONCURRENT_CALLS", 3))
        throw new ArenaError("当前讨论较多，请稍后再继续。", 429, "CONCURRENCY_LIMIT");
      step.reservation = estimateCallCost(input);
      reserveCall(version, step.reservation);
    }
    const lease = Date.now() + getModelConfig().timeoutMs + 30_000;
    db()
      .prepare(
        "UPDATE steps SET status='running',started_at=?,lease_until=?,reservation=? WHERE id=? AND status='pending'",
      )
      .run(now(), lease, step.reservation, step.id);
    step.status = "running";
    version.status = "running";
    version.stage = step.stage;
    version.error = null;
    saveVersion(version);
    event(arenaId, versionId, "step_started", `${step.role} 开始执行。`, step.stage, step.role, {
      reservedCny: step.reservation,
      model: getModelConfig().id,
      promptVersion: getModelConfig().promptVersion,
      schemaVersion: getModelConfig().schemaVersion,
    });
    return { step, input };
  });
}
export async function advanceArena(arenaId: string, owner: string, versionId: string) {
  const claimed = claim(arenaId, owner, versionId);
  if (!claimed) return getArena(arenaId, owner);
  const { step, input } = claimed;
  let result: ModelResult<Strategy | Attack | Revision | Verdict> | undefined;
  try {
    if (step.stage === "propose") result = await generateStrategy(input);
    else if (step.stage === "attack") result = await generateAttack(input);
    else if (step.stage === "revise") result = await generateRevision(input);
    else if (step.stage === "judge") result = await generateVerdict(input);
    const evidence =
      step.stage === "verify"
        ? [
            ...input.attacks.flatMap((attack) =>
              executeAttackTools(attack, input.challenge.materials),
            ),
            ...checkConstraints(input.challenge, input.strategies),
          ]
        : null;
    let value: Strategy | Attack | Revision | Verdict | undefined;
    try {
      if (step.stage === "propose" && (result!.value as Strategy).id !== input.role)
        throw new Error("模型返回的方案编号与指定角色不一致。");
      if (step.stage === "attack" && (result!.value as Attack).from !== input.role)
        throw new Error("质疑发起者与本轮角色不一致。");
      value =
        step.stage === "attack"
          ? validateAttack(
              { ...(result!.value as Attack), id: `attack-${input.role}`, from: input.role },
              input.strategies,
            )
          : step.stage === "revise"
            ? validateRevision(result!.value as Revision, input)
            : step.stage === "judge"
              ? validateVerdict(result!.value as Verdict, input)
              : result?.value;
    } catch (error) {
      const feedback = error instanceof Error ? error.message.slice(0, 500) : "协议引用不合法";
      throw new ModelCallError(`协议校验未通过：${feedback}`, false, result?.usage, {
        feedback,
        rejectedOutput: JSON.stringify(result?.value).slice(0, 24000),
      });
    }
    atomic(() => {
      const currentStep = db().prepare("SELECT status FROM steps WHERE id=?").get(step.id) as {
        status: string;
      };
      if (!["running", "uncertain"].includes(currentStep.status)) return;
      const version = getVersion(versionId);
      settle(version, step, result?.usage);
      if (step.stage === "propose") {
        const strategy = value as Strategy;
        const userText = [
          input.challenge.goal,
          input.challenge.constraints,
          input.challenge.preferences,
          input.challenge.materials,
          ...input.challenge.options,
        ].join("\n");
        strategy.claims = strategy.claims.map((c, index) => ({
          ...c,
          id: `${strategy.id}-claim-${index + 1}`,
          status:
            c.status === "estimate"
              ? "estimate"
              : c.status === "user" && userText.includes(c.text)
                ? "user"
                : "unknown",
          sourceIds: [],
        }));
        const duplicate = version.strategies.some((other) => strategiesDuplicate(other, strategy));
        const duplicateRetryExists = db()
          .prepare("SELECT id FROM steps WHERE version_id=? AND stage='propose' AND role=?")
          .get(versionId, `${input.role}:retry`);
        const maySchedule =
          ["running", "uncertain"].includes(version.status) &&
          assertOwner(arenaId, owner).active_version_id === versionId;
        if (duplicate && !duplicateRetryExists && maySchedule) {
          db()
            .prepare(
              "INSERT INTO steps(id,arena_id,version_id,stage,role,ordinal) VALUES(?,?,?,?,?,?)",
            )
            .run(id(), arenaId, versionId, "propose", `${input.role}:retry`, step.ordinal + 0.1);
          event(
            arenaId,
            versionId,
            "duplicate_strategy",
            "方案实质重复；仅允许再生成一次，费用照常记录。",
            "propose",
            step.role,
          );
        } else if (!duplicate) version.strategies.push(strategy);
        else
          event(
            arenaId,
            versionId,
            "duplicate_omitted",
            maySchedule
              ? "再次生成仍重复，已保留较少的独立方案，不补造方案。"
              : "迟到方案实质重复，已归档结果；讨论已停止或换版本，不启动补充请求。",
            "propose",
            step.role,
          );
      } else if (step.stage === "attack") {
        const attack = value as Attack;
        const existing = version.attacks.find(
          (a) =>
            a.targetStrategyId === attack.targetStrategyId &&
            a.targetClaimId === attack.targetClaimId &&
            a.reason.replace(/\s/g, "").toLowerCase() ===
              attack.reason.replace(/\s/g, "").toLowerCase(),
        );
        if (existing) {
          attack.id = existing.id;
          event(
            arenaId,
            versionId,
            "duplicate_attack",
            "完全相同的目标观点与质疑理由已合并，避免重复核验。",
            "attack",
            input.role,
            { attackId: existing.id },
          );
        } else version.attacks.push(attack);
      } else if (step.stage === "verify") version.evidence.push(...evidence!);
      else if (step.stage === "revise") version.revisions.push(value as Revision);
      else {
        version.verdict = value as Verdict;
      }
      db()
        .prepare(
          "UPDATE steps SET status='completed',finished_at=?,lease_until=NULL,reservation=0,usage=?,error=NULL WHERE id=?",
        )
        .run(now(), result ? JSON.stringify(result.usage) : null, step.id);
      if (["running", "uncertain"].includes(version.status)) {
        version.status = step.stage === "judge" ? "completed" : "ready";
        version.error = null;
      }
      if (version.status === "paused") version.verdict = partialVerdict(version);
      syncAttackStatuses(version);
      saveVersion(version);
      event(arenaId, versionId, "step_completed", `${step.role} 已完成。`, step.stage, step.role, {
        usage: result?.usage ?? null,
        result: value ?? evidence,
      });
    });
  } catch (error) {
    const modelError = error instanceof ModelCallError ? error : undefined;
    const uncertain = modelError?.uncertain ?? false;
    const usage = modelError?.usage ?? result?.usage;
    const validationMessage =
      modelError?.repair?.feedback ||
      (!modelError && result && error instanceof Error ? error.message.slice(0, 500) : null);
    const message =
      modelError?.message ||
      (validationMessage
        ? `协议校验未通过：${validationMessage} 已记录实际用量，未生成替代内容。`
        : "此步骤处理失败，已有记录已保留；未生成替代内容。请检查模型响应或服务日志。");
    atomic(() => {
      const version = getVersion(versionId);
      if (!uncertain) settle(version, step, usage);
      db()
        .prepare(
          "UPDATE steps SET status=?,error=?,finished_at=?,lease_until=NULL,reservation=?,usage=? WHERE id=?",
        )
        .run(
          uncertain ? "uncertain" : "failed",
          message,
          now(),
          uncertain ? step.reservation : 0,
          usage ? JSON.stringify(usage) : null,
          step.id,
        );
      if (!["paused", "superseded"].includes(version.status)) {
        version.status = uncertain ? "uncertain" : "failed";
        version.error = message;
      }
      event(
        arenaId,
        versionId,
        uncertain ? "step_uncertain" : "step_failed",
        message,
        step.stage,
        step.role,
        {
          usage: usage ?? null,
          heldReservationCny: uncertain ? step.reservation : 0,
          ...(validationMessage
            ? {
                rejectedResult: result?.value ?? modelError?.repair?.rejectedOutput,
                validationMessage,
              }
            : {}),
        },
      );
      const repairRole = `${input.role}:repair`;
      if (
        modelError?.repair &&
        !uncertain &&
        !["paused", "superseded"].includes(version.status) &&
        !db()
          .prepare("SELECT id FROM steps WHERE version_id=? AND stage=? AND role=?")
          .get(versionId, step.stage, repairRole)
      ) {
        db()
          .prepare(
            "INSERT INTO steps(id,arena_id,version_id,stage,role,ordinal) VALUES(?,?,?,?,?,?)",
          )
          .run(id(), arenaId, versionId, step.stage, repairRole, step.ordinal + 0.01);
        version.status = "ready";
        version.error = null;
        event(
          arenaId,
          versionId,
          "protocol_repair_scheduled",
          "已记录格式或引用错误，将使用额外额度尝试一次修复；不会替换成模拟结果。",
          step.stage,
          input.role,
          modelError.repair,
        );
      }
      saveVersion(version);
    });
  }
  return getArena(arenaId, owner);
}
function settle(version: ArenaVersion, step: StepRow, usage?: ModelUsage) {
  version.reservedCny = Math.max(0, version.reservedCny - step.reservation);
  if (usage) version.costCny += usage.estimatedCny;
}
