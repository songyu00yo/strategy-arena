import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PLANNING_CONTRACT_VERSION,
  PLANNING_AGENT_IDS,
  type CreatePlanningInput,
  type PlanningAction,
  type PlanningAgentId,
  type PlanningAnswerInput,
  type PlanningDimension,
  type PlanningCoverageArea,
  type PlanningCoverageEntry,
  type PlanningEvent,
  type PlanningItem,
  type PlanningQuestion,
  type PlanningReport,
  type PlanningSession,
  type PlanningSnapshot,
  type PlanningSource,
} from "../planning-contracts";
import {
  CreatePlanningSchema,
  PlanningActionSchema,
  PlanningAnalysisOutputSchema,
  PlanningExpertOutputSchema,
  PlanningQuestionsOutputSchema,
  PlanningReviewOutputSchema,
  type PlanningAnalysisOutput,
  type PlanningExpertOutput,
  type PlanningQuestionsOutput,
  type PlanningReviewOutput,
} from "../planning-schemas";
import { ModelModeSchema, type ModelUsage } from "../contracts";
import { ArenaError, atomic, consumeRun, db, id, now } from "./db";
import { holdBilling } from "./billing";
import {
  estimateStructuredCall,
  generateStructured,
  ModelCallError,
  resolveModelConfig,
  type ModelConfig,
  type StructuredRequest,
} from "./model";
import {
  PLANNING_PROMPTS,
  PLANNING_PROMPT_VERSION,
  PLANNING_SCHEMA_VERSION,
} from "../../../prompts/planning";

const DIMENSIONS: PlanningDimension[] = [
  "function",
  "content",
  "flow",
  "style",
  "constraints",
  "delivery",
];
const NAMES = {
  A: "项目理解",
  B: "关键取舍",
  D: "可行性分析",
  E: "制作路径",
  C: "综合交付",
} as const;
const RESPONSIBILITIES = {
  A: "目标 · 受众 · 范围",
  B: "选项 · 优先级 · 取舍",
  D: "资源 · 时间 · 风险",
  E: "第一版 · 步骤 · 检查",
  C: "结论 · 条件 · 待确认",
} as const;
const COVERAGE_AREAS: PlanningCoverageArea[] = [
  "goal",
  "resources",
  "time_cost",
  "constraints",
  "risks",
  "implementation",
  "mvp",
];
const COVERAGE_NAMES: Record<PlanningCoverageArea, string> = {
  goal: "项目目标",
  resources: "现有资源",
  time_cost: "时间与成本",
  constraints: "限制条件",
  risks: "风险",
  implementation: "制作路径",
  mvp: "最小可行版本",
};
const INITIAL_QUESTION_LIMIT = 8;
const ADDITIONAL_QUESTION_LIMIT = 3;
type RoundState = {
  number: number;
  limit: number;
  questionKeys: string[];
  closed: boolean;
  endedEarly: boolean;
};
type PrivatePlanning = {
  session: PlanningSession;
  snapshotVersion: number;
  eventSeq: number;
  events: PlanningEvent[];
  nextRole: PlanningAgentId;
  stopped: boolean;
  config?: ModelConfig;
  configHash?: string;
  reportHistory: PlanningReport[];
  roundState: RoundState;
};
type Operation = {
  id: string;
  session_id: string;
  owner: string;
  revision: number;
  kind: string;
  request_hash: string;
  state: string;
  role: PlanningAgentId | null;
  updated_at: number;
};
type Output =
  | PlanningAnalysisOutput
  | PlanningQuestionsOutput
  | PlanningExpertOutput
  | PlanningReviewOutput;
