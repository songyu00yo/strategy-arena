/** Paid evaluation runner. Importing this module never starts model calls. */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import protocol from "../evals/protocol.json";
import {
  AttackSchema,
  ChallengeSchema,
  RevisionSchema,
  StrategySchema,
  VerdictSchema,
  SCHEMA_VERSION,
  type Attack,
  type Challenge,
  type Evidence,
  type ModelResult,
  type ModelUsage,
  type Revision,
  type StageInput,
  type Strategy,
  type Verdict,
} from "../src/lib/contracts";
import {
  estimateCallCost,
  generateEvaluation,
  getModelConfig,
  ModelCallError,
} from "../src/lib/server/model";
import {
  checkConstraints,
  executeAttackTools,
  strategiesDuplicate,
  validateAttack,
  validateRevision,
  validateVerdict,
} from "../src/lib/server/tools";

export const EVAL_PROTOCOL_VERSION = protocol.version;
export const EVALUATION_MODES = ["strong-single", "independent", "arena"] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];
export type EvaluationStage = "propose" | "attack" | "revise" | "judge";
type Output = Strategy | Attack | Revision | Verdict;
type ConditionStatus = "completed" | "failed" | "budget_exhausted" | "uncertain" | "skipped";
export interface EvaluationCase {
  id: string;
  partition: string;
  initial: Challenge;
  changed: Challenge;
  changeReason: string;
  positiveChecks: string[];
  negativeChecks: string[];
}
export interface EvaluationCaps {
  maxCny: number;
  maxTokens: number;
  maxToolCalls: number;
}
export interface Ledger extends EvaluationCaps {
  spentCny: number;
  heldCny: number;
  inputTokens: number;
  outputTokens: number;
  heldTokens: number;
  toolCalls: number;
}
export interface EvaluationAdapter {
  generate(
    stage: EvaluationStage,
    input: StageInput,
    mode: EvaluationMode,
  ): Promise<ModelResult<Output>>;
  estimateCost(input: StageInput): number;
  estimateTokens(input: StageInput): number;
}
export interface AttemptRecord {
  condition: "initial" | "changed";
  stage: EvaluationStage;
  role: string;
  attempt: number;
  status: "completed" | "failed" | "uncertain";
  reservedCny: number;
  reservedTokens: number;
  usage: ModelUsage | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
  rawOutput?: Output;
  rejectedOutput?: string;
}
export interface ConditionResult {
  condition: "initial" | "changed";
  status: ConditionStatus;
  challenge: Challenge;
  strategies: Strategy[];
  attacks: Attack[];
  evidence: Evidence[];
  revisions: Revision[];
  verdict: Verdict | null;
  error: string | null;
  failedStage: string | null;
  durationMs: number;
  duplicateStrategyPairs: string[][];
}
export interface TrajectoryResult {
  id: string;
  caseId: string;
  arm: EvaluationMode;
  status: ConditionStatus;
  caps: EvaluationCaps;
  accounting: Ledger;
  conditions: ConditionResult[];
  attempts: AttemptRecord[];
  durationMs: number;
}
export type Checkpoint = (event: Record<string, unknown>) => void;
export const defaultCaps: EvaluationCaps = { ...protocol.trajectoryCaps };
export function ledger(caps: EvaluationCaps): Ledger {
  return {
    ...caps,
    spentCny: 0,
    heldCny: 0,
    inputTokens: 0,
    outputTokens: 0,
    heldTokens: 0,
    toolCalls: 0,
  };
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const roles = ["A", "B", "C"] as const;
class StopTrajectory extends Error {
  constructor(
    public status: ConditionStatus,
    message: string,
  ) {
    super(message);
  }
}
function rounded(value: number) {
  return Math.round(value * 1e10) / 1e10;
}
function validUsage(usage: ModelUsage) {
  return (
    [
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.estimatedCny,
      usage.durationMs,
    ].every((value) => Number.isFinite(value) && value >= 0) &&
    typeof usage.model === "string" &&
    typeof usage.responseId === "string"
  );
}
function reserve(local: Ledger, global: Ledger, money: number, tokens: number) {
  if (!Number.isFinite(money) || money <= 0 || !Number.isInteger(tokens) || tokens <= 0)
    throw new StopTrajectory("failed", "Invalid pre-call reservation estimate.");
  for (const account of [local, global]) {
    if (
      account.spentCny + account.heldCny + money > account.maxCny + 1e-9 ||
      account.inputTokens + account.outputTokens + account.heldTokens + tokens > account.maxTokens
    )
      throw new StopTrajectory(
        "budget_exhausted",
        "The next call does not fit the remaining CNY/token reservation cap.",
      );
  }
  for (const account of [local, global]) {
    account.heldCny = rounded(account.heldCny + money);
    account.heldTokens += tokens;
  }
}
function settle(
  local: Ledger,
  global: Ledger,
  money: number,
  tokens: number,
  usage: ModelUsage | undefined,
  uncertain: boolean,
) {
  for (const account of [local, global]) {
    if (!uncertain) {
      account.heldCny = Math.max(0, rounded(account.heldCny - money));
      account.heldTokens = Math.max(0, account.heldTokens - tokens);
    }
    if (usage) {
      account.spentCny = rounded(account.spentCny + usage.estimatedCny);
      account.inputTokens += usage.inputTokens;
      account.outputTokens += usage.outputTokens;
    }
  }
}
function normalizeStrategy(strategy: Strategy, input: StageInput): Strategy {
  if (strategy.id !== input.role)
    throw new Error("Proposal role does not match its assigned strategy ID.");
  const userText = [
    input.challenge.goal,
    input.challenge.constraints,
    input.challenge.preferences,
    input.challenge.materials,
    ...input.challenge.options,
  ].join("\n");
  return {
    ...strategy,
    claims: strategy.claims.map((claim, index) => ({
      ...claim,
      id: `${strategy.id}-claim-${index + 1}`,
      status:
        claim.status === "estimate"
          ? "estimate"
          : claim.status === "user" && userText.includes(claim.text)
            ? "user"
            : "unknown",
      sourceIds: [],
    })),
  };
}
function validateOutput(
  stage: EvaluationStage,
  value: Output,
  input: StageInput,
  mode: EvaluationMode,
): Output {
  if (stage === "propose") return normalizeStrategy(StrategySchema.parse(value), input);
  if (stage === "attack") {
    const attack = AttackSchema.parse(value);
    if (attack.from !== input.role)
      throw new Error("Critique role does not match its assigned role.");
    if (mode === "independent" && attack.targetStrategyId !== input.role)
      throw new Error("Independent critique must target its own strategy.");
    return validateAttack(
      { ...attack, id: `attack-${input.role}`, from: input.role },
      input.strategies,
      mode !== "arena",
    );
  }
  if (stage === "revise") return validateRevision(RevisionSchema.parse(value), input);
  return validateVerdict(VerdictSchema.parse(value), input);
}
function emptyCondition(condition: "initial" | "changed", challenge: Challenge): ConditionResult {
  return {
    condition,
    status: "skipped",
    challenge,
    strategies: [],
    attacks: [],
    evidence: [],
    revisions: [],
    verdict: null,
    error: null,
    failedStage: null,
    durationMs: 0,
    duplicateStrategyPairs: [],
  };
}

/** Uses real deterministic tools; only the model adapter is injectable for unit tests. */
export async function runTrajectory(options: {
  item: EvaluationCase;
  mode: EvaluationMode;
  global: Ledger;
  caps?: EvaluationCaps;
  adapter: EvaluationAdapter;
  checkpoint: Checkpoint;
  id?: string;
}): Promise<TrajectoryResult> {
  const { item, mode, global, adapter, checkpoint } = options;
  const caps = { ...(options.caps ?? defaultCaps) };
  const accounting = ledger(caps);
  const started = Date.now();
  const result: TrajectoryResult = {
    id: options.id ?? randomUUID(),
    caseId: item.id,
    arm: mode,
    status: "skipped",
    caps,
    accounting,
    conditions: [],
    attempts: [],
    durationMs: 0,
  };
  const history: string[] = [];
  checkpoint({ type: "trajectory_started", id: result.id, caseId: item.id, arm: mode, caps });
  let stopFollowing = false;
  for (const condition of ["initial", "changed"] as const) {
    const current = emptyCondition(condition, structuredClone(item[condition]));
    result.conditions.push(current);
    if (stopFollowing) {
      current.error =
        "Initial condition did not complete; the paired update was not silently restarted.";
      checkpoint({ type: "condition_skipped", id: result.id, condition, reason: current.error });
      continue;
    }
    const conditionStarted = Date.now();
    let activeStage: string = "propose";
    function inputFor(stage: EvaluationStage, role: string): StageInput {
      const independent = mode === "independent" && stage !== "judge";
      const proposeIsolated = stage === "propose" && mode !== "strong-single";
      const initial = result.conditions.find((entry) => entry.condition === "initial");
      const previousStrategy =
        condition === "changed"
          ? (initial?.revisions.find((revision) => revision.strategyId === role)?.strategy ??
            initial?.strategies.find((strategy) => strategy.id === role))
          : undefined;
      return {
        challenge: structuredClone(current.challenge),
        role,
        strategies: proposeIsolated
          ? []
          : structuredClone(
              independent
                ? current.strategies.filter((strategy) => strategy.id === role)
                : current.strategies,
            ),
        attacks: proposeIsolated
          ? []
          : structuredClone(
              independent
                ? current.attacks.filter((attack) => attack.targetStrategyId === role)
                : current.attacks,
            ),
        evidence: proposeIsolated
          ? []
          : structuredClone(
              independent
                ? current.evidence.filter(
                    (evidence) =>
                      current.attacks.some(
                        (attack) =>
                          attack.targetStrategyId === role && attack.id === evidence.attackId,
                      ) || evidence.attackId === `constraint-${role}`,
                  )
                : current.evidence,
            ),
        revisions: proposeIsolated
          ? []
          : structuredClone(
              independent
                ? current.revisions.filter((revision) => revision.strategyId === role)
                : current.revisions,
            ),
        userChallenges: condition === "changed" ? [`Condition update: ${item.changeReason}`] : [],
        ...(previousStrategy ? { previousStrategy: structuredClone(previousStrategy) } : {}),
        ...(mode === "strong-single" ? { contextHistory: [...history] } : {}),
        evaluationMode: mode,
      };
    }
    async function call(stage: EvaluationStage, role: string): Promise<Output> {
      let repair: ModelCallError["repair"];
      for (let attempt = 0; attempt <= 1; attempt++) {
        const input = inputFor(stage, role);
        if (repair) {
          input.repairFeedback = repair.feedback;
          input.rejectedOutput = repair.rejectedOutput;
        }
        const money = adapter.estimateCost(input),
          tokens = adapter.estimateTokens(input);
        reserve(accounting, global, money, tokens);
        const record: AttemptRecord = {
          condition,
          stage,
          role,
          attempt,
          status: "failed",
          reservedCny: money,
          reservedTokens: tokens,
          usage: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: "",
        };
        let response: ModelResult<Output> | undefined;
        let accounted = false;
        checkpoint({
          type: "call_started",
          id: result.id,
          condition,
          stage,
          role,
          attempt,
          reservation: { cny: money, tokens },
          input,
          accounting: { ...accounting },
          global: { ...global },
        });
        try {
          response = await adapter.generate(stage, input, mode);
          if (!validUsage(response.usage))
            throw new ModelCallError("Usage could not be verified; reservation retained.", true);
          record.usage = response.usage;
          record.rawOutput = response.value;
          settle(accounting, global, money, tokens, response.usage, false);
          accounted = true;
          checkpoint({
            type: "call_returned",
            id: result.id,
            condition,
            stage,
            role,
            attempt,
            rawOutput: response.value,
            usage: response.usage,
          });
          let value: Output;
          try {
            value = validateOutput(stage, response.value, input, mode);
          } catch (error) {
            const feedback =
              error instanceof Error
                ? error.message.slice(0, 1500)
                : "Invalid schema or references.";
            throw new ModelCallError(
              "Output failed schema or reference validation.",
              false,
              response.usage,
              { feedback, rejectedOutput: JSON.stringify(response.value).slice(0, 24000) },
            );
          }
          if (mode === "strong-single")
            history.push(JSON.stringify({ condition, stage, role, output: value }));
          record.status = "completed";
          record.finishedAt = new Date().toISOString();
          result.attempts.push(record);
          checkpoint({
            type: "call_completed",
            id: result.id,
            ...record,
            normalizedOutput: value,
            accounting: { ...accounting },
            global: { ...global },
          });
          if (
            [accounting, global].some(
              (account) =>
                account.spentCny + account.heldCny > account.maxCny + 1e-9 ||
                account.inputTokens + account.outputTokens + account.heldTokens > account.maxTokens,
            )
          )
            throw new StopTrajectory(
              "budget_exhausted",
              "Reported usage exceeded the reservation assumption; stopped before another call.",
            );
          return value;
        } catch (error) {
          if (error instanceof StopTrajectory) throw error;
          const failure =
            error instanceof ModelCallError
              ? error
              : new ModelCallError(
                  "Unexpected model adapter failure; request completion is unknown.",
                  true,
                );
          const usage = failure.usage && validUsage(failure.usage) ? failure.usage : undefined;
          if (!accounted) settle(accounting, global, money, tokens, usage, failure.uncertain);
          record.status = failure.uncertain ? "uncertain" : "failed";
          record.usage = record.usage ?? usage ?? null;
          record.error = failure.message;
          record.rejectedOutput = failure.repair?.rejectedOutput;
          record.finishedAt = new Date().toISOString();
          result.attempts.push(record);
          checkpoint({
            type: "call_failed",
            id: result.id,
            ...record,
            heldReservation: failure.uncertain,
            accounting: { ...accounting },
            global: { ...global },
          });
          if (mode === "strong-single" && failure.repair)
            history.push(
              JSON.stringify({
                condition,
                stage,
                role,
                rejectedOutput: failure.repair.rejectedOutput,
                validation: failure.repair.feedback,
              }),
            );
          if (failure.uncertain)
            throw new StopTrajectory(
              "uncertain",
              "Provider execution is uncertain; reservation retained and no retry was made.",
            );
          if (attempt === 0 && failure.repair) {
            repair = failure.repair;
            checkpoint({
              type: "format_repair_scheduled",
              id: result.id,
              condition,
              stage,
              role,
              nextAttempt: 1,
            });
            continue;
          }
          throw new StopTrajectory("failed", failure.message);
        }
      }
      throw new StopTrajectory("failed", "Unreachable repair state.");
    }
    try {
      for (const role of roles) current.strategies.push((await call("propose", role)) as Strategy);
      for (let index = 0; index < current.strategies.length; index++)
        for (let other = index + 1; other < current.strategies.length; other++)
          if (strategiesDuplicate(current.strategies[index], current.strategies[other]))
            current.duplicateStrategyPairs.push([
              current.strategies[index].id,
              current.strategies[other].id,
            ]);
      activeStage = "attack";
      for (const role of roles) current.attacks.push((await call("attack", role)) as Attack);
      activeStage = "verify";
      const toolCount = current.attacks.reduce((sum, attack) => sum + attack.requests.length, 0);
      if (
        [accounting, global].some((account) => account.toolCalls + toolCount > account.maxToolCalls)
      )
        throw new StopTrajectory("budget_exhausted", "Tool request cap would be exceeded.");
      accounting.toolCalls += toolCount;
      global.toolCalls += toolCount;
      current.evidence = [
        ...current.attacks.flatMap((attack) =>
          executeAttackTools(attack, current.challenge.materials),
        ),
        ...checkConstraints(current.challenge, current.strategies),
      ];
      checkpoint({
        type: "tools_completed",
        id: result.id,
        condition,
        toolRequestCount: toolCount,
        evidence: current.evidence,
        accounting: { ...accounting },
      });
      activeStage = "revise";
      for (const role of roles) current.revisions.push((await call("revise", role)) as Revision);
      activeStage = "judge";
      current.verdict = (await call("judge", "judge")) as Verdict;
      current.attacks = current.attacks.map((attack) => ({
        ...attack,
        status:
          current.verdict!.attackFindings.find((finding) => finding.attackId === attack.id)
            ?.status ?? "unresolved",
      }));
      current.status = "completed";
    } catch (error) {
      const failure =
        error instanceof StopTrajectory
          ? error
          : new StopTrajectory(
              "failed",
              "Local evaluation validation/tool failure; raw checkpoint retained.",
            );
      current.status = failure.status;
      current.error = failure.message;
      current.failedStage = activeStage;
      stopFollowing = true;
    }
    current.durationMs = Date.now() - conditionStarted;
    checkpoint({
      type: "condition_finished",
      id: result.id,
      condition,
      result: current,
      accounting: { ...accounting },
    });
  }
  result.status = result.conditions.every((condition) => condition.status === "completed")
    ? "completed"
    : (result.conditions.find(
        (condition) => condition.status !== "completed" && condition.status !== "skipped",
      )?.status ?? "failed");
  result.durationMs = Date.now() - started;
  checkpoint({ type: "trajectory_finished", result });
  return result;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
function savePrivate(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
function jsonlWriter(path: string): Checkpoint {
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
  return (event) => {
    const fd = openSync(path, "a", 0o600);
    try {
      appendFileSync(fd, JSON.stringify({ recordedAt: new Date().toISOString(), ...event }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
}
/** Blinding hides explicit method metadata, not stylistic clues inside generated prose. */
export function exportBlinded(
  results: TrajectoryResult[],
  cases: EvaluationCase[],
  directory: string,
) {
  const cards = shuffled(results).map((result) => {
    const item = cases.find((item) => item.id === result.caseId)!;
    const label = randomBytes(8).toString("hex");
    savePrivate(resolve(directory, "blind", `${label}.json`), {
      label,
      task: {
        id: item.id,
        initial: item.initial,
        changed: item.changed,
        changeReason: item.changeReason,
        positiveChecks: item.positiveChecks,
        negativeChecks: item.negativeChecks,
      },
      conditions: result.conditions.map((condition) => ({
        condition: condition.condition,
        status: condition.status,
        strategies: condition.strategies.map(
          (strategy) =>
            condition.revisions.find((revision) => revision.strategyId === strategy.id)?.strategy ??
            strategy,
        ),
        evidence: condition.evidence,
        verdict: condition.verdict,
        incomplete: condition.status !== "completed",
      })),
    });
    return {
      label,
      caseId: result.caseId,
      arm: result.arm,
      trajectoryId: result.id,
      artifactPath: `raw/${result.id}.json`,
    };
  });
  savePrivate(resolve(directory, "private", "blind-mapping.json"), {
    note: "Keep this mapping from raters until labels are final.",
    cards,
  });
  savePrivate(resolve(directory, "blind", "scorecards.json"), {
    rubric: {
      constraintCompliance: "0=未满足，1=部分满足，2=满足。",
      claimTraceability: "0=无可追溯依据，1=部分可追溯，2=材料、估算与未知区分清楚。",
      actionability: "0=不可执行，1=部分可执行，2=第一步、检查和退出条件具体。",
      adaptation: "0=未贴合条件，1=部分调整，2=合理响应变化且无负向退步。",
    },
    records: cards.flatMap((card) =>
      ["initial", "changed"].map((condition) => ({
        label: card.label,
        condition,
        raterId: "",
        scores: {
          constraintCompliance: null,
          claimTraceability: null,
          actionability: null,
          adaptation: null,
        },
        reason: "",
        evidenceLocations: [],
      })),
    ),
  });
  return cards;
}

function cliOptions(argv: string[]) {
  const allowed = new Set([
    "--split",
    "--case",
    "--output",
    "--max-cny",
    "--trajectory-cny",
    "--max-tokens",
    "--max-tools",
  ]);
  for (let index = 0; index < argv.length; index += 2)
    if (!allowed.has(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith("--"))
      throw new Error(
        "Invalid arguments. See docs/evaluation.md; automatic resume is not supported.",
      );
  const option = (key: string, fallback: string) => {
    const index = argv.indexOf(key);
    return index === -1 ? fallback : argv[index + 1];
  };
  const split = option("--split", "development");
  if (!["development", "held-out"].includes(split))
    throw new Error("--split must be development or held-out.");
  const maxCny = Number(option("--max-cny", String(protocol.commandCapCny)));
  const caps = {
    maxCny: Number(option("--trajectory-cny", String(defaultCaps.maxCny))),
    maxTokens: Number(option("--max-tokens", String(defaultCaps.maxTokens))),
    maxToolCalls: Number(option("--max-tools", String(defaultCaps.maxToolCalls))),
  };
  if (
    ![maxCny, caps.maxCny, caps.maxTokens, caps.maxToolCalls].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !Number.isInteger(caps.maxTokens) ||
    !Number.isInteger(caps.maxToolCalls)
  )
    throw new Error(
      "Budget caps must be positive finite numbers; token/tool caps must be integers.",
    );
  if (
    caps.maxCny > defaultCaps.maxCny ||
    maxCny > protocol.commandCapCny ||
    caps.maxToolCalls > defaultCaps.maxToolCalls
  )
    throw new Error(
      "This runner permits at most 1.5 CNY per trajectory, 20 CNY per command, and 12 tool requests per trajectory.",
    );
  return {
    split,
    selectedIds: argv.flatMap((argument, index) =>
      argument === "--case" ? argv[index + 1].split(",") : [],
    ),
    output: option("--output", "artifacts/evaluations"),
    maxCny,
    caps,
  };
}
export async function main(argv = process.argv.slice(2)) {
  const options = cliOptions(argv);
  const model = getModelConfig();
  if (!model.configured) throw new Error("MODEL_API_KEY is missing. No model calls were made.");
  const definitionBytes = readFileSync("evals/cases.json");
  const definitions = JSON.parse(definitionBytes.toString("utf8")) as { cases: EvaluationCase[] };
  const partition = options.split === "held-out" ? "holdout" : "development";
  const cases = definitions.cases.filter(
    (item) =>
      item.partition === partition &&
      (!options.selectedIds.length || options.selectedIds.includes(item.id)),
  );
  if (!cases.length || options.selectedIds.some((id) => !cases.some((item) => item.id === id)))
    throw new Error("Case selection is empty or includes an ID outside the selected split.");
  for (const item of cases) {
    if (!/^[a-z0-9-]+$/.test(item.id)) throw new Error("Unsafe case ID.");
    ChallengeSchema.parse(item.initial);
    ChallengeSchema.parse(item.changed);
  }
  const artifactsRoot = resolve("artifacts");
  const outputRoot = resolve(options.output);
  if (outputRoot !== artifactsRoot && !outputRoot.startsWith(artifactsRoot + sep))
    throw new Error("--output must stay inside the ignored artifacts directory.");
  const directory = resolve(
    outputRoot,
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const checkpoint = jsonlWriter(resolve(directory, "checkpoint.jsonl"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const workingTreeDirty = Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  );
  const config = JSON.parse(readFileSync("config/model.json", "utf8"));
  const base = new URL(process.env.MODEL_BASE_URL || config.baseUrl);
  if (base.username || base.password || base.protocol !== "https:")
    throw new Error("The model base URL must be HTTPS and contain no credentials.");
  const toolPolicyHash = hash(readFileSync("src/lib/server/tools.ts"));
  const effectiveModel = {
    ...model,
    temperature: Number(process.env.MODEL_TEMPERATURE ?? config.temperature),
    baseUrl: base.toString(),
    thinking: config.thinking,
  };
  const modelConfigHash = hash(JSON.stringify(effectiveModel));
  const schedule = shuffled(
    cases.flatMap((item) => EVALUATION_MODES.map((mode) => ({ caseId: item.id, mode }))),
  );
  const metadata = {
    kind: "real-model-evaluation-planned",
    protocolVersion: EVAL_PROTOCOL_VERSION,
    createdAt: new Date().toISOString(),
    commit,
    workingTreeDirty,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    split: options.split,
    selectedCaseIds: cases.map((item) => item.id),
    caseDefinitionSha256: hash(definitionBytes),
    protocolDefinitionSha256: hash(readFileSync("evals/protocol.json")),
    runnerSourceSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    modelAdapterSourceSha256: hash(readFileSync("src/lib/server/model.ts")),
    basePromptSourceSha256: hash(readFileSync("prompts/protocol.ts")),
    promptVersion: model.promptVersion,
    schemaVersion: SCHEMA_VERSION,
    model: effectiveModel,
    modelConfigHash,
    toolPolicyHash,
    caps: options.caps,
    commandCapCny: options.maxCny,
    schedule,
    modelIdentityNote:
      "Provider aliases are mutable. Actual returned model identities and response IDs are retained in each call usage.",
    resumePolicy:
      "No automatic resume. An interrupted/uncertain call remains unresolved; inspect checkpoint and provider usage before any new paid run.",
  };
  savePrivate(resolve(directory, "metadata.json"), metadata);
  const global = ledger({
    maxCny: options.maxCny,
    maxTokens: options.caps.maxTokens * schedule.length,
    maxToolCalls: options.caps.maxToolCalls * schedule.length,
  });
  const adapter: EvaluationAdapter = {
    generate: generateEvaluation,
    estimateCost: estimateCallCost,
    estimateTokens: (input) =>
      Buffer.byteLength(JSON.stringify(input), "utf8") + 22000 + model.maxOutputTokens,
  };
  const results: TrajectoryResult[] = [];
  for (const entry of schedule) {
    const item = cases.find((item) => item.id === entry.caseId)!;
    const result = await runTrajectory({
      item,
      mode: entry.mode,
      global,
      caps: options.caps,
      adapter,
      checkpoint,
    });
    results.push(result);
    savePrivate(resolve(directory, "raw", `${result.id}.json`), {
      metadata: {
        commit,
        workingTreeDirty,
        promptVersion: model.promptVersion,
        schemaVersion: SCHEMA_VERSION,
        modelConfigHash,
        toolPolicyHash,
        declaredModel: model.id,
      },
      ...result,
    });
    console.log(
      JSON.stringify({
        caseId: result.caseId,
        arm: result.arm,
        status: result.status,
        costCny: result.accounting.spentCny,
        heldCny: result.accounting.heldCny,
      }),
    );
  }
  const cards = exportBlinded(results, cases, directory);
  savePrivate(resolve(directory, "summary.json"), {
    status: results.every((result) => result.status === "completed")
      ? "model-runs-complete-awaiting-human-scores"
      : "incomplete-awaiting-audit",
    protocolVersion: EVAL_PROTOCOL_VERSION,
    commit,
    workingTreeDirty,
    selectedCases: cases.length,
    plannedTrajectories: schedule.length,
    recordedTrajectories: results.length,
    plannedConditionOutputs: schedule.length * 2,
    completedConditionOutputs: results
      .flatMap((result) => result.conditions)
      .filter((condition) => condition.status === "completed").length,
    unfinishedRemainInDenominator: true,
    globalAccounting: global,
    perArm: EVALUATION_MODES.map((arm) => {
      const group = results.filter((result) => result.arm === arm);
      return {
        arm,
        trajectories: group.length,
        completed: group.filter((result) => result.status === "completed").length,
        costCny: group.reduce((sum, result) => sum + result.accounting.spentCny, 0),
        heldCny: group.reduce((sum, result) => sum + result.accounting.heldCny, 0),
      };
    }),
    blindCards: cards.length,
    qualityScores: null,
    qualityConclusion:
      "No human labels have been supplied. No quality superiority or significance claim is made.",
  });
  checkpoint({
    type: "run_finished",
    recordedTrajectories: results.length,
    globalAccounting: global,
  });
  console.log(
    `Saved private raw records and blinded cards under ${relative(process.cwd(), directory)}. No quality scores were generated.`,
  );
  if (results.some((result) => result.status !== "completed")) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      "Evaluation did not finish. Inspect local checkpoints/configuration; credentials and raw inputs are not printed. Automatic resume is disabled.",
    );
    process.exitCode = 1;
  });
