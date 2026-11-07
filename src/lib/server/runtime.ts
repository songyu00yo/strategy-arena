import { createHash } from "node:crypto";
import type {
  ArenaSnapshot,
  ExecutionMode,
  ModelMode,
  ModelOption,
  ModelCatalogOption,
  ModelProvider,
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
  FollowUpInput,
} from "@/lib/contracts";
import type { z } from "zod";
import type { AgentPlan } from "@/lib/agent-contracts";
import { AGENT_LIMITS, AGENT_PROTOCOL } from "@/lib/agent-contracts";
import {
  actionFor,
  seedAgent,
  agentRequest,
  compilePlan,
  agentInput,
  bindActionInput,
  modelRequestsUsed,
  runAgentTool,
  hashOf,
  copyActionForRetry,
  dependenciesComplete,
  syncActions,
  corpusFor,
  webConfigured,
  agentConfigurationHash,
} from "./agent";
import { draftWriter } from "./model-drafts";
import { allSources } from "./intakes";
import { SCHEMA_VERSION } from "@/lib/contracts";
import { PROMPT_VERSION } from "../../../prompts/protocol";
import { MODEL_CATALOG, isModelId } from "@/lib/model-catalog";
import { routeModel } from "@/lib/model-routing";
import { stepContext } from "@/lib/step-context";
import {
  getModelConfig,
  estimateCallCost,
  estimateStructuredCall,
  generateStructured,
  generateStrategy,
  generateAttack,
  generateRevision,
  generateVerdict,
  ModelCallError,
} from "./model";
import {
  executeAttackTools,
  checkConstraints,
  normalizeStrategyResources,
  proposedClaims,
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

type SelectedConfig = ReturnType<typeof getModelConfig>;
export function modelInfo(): ArenaSnapshot["model"] {
  const models: ModelCatalogOption[] = MODEL_CATALOG.map((model) => {
    try {
      const c = getModelConfig(model.provider, model.id);
      return {
        ...model,
        configured: c.configured,
        inputPrice: c.inputPrice,
        outputPrice: c.outputPrice,
      };
    } catch {
      return { ...model, configured: false, error: "模型配置无效，请运行者检查服务端配置。" };
    }
  });
  const providers = (["deepseek", "openai"] as const).map((provider): ModelOption => {
    try {
      const c = getModelConfig(provider);
      return { provider, id: c.id, configured: c.configured, currency: c.currency };
    } catch {
      return {
        provider,
        id: provider === "openai" ? "GPT" : "DeepSeek",
        configured: false,
        currency: provider === "openai" ? "USD" : "CNY",
        error: "模型配置无效，请运行者检查服务端配置。",
      };
    }
  });
  return {
    id: "gpt-6.1-terra",
    configured: providers.some((provider) => provider.configured),
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    providers,
    models,
    tools: {
      webConfigured: webConfigured(),
      protocol: AGENT_PROTOCOL,
      provider: process.env.ARENA_SEARCH_PROVIDER === "tavily" ? "tavily" : "deepseek",
    },
  };
}
function runConfiguration(config: SelectedConfig) {
  const configuration = { ...config } as Record<string, unknown>;
  delete configuration.configured; // Key rotation does not change the strategy protocol.
  return {
    configuration,
    hash: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
  };
}
function pinConfiguration(version: ArenaVersion, mode: ModelMode, frozen?: SelectedConfig) {
  const route = routeModel(version.challenge, mode);
  const config = frozen ?? getModelConfig(route.provider, isModelId(mode) ? mode : undefined);
  const reason =
    frozen && mode === "auto"
      ? `本任务在材料读取阶段已固定 ${config.id}，补问与本轮讨论继续使用同一模型。`
      : route.reason;
  const current = runConfiguration(config);
  version.runConfiguration = current.configuration;
  version.configurationHash = current.hash;
  version.modelSelection = {
    requestedMode: mode,
    provider: config.provider,
    modelId: config.id,
    currency: config.currency,
    policyVersion: route.policyVersion,
    reason,
  };
  version.costUsd = 0;
  version.reservedUsd = 0;
  saveVersion(version);
  const arena = db().prepare("SELECT arena_id FROM versions WHERE id=?").get(version.id) as {
    arena_id: string;
  };
  event(
    arena.arena_id,
    version.id,
    "model_selected",
    `本版本选择 ${config.id}：${reason}`,
    undefined,
    undefined,
    {
      ...version.modelSelection,
      configurationHash: current.hash,
    },
  );
}
export function getArena(arenaId: string, owner: string) {
  return atomic(() => {
    assertOwner(arenaId, owner);
    expireLeases();
    return snapshot(arenaId, owner, modelInfo());
  });
}
export function createArena(
  challenge: Challenge,
  owner: string,
  mode: ModelMode = "auto",
  options?: { intakeId: string; revision: number; assumptions?: string[] },
  executionMode: ExecutionMode = "fixed",
) {
  const arenaId = atomic(() => {
    let draft: { body: string; submitted_arena_id: string | null } | undefined;
    let draftBody: Record<string, unknown> | undefined;
    if (options) {
      draft = db()
        .prepare("SELECT body,submitted_arena_id FROM intake_drafts WHERE id=? AND owner=?")
        .get(options.intakeId, owner) as typeof draft;
      if (!draft) throw new ArenaError("未找到这份任务草稿。", 404, "NOT_FOUND");
      // Return an already committed result before charging another run or checking stale revisions.
      if (draft.submitted_arena_id) {
        assertOwner(draft.submitted_arena_id, owner);
        return draft.submitted_arena_id;
      }
      try {
        const body: unknown = JSON.parse(draft.body);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("invalid draft");
        draftBody = body as Record<string, unknown>;
      } catch {
        throw new ArenaError("任务草稿无法读取，请重新整理。", 409, "INTAKE_INVALID");
      }
      if (draftBody.revision !== options.revision || draftBody.status !== "summary")
        throw new ArenaError("任务草稿已更新，请刷新后确认最新摘要。", 409, "STALE_INTAKE");
    }
    let frozen: SelectedConfig | undefined;
    if (
      draftBody &&
      typeof draftBody.configHash === "string" &&
      draftBody.config &&
      typeof draftBody.config === "object"
    ) {
      const previous = draftBody.config as { provider?: unknown; id?: unknown };
      if (
        (previous.provider !== "openai" && previous.provider !== "deepseek") ||
        typeof previous.id !== "string"
      )
        throw new ArenaError("草稿模型记录无效，请新建任务。", 409, "CONFIGURATION_CHANGED");
      frozen = getModelConfig(previous.provider, isModelId(previous.id) ? previous.id : undefined);
      if (runConfiguration(frozen).hash !== draftBody.configHash)
        throw new ArenaError(
          "模型或提示词配置已变化，请重新整理任务。",
          409,
          "CONFIGURATION_CHANGED",
        );
    }
    consumeRun(owner);
    const arenaId = id();
    db()
      .prepare("INSERT INTO arenas(id,owner,active_version_id,created_at) VALUES(?,?,?,?)")
      .run(arenaId, owner, "", now());
    const version = addVersion(arenaId, challenge, "首次讨论", null);
    if (options && draftBody) {
      draftBody.challenge = challenge;
      if (options.assumptions) draftBody.assumptions = options.assumptions;
      version.intake = {
        id: options.intakeId,
        originalGoal: String(draftBody.goal ?? ""),
        answers: Array.isArray(draftBody.answers)
          ? (draftBody.answers as NonNullable<ArenaVersion["intake"]>["answers"])
          : [],
        assumptions: Array.isArray(draftBody.assumptions)
          ? (draftBody.assumptions as string[])
          : [],
        usedSources: Array.isArray(draftBody.sources)
          ? (draftBody.sources as NonNullable<ArenaVersion["intake"]>["usedSources"])
          : [],
        usage: Array.isArray(draftBody.usage) ? (draftBody.usage as ModelUsage[]) : [],
      };
    }
    if (executionMode === "agent")
      seedAgent(arenaId, version, options ? allSources(options.intakeId) : []);
    else version.executionMode = "fixed";
    pinConfiguration(version, mode, frozen);
    if (options && draftBody) {
      draftBody.status = "submitted";
      draftBody.arenaId = arenaId;
      draftBody.updatedAt = now();
      draftBody.revision = options.revision + 1;
      db()
        .prepare(
          "UPDATE intake_drafts SET submitted_arena_id=?,body=?,updated_at=? WHERE id=? AND owner=?",
        )
        .run(arenaId, JSON.stringify(draftBody), Date.now(), options.intakeId, owner);
    }
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
  mode?: ModelMode,
  options: {
    baseVersionId?: string;
    followUp?: FollowUpInput;
    claim?: z.infer<typeof InterventionSchema>;
    executionMode?: ExecutionMode;
  } = {},
) {
  atomic(() => {
    const arena = assertOwner(arenaId, owner);
    const previous = getVersion(arena.active_version_id);
    if (options.baseVersionId && previous.id !== options.baseVersionId)
      throw new ArenaError(
        "当前版本已更新，你填写的内容已保留。请回到当前版本确认后再提交。",
        409,
        "STALE_VERSION",
      );
    let supplement = intervention;
    if (options.followUp) {
      const source = stepContext(previous, options.followUp.stepId);
      if (!options.baseVersionId || !source || source.quote !== options.followUp.quote)
        throw new ArenaError(
          "这一步的内容已更新，你填写的内容已保留。请重新查看原文后确认。",
          409,
          "STALE_SOURCE",
        );
      supplement = `用户对 V${previous.number} 步骤「${source.stepId}」的补充，属于待复核意见，不是已证实事实，也不能覆盖当前明确限制。\n原文：\n${source.quote}\n用户意见：\n${options.followUp.text}`;
    }
    if (options.claim) {
      const input = options.claim;
      const strategy =
        previous.revisions.findLast((entry) => entry.strategyId === input.targetStrategyId)
          ?.strategy ?? previous.strategies.find((entry) => entry.id === input.targetStrategyId);
      const claim = strategy?.claims.find((entry) => entry.id === input.targetClaimId);
      if (!claim)
        throw new ArenaError("这条观点不属于当前版本，请刷新后重试。", 409, "STALE_CLAIM");
      if (input.quote !== undefined && input.quote !== claim.text)
        throw new ArenaError(
          "这条判断已更新，你填写的内容已保留。请重新查看原文后确认。",
          409,
          "STALE_SOURCE",
        );
      supplement = `针对方案 ${strategy!.id} 的观点「${claim.text}」：${input.text}`;
    }
    consumeRun(owner);
    if (["ready", "running"].includes(previous.status)) {
      previous.status = "superseded";
      db()
        .prepare(
          "UPDATE steps SET status='skipped',finished_at=? WHERE version_id=? AND status='pending'",
        )
        .run(now(), previous.id);
      syncActions(previous);
      saveVersion(previous);
      event(
        arenaId,
        previous.id,
        "superseded",
        "条件已变化，尚未开始的步骤已取消；已发出的请求仍记录到原版本。",
        previous.stage,
      );
    }
    const version = addVersion(arenaId, challenge, reason, previous.id);
    if (previous.intake) version.intake = structuredClone(previous.intake);
    if (options.followUp) version.followUp = { ...options.followUp, sourceVersionId: previous.id };
    if ((options.executionMode ?? previous.executionMode) === "agent") {
      const inherited = corpusFor(previous.id);
      seedAgent(arenaId, version, inherited?.sources ?? previous.intake?.usedSources ?? []);
    } else version.executionMode = "fixed";
    pinConfiguration(version, mode ?? previous.modelSelection?.requestedMode ?? "deepseek");
    for (const text of [...userChallenges(previous.id), ...(supplement ? [supplement] : [])])
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
  executionMode?: ExecutionMode,
) {
  const arena = assertOwner(arenaId, owner);
  const current = getVersion(arena.active_version_id);
  return newVersion(
    arenaId,
    owner,
    current.challenge,
    "用户针对观点补充质疑",
    undefined,
    undefined,
    { baseVersionId: input.baseVersionId ?? current.id, claim: input, executionMode },
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
              `方案 ${s.id} 可先验证：${(version.revisions.findLast((r) => r.strategyId === s.id)?.strategy || s).firstAction}`,
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
    db()
      .prepare(
        "UPDATE steps SET status='skipped',finished_at=? WHERE version_id=? AND status='pending'",
      )
      .run(now(), versionId);
    syncActions(version);
    saveVersion(version);
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
    syncActions(version);
    const pendingDraft = db()
      .prepare("SELECT body FROM model_drafts WHERE step_id=?")
      .get(step.id) as { body: string } | undefined;
    if (pendingDraft) {
      const interrupted = JSON.parse(pendingDraft.body) as import("@/lib/contracts").ModelDraft;
      interrupted.status = "interrupted";
      interrupted.revision++;
      db()
        .prepare("UPDATE model_drafts SET body=? WHERE step_id=?")
        .run(JSON.stringify(interrupted), step.id);
      event(
        step.arena_id,
        step.version_id,
        "draft_finished",
        "生成中断，结果待核对",
        step.stage,
        step.role,
        interrupted,
      );
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
      parent.revisions.findLast((r) => r.strategyId === step.role.split(":")[0])?.strategy ||
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
  const input: StageInput = {
    challenge: version.challenge,
    role: step.role.split(":")[0],
    strategies: independent ? [] : version.strategies,
    attacks: independent ? [] : version.attacks,
    evidence: independent ? [] : version.evidence,
    revisions: independent ? [] : version.revisions,
    userChallenges: userChallenges(version.id),
    assumptions: version.intake?.assumptions ?? [],
    ...(previousStrategy ? { previousStrategy } : {}),
    ...(step.role.includes(":retry")
      ? { duplicateHint: "上次方案与其他方案实质重复。请换一种机制、资源分配与执行路径。" }
      : {}),
    ...(repair ? { repairFeedback: repair.feedback, rejectedOutput: repair.rejectedOutput } : {}),
  };
  const action = actionFor(step.id);
  return action ? agentInput(version, action, input) : input;
}
// This conservative conversion is a budget guard only; recorded amounts retain their native currency.
const CNY_PER_USD_BUDGET = 6;
function spentUsd(version: ArenaVersion) {
  return (
    (version.costCny + version.reservedCny) / CNY_PER_USD_BUDGET +
    (version.costUsd ?? 0) +
    (version.reservedUsd ?? 0) +
    (version.toolCostUsd ?? 0) +
    (version.toolReservedUsd ?? 0)
  );
}
function localBudget(usdName: string, cnyName: string, fallback: number) {
  const usd = positiveEnv(usdName, fallback);
  return process.env[cnyName] === undefined
    ? usd
    : Math.min(usd, positiveEnv(cnyName, fallback * CNY_PER_USD_BUDGET) / CNY_PER_USD_BUDGET);
}
export function reserveCall(version: ArenaVersion, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0)
    throw new ArenaError("模型费用配置无效。", 503, "INVALID_COST_CONFIG");
  const currency = version.modelSelection?.currency ?? "CNY";
  const amountUsd = currency === "USD" ? amount : amount / CNY_PER_USD_BUDGET;
  const arena = db().prepare("SELECT arena_id FROM versions WHERE id=?").get(version.id) as {
    arena_id: string;
  };
  const related = db()
    .prepare("SELECT body FROM versions WHERE arena_id=?")
    .all(arena.arena_id) as { body: string }[];
  const arenaSpent = related.reduce((sum, row) => sum + spentUsd(JSON.parse(row.body)), 0);
  if (arenaSpent + amountUsd > localBudget("ARENA_RUN_BUDGET_USD", "ARENA_RUN_BUDGET_CNY", 0.25))
    throw new ArenaError(
      "这场讨论及其历史版本的费用上限不足以启动下一步，请联系管理员或缩短材料。",
      429,
      "RUN_BUDGET",
    );
  const all = db().prepare("SELECT body FROM versions").all() as { body: string }[];
  const spent = all.reduce((sum, row) => sum + spentUsd(JSON.parse(row.body)), 0);
  if (spent + amountUsd > localBudget("ARENA_GLOBAL_BUDGET_USD", "ARENA_GLOBAL_BUDGET_CNY", 120))
    throw new ArenaError("服务总费用额度已用完，请联系管理员。", 429, "GLOBAL_BUDGET");
  if (currency === "USD") version.reservedUsd = (version.reservedUsd ?? 0) + amount;
  else version.reservedCny += amount;
}
function claim(
  arenaId: string,
  owner: string,
  versionId: string,
): { step: StepRow; input: StageInput; config: SelectedConfig } | null {
  return atomic(() => {
    const arena = assertOwner(arenaId, owner);
    requireVersion(arenaId, versionId);
    expireLeases();
    const version = getVersion(versionId);
    if (arena.active_version_id !== versionId || !["ready", "running"].includes(version.status))
      return null;
    if (db().prepare("SELECT id FROM steps WHERE version_id=? AND status='running'").get(versionId))
      return null;
    const provider: ModelProvider = version.modelSelection?.provider ?? "deepseek";
    const selected = version.modelSelection;
    const config = getModelConfig(
      provider,
      selected && isModelId(selected.requestedMode) && isModelId(selected.modelId)
        ? selected.modelId
        : undefined,
    );
    if (
      !version.modelSelection ||
      !version.runConfiguration?.provider ||
      !version.configurationHash ||
      version.configurationHash !== runConfiguration(config).hash ||
      (version.agent && version.agent.configurationHash !== agentConfigurationHash())
    ) {
      version.status = "failed";
      version.error =
        "服务的模型或提示词配置已更新；为避免同一版本混用配置，已停止后续步骤。请创建新版本重赛。";
      db()
        .prepare(
          "UPDATE steps SET status='skipped',finished_at=? WHERE version_id=? AND status='pending'",
        )
        .run(now(), versionId);
      syncActions(version);
      saveVersion(version);
      event(arenaId, versionId, "configuration_changed", version.error, version.stage);
      return null;
    }
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
    const action = actionFor(step.id);
    if (action && !dependenciesComplete(action)) return null;
    if (action && action.kind !== "tools") {
      const count = modelRequestsUsed(versionId);
      if (
        count >= AGENT_LIMITS.modelRequests ||
        (action.kind !== "judge" && count >= AGENT_LIMITS.modelRequests - 1)
      ) {
        version.status = "paused";
        version.agent!.stopReason = "达到本版模型请求上限，保留现有证据与未决事项。";
        version.verdict = partialVerdict(version);
        db()
          .prepare(
            "UPDATE steps SET status='skipped',finished_at=? WHERE version_id=? AND status='pending'",
          )
          .run(now(), versionId);
        syncActions(version);
        saveVersion(version);
        event(arenaId, versionId, "agent_limit", version.agent!.stopReason, version.stage);
        return null;
      }
    }
    if (
      step.stage === "judge" &&
      (action || !version.evidence.some((e) => e.estimateScope === "final"))
    ) {
      const finalStrategies = version.strategies.map(
        (strategy) =>
          version.revisions.findLast((revision) => revision.strategyId === strategy.id)?.strategy ??
          strategy,
      );
      version.evidence.push(...checkConstraints(version.challenge, finalStrategies, "final"));
    }
    const input = inputFor(version, step);
    if (step.stage !== "verify" || action?.kind === "plan") {
      if (!config.configured)
        throw new ArenaError(
          `${config.id} 尚未配置模型密钥。请配置所选服务商的密钥后重新启动；不会切换到其他模型。`,
          503,
          "MODEL_NOT_CONFIGURED",
        );
      const concurrent = db()
        .prepare(
          "SELECT COUNT(*) AS count FROM steps WHERE status IN ('running','uncertain') AND (stage!='verify' OR EXISTS(SELECT 1 FROM agent_actions a WHERE a.step_id=steps.id AND a.kind='plan'))",
        )
        .get() as { count: number };
      if (concurrent.count >= positiveEnv("ARENA_MAX_CONCURRENT_CALLS", 3))
        throw new ArenaError("当前讨论较多，请稍后再继续。", 429, "CONCURRENCY_LIMIT");
      step.reservation =
        action?.kind === "plan"
          ? estimateStructuredCall(agentRequest(version, action, config)).amount
          : estimateCallCost(input, config);
      try {
        reserveCall(version, step.reservation);
      } catch (error) {
        if (
          !action ||
          !(error instanceof ArenaError) ||
          !["RUN_BUDGET", "GLOBAL_BUDGET"].includes(error.code)
        )
          throw error;
        version.status = "paused";
        version.agent!.stopReason = error.message;
        version.verdict = partialVerdict(version);
        db()
          .prepare(
            "UPDATE steps SET status='skipped',finished_at=? WHERE version_id=? AND status='pending'",
          )
          .run(now(), versionId);
        syncActions(version);
        saveVersion(version);
        event(arenaId, versionId, "agent_limit", error.message, version.stage);
        return null;
      }
    }
    if (action) {
      const inputHash = bindActionInput(
        action,
        action.kind === "plan" ? agentRequest(version, action, config).input : input,
      );
      const tracked = version.agent!.actions.find((entry) => entry.id === step!.id);
      if (tracked) {
        tracked.inputHash = inputHash;
        tracked.status = "running";
      }
    }
    const lease = Date.now() + config.timeoutMs + 30_000;
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
    event(
      arenaId,
      versionId,
      "step_started",
      `${action?.role ?? step.role} 开始执行。`,
      step.stage,
      action?.role ?? step.role,
      {
        configuration: runConfiguration(config).configuration,
        ...(config.currency === "USD"
          ? { reservedUsd: step.reservation }
          : { reservedCny: step.reservation }),
        currency: config.currency,
        modelSelection: version.modelSelection,
        model: config.id,
        promptVersion: config.promptVersion,
        schemaVersion: config.schemaVersion,
      },
    );
    return { step, input, config };
  });
}
export async function advanceArena(arenaId: string, owner: string, versionId: string) {
  const claimed = claim(arenaId, owner, versionId);
  if (!claimed) return getArena(arenaId, owner);
  const { step, input, config } = claimed;
  const frozenSources = corpusFor(versionId)?.sources ?? getVersion(versionId).intake?.usedSources;
  const action = actionFor(step.id);
  const draft = draftWriter(arenaId, versionId, step.id, step.stage, action?.role ?? input.role);
  let result: ModelResult<Strategy | Attack | Revision | Verdict | AgentPlan> | undefined;
  try {
    if (action?.kind === "plan")
      result = await generateStructured({
        ...agentRequest(getVersion(versionId), action, config),
        input: JSON.parse(action.input_body!),
        onPreview: draft.preview,
      });
    else if (step.stage === "propose")
      result = await generateStrategy(input, config, step.id, draft.preview);
    else if (step.stage === "attack")
      result = await generateAttack(input, config, step.id, draft.preview);
    else if (step.stage === "revise")
      result = await generateRevision(input, config, step.id, draft.preview);
    else if (step.stage === "judge")
      result = await generateVerdict(input, config, step.id, draft.preview);
    if (result?.formatNormalization)
      atomic(() => {
        event(
          arenaId,
          versionId,
          "format_normalized",
          "模型参数仅移除一个冗余尾部右花括号，原始参数已保存；这不表示语义核验通过。",
          step.stage,
          step.role,
          {
            ...result!.formatNormalization,
            schemaValidated: true,
            semanticValidation: "pending",
            model: result!.usage.model,
            responseId: result!.usage.responseId,
          },
        );
      });
    let evidence: import("@/lib/contracts").Evidence[] | null = null;
    if (action?.kind === "tools") {
      const current = getVersion(versionId);
      const payload = JSON.parse(action.payload);
      const requests: Array<{ request: import("@/lib/contracts").ToolRequest; attackId: string }> =
        payload.request
          ? [{ request: payload.request, attackId: "research" }]
          : input.attacks
              .filter((attack) => attack.round === action.round)
              .flatMap((attack) =>
                attack.requests.map((request) => ({ request, attackId: attack.id })),
              );
      evidence = [];
      for (const [index, entry] of requests.entries()) {
        const latestState = getVersion(versionId);
        if (
          !["running", "ready"].includes(latestState.status) ||
          assertOwner(arenaId, owner).active_version_id !== versionId
        )
          break;
        const external = entry.request.tool === "search_web" || entry.request.tool === "read_web";
        const toolReservation = external
          ? process.env.ARENA_SEARCH_PROVIDER === "tavily"
            ? Number(process.env.TAVILY_USD_PER_CREDIT ?? "0.008")
            : 0.000834
          : 0;
        if (
          external &&
          current.agent!.toolsUsed < AGENT_LIMITS.tools &&
          current.agent!.externalToolsUsed < AGENT_LIMITS.externalTools
        ) {
          try {
            atomic(() => {
              const latest = getVersion(versionId);
              reserveCall(
                structuredClone(latest),
                latest.modelSelection?.currency === "USD"
                  ? toolReservation
                  : toolReservation * CNY_PER_USD_BUDGET,
              );
              latest.toolReservedUsd = (latest.toolReservedUsd ?? 0) + toolReservation;
              saveVersion(latest);
            });
          } catch (error) {
            if (
              !(error instanceof ArenaError) ||
              !["RUN_BUDGET", "GLOBAL_BUDGET"].includes(error.code)
            )
              throw error;
            const skipped: import("@/lib/contracts").Evidence = {
              id: `E-${id()}`,
              attackId: entry.attackId,
              actionId: step.id,
              tool: entry.request.tool,
              status: "unavailable",
              title: "工具费用额度不足",
              content: error.message,
              source: "费用保护",
              sourceIds: [],
              expression: null,
              result: null,
              assumptions: "",
              createdAt: now(),
            };
            atomic(() => {
              const latest = getVersion(versionId);
              latest.evidence.push(skipped);
              saveVersion(latest);
              event(arenaId, versionId, "tool_skipped", error.message, "verify", "tools", {
                request: entry.request,
              });
            });
            current.evidence.push(skipped);
            continue;
          }
        }
        let paidToolUsd = 0;
        const didReserve =
          external &&
          current.agent!.toolsUsed < AGENT_LIMITS.tools &&
          current.agent!.externalToolsUsed < AGENT_LIMITS.externalTools;
        const obtained = (
          await runAgentTool(
            current,
            entry.request,
            entry.attackId,
            `${step.id}-tool-${index}`,
            (amount) => {
              paidToolUsd = amount;
            },
          )
        ).map((evidence) => ({ ...evidence, actionId: step.id }));
        // Each result is committed before another external request can start.
        atomic(() => {
          const latest = getVersion(versionId);
          if (didReserve)
            latest.toolReservedUsd = Math.max(0, (latest.toolReservedUsd ?? 0) - toolReservation);
          latest.toolCostUsd = (latest.toolCostUsd ?? 0) + paidToolUsd;
          latest.evidence.push(...obtained);
          saveVersion(latest);
          event(arenaId, versionId, "tool_completed", "本项资料核验已记录", "verify", "tools", {
            attemptId: `${step.id}-tool-${index}`,
            evidenceIds: obtained.map((item) => item.id),
          });
        });
        current.evidence.push(...obtained);
      }
      evidence = checkConstraints(input.challenge, input.strategies);
    } else if (step.stage === "verify" && !action) {
      evidence = [
        ...input.attacks.flatMap((attack) =>
          executeAttackTools(attack, input.challenge.materials, frozenSources),
        ),
        ...checkConstraints(input.challenge, input.strategies),
      ];
    }
    let value: Strategy | Attack | Revision | Verdict | AgentPlan | undefined;
    const modelOutput = result ? structuredClone(result.value) : undefined;
    try {
      if (step.stage === "propose" && (result!.value as Strategy).id !== input.role)
        throw new Error("模型返回的方案编号与指定角色不一致。");
      if (step.stage === "propose")
        result!.value = normalizeStrategyResources(
          result!.value as Strategy,
          input.challenge,
          frozenSources,
        );
      if (step.stage === "attack" && (result!.value as Attack).from !== input.role)
        throw new Error("质疑发起者与本轮角色不一致。");
      value =
        step.stage === "attack"
          ? validateAttack(
              {
                ...(result!.value as Attack),
                id: action ? `attack-${step.id}` : `attack-${input.role}`,
                from: input.role,
                ...(action
                  ? {
                      round: action.round,
                      targetRevisionHash: hashOf(
                        input.strategies.find(
                          (strategy) => strategy.id === (result!.value as Attack).targetStrategyId,
                        ),
                      ),
                    }
                  : {}),
              },
              input.strategies,
            )
          : step.stage === "revise"
            ? validateRevision(result!.value as Revision, input, frozenSources)
            : step.stage === "judge"
              ? validateVerdict(result!.value as Verdict, input, frozenSources)
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
      if (action?.kind === "plan") {
        if (
          ["running", "uncertain"].includes(version.status) &&
          assertOwner(arenaId, owner).active_version_id === versionId
        )
          compilePlan(arenaId, version, action, value as AgentPlan);
        else
          event(
            arenaId,
            versionId,
            "plan_archived",
            "已归档这次规划，当前讨论已停止或更换版本。",
            null,
            "planner",
            value,
          );
      } else if (step.stage === "propose") {
        const strategy = value as Strategy;
        strategy.claims = proposedClaims(strategy, input.challenge, frozenSources);
        const duplicate = version.strategies.some((other) => strategiesDuplicate(other, strategy));
        const duplicateRetryExists = db()
          .prepare("SELECT id FROM steps WHERE version_id=? AND stage='propose' AND role=?")
          .get(versionId, `${input.role}:retry`);
        const maySchedule =
          ["running", "uncertain"].includes(version.status) &&
          assertOwner(arenaId, owner).active_version_id === versionId;
        if (duplicate && !duplicateRetryExists && maySchedule) {
          const retryId = id();
          db()
            .prepare(
              "INSERT INTO steps(id,arena_id,version_id,stage,role,ordinal) VALUES(?,?,?,?,?,?)",
            )
            .run(retryId, arenaId, versionId, "propose", `${input.role}:retry`, step.ordinal + 0.1);
          if (action) copyActionForRetry(version, action, retryId);
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
            (!action ||
              (a.round === attack.round && a.targetRevisionHash === attack.targetRevisionHash)) &&
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
      else if (step.stage === "revise")
        version.revisions.push({
          ...(value as Revision),
          ...(action ? { revisionId: step.id, round: action.round } : {}),
        });
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
      syncActions(version);
      draft.finish("committed");
      saveVersion(version);
      event(
        arenaId,
        versionId,
        "step_completed",
        `${action?.role ?? step.role} 已完成。`,
        step.stage,
        action?.role ?? step.role,
        {
          usage: result?.usage ?? null,
          ...(modelOutput
            ? {
                modelOutput,
                modelOutputScope: "parsed-structured-output-before-server-rules",
              }
            : {}),
          result: value ?? evidence,
        },
      );
    });
  } catch (error) {
    const modelError = error instanceof ModelCallError ? error : undefined;
    const uncertain =
      (modelError?.uncertain ?? false) ||
      (error instanceof Error && error.message === "MCP_OUTCOME_UNCERTAIN");
    const usage = modelError?.usage ?? result?.usage;
    const validationMessage =
      modelError?.repair?.feedback ||
      (!modelError && result && error instanceof Error ? error.message.slice(0, 500) : null);
    const message =
      modelError?.message ||
      (error instanceof Error && error.message === "MCP_OUTCOME_UNCERTAIN"
        ? "联网请求结果待确认，工具费用预留保留，后续步骤已停止。"
        : error instanceof Error && error.message === "CORPUS_SNAPSHOT_MISSING"
          ? "此版本的材料快照缺失，请保留记录并创建新版本。"
          : null) ||
      (validationMessage
        ? `协议校验未通过：${validationMessage} 已记录实际用量，未生成替代内容。`
        : "此步骤处理失败，已有记录已保留；未生成替代内容。请检查模型响应或服务日志。");
    atomic(() => {
      const currentStep = db().prepare("SELECT status FROM steps WHERE id=?").get(step.id) as {
        status: string;
      };
      if (!["running", "uncertain"].includes(currentStep.status)) return;
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
          ...(modelError?.diagnostic ? { structureDiagnostic: modelError.diagnostic } : {}),
          ...(config.currency === "USD"
            ? { heldReservationUsd: uncertain ? step.reservation : 0 }
            : { heldReservationCny: uncertain ? step.reservation : 0 }),
          currency: config.currency,
          ...(validationMessage
            ? {
                rejectedResult: result?.value ?? modelError?.repair?.rejectedOutput,
                validationMessage,
              }
            : {}),
        },
      );
      const repairRole = action ? `${step.role}:repair` : `${input.role}:repair`;
      if (
        modelError?.repair &&
        (!action ||
          (action.kind !== "plan" &&
            !step.role.includes(":repair") &&
            modelRequestsUsed(versionId) < AGENT_LIMITS.modelRequests - 1)) &&
        !uncertain &&
        !["paused", "superseded"].includes(version.status) &&
        !db()
          .prepare("SELECT id FROM steps WHERE version_id=? AND stage=? AND role=?")
          .get(versionId, step.stage, repairRole)
      ) {
        const repairId = id();
        db()
          .prepare(
            "INSERT INTO steps(id,arena_id,version_id,stage,role,ordinal) VALUES(?,?,?,?,?,?)",
          )
          .run(repairId, arenaId, versionId, step.stage, repairRole, step.ordinal + 0.01);
        if (action) copyActionForRetry(version, action, repairId);
        version.status = "ready";
        version.error = null;
        event(
          arenaId,
          versionId,
          "protocol_repair_scheduled",
          "输出校验发现格式、引用或明确条件冲突，原结果已保留，将在额度内尝试一次修正。",
          step.stage,
          input.role,
          modelError.repair,
        );
      }
      if (action && ["failed", "uncertain"].includes(version.status))
        version.verdict = partialVerdict(version);
      syncActions(version);
      draft.finish(uncertain ? "interrupted" : "rejected");
      saveVersion(version);
    });
  }
  return getArena(arenaId, owner);
}
function settle(version: ArenaVersion, step: StepRow, usage?: ModelUsage) {
  if (version.modelSelection?.currency === "USD") {
    version.reservedUsd = Math.max(0, (version.reservedUsd ?? 0) - step.reservation);
    if (usage) version.costUsd = (version.costUsd ?? 0) + (usage.estimatedUsd ?? 0);
  } else {
    version.reservedCny = Math.max(0, version.reservedCny - step.reservation);
    if (usage) version.costCny += usage.estimatedCny;
  }
}