type CallResult = { value: Output; usage: ModelUsage; formatNormalization?: unknown };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Confirmation metadata never changes the content the user actually reviewed. */
export function planningContentFingerprint(session: PlanningSession): string {
  return hash({
    goal: session.goal,
    items: session.items.map(({ confirmation, ...item }) => {
      void confirmation;
      return { ...item, status: item.status === "confirmed" ? "proposed" : item.status };
    }),
    answers: session.answers,
    sources: session.sourceRecords.filter((source) => source.kind !== "analysis"),
    questions: session.questions.filter((question) => question.status === "active"),
  });
}
function reportFingerprint(report: Omit<PlanningReport, "fingerprint"> | PlanningReport) {
  return hash({
    basedOnRevision: report.basedOnRevision,
    contentFingerprint: report.contentFingerprint,
    title: report.title,
    summary: report.summary,
    sections: report.sections,
    tasks: report.tasks,
    risks: report.risks,
    unresolved: report.unresolved,
    acceptance: report.acceptance,
    executionPrompt: report.executionPrompt,
    markdown: report.markdown,
  });
}
function read(sessionId: string, owner: string): PrivatePlanning {
  const row = db()
    .prepare("SELECT body FROM planning_sessions WHERE id=? AND owner=?")
    .get(sessionId, owner) as { body: string } | undefined;
  if (!row) throw new ArenaError("未找到这份规划，或当前浏览器没有访问权限。", 404, "NOT_FOUND");
  const state = JSON.parse(row.body) as PrivatePlanning;
  if (!state.roundState || state.session.contractVersion !== PLANNING_CONTRACT_VERSION) {
    const s = state.session;
    state.roundState ??= {
      number: 1,
      limit: INITIAL_QUESTION_LIMIT,
      questionKeys: s.questions.map(questionKey),
      closed:
        Boolean(s.report) ||
        (!s.questions.some((question) => question.status === "active") &&
          s.questions.length >= INITIAL_QUESTION_LIMIT),
      endedEarly: Boolean(s.report) && s.questions.length < INITIAL_QUESTION_LIMIT,
    };
    s.contractVersion = PLANNING_CONTRACT_VERSION;
    s.productScope = "analysis_and_guidance";
    s.expertResults ??= [];
    s.progress ??= initialProgress();
    s.agents = PLANNING_AGENT_IDS.map((role) => {
      const existing = s.agents.find((agent) => agent.id === role);
      return existing
        ? { ...existing, name: NAMES[role], responsibility: RESPONSIBILITIES[role] }
        : initialAgent(role);
    });
    if (!s.activeOperationId && state.nextRole === "C" && !s.report) {
      state.roundState.closed = true;
      state.nextRole = "D";
    }
    if (
      !s.activeOperationId &&
      !["working", "uncertain"].includes(s.status) &&
      state.roundState.questionKeys.length >= state.roundState.limit
    ) {
      closeQuestions(state, false, "system");
      if (!s.report) {
        state.nextRole = "A";
        if (!["failed", "paused"].includes(s.status)) s.status = "ready";
      }
    }
    emit(
      state,
      "session_upgraded",
      "system",
      "已有内容已接入新的分析流程",
      "保留历史回答与报告；新增可行性和制作路径分析，不补造历史专家结论。",
    );
    save(state);
  }
  return state;
}
function operation(operationId: string): Operation | undefined {
  return db().prepare("SELECT * FROM planning_operations WHERE id=?").get(operationId) as
    | Operation
    | undefined;
}
function questionKey(question: Pick<PlanningQuestion, "id" | "version">) {
  return `${question.id}:${question.version}`;
}
function initialAgent(role: PlanningAgentId): PlanningSession["agents"][number] {
  return {
    id: role,
    name: NAMES[role],
    responsibility: RESPONSIBILITIES[role],
    status: "idle",
    taskId: null,
    operationId: null,
    taskLabel: "等待开始",
    summary: "",
    preview: "",
    startedAt: null,
    finishedAt: null,
  };
}
function emptyCoverage(): PlanningCoverageEntry[] {
  return COVERAGE_AREAS.map((area) => ({
    area,
    status: "unknown",
    reason: "尚未分析此方面。",
    itemIds: [],
    assessedBy: null,
  }));
}
function initialProgress(): PlanningSession["progress"] {
  return {
    round: 1,
    questionLimit: INITIAL_QUESTION_LIMIT,
    questionsIssued: 0,
    questionsAnswered: 0,
    questionsRemaining: INITIAL_QUESTION_LIMIT,
    questionSlotsRemaining: INITIAL_QUESTION_LIMIT,
    activeQuestions: 0,
    stage: "understanding",
    budgetExhausted: false,
    endedEarly: false,
    coverage: emptyCoverage(),
  };
}
function updateProgress(state: PrivatePlanning) {
  const s = state.session,
    round = state.roundState;
  const keys = new Set(round.questionKeys);
  const answered = new Set(
    s.answers
      .map((answer) => `${answer.questionId}:${answer.questionVersion}`)
      .filter((key) => keys.has(key)),
  ).size;
  const stage = {
    A: "understanding",
    B: "clarifying",
    D: "feasibility",
    E: "production",
    C: "synthesizing",
  } as const;
  s.progress = {
    ...s.progress,
    round: round.number,
    questionLimit: round.limit,
    questionsIssued: keys.size,
    questionsAnswered: answered,
    questionsRemaining: Math.max(0, round.limit - answered),
    questionSlotsRemaining: Math.max(0, round.limit - keys.size),
    activeQuestions: s.questions.filter((question) => question.status === "active").length,
    stage: s.report
      ? "report"
      : s.questions.some((question) => question.status === "active")
        ? "clarifying"
        : stage[state.nextRole],
    budgetExhausted: keys.size >= round.limit,
    endedEarly: round.endedEarly,
  };
}
function updateCoverage(
  state: PrivatePlanning,
  entries: PlanningAnalysisOutput["analysisCoverage"],
  role: PlanningAgentId,
) {
  const known = new Set(state.session.items.map((item) => item.id));
  for (const entry of entries) {
    const index = state.session.progress.coverage.findIndex(
      (current) => current.area === entry.area,
    );
    state.session.progress.coverage[index] = {
      ...entry,
      itemIds: entry.itemIds.filter((key) => known.has(key)),
      assessedBy: role,
    };
  }
}
function currentExperts(state: PrivatePlanning) {
  const fingerprint = planningContentFingerprint(state.session);
  return state.session.expertResults.filter(
    (entry) =>
      entry.round === state.roundState.number &&
      entry.basedOnRevision === state.session.revision &&
      entry.contentFingerprint === fingerprint,
  );
}
function canConfirm(state: PrivatePlanning) {
  const { session } = state;
  const { report, review } = session;
  if (!report || !review || report.status !== "draft" || !review.ready || review.blockers.length)
    return false;
  if (session.activeOperationId || ["working", "uncertain", "completed"].includes(session.status))
    return false;
  if (
    session.questions.some((question) => question.status === "active") ||
    !["D", "E"].every((role) => currentExperts(state).some((expert) => expert.agentId === role))
  )
    return false;
  const fingerprint = planningContentFingerprint(session);
  return (
    report.basedOnRevision === session.revision &&
    review.basedOnRevision === session.revision &&
    report.contentFingerprint === fingerprint &&
    review.contentFingerprint === fingerprint &&
    report.fingerprint === reportFingerprint(report)
  );
}
function capabilities(state: PrivatePlanning) {
  const s = state.session;
  updateProgress(state);
  const locked = Boolean(s.activeOperationId) || s.status === "working" || s.status === "uncertain";
  const active = s.questions.some((question) => question.status === "active");
  const finished = Boolean(s.report);
  s.capabilities = {
    canAdvance: !locked && !finished && s.status !== "completed" && !active,
    canAnswer: !locked && active && s.status !== "completed",
    canAddNote: !locked,
    canPreview:
      !locked &&
      s.status !== "completed" &&
      (!state.roundState.closed || (finished && !canConfirm(state))),
    canConfirm: canConfirm(state),
    canStop: s.status === "working",
    canStartRound: !locked && finished,
    reason:
      s.status === "uncertain"
        ? "上一请求的结果或费用尚未核实，保留已有内容并暂停新的模型请求。"
        : s.activeOperationId
          ? "正在完成当前请求。"
          : active
            ? "可以回答当前问题，也可以直接生成已有信息的分析。"
            : "",
  };
  if (locked || ["paused", "failed"].includes(s.status)) s.nextAction = "none";
  else if (active) s.nextAction = "answer";
  else if (s.capabilities.canConfirm) s.nextAction = "confirm";
  else if (finished) s.nextAction = "start_round";
  else s.nextAction = "advance";
}
function save(state: PrivatePlanning) {
  state.snapshotVersion++;
  state.session.updatedAt = now();
  capabilities(state);
  db()
    .prepare("UPDATE planning_sessions SET body=?,snapshot_version=?,updated_at=? WHERE id=?")
    .run(JSON.stringify(state), state.snapshotVersion, Date.now(), state.session.id);
}
function snapshot(state: PrivatePlanning): PlanningSnapshot {
  capabilities(state);
  return structuredClone({
    snapshotVersion: state.snapshotVersion,
    session: state.session,
    events: state.events,
    eventCursor: state.eventSeq,
  });
}
function emit(
  state: PrivatePlanning,
  kind: PlanningEvent["kind"],
  actor: PlanningEvent["actor"],
  title: string,
  detail = "",
  extra: Partial<PlanningEvent> = {},
) {
  const event: PlanningEvent = {
    id: id(),
    seq: ++state.eventSeq,
    revision: state.session.revision,
    operationId: state.session.activeOperationId,
    kind,
    actor,
    from: actor,
    to: null,
    questionId: null,
    questionVersion: null,
    answerId: null,
    itemIds: [],
    title,
    detail,
    createdAt: now(),
    ...extra,
  };
  state.events.push(event);
  if (state.events.length > 500) state.events = state.events.slice(-500);
  return event;
}
function archiveReport(state: PrivatePlanning) {
  if (state.session.report) state.reportHistory.push(structuredClone(state.session.report));
  state.session.report = null;
  state.session.review = null;
  state.session.expertResults = [];
  state.session.progress.coverage = emptyCoverage();
}
function checkRevision(state: PrivatePlanning, revision: number) {
  if (state.session.revision !== revision)
    throw new ArenaError(
      "规划已经更新，请先读取最新内容；你的输入仍可保留。",
      409,
      "STALE_PLANNING",
    );
}
function checkDuplicate(
  existing: Operation,
  owner: string,
  sessionId: string | null,
  requestHash: string,
) {
  if (
    existing.owner !== owner ||
    (sessionId && existing.session_id !== sessionId) ||
    existing.request_hash !== requestHash
  )
    throw new ArenaError("该操作编号已用于另一份请求。", 409, "OPERATION_REUSED");
}
function insertOperation(
  state: PrivatePlanning,
  owner: string,
  action: PlanningAction | CreatePlanningInput,
  kind: string,
  role: PlanningAgentId | null = null,
  pending = false,
) {
  db()
    .prepare(
      "INSERT INTO planning_operations(id,session_id,owner,revision,kind,request_hash,state,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      action.operationId,
      state.session.id,
      owner,
      "revision" in action ? action.revision : 0,
      kind,
      hash(action),
      pending ? "pending" : "completed",
      role,
      Date.now(),
      Date.now(),
    );
}
function recoverStale(state: PrivatePlanning) {
  const active = state.session.activeOperationId
    ? operation(state.session.activeOperationId)
    : undefined;
  if (
    !active ||
    active.state !== "pending" ||
    Date.now() - active.updated_at <= (state.config?.timeoutMs ?? 180000) + 60000
  )
    return;
  const calls = db()
    .prepare("SELECT id FROM planning_calls WHERE operation_id=? AND state='pending'")
    .all(active.id) as { id: string }[];
  const uncertain = calls.length > 0;
  const message = uncertain
    ? "上次请求被中断，结果和费用尚未核实；预留保留，不自动重发。"
    : "上次操作在模型调用前中断，已有内容已保留。";
  for (const call of calls) {
    try {
      holdBilling(call.id);
    } catch {
      /* Reservation remains held even if the ledger is temporarily unavailable. */
    }
    db()
      .prepare("UPDATE planning_calls SET state='uncertain',error=? WHERE id=?")
      .run(message, call.id);
  }
  db()
    .prepare("UPDATE planning_operations SET state=?,updated_at=? WHERE id=?")
    .run(uncertain ? "uncertain" : "failed", Date.now(), active.id);
  state.session.status = uncertain ? "uncertain" : "failed";
  state.session.error = {
    code: uncertain ? "PLANNING_UNCERTAIN" : "PLANNING_INTERRUPTED",
    message,
  };
  state.session.activeOperationId = null;
  const agent = state.session.agents.find((entry) => entry.id === active.role);
  if (agent) {
    agent.status = uncertain ? "uncertain" : "failed";
    agent.finishedAt = now();
  }
  emit(state, uncertain ? "uncertain" : "failed", "system", "本次工作已暂停", message, {
    operationId: active.id,
  });
  save(state);
}

