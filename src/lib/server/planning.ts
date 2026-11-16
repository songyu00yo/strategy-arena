import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PLANNING_CONTRACT_VERSION,
  type CreatePlanningInput,
  type PlanningAction,
  type PlanningAgentId,
  type PlanningAnswerInput,
  type PlanningDimension,
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
  PlanningQuestionsOutputSchema,
  PlanningReviewOutputSchema,
  type PlanningAnalysisOutput,
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
const NAMES = { A: "理解与拆解", B: "构思与提问", C: "查漏与交付" } as const;
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
type Output = PlanningAnalysisOutput | PlanningQuestionsOutput | PlanningReviewOutput;
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
  return JSON.parse(row.body) as PrivatePlanning;
}
function operation(operationId: string): Operation | undefined {
  return db().prepare("SELECT * FROM planning_operations WHERE id=?").get(operationId) as
    | Operation
    | undefined;
}
function unresolvedItems(session: PlanningSession) {
  return session.items.filter(
    (item) => item.required && ["open", "needs_review", "deferred"].includes(item.status),
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
    unresolvedItems(session).length ||
    session.questions.some((question) => question.status === "active")
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
  const locked = Boolean(s.activeOperationId) || s.status === "working" || s.status === "uncertain";
  const active = s.questions.some((question) => question.status === "active");
  s.capabilities = {
    canAdvance: !locked && s.status !== "completed" && !active,
    canAnswer: !locked && active && s.status !== "completed",
    canAddNote: !locked,
    canPreview: !locked && s.items.length > 0 && s.status !== "completed",
    canConfirm: canConfirm(state),
    canStop: s.status === "working",
    reason:
      s.status === "uncertain"
        ? "上一请求的结果或费用尚未核实，保留已有内容并暂停新的模型请求。"
        : s.activeOperationId
          ? "正在完成当前请求。"
          : active
            ? "请先回答当前问题，也可以查看阶段草稿。"
            : "",
  };
  if (locked || ["paused", "completed", "failed"].includes(s.status)) s.nextAction = "none";
  else if (active) s.nextAction = "answer";
  else if (s.capabilities.canConfirm) s.nextAction = "confirm";
  else s.nextAction = state.nextRole === "C" ? "review" : "advance";
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
      session: {
        contractVersion: PLANNING_CONTRACT_VERSION,
        id: sessionId,
        revision: 0,
        goal: parsed.goal,
        modelMode: parsed.modelMode,
        status: "ready",
        agents: (["A", "B", "C"] as const).map((role) => ({
          id: role,
          name: NAMES[role],
          responsibility: NAMES[role],
          status: "idle",
          taskId: null,
          operationId: null,
          taskLabel: "等待开始",
          summary: "",
          preview: "",
          startedAt: null,
          finishedAt: null,
        })),
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
    const item: PlanningItem = {
      ...proposed,
      status:
        proposed.status === "not_applicable" && !proposed.reason.trim() ? "open" : proposed.status,
      dependsOn: [...new Set(proposed.dependsOn)],
      sources: sources(state, proposed.sources, sourceId, proposed.description),
      confirmation: null,
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
      to: "B",
    });
  }
  state.session.draft = {
    title: "正在形成的执行方案",
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
  state.nextRole = "B";
  state.session.status = state.session.questions.some((question) => question.status === "active")
    ? "awaiting_user"
    : "ready";
}
function applyQuestions(state: PrivatePlanning, output: PlanningQuestionsOutput) {
  const questions: PlanningQuestion[] = output.questions.map((input) => {
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
    for (const question of questions)
      emit(state, "question_issued", "B", question.title, question.reason, {
        from: "B",
        to: "user",
        questionId: question.id,
        questionVersion: question.version,
        itemIds: question.itemIds,
      });
    state.session.status = "awaiting_user";
  } else state.session.status = "ready";
  state.nextRole = questions.length ? "A" : "C";
}
function reportMarkdown(
  report: Pick<
    PlanningReport,
    | "title"
    | "summary"
    | "sections"
    | "tasks"
    | "risks"
    | "unresolved"
    | "acceptance"
    | "executionPrompt"
  >,
) {
  const lines = [
    `# ${report.title}`,
    "",
    report.summary,
    "",
    "## 采用与执行边界",
    "",
    "本正文记录生成时的内容与来源。整份方案是否已被采用，以报告的用户确认回执为准；整体确认只采用列明的具体方案，不会自动解决或批准未决事项。",
  ];
  for (const section of report.sections) {
    lines.push("", `## ${section.title}`, "", section.content);
    if (section.sources.length)
      lines.push(
        "",
        "来源：",
        "",
        ...section.sources.map((source) => `- ${source.kind} · ${source.id}：${source.quote}`),
      );
  }
  lines.push("", "## 执行任务", "");
  report.tasks.forEach((task, index) => {
    lines.push(`### ${index + 1}. ${task.title}`, "", task.instructions);
    if (task.dependsOn.length) lines.push("", `依赖任务：${task.dependsOn.join("、")}`);
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
  lines.push("", "## 执行提示词", "", report.executionPrompt, "");
  return lines.join("\n");
}
function applyReview(state: PrivatePlanning, output: PlanningReviewOutput) {
  const s = state.session;
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
  for (const item of unresolvedItems(s))
    blockers.push({
      id: `required-${item.id}`,
      itemIds: [item.id],
      description: `必需事项「${item.title}」尚未解决。`,
    });
  for (const question of s.questions.filter((entry) => entry.status === "active"))
    blockers.push({
      id: `question-${question.id}-${question.version}`,
      itemIds: question.itemIds,
      description: `仍待用户回答：${question.title}`,
    });
  for (const entry of coverage.filter((value) => value.status === "open"))
    blockers.push({
      id: `coverage-${entry.dimension}`,
      itemIds: entry.itemIds,
      description: entry.reason,
    });
  if (!output.report.tasks.length || !output.report.acceptance.length)
    blockers.push({
      id: "execution-detail",
      itemIds: [],
      description: "报告还缺少具体执行任务或整体验收方法。",
    });
  assertGraph(output.report.tasks);
  const contentFingerprint = planningContentFingerprint(s);
  s.review = {
    id: id(),
    basedOnRevision: s.revision,
    contentFingerprint,
    ready: output.ready && blockers.length === 0,
    coverage,
    blockers,
    risks: output.risks,
    uncertainties: output.uncertainties,
  };
  if (s.report) state.reportHistory.push(structuredClone(s.report));
  const sections = output.report.sections.map((section) => ({
    ...section,
    itemIds: section.itemIds.filter((key) => known.has(key)),
    sources: sources(state, section.sources),
  }));
  const statusLabel = (item: PlanningItem) =>
    item.status === "confirmed"
      ? `用户已确认（确认事件 ${item.confirmation?.eventId ?? "未提供"}）`
      : item.status === "proposed"
        ? "具体方案；整体采用状态由本报告的用户确认回执确定"
        : item.status === "not_applicable"
          ? "本任务不适用；理由随本报告一并审阅"
          : "未决，不能作为已批准的执行要求";
  const sourceLabel = (item: PlanningItem) =>
    item.sources.length
      ? item.sources.map((source) => `${source.kind}/${source.id}：${source.quote}`).join("；")
      : "尚无可引用来源，不当作用户已说过的事实";
  const settledItems = s.items.filter((item) => ["confirmed", "proposed"].includes(item.status));
  const pendingItems = s.items.filter((item) =>
    ["open", "needs_review", "deferred"].includes(item.status),
  );
  const unresolved = [
    ...new Set([
      ...output.report.unresolved,
      ...blockers.map((blocker) => blocker.description),
      ...pendingItems.map((item) => `${item.title}：${item.description}`),
    ]),
  ];
  sections.push({
    id: "authoritative-requirements",
    title: "逐项要求与依据（生成时记录）",
    content: s.items
      .map(
        (item) =>
          `### ${item.title}\n\n${item.description}\n\n生成时状态：${statusLabel(item)}。${item.reason}\n\n依据：${sourceLabel(item)}`,
      )
      .join("\n\n"),
    itemIds: s.items.map((item) => item.id),
    sources: s.items.flatMap((item) => item.sources),
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
    executionPrompt: [
      "执行前先核对本报告的用户确认回执。没有整体确认时仅可继续讨论，不能把具体建议当作已授权实施；有确认回执时按确认后的具体方案执行。未决事项在任何情况下都不能自行补造或默认采用。",
      `原始目标：${s.goal}`,
      "具体方案与依据：",
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
    s.review.ready ? "查漏完成，可以审阅" : "阶段查漏已完成",
    output.summary,
    { to: "user", itemIds: blockers.flatMap((blocker) => blocker.itemIds) },
  );
  emit(state, "report_ready", "C", "执行方案已整理", report.summary, { to: "user" });
  s.status = s.questions.some((question) => question.status === "active")
    ? "awaiting_user"
    : "review_ready";
  state.nextRole = s.review.ready ? "C" : "A";
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
        item.description = `前文整理（其中的分析建议未因本次回答而整体获确认）：\n${item.description}\n\n本次用户实际回答：\n${text}`;
        item.status = "needs_review";
        item.confirmation = null;
        item.reason = "已保存用户实际回答；需要据此核对整项范围，不能把部分回答当作整项确认。";
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
  s.status = s.questions.some((question) => question.status === "active")
    ? "awaiting_user"
    : "ready";
  s.error = null;
  emit(state, "requirements_changed", "user", "方案将依据你的回答继续细化", "", {
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
      "只能确认已经通过查漏的当前报告，请先审阅最新内容。",
      409,
      "REPORT_NOT_CONFIRMABLE",
    );
  const s = state.session;
  const event = emit(
    state,
    "report_confirmed",
    "user",
    "执行方案已确认",
    "本次确认对应你刚刚审阅的完整报告。",
    {
      operationId: action.operationId,
      from: "user",
      to: "C",
      itemIds: s.items.map((item) => item.id),
    },
  );
  for (const item of s.items) {
    if (item.status === "proposed" || item.status === "not_applicable") {
      if (item.status === "proposed") item.status = "confirmed";
      item.confirmation = { answerId: null, eventId: event.id, revision: s.revision };
    }
  }
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
  if (state.configHash && state.configHash !== fingerprint)
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
  return {
    name:
      role === "A" ? "planning_analyze" : role === "B" ? "planning_questions" : "planning_review",
    schema: (role === "A"
      ? PlanningAnalysisOutputSchema
      : role === "B"
        ? PlanningQuestionsOutputSchema
        : PlanningReviewOutputSchema) as z.ZodType<Output>,
    system: PLANNING_PROMPTS[role],
    config: state.config,
    input: {
      originalGoal: state.session.goal,
      revision: state.session.revision,
      items: state.session.items,
      answers: state.session.answers,
      sources: state.session.sourceRecords.filter(
        (source) =>
          source.kind !== "analysis" ||
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
    capabilities(state);
    if (action.kind === "advance" && !state.session.capabilities.canAdvance)
      throw new ArenaError(
        "请先处理当前问题或审阅已经完成的报告。",
        409,
        "PLANNING_ACTION_UNAVAILABLE",
      );
    if (action.kind === "preview" && !state.session.capabilities.canPreview)
      throw new ArenaError(
        "请先形成需求事项，再查看阶段报告。",
        409,
        "PLANNING_ACTION_UNAVAILABLE",
      );
    const role: PlanningAgentId = action.kind === "preview" ? "C" : state.nextRole;
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
      summary: "",
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
    return { state, run: true as const, role, request, callId };
  });
  if (!claimed.run) return snapshot(claimed.state);
  const { role, callId, request } = claimed;
  let result: CallResult | undefined;
  let lastPreview = 0;
  try {
    result = await generateStructured({
      ...request,
      attemptId: callId,
      onPreview: (preview) => {
        if (preview.field !== "summary" || Date.now() - lastPreview < 150) return;
        lastPreview = Date.now();
        try {
          atomic(() => {
            const state = read(sessionId, owner);
            if (
              state.session.activeOperationId !== action.operationId ||
              state.session.status !== "working"
            )
              return;
            state.session.agents.find((agent) => agent.id === role)!.preview = preview.text.slice(
              0,
              2000,
            );
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
      agent.summary = output.summary;
      if (!state.stopped && state.session.revision === action.revision) {
        const completed = emit(
          state,
          "agent_completed",
          role,
          `${NAMES[role]}已完成`,
          output.summary,
          { to: role === "A" ? "B" : "user" },
        );
        state.session.sourceRecords.push({
          id: completed.id,
          kind: "analysis",
          label: `${NAMES[role]}的建议`,
          text:
            "items" in output
              ? [output.summary, ...output.items.map((item) => item.description)].join("\n\n")
              : JSON.stringify(output),
          createdAt: now(),
        });
        if (role === "A") applyAnalysis(state, output as PlanningAnalysisOutput, completed.id);
        else if (role === "B") applyQuestions(state, output as PlanningQuestionsOutput);
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