export function createPlanning(owner: string, input: CreatePlanningInput): PlanningSnapshot {
  const parsed = CreatePlanningSchema.parse(input);
  return atomic(() => {
    const existing = operation(parsed.operationId);
    if (existing) {
      checkDuplicate(existing, owner, null, hash(parsed));
      return snapshot(read(existing.session_id, owner));
    }
    consumeRun(owner);
    const sessionId = id();
    const createdAt = now();
    const state: PrivatePlanning = {
      snapshotVersion: 1,
      eventSeq: 0,
      events: [],
      nextRole: "A",
      stopped: false,
      reportHistory: [],
      roundState: {
        number: 1,
        limit: INITIAL_QUESTION_LIMIT,
        questionKeys: [],
        closed: false,
        endedEarly: false,
      },
      session: {
        contractVersion: PLANNING_CONTRACT_VERSION,
        id: sessionId,
        revision: 0,
        goal: parsed.goal,
        modelMode: parsed.modelMode,
        productScope: "analysis_and_guidance",
        status: "ready",
        progress: initialProgress(),
        agents: PLANNING_AGENT_IDS.map(initialAgent),
        expertResults: [],
        items: [],
        sourceRecords: [
          {
            id: `goal-${sessionId}`,
            kind: "goal",
            label: "你的原始想法",
            text: parsed.goal,
            createdAt,
          },
        ],
        questions: [],
        answers: [],
        draft: null,
        review: null,
        report: null,
        capabilities: {
          canAdvance: true,
          canAnswer: false,
          canAddNote: true,
          canPreview: false,
          canConfirm: false,
          canStop: false,
          canStartRound: false,
          reason: "",
        },
        nextAction: "advance",
        activeOperationId: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      },
    };
    emit(state, "session_created", "user", "规划已建立", parsed.goal, {
      operationId: parsed.operationId,
      to: "A",
    });
    capabilities(state);
    db()
      .prepare(
        "INSERT INTO planning_sessions(id,owner,body,snapshot_version,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(sessionId, owner, JSON.stringify(state), state.snapshotVersion, Date.now());
    insertOperation(state, owner, parsed, "create");
    return snapshot(state);
  });
}
export function getPlanning(sessionId: string, owner: string): PlanningSnapshot {
  return atomic(() => {
    const state = read(sessionId, owner);
    recoverStale(state);
    return snapshot(state);
  });
}

function assertGraph(items: { id: string; dependsOn: string[] }[]) {
  const map = new Map(items.map((item) => [item.id, item]));
  if (map.size !== items.length)
    throw new ArenaError("生成的事项编号重复，请重新整理本步。", 422, "PLANNING_INVALID_OUTPUT");
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key))
      throw new ArenaError("生成的依赖关系包含循环，本步未采用。", 422, "PLANNING_INVALID_OUTPUT");
    const item = map.get(key);
    if (!item)
      throw new ArenaError(
        "生成的依赖指向不存在的事项，本步未采用。",
        422,
        "PLANNING_INVALID_OUTPUT",
      );
    visiting.add(key);
    for (const dependency of item.dependsOn) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const item of items) visit(item.id);
}
function sources(
  state: PrivatePlanning,
  proposed: PlanningSource[],
  fallbackId?: string,
  fallbackQuote = "",
): PlanningSource[] {
  const valid = proposed.filter((source) => {
    const record = state.session.sourceRecords.find(
      (entry) => entry.id === source.id && entry.kind === source.kind,
    );
    return record && source.quote.trim() && record.text.includes(source.quote);
  });
  if (!valid.length && fallbackId)
    valid.push({ kind: "analysis", id: fallbackId, quote: fallbackQuote });
  return valid;
}
function invalidateDependents(
  state: PrivatePlanning,
  changedIds: Set<string>,
  exclude = new Set<string>(),
) {
  const affected = new Set(changedIds);
  let progress = true;
  while (progress) {
    progress = false;
    for (const item of state.session.items) {
      if (!affected.has(item.id) && item.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(item.id);
        progress = true;
      }
    }
  }
  for (const item of state.session.items) {
    if (affected.has(item.id) && !exclude.has(item.id)) {
      item.status = "needs_review";
      item.confirmation = null;
      item.reason = "相关要求已变化，需要依据当前信息重新核对。";
    }
  }
  return affected;
}
function applyAnalysis(state: PrivatePlanning, output: PlanningAnalysisOutput, sourceId: string) {
  const previous = structuredClone(state.session.items);
  const map = new Map(state.session.items.map((item) => [item.id, item]));
  const changed = new Set<string>();
  for (const proposed of output.items) {
    const old = map.get(proposed.id);
    if (old?.status === "confirmed") continue;
    const lastAnswer = state.session.answers.findLast((answer) =>
      answer.question.itemIds.includes(proposed.id),
    );
    const userDeferred = lastAnswer && lastAnswer.state !== "answered";
    const item: PlanningItem = {
      ...proposed,
      status: userDeferred
        ? "deferred"
        : proposed.status === "not_applicable" && !proposed.reason.trim()
          ? "open"
          : proposed.status,
      dependsOn: [...new Set(proposed.dependsOn)],
      sources: [
        ...new Map(
          [
            ...(old?.sources.filter((source) => source.kind !== "analysis") ?? []),
            ...sources(state, proposed.sources, sourceId, proposed.description),
          ].map((source) => [hash(source), source]),
        ).values(),
      ],
      confirmation: null,
      reason: userDeferred
        ? "用户尚未作出这个决定；以下分析不能替代用户决定。" + proposed.reason
        : proposed.reason,
    };
    if (JSON.stringify(old) !== JSON.stringify(item)) changed.add(item.id);
    map.set(item.id, item);
  }
  const merged = [...map.values()];
  if (merged.length > 100)
    throw new ArenaError("当前需求事项已达上限，请先收敛已有内容。", 422, "PLANNING_ITEM_LIMIT");
  assertGraph(merged);
  state.session.items = merged;
  if (changed.size) {
    invalidateDependents(state, changed, changed);
    state.session.revision++;
    archiveReport(state);
    emit(state, "requirements_changed", "A", "需求事项已更新", output.summary, {
      itemIds: [...changed],
      to: state.roundState.closed ? "D" : "B",
    });
  }
  state.session.draft = {
    title: "目前对项目的理解",
    summary: output.summary,
    sections: state.session.items.map((item) => ({
      id: `item-${item.id}`,
      title: item.title,
      content: item.description,
      itemIds: [item.id],
      sources: item.sources,
    })),
    changes: [...changed].map((key) => ({
      itemIds: [key],
      before: previous.find((item) => item.id === key)?.description ?? "",
      after: map.get(key)!.description,
      reason: map.get(key)!.reason,
    })),
  };
  updateCoverage(state, output.analysisCoverage, "A");
  if (!state.roundState.closed && state.roundState.questionKeys.length >= state.roundState.limit)
    closeQuestions(state, false, "system");
  state.nextRole = state.roundState.closed ? "D" : "B";
  state.session.status = state.session.questions.some((question) => question.status === "active")
    ? "awaiting_user"
    : "ready";
}
function applyQuestions(state: PrivatePlanning, output: PlanningQuestionsOutput) {
  const slots = state.roundState.closed
    ? 0
    : Math.max(0, state.roundState.limit - state.roundState.questionKeys.length);
  const candidates = output.questions
    .filter(
      (input) =>
        !state.session.answers.some(
          (answer) =>
            answer.question.id === input.id &&
            answer.question.title === input.title &&
            hash(answer.question.options) === hash(input.options),
        ),
    )
    .slice(0, slots);
  const questions: PlanningQuestion[] = candidates.map((input) => {
    if (input.itemIds.length !== 1)
      throw new ArenaError(
        "每道问题只能对应一个明确决定，请重新整理本步。",
        422,
        "PLANNING_INVALID_OUTPUT",
      );
    const related = input.itemIds.map((key) => state.session.items.find((item) => item.id === key));
    if (
      related.some((item) => !item) ||
      related.every((item) => ["confirmed", "proposed", "not_applicable"].includes(item!.status))
    )
      throw new ArenaError(
        "问题没有关联当前待决定事项，本步未采用。",
        422,
        "PLANNING_INVALID_OUTPUT",
      );
    const choices = new Set(input.options.map((option) => option.id));
    if (
      choices.size !== input.options.length ||
      (["single", "multiple"].includes(input.type) && input.options.length < 2)
    )
      throw new ArenaError(
        "问题选项不完整或编号重复，本步未采用。",
        422,
        "PLANNING_INVALID_OUTPUT",
      );
    if (
      input.type === "multiple" &&
      ((input.minSelections ?? 1) > (input.maxSelections ?? input.options.length) ||
        (input.maxSelections ?? 1) > input.options.length)
    )
      throw new ArenaError("多选题的选择数量范围无效。", 422, "PLANNING_INVALID_OUTPUT");
    const earlier = state.session.questions.filter((question) => question.id === input.id);
    const version = Math.max(0, ...earlier.map((question) => question.version)) + 1;
    return {
      ...input,
      itemIds: [...new Set(input.itemIds)],
      minSelections:
        input.type === "text" || input.type === "number"
          ? null
          : input.type === "single"
            ? 1
            : input.minSelections,
      maxSelections:
        input.type === "text" || input.type === "number"
          ? null
          : input.type === "single"
            ? 1
            : input.maxSelections,
      version,
      askedBy: "B",
      answerTo: "A",
      status: "active",
      allowUnknown: true,
      allowSkip: true,
    };
  });
  if (new Set(questions.map((question) => question.id)).size !== questions.length)
    throw new ArenaError("同一轮的问题编号重复，本步未采用。", 422, "PLANNING_INVALID_OUTPUT");
  if (new Set(questions.flatMap((question) => question.itemIds)).size !== questions.length)
    throw new ArenaError("同一轮请勿重复询问同一个决定。", 422, "PLANNING_INVALID_OUTPUT");
  if (questions.length) {
    archiveReport(state);
    state.session.revision++;
    for (const old of state.session.questions)
      if (old.status === "active") old.status = "withdrawn";
    state.session.questions.push(...questions);
    state.roundState.questionKeys.push(...questions.map(questionKey));
    for (const question of questions)
      emit(state, "question_issued", "B", question.title, question.reason, {
        from: "B",
        to: "user",
        questionId: question.id,
        questionVersion: question.version,
        itemIds: question.itemIds,
      });
    state.session.status = "awaiting_user";
  } else {
    closeQuestions(state, false, "B");
    state.session.status = "ready";
  }
  state.nextRole = questions.length ? "A" : "D";
}
function closeQuestions(state: PrivatePlanning, early: boolean, actor: PlanningEvent["actor"]) {
  const alreadyClosed = state.roundState.closed;
  const unanswered = state.session.questions.filter((question) => question.status === "active");
  if (alreadyClosed && !unanswered.length) return;
  state.roundState.closed = true;
  if (!alreadyClosed) state.roundState.endedEarly = early;
  if (unanswered.length) {
    archiveReport(state);
    state.session.revision++;
    for (const question of unanswered) question.status = "withdrawn";
  }
  const questionAgent = state.session.agents.find((agent) => agent.id === "B");
  if (questionAgent?.status === "awaiting_user") questionAgent.status = "completed";
  if (alreadyClosed) return;
  emit(
    state,
    "questions_closed",
    actor,
    "本轮提问已结束",
    early
      ? "按你的选择，直接分析已有信息；未回答的内容会作为未知保留。"
      : "不再追加本轮问题，接下来整理可行性与制作路径。",
    { to: "D", itemIds: unanswered.flatMap((question) => question.itemIds) },
  );
}
function startRound(
  state: PrivatePlanning,
  action: Extract<PlanningAction, { kind: "start_round" }>,
) {
  capabilities(state);
  if (!state.session.capabilities.canStartRound)
    throw new ArenaError(
      "请先完成当前分析，再开启额外三题的细化。",
      409,
      "PLANNING_ACTION_UNAVAILABLE",
    );
  closeQuestions(state, false, "user");
  archiveReport(state);
  state.roundState = {
    number: state.roundState.number + 1,
    limit: ADDITIONAL_QUESTION_LIMIT,
    questionKeys: [],
    closed: false,
    endedEarly: false,
  };
  state.session.revision++;
  state.session.status = "ready";
  state.session.error = null;
  state.session.agents = PLANNING_AGENT_IDS.map(initialAgent);
  state.nextRole = "A";
  state.stopped = false;
  emit(
    state,
    "round_started",
    "user",
    "继续细化已开启",
    "本轮最多追加三题，已有回答与来源继续保留。",
    { operationId: action.operationId, to: "A" },
  );
}
function applyExpert(
  state: PrivatePlanning,
  role: "D" | "E",
  output: PlanningExpertOutput,
  sourceId: string,
) {
  const s = state.session;
  const known = new Set(s.items.map((item) => item.id));
  s.expertResults = s.expertResults.filter((entry) => entry.agentId !== role);
  s.expertResults.push({
    id: sourceId,
    agentId: role,
    round: state.roundState.number,
    basedOnRevision: s.revision,
    contentFingerprint: planningContentFingerprint(s),
    summary: output.summary,
    conclusion: output.conclusion,
    sections: output.sections.map((section) => ({
      ...section,
      itemIds: section.itemIds.filter((key) => known.has(key)),
      sources: sources(state, section.sources, sourceId, section.content),
    })),
    risks: output.risks,
    unknowns: output.unknowns,
    nextSteps: output.nextActions,
    minimumViableVersion: output.minimumViableVersion,
    createdAt: now(),
  });
  updateCoverage(state, output.analysisCoverage, role);
  state.nextRole = role === "D" ? "E" : "C";
  s.status = "ready";
}
function reportMarkdown(
  report: Pick<
    PlanningReport,
    "title" | "summary" | "sections" | "tasks" | "risks" | "unresolved" | "acceptance"
  >,
) {
  const lines = [
    `# ${report.title}`,
    "",
    report.summary,
    "",
    "## 阅读说明",
    "",
    "这是一份基于当前信息的项目分析与制作指引。采用本分析不会自动解决未知事项，也不表示任何制作或部署已经执行。",
  ];
  for (const section of report.sections) {
    lines.push("", `## ${section.title}`, "", section.content);
    if (section.sources.length)
      lines.push(
        "",
        "来源：",
        "",
        ...section.sources.map(
          (source) =>
            `- ${source.kind === "analysis" ? "分析建议" : "提供的信息"}：${source.quote}`,
        ),
      );
  }
  lines.push("", "## 建议的制作步骤", "");
  report.tasks.forEach((task, index) => {
    lines.push(`### ${index + 1}. ${task.title}`, "", task.instructions);
    if (task.dependsOn.length)
      lines.push(
        "",
        `先完成：${task.dependsOn.map((key) => report.tasks.find((entry) => entry.id === key)?.title ?? "前置步骤").join("、")}`,
      );
    if (task.acceptance.length)
      lines.push("", "验收：", "", ...task.acceptance.map((entry) => `- ${entry}`));
    lines.push("");
  });
  for (const [title, entries] of [
    ["风险", report.risks],
    ["未决事项", report.unresolved],
    ["整体验收", report.acceptance],
  ] as const)
    lines.push(
      "",
      `## ${title}`,
      "",
      ...(entries.length ? entries.map((entry) => `- ${entry}`) : ["当前未列出额外事项。"]),
    );
  lines.push("");
  return lines.join("\n");
}
function applyReview(state: PrivatePlanning, output: PlanningReviewOutput) {
  const s = state.session;
  updateCoverage(state, output.analysisCoverage, "C");
  const known = new Set(s.items.map((item) => item.id));
  const coverage = DIMENSIONS.map((dimension) => {
    const entry = output.coverage.find((value) => value.dimension === dimension);
    return entry
      ? { ...entry, itemIds: entry.itemIds.filter((key) => known.has(key)) }
      : { dimension, status: "open" as const, reason: "本次查漏尚未覆盖此方面。", itemIds: [] };
  });
  const blockers = output.blockers.map((blocker) => ({
    ...blocker,
    itemIds: blocker.itemIds.filter((key) => known.has(key)),
  }));
  for (const question of s.questions.filter((entry) => entry.status === "active"))
    blockers.push({
      id: `question-${question.id}-${question.version}`,
      itemIds: question.itemIds,
      description: `仍待用户回答：${question.title}`,
    });
  for (const entry of s.progress.coverage.filter((value) => !value.assessedBy))
    blockers.push({
      id: `coverage-${entry.area}`,
      itemIds: entry.itemIds,
      description: `分析尚未检查${COVERAGE_NAMES[entry.area]}。`,
    });
  const experts = currentExperts(state);
  for (const role of ["D", "E"] as const)
    if (!experts.some((expert) => expert.agentId === role))
      blockers.push({
        id: `expert-${role}`,
        itemIds: [],
        description: `缺少基于当前信息的${NAMES[role]}。`,
      });
  if (!output.report.acceptance.length)
    blockers.push({
      id: "analysis-verification",
      itemIds: [],
      description: "报告还缺少检验建议是否有效的方法。",
    });
  for (const section of output.report.sections) {
    if (sources(state, section.sources).length !== section.sources.length)
      blockers.push({
        id: `source-${section.id}`,
        itemIds: section.itemIds.filter((key) => known.has(key)),
        description: `「${section.title}」引用了无法对应原文的依据，尚不能把这部分当作可靠结论。`,
      });
  }
  assertGraph(output.report.tasks);
  const contentFingerprint = planningContentFingerprint(s);
  if (s.report) state.reportHistory.push(structuredClone(s.report));
  const sections = output.report.sections.map((section) => ({
    ...section,
    itemIds: section.itemIds.filter((key) => known.has(key)),
    sources: sources(state, section.sources),
  }));
  const statusLabel = (item: PlanningItem) =>
    item.status === "confirmed"
      ? "已有用户明确确认"
      : item.status === "proposed"
        ? "分析建议，不能当作用户已作出的决定"
        : item.status === "not_applicable"
          ? "分析认为本项目不适用"
          : "尚未确定，分析中保留为未知";
  const sourceLabel = (item: PlanningItem) =>
    item.sources.length
      ? item.sources
          .map(
            (source) =>
              `${source.kind === "analysis" ? "分析建议" : (s.sourceRecords.find((entry) => entry.kind === source.kind && entry.id === source.id)?.label ?? "提供的信息")}：${source.quote}`,
          )
          .join("；")
      : "尚无可引用来源，不当作用户已说过的事实";
  const settledItems = s.items.filter((item) => ["confirmed", "proposed"].includes(item.status));
  const pendingItems = s.items.filter((item) =>
    ["open", "needs_review", "deferred"].includes(item.status),
  );
  const unanswered = s.questions.filter(
    (question) =>
      state.roundState.questionKeys.includes(questionKey(question)) &&
      !s.answers.some(
        (answer) =>
          answer.questionId === question.id && answer.questionVersion === question.version,
      ),
  );
  const deferredAnswers = s.answers.filter(
    (answer) =>
      answer.state !== "answered" &&
      answer.question.itemIds.some((key) => pendingItems.some((item) => item.id === key)),
  );
  const unresolved = [
    ...new Set([
      ...output.report.unresolved,
      ...output.uncertainties,
      ...blockers.map((blocker) => blocker.description),
      ...pendingItems.map((item) => `${item.title}：${item.description}`),
      ...unanswered.map((question) => `本轮未回答：${question.title}`),
      ...deferredAnswers.map(
        (answer) =>
          `${answer.question.title}：${answer.state === "unknown" ? "用户暂时不知道" : "用户选择跳过"}，不能推断用户已作决定。`,
      ),
      ...experts.flatMap((expert) => expert.unknowns),
      ...s.progress.coverage
        .filter((entry) => entry.status !== "covered")
        .map((entry) => `${COVERAGE_NAMES[entry.area]}：${entry.reason}`),
    ]),
  ];
  s.review = {
    id: id(),
    basedOnRevision: s.revision,
    contentFingerprint,
    ready: output.ready && blockers.length === 0,
    coverage,
    blockers,
    risks: [...new Set([...output.risks, ...experts.flatMap((expert) => expert.risks)])],
    uncertainties: unresolved,
  };
  sections.push({
    id: "authoritative-requirements",
    title: "已知条件与待定项",
    content: s.items
      .map((item) => {
        const label =
          item.status === "confirmed"
            ? "用户已定"
            : item.status === "proposed"
              ? "建议"
              : item.status === "not_applicable"
                ? "不适用"
                : "待定";
        const description = item.description.replace(/\s+/g, " ");
        return `- ${item.title}（${label}）：${description.length > 160 ? `${description.slice(0, 160)}…` : description}`;
      })
      .join("\n"),
    itemIds: s.items.map((item) => item.id),
    sources: [],
  });
  const report: PlanningReport = {
    ...output.report,
    sections,
    id: id(),
    basedOnRevision: s.revision,
    contentFingerprint,
    fingerprint: "",
    status: "draft",
    confirmedAt: null,
    markdown: "",
    unresolved,
    risks: [...new Set([...output.report.risks, ...experts.flatMap((expert) => expert.risks)])],
    executionPrompt: [
      "这是项目分析与制作指引的内部交接材料。本系统没有执行制作或部署，用户采用报告只代表采用当前分析，不构成对每条 AI 建议或后续制作的授权。制作须有用户另外的明确指令；未知和跳过事项不能补造或默认采用。",
      `原始目标：${s.goal}`,
      "已有明确方案及其来源状态（AI 建议不是用户决定）：",
      ...settledItems.map(
        (item) =>
          `- ${item.title}：${item.description}\n  生成时状态：${statusLabel(item)}\n  依据：${sourceLabel(item)}`,
      ),
      "实施说明（遇到与上述用户依据冲突或未决依赖时，先停下相关步骤并询问）：",
      output.report.executionPrompt,
      "未决边界（以下内容未成为执行要求；不可擅自决定，相关任务须先澄清）：",
      ...(unresolved.length
        ? unresolved.map((entry) => `- ${entry}`)
        : ["未列出阻断或暂缓决定的事项。"]),
    ].join("\n\n"),
  };
  report.markdown = reportMarkdown(report);
  report.fingerprint = reportFingerprint(report);
  s.report = report;
  emit(
    state,
    "review_completed",
    "C",
    s.review.ready ? "项目分析已整理" : "已整理当前分析及其缺口",
    output.summary,
    { to: "user", itemIds: blockers.flatMap((blocker) => blocker.itemIds) },
  );
  emit(state, "report_ready", "C", "分析与制作指引已整理", report.summary, { to: "user" });
  s.status = "review_ready";
  state.nextRole = "C";
}

function validateAnswer(question: PlanningQuestion, answer: PlanningAnswerInput) {
  if (answer.state !== "answered") {
    if (
      (answer.state === "unknown" && !question.allowUnknown) ||
      (answer.state === "skipped" && !question.allowSkip)
    )
      throw new ArenaError("这道问题需要实际回答。", 400, "INVALID_ANSWER");
    if (answer.optionIds.length || answer.text.trim() || answer.number !== null)
      throw new ArenaError("不知道或跳过不能同时包含一个已选答案。", 400, "INVALID_ANSWER");
    return;
  }
  const options = new Set(question.options.map((option) => option.id));
  if (
    new Set(answer.optionIds).size !== answer.optionIds.length ||
    answer.optionIds.some((key) => !options.has(key))
  )
    throw new ArenaError("请选择当前问题中的有效选项。", 400, "INVALID_ANSWER");
  if (
    ["single", "multiple"].includes(question.type) &&
    answer.optionIds.length === 0 &&
    answer.text.trim() &&
    answer.number === null
  )
    return;
  if (question.type === "single" && (answer.optionIds.length !== 1 || answer.number !== null))
    throw new ArenaError("请选择一个选项，可以另行补充文字。", 400, "INVALID_ANSWER");
  if (
    question.type === "multiple" &&
    (answer.optionIds.length < (question.minSelections ?? 1) ||
      answer.optionIds.length > (question.maxSelections ?? question.options.length) ||
      answer.number !== null)
  )
    throw new ArenaError("请选择允许数量的选项。", 400, "INVALID_ANSWER");
  if (
    question.type === "text" &&
    (!answer.text.trim() || answer.optionIds.length || answer.number !== null)
  )
    throw new ArenaError("请填写这道问题的文字回答。", 400, "INVALID_ANSWER");
  if (question.type === "number" && (answer.number === null || answer.optionIds.length))
    throw new ArenaError("请填写有效数字。", 400, "INVALID_ANSWER");
}
function answerText(question: PlanningQuestion, answer: PlanningAnswerInput) {
  if (answer.state === "unknown") return "用户暂时不知道";
  if (answer.state === "skipped") return "用户选择暂时跳过";
  const choices = answer.optionIds
    .map((key) => question.options.find((option) => option.id === key)!)
    .map((option) => `${option.label}：${option.description}`)
    .join("；");
  return [
    choices,
    answer.number === null ? "" : `${answer.number}${question.unit}`,
    answer.text.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}
function saveAnswers(state: PrivatePlanning, action: Extract<PlanningAction, { kind: "answer" }>) {
  const s = state.session;
  const seen = new Set<string>();
  const entries = action.answers.map((answer) => {
    const question = s.questions.find(
      (entry) =>
        entry.id === answer.questionId &&
        entry.version === answer.questionVersion &&
        entry.status === "active",
    );
    if (!question || seen.has(answer.questionId))
      throw new ArenaError("问题已更新或回答重复，请读取最新问题。", 409, "STALE_QUESTION");
    seen.add(answer.questionId);
    validateAnswer(question, answer);
    return { question, answer };
  });
  archiveReport(state);
  s.revision++;
  const changedIds = new Set(entries.flatMap((entry) => entry.question.itemIds));
  invalidateDependents(state, changedIds, changedIds);
  for (const { question, answer } of entries) {
    const saved = {
      ...answer,
      id: id(),
      question: structuredClone(question),
      createdAt: now(),
      revision: s.revision,
    };
    const text = `${question.title}\n${answerText(question, answer)}`;
    s.answers.push(saved);
    s.sourceRecords.push({
      id: saved.id,
      kind: "answer",
      label: question.title,
      text,
      createdAt: saved.createdAt,
    });
    emit(state, "answer_saved", "user", "回答已保存", answerText(question, answer), {
      operationId: action.operationId,
      from: "user",
      to: question.answerTo,
      questionId: question.id,
      questionVersion: question.version,
      answerId: saved.id,
      itemIds: question.itemIds,
    });
    question.status = "answered";
    for (const item of s.items.filter((entry) => question.itemIds.includes(entry.id))) {
      item.sources = [...item.sources, { kind: "answer", id: saved.id, quote: text }];
      if (answer.state === "answered") {
        item.description = `此前分析：\n${item.description}\n\n用户回答：\n${text}`;
        item.status = "needs_review";
        item.confirmation = null;
        item.reason = "已收到回答，待更新分析。";
      } else {
        item.status = "deferred";
        item.confirmation = null;
        item.reason =
          answer.state === "unknown"
            ? "用户暂时不知道，仍需澄清或保留明确边界。"
            : "用户暂时跳过，尚未决定。";
      }
    }
  }
  state.nextRole = "A";
  if (
    !s.questions.some((question) => question.status === "active") &&
    state.roundState.questionKeys.length >= state.roundState.limit
  )
    closeQuestions(state, false, "system");
  s.status = s.questions.some((question) => question.status === "active")
    ? "awaiting_user"
    : "ready";
  if (s.status === "ready") {
    const questionAgent = s.agents.find((agent) => agent.id === "B");
    if (questionAgent?.status === "awaiting_user") questionAgent.status = "completed";
  }
  s.error = null;
  emit(state, "requirements_changed", "user", "将依据你的回答更新项目理解", "", {
    operationId: action.operationId,
    to: "A",
    itemIds: [...changedIds],
  });
}
function saveNote(state: PrivatePlanning, action: Extract<PlanningAction, { kind: "note" }>) {
  const s = state.session;
  if (action.itemIds.some((key) => !s.items.some((item) => item.id === key)))
    throw new ArenaError("补充意见关联的事项已不存在。", 409, "STALE_ITEM");
  archiveReport(state);
  s.revision++;
  const noteId = id();
  s.sourceRecords.push({
    id: noteId,
    kind: "note",
    label: "用户补充与纠正",
    text: action.text,
    createdAt: now(),
  });
  const changed = new Set(action.itemIds.length ? action.itemIds : s.items.map((item) => item.id));
  const affected = invalidateDependents(state, changed);
  for (const item of s.items)
    if (affected.has(item.id)) item.sources.push({ kind: "note", id: noteId, quote: action.text });
  for (const question of s.questions)
    if (question.status === "active") question.status = "withdrawn";
  const questionAgent = s.agents.find((agent) => agent.id === "B");
  if (questionAgent?.status === "awaiting_user") questionAgent.status = "completed";
  state.nextRole = "A";
  state.stopped = false;
  s.status = "ready";
  s.error = null;
  emit(state, "note_saved", "user", "补充意见已保存", action.text, {
    operationId: action.operationId,
    to: "A",
    itemIds: [...affected],
  });
  emit(state, "requirements_changed", "user", "相关事项需要重新核对", "已有报告保留为历史版本。", {
    operationId: action.operationId,
    itemIds: [...affected],
  });
}
function confirm(state: PrivatePlanning, action: Extract<PlanningAction, { kind: "confirm" }>) {
  if (
    !canConfirm(state) ||
    state.session.report?.id !== action.reportId ||
    state.session.report.fingerprint !== action.fingerprint
  )
    throw new ArenaError(
      "只能采用已经完成分析核对的当前报告，请先审阅最新内容。",
      409,
      "REPORT_NOT_CONFIRMABLE",
    );
  const s = state.session;
  emit(
    state,
    "report_confirmed",
    "user",
    "已采用这份分析",
    "本次采用对应你刚刚审阅的报告；AI 建议和未知事项仍保留各自的来源与状态。",
    {
      operationId: action.operationId,
      from: "user",
      to: "C",
      itemIds: s.items.map((item) => item.id),
    },
  );
  s.report!.status = "confirmed";
  s.report!.confirmedAt = now();
  s.status = "completed";
  s.error = null;
}
function frozenConfiguration(state: PrivatePlanning) {
  const config = {
    ...resolveModelConfig(ModelModeSchema.parse(state.session.modelMode)),
    promptVersion: PLANNING_PROMPT_VERSION,
    schemaVersion: PLANNING_SCHEMA_VERSION,
  };
  if (!config.configured)
    throw new ArenaError("所选模型尚未配置，请先完成模型服务配置。", 503, "MODEL_NOT_CONFIGURED");
  const { configured, ...identity } = config;
  void configured;
  const fingerprint = hash(identity);
  const modelIdentity = (value: ModelConfig) => {
    const {
      configured: ignoredConfigured,
      promptVersion: ignoredPrompt,
      schemaVersion: ignoredSchema,
      ...rest
    } = value;
    void ignoredConfigured;
    void ignoredPrompt;
    void ignoredSchema;
    return hash(rest);
  };
  if (
    state.configHash &&
    state.configHash !== fingerprint &&
    (!state.config || modelIdentity(state.config) !== modelIdentity(config))
  )
    throw new ArenaError(
      "本规划的模型配置已经变化，请新建规划，已有内容仍可查看。",
      409,
      "CONFIGURATION_CHANGED",
    );
  state.config = config;
  state.configHash = fingerprint;
  return config;
}
function requestFor(state: PrivatePlanning, role: PlanningAgentId): StructuredRequest<Output> {
  updateProgress(state);
  const experts = currentExperts(state);
  const names = {
    A: "planning_analyze",
    B: "planning_questions",
    D: "planning_feasibility",
    E: "planning_production",
    C: "planning_review",
  };
  return {
    name: names[role],
    schema: (role === "A"
      ? PlanningAnalysisOutputSchema
      : role === "B"
        ? PlanningQuestionsOutputSchema
        : role === "D" || role === "E"
          ? PlanningExpertOutputSchema
          : PlanningReviewOutputSchema) as z.ZodType<Output>,
    system: PLANNING_PROMPTS[role],
    config: state.config,
    input: {
      originalGoal: state.session.goal,
      productScope: "只交付项目理解、可行性分析和制作指引，不执行制作或部署。",
      outputTokenBudget: state.config?.maxOutputTokens,
      revision: state.session.revision,
      progress: state.session.progress,
      collectionClosed: state.roundState.closed,
      expertResults: experts,
      items: state.session.items,
      answers: state.session.answers,
      sources: state.session.sourceRecords.filter(
        (source) =>
          source.kind !== "analysis" ||
          experts.some(
            (expert) =>
              expert.id === source.id ||
              expert.sections.some((section) =>
                section.sources.some(
                  (reference) => reference.kind === "analysis" && reference.id === source.id,
                ),
              ),
          ) ||
          state.session.items.some((item) =>
            item.sources.some(
              (reference) => reference.kind === "analysis" && reference.id === source.id,
            ),
          ),
      ),
      previousQuestions: state.session.questions,
      previousSummary: state.session.draft?.summary ?? "",
      previousReview: state.session.review,
    },
  };
}

export async function actPlanning(
  sessionId: string,
  owner: string,
  input: PlanningAction,
): Promise<PlanningSnapshot> {
  const action = PlanningActionSchema.parse(input);
  const claimed = atomic(() => {
    const state = read(sessionId, owner);
    recoverStale(state);
    const duplicate = operation(action.operationId);
    if (duplicate) {
      checkDuplicate(duplicate, owner, sessionId, hash(action));
      return { state, run: false as const };
    }
    checkRevision(state, action.revision);
    if (state.session.status === "uncertain")
      throw new ArenaError(
        "上一请求结果或费用未知，核实前不能再次发送。",
        409,
        "PLANNING_UNCERTAIN",
      );
    if (action.kind === "stop") {
      if (state.session.status !== "working")
        throw new ArenaError("当前没有正在执行的规划动作。", 409, "NOT_WORKING");
      insertOperation(state, owner, action, action.kind);
      state.stopped = true;
      state.session.status = "paused";
      emit(state, "paused", "user", "已暂停后续工作", "正在进行的请求仍会记录实际结果与费用。", {
        operationId: action.operationId,
      });
      save(state);
      return { state, run: false as const };
    }
    if (state.session.activeOperationId || state.session.status === "working")
      throw new ArenaError("当前动作尚未完成，请等待或暂停。", 409, "PLANNING_BUSY");
    if (action.kind === "answer") {
      saveAnswers(state, action);
      insertOperation(state, owner, action, action.kind);
      save(state);
      return { state, run: false as const };
    }
    if (action.kind === "note") {
      saveNote(state, action);
      insertOperation(state, owner, action, action.kind);
      save(state);
      return { state, run: false as const };
    }
    if (action.kind === "confirm") {
      confirm(state, action);
      insertOperation(state, owner, action, action.kind);
      save(state);
      return { state, run: false as const };
    }
    if (action.kind === "start_round") {
      startRound(state, action);
      insertOperation(state, owner, action, action.kind);
      save(state);
      return { state, run: false as const };
    }
    capabilities(state);
    if (action.kind === "advance" && !state.session.capabilities.canAdvance)
      throw new ArenaError(
        "请先处理当前问题或审阅已经完成的报告。",
        409,
        "PLANNING_ACTION_UNAVAILABLE",
      );
    if (action.kind === "preview" && !state.session.capabilities.canPreview)
      throw new ArenaError(
        "当前分析正在形成或已经完成，请查看当前进度。",
        409,
        "PLANNING_ACTION_UNAVAILABLE",
      );
    if (action.kind === "preview") {
      const hadReport = Boolean(state.session.report);
      closeQuestions(state, true, "user");
      if (hadReport) {
        if (state.session.report) state.reportHistory.push(structuredClone(state.session.report));
        state.session.report = null;
        state.session.review = null;
        state.nextRole = ["D", "E"].every((entry) =>
          currentExperts(state).some((expert) => expert.agentId === entry),
        )
          ? "C"
          : "D";
      } else if (state.nextRole === "B") state.nextRole = "D";
    }
    const role = state.nextRole;
    frozenConfiguration(state);
    const request = requestFor(state, role);
    const callId = id();
    const reservation = estimateStructuredCall(request);
    state.stopped = false;
    state.session.status = "working";
    state.session.error = null;
    state.session.activeOperationId = action.operationId;
    const agent = state.session.agents.find((entry) => entry.id === role)!;
    Object.assign(agent, {
      status: "running",
      taskId: callId,
      operationId: action.operationId,
      taskLabel: NAMES[role],
      preview: "",
      startedAt: now(),
      finishedAt: null,
    });
    insertOperation(state, owner, action, action.kind, role, true);
    db()
      .prepare(
        "INSERT INTO planning_calls(id,operation_id,role,state,reservation,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(callId, action.operationId, role, "pending", JSON.stringify(reservation), Date.now());
    emit(state, "agent_started", role, `${NAMES[role]}开始`, "", { to: role });
    save(state);
    return {
      state,
      run: true as const,
      role,
      request,
      callId,
      basedOnRevision: state.session.revision,
    };
  });
  if (!claimed.run) return snapshot(claimed.state);
  const { role, callId, request } = claimed;
  let result: CallResult | undefined;
  let lastPreview = 0;
  const publicPreview = new Map<string, string>();
  try {
    result = await generateStructured({
      ...request,
      attemptId: callId,
      onPreview: (preview) => {
        if (preview.field !== "summary" && !/^nextActions\.\d+$/.test(preview.field)) return;
        publicPreview.set(preview.field, preview.text);
        if (Date.now() - lastPreview < 150) return;
        lastPreview = Date.now();
        try {
          atomic(() => {
            const state = read(sessionId, owner);
            if (
              state.session.activeOperationId !== action.operationId ||
              state.session.status !== "working"
            )
              return;
            state.session.agents.find((agent) => agent.id === role)!.preview = [
              publicPreview.get("summary") ?? "",
              ...[...publicPreview]
                .filter(([key]) => key.startsWith("nextActions."))
                .sort(([left], [right]) => Number(left.split(".")[1]) - Number(right.split(".")[1]))
                .map(([, text]) => `• ${text}`),
            ]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, 6000);
            db()
              .prepare("UPDATE planning_operations SET updated_at=? WHERE id=? AND state='pending'")
              .run(Date.now(), action.operationId);
            save(state);
          });
        } catch {
          /* A preview failure cannot discard the paid result or interrupt accounting. */
        }
      },
    });
    const output = request.schema.parse(result.value);
    atomic(() => {
      db()
        .prepare(
          "UPDATE planning_calls SET state='completed',usage=?,output=?,finished_at=? WHERE id=?",
        )
        .run(
          JSON.stringify(result!.usage),
          JSON.stringify({ value: output, formatNormalization: result!.formatNormalization }),
          Date.now(),
          callId,
        );
    });
    return atomic(() => {
      const state = read(sessionId, owner);
      const current = operation(action.operationId);
      if (state.session.activeOperationId !== action.operationId || current?.state !== "pending")
        return snapshot(state);
      const agent = state.session.agents.find((entry) => entry.id === role)!;
      agent.status = "completed";
      agent.finishedAt = now();
      agent.preview = "";
      agent.summary = [output.summary, ...output.nextActions.map((point) => `• ${point}`)].join(
        "\n\n",
      );
      if (!state.stopped && state.session.revision === claimed.basedOnRevision) {
        const completed = emit(
          state,
          "agent_completed",
          role,
          `${NAMES[role]}已完成`,
          output.summary,
          {
            to:
              role === "A"
                ? state.roundState.closed
                  ? "D"
                  : "B"
                : role === "D"
                  ? "E"
                  : role === "E"
                    ? "C"
                    : "user",
          },
        );
        state.session.sourceRecords.push({
          id: completed.id,
          kind: "analysis",
          label: `${NAMES[role]}的建议`,
          text:
            "items" in output
              ? [output.summary, ...output.items.map((item) => item.description)].join("\n\n")
              : "sections" in output
                ? [
                    output.summary,
                    ...output.nextActions,
                    ...output.sections.map((section) => section.content),
                  ].join("\n\n")
                : JSON.stringify(output),
          createdAt: now(),
        });
        if (role === "A") applyAnalysis(state, output as PlanningAnalysisOutput, completed.id);
        else if (role === "B") applyQuestions(state, output as PlanningQuestionsOutput);
        else if (role === "D" || role === "E")
          applyExpert(state, role, output as PlanningExpertOutput, completed.id);
        else applyReview(state, output as PlanningReviewOutput);
        if (role === "B" && state.session.status === "awaiting_user")
          agent.status = "awaiting_user";
      } else {
        state.session.status = "paused";
        emit(
          state,
          "agent_completed",
          role,
          "已记录暂停前发出的请求",
          "返回内容保留在调用记录中，未覆盖当前方案。",
          { to: "system" },
        );
      }
      db()
        .prepare("UPDATE planning_operations SET state='completed',updated_at=? WHERE id=?")
        .run(Date.now(), action.operationId);
      state.session.activeOperationId = null;
      save(state);
      return snapshot(state);
    });
  } catch (error) {
    const modelError = error instanceof ModelCallError ? error : undefined;
    const uncertain = modelError?.uncertain ?? false;
    const usage = result?.usage ?? modelError?.usage;
    const message =
      modelError?.message ??
      (error instanceof ArenaError ? error.message : "本步未能完成，已有内容已保留。请重试本步。");
    if (uncertain)
      try {
        holdBilling(callId);
      } catch {
        /* Keep the unresolved reservation and do not retry. */
      }
    return atomic(() => {
      const state = read(sessionId, owner);
      db()
        .prepare(
          "UPDATE planning_calls SET state=?,usage=?,output=COALESCE(?,output),error=?,finished_at=? WHERE id=?",
        )
        .run(
          uncertain ? "uncertain" : "failed",
          usage ? JSON.stringify(usage) : null,
          result ? JSON.stringify({ value: result.value }) : null,
          message,
          Date.now(),
          callId,
        );
      const current = operation(action.operationId);
      if (state.session.activeOperationId !== action.operationId || current?.state !== "pending")
        return snapshot(state);
      db()
        .prepare("UPDATE planning_operations SET state=?,updated_at=? WHERE id=?")
        .run(uncertain ? "uncertain" : "failed", Date.now(), action.operationId);
      state.session.activeOperationId = null;
      state.session.status = uncertain ? "uncertain" : state.stopped ? "paused" : "failed";
      state.session.error = {
        code: uncertain ? "PLANNING_UNCERTAIN" : "PLANNING_STEP_FAILED",
        message,
      };
      const agent = state.session.agents.find((entry) => entry.id === role)!;
      agent.status = uncertain ? "uncertain" : "failed";
      agent.finishedAt = now();
      agent.preview = "";
      emit(
        state,
        uncertain ? "uncertain" : "failed",
        role,
        uncertain ? "请求结果待核实" : "本步暂未完成",
        message,
        { operationId: action.operationId },
      );
      save(state);
      return snapshot(state);
    });
  }
}
