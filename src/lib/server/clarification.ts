import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ChallengeSchema, type Challenge } from "../contracts";
import type { IntakeDraft, IntakeQuestion, RecordedAnswer } from "../intake-contracts";
import {
  DecompositionSchema,
  OptionReviewSchema,
  HandoffReviewSchema,
  type ClarificationState,
  type DecisionItem,
  type ClarificationRun,
} from "../clarification-contracts";
import {
  CLARIFICATION_PROTOCOL,
  CLARIFICATION_ROLES,
  CLARIFICATION_SYSTEM,
} from "../../../prompts/clarification";
import type { ModelConfig, StructuredRequest } from "./model";
import { ModelCallError } from "./model";
import { ArenaError } from "./db";

export interface ClarificationContext {
  operationId: string;
  revision: number;
  finish: boolean;
  config: ModelConfig;
  submit?: { challenge: Challenge; assumptions: string[] };
  editedFields?: Partial<Omit<Challenge, "materials">>;
  call: <T>(role: "A" | "B" | "C", request: StructuredRequest<T>) => Promise<T>;
  record: (state: ClarificationState) => void;
}
export function clarificationProtocolHash() {
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocol: CLARIFICATION_PROTOCOL,
        system: CLARIFICATION_SYSTEM,
        roles: CLARIFICATION_ROLES,
      }),
    )
    .digest("hex");
}
export function emptyClarification(): ClarificationState {
  return {
    protocol: CLARIFICATION_PROTOCOL,
    items: [],
    retiredIds: [],
    runs: [],
    rounds: [],
    suggestions: [],
    conflicts: [],
    review: null,
    next: "questions",
    draftOnly: false,
    specification: "",
    executionPrompt: "",
  };
}
export function clarificationFingerprint(
  draft: IntakeDraft,
  submission?: ClarificationContext["submit"],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: draft.goal,
        answers: draft.answers,
        sources: draft.sources,
        summary: submission?.challenge ?? draft.challenge,
        pendingFields: draft.confirmation?.pendingSummaryFields ?? [],
      }),
    )
    .digest("hex");
}
export function decisionAnswer(draft: IntakeDraft, item: DecisionItem): RecordedAnswer | undefined {
  return draft.answers.findLast(
    (answer) => (answer.question.decisionId ?? answer.questionId) === item.id,
  );
}
function confirmed(answer: RecordedAnswer | undefined) {
  const value = answer && (Array.isArray(answer.value) ? answer.value.join("、") : answer.value);
  return (
    !!answer &&
    answer.state === "answered" &&
    answer.confirmation === "confirmed" &&
    !answer.needsReconfirmation &&
    !!value?.trim() &&
    !/^(?:其他.*(?:描述|补充)|other(?:\b|[ ,]))/i.test(value)
  );
}
function deferred(answer: RecordedAnswer | undefined) {
  return (
    !!answer &&
    !answer.needsReconfirmation &&
    (answer.state !== "answered" ||
      !(Array.isArray(answer.value) ? answer.value.length : answer.value.trim()))
  );
}
const SUMMARY_FIELDS_BY_TOPIC: Record<DecisionItem["topic"], (keyof Challenge)[]> = {
  scope: ["goal", "constraints", "options", "budget", "timeHours", "domain"],
  function: ["constraints", "budget", "timeHours", "domain"],
  content: ["constraints", "domain"],
  flow: ["constraints", "timeHours"],
  style: ["preferences"],
  acceptance: ["constraints", "budget", "timeHours"],
  materials: ["materials"],
  authorization: ["constraints", "budget"],
};
const SUMMARY_FIELD_LABELS: Partial<Record<keyof Challenge, string>> = {
  goal: "目标",
  constraints: "要求",
  preferences: "偏好与风格",
  options: "备选方案",
  budget: "金额",
  timeHours: "时间",
  domain: "成果类型",
  materials: "材料",
};
function concreteProvidedQuote(quote: string) {
  const text = quote.trim();
  const undecided = /(?:没(?:有)?想好|尚未(?:确定|决定|明确)|还没(?:确定|决定))/;
  const unknownReply =
    /^(?:(?:我|我们|本人|目前|现在|暂时|具体|还|仍|尚|也|都)\s*)*不(?:知道|清楚|确定)|^(?:(?:目前|暂时|仍)\s*)*(?:未知|未定|待定|待确认)[，。！？,.!?\s]*$|^(?:i\s+(?:am\s+)?)?(?:unknown|undecided|tbd|not\s+(?:yet\s+)?(?:sure|decided|specified|known))(?:\b|$)/i;
  return !!text && !undecided.test(text) && !unknownReply.test(text);
}
function resolved(
  draft: IntakeDraft,
  item: DecisionItem,
  submission?: ClarificationContext["submit"],
) {
  if (confirmed(decisionAnswer(draft, item))) return true;
  if (!item.provided) return false;
  if (!item.provided.sourceRef.trim() || !concreteProvidedQuote(item.provided.quote)) return false;
  if (
    !submission &&
    ["original_goal", "confirmed_summary"].includes(item.provided.sourceRef) &&
    SUMMARY_FIELDS_BY_TOPIC[item.topic].some((field) =>
      draft.confirmation?.pendingSummaryFields?.includes(field),
    )
  )
    return false;
  const { sourceRef, quote } = item.provided;
  if (sourceRef === "original_goal") return draft.goal.includes(quote);
  if (sourceRef === "confirmed_summary") {
    const summary = submission?.challenge ?? draft.confirmation?.summary?.challenge;
    return (
      !!summary &&
      (["goal", "constraints", "preferences"] as const).some(
        (field) =>
          !draft.confirmation?.pendingSummaryFields?.includes(field) &&
          summary[field].includes(quote),
      )
    );
  }
  const answer = draft.answers.find((entry) => entry.questionId === sourceRef);
  const value = answer && (Array.isArray(answer.value) ? answer.value.join("、") : answer.value);
  return confirmed(answer) && !!value?.includes(quote);
}
function mergeItems(state: ClarificationState, incoming: DecisionItem[], draft: IntakeDraft) {
  const items = new Map(state.items.map((item) => [item.id, item]));
  if (new Set(incoming.map((item) => item.id)).size !== incoming.length)
    throw new ArenaError("需求拆解返回了重复事项，请重新整理。", 502, "CLARIFICATION_DUPLICATE");
  for (const item of incoming) {
    const prior = items.get(item.id);
    if (prior && confirmed(decisionAnswer(draft, prior))) continue;
    items.set(item.id, item);
  }
  state.items = [...items.values()];
}
function activeItems(state: ClarificationState) {
  return state.items.filter((item) => !state.retiredIds.includes(item.id));
}
function formatAnswer(answer: RecordedAnswer) {
  return `${answer.question.title} — ${Array.isArray(answer.value) ? answer.value.join("、") : answer.value}${answer.question.authorization ? `（单项授权范围为${answer.question.authorization}，仅明确同意时生效）` : ""}`;
}
export function formatClarification(
  draft: IntakeDraft,
  state: ClarificationState,
  challenge: Challenge,
) {
  const pendingFields = new Set(draft.confirmation?.pendingSummaryFields ?? []);
  const summary = draft.confirmation?.summary?.challenge;
  const domains = {
    learning: "学习成长",
    life: "生活决策",
    work: "工作业务",
    creation: "内容创作",
    general: "不限领域",
  };
  const summaryFields: Array<{
    field: keyof Challenge;
    label: string;
    value: string | number | string[] | null | undefined;
  }> = [
    { field: "constraints", label: "要求", value: challenge.constraints },
    { field: "preferences", label: "偏好", value: challenge.preferences },
    { field: "budget", label: "金额上限（人民币元）", value: summary?.budget },
    { field: "timeHours", label: "时间上限（小时）", value: summary?.timeHours },
    { field: "options", label: "备选方案", value: summary?.options },
    { field: "domain", label: "成果领域", value: summary ? domains[summary.domain] : undefined },
  ];
  const summaryLines = summaryFields
    .filter(
      ({ field, value }) => !pendingFields.has(field) && value !== null && value !== undefined,
    )
    .map(({ label, value }) => ({
      label,
      text: Array.isArray(value) ? value.join("、") : String(value),
    }))
    .filter(({ text }) => text.length > 0)
    .map(({ label, text }) => `${label} — ${text}`);
  const formal = draft.answers.filter(
    (answer) =>
      confirmed(answer) &&
      !state.retiredIds.includes(answer.question.decisionId ?? answer.questionId),
  );
  const unresolved = activeItems(state).filter((item) => !resolved(draft, item));
  const headings = {
    scope: "目标与范围",
    function: "功能",
    content: "内容",
    flow: "流程",
    style: "风格",
    acceptance: "验收",
    materials: "材料",
    authorization: "授权",
  } as const;
  const lines = [
    `# ${state.draftOnly ? "需求草稿" : "已确认需求说明"}`,
    "",
    "## 用户目标",
    draft.goal,
    "",
  ];
  if (draft.confirmation?.summary || !state.draftOnly) {
    lines.push("## 用户确认的摘要");
    if (!pendingFields.has("goal")) lines.push(`目标 — ${challenge.goal}`);
    lines.push(...summaryLines);
    lines.push("");
  }
  for (const [topic, heading] of Object.entries(headings)) {
    const answers = formal.filter(
      (answer) =>
        state.items.find((item) => item.id === (answer.question.decisionId ?? answer.questionId))
          ?.topic === topic,
    );
    const provided = activeItems(state)
      .filter(
        (item) =>
          item.topic === topic &&
          item.provided &&
          !confirmed(decisionAnswer(draft, item)) &&
          resolved(draft, item),
      )
      .map((item) => item.provided!.quote);
    if (answers.length || provided.length)
      lines.push(
        `## ${heading}`,
        ...answers.map((answer) => `- ${formatAnswer(answer)}`),
        ...provided.map((quote) => `- ${quote}`),
        "",
      );
  }
  const missing = draft.attachments
    .filter((attachment) => attachment.state !== "ready")
    .map((attachment) => `${attachment.name} — ${attachment.error || "需要补充或完整读取"}`);
  lines.push(
    "## 未决与阻塞",
    ...(unresolved.length
      ? unresolved.map((item) => `- ${item.title}${item.required ? "（阻塞交接）" : "（未决）"}`)
      : pendingFields.size
        ? []
        : ["当前记录未列出未决事项。"]),
    ...[...pendingFields].map(
      (field) => `- ${SUMMARY_FIELD_LABELS[field] ?? field}的摘要修改尚待确认（阻塞交接）`,
    ),
    ...state.conflicts.map((conflict) => `- 冲突 — ${conflict}`),
    "",
    "## 材料与来源",
    ...(draft.sources.length
      ? draft.sources.map((source) => `- ${source.filename} ${source.location} [${source.id}]`)
      : ["尚未提供可引用的附件材料。"]),
    ...missing.map((text) => `- 待提供 — ${text}`),
    "",
    "## AI 建议（待确认）",
    ...(state.suggestions.length
      ? state.suggestions.map((suggestion) => `- ${suggestion}`)
      : ["无额外建议。"]),
    "",
    "## 执行反馈",
    "尚无执行反馈。",
  );
  state.specification = lines.join("\n");
  state.executionPrompt = [
    "依据当前版本用户确认的需求执行。",
    pendingFields.size
      ? `原始目标（相关修改待确认） — ${draft.goal}`
      : `用户目标 — ${challenge.goal}`,
    ...summaryLines.map((line) => `已确认${line}`),
    ...formal.map((answer) => `- ${formatAnswer(answer)}`),
    ...activeItems(state)
      .filter(
        (item) => item.provided && !confirmed(decisionAnswer(draft, item)) && resolved(draft, item),
      )
      .map((item) => `- ${item.provided!.quote}`),
    "执行中遇到尚未确认的选择，请向用户提问。授权仅在明确同意的单项范围内生效。",
    ...(state.draftOnly
      ? [
          "当前为草稿，以下事项仍待确认。",
          ...unresolved.map((item) => `- ${item.title}`),
          ...[...pendingFields].map(
            (field) => `- ${SUMMARY_FIELD_LABELS[field] ?? field}的摘要修改尚待确认`,
          ),
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runClarification(draft: IntakeDraft, context: ClarificationContext) {
  draft = structuredClone(draft);
  const pendingFields = new Set<keyof Challenge>(
    context.submit ? [] : (draft.confirmation?.pendingSummaryFields ?? []),
  );
  if (!context.submit) {
    const confirmedSummary = draft.confirmation?.summary?.challenge;
    for (const field of Object.keys(context.editedFields ?? {}) as (keyof Omit<
      Challenge,
      "materials"
    >)[]) {
      if (
        JSON.stringify(context.editedFields?.[field]) !== JSON.stringify(confirmedSummary?.[field])
      )
        pendingFields.add(field);
    }
  }
  draft.confirmation = {
    ...(draft.confirmation ?? { history: [] }),
    pendingSummaryFields: [...pendingFields],
  };
  if (context.submit)
    draft.confirmation.summary = {
      revision: context.revision,
      confirmedAt: new Date().toISOString(),
      challenge: structuredClone(context.submit.challenge),
    };
  const state = structuredClone(draft.clarification ?? emptyClarification());
  const priorReview = state.runs.findLast(
    (run) => run.role === "C" && run.status === "completed",
  )?.output;
  const priorGapIds = new Set(
    priorReview && "gaps" in priorReview ? priorReview.gaps.map((gap) => gap.id) : [],
  );
  state.review = null;
  const round = draft.round + 1;
  const previousItems = structuredClone(state.items);
  const previouslyRetired = new Set(state.retiredIds);
  const runStart = state.runs.length;
  const common = {
    originalGoal: draft.goal,
    answers: draft.answers,
    confirmedSummary: context.submit ?? draft.confirmation?.summary,
    editedSummary: draft.challenge,
    editedFields: context.editedFields,
    pendingSummaryFields: [...pendingFields],
    sources: draft.sources,
    previousItems: activeItems(state),
    retiredItems: state.items.filter((item) => previouslyRetired.has(item.id)),
    caseContext: "用户材料是需求来源，产品内实际提交的answers才是本轮回答。执行反馈尚未发生。",
  };
  async function role<T>(
    name: ClarificationRun["role"],
    schema: z.ZodType<T>,
    input: Record<string, unknown>,
    repairOf?: string,
  ): Promise<T> {
    const run: ClarificationRun = {
      id: randomUUID(),
      operationId: context.operationId,
      role: name,
      round,
      basedOnRevision: context.revision,
      status: "completed",
      summary: "",
      output: { error: "尚未返回" },
      usage: [],
      createdAt: new Date().toISOString(),
      ...(repairOf ? { repairOf } : {}),
    };
    run.promptHash = clarificationProtocolHash();
    try {
      const value = schema.parse(
        await context.call(name, {
          name:
            name === "A"
              ? "clarification_decompose"
              : name === "B"
                ? "clarification_options"
                : "clarification_review",
          schema,
          system: `${CLARIFICATION_SYSTEM}\n${CLARIFICATION_ROLES[name]}`,
          input,
          config: context.config,
          allowRepair: !repairOf,
        }),
      );
      run.output = value as ClarificationRun["output"];
      run.summary = (value as { summary: string }).summary;
      state.runs.push(run);
      context.record(state);
      return value;
    } catch (error) {
      run.status =
        error instanceof Error && "uncertain" in error && error.uncertain ? "uncertain" : "failed";
      run.summary = error instanceof Error ? error.message : "角色调用失败";
      const repair = error instanceof ModelCallError ? error.repair : undefined;
      run.output = { error: run.summary, ...(repair ? { repair } : {}) };
      state.runs.push(run);
      context.record(state);
      if (!repairOf && error instanceof ModelCallError && !error.uncertain && repair)
        return role(
          name,
          schema,
          {
            ...input,
            repairFeedback: repair.feedback,
            rejectedOutput: repair.rejectedOutput,
          },
          run.id,
        );
      throw error;
    }
  }
  function pendingReviewItems(items: DecisionItem[], currentReview = false) {
    return items.map((item) => {
      if (confirmed(decisionAnswer(draft, item))) return item;
      const userAnswer = draft.answers.find(
        (answer) => answer.questionId === item.provided?.sourceRef,
      );
      const newUserSource =
        item.provided &&
        resolved(draft, item, context.submit) &&
        ((context.submit && item.provided.sourceRef === "confirmed_summary") ||
          confirmed(userAnswer));
      if (!currentReview && (!priorGapIds.has(item.id) || newUserSource)) return item;
      const { provided: omitted, ...pending } = item;
      void omitted;
      return pending;
    });
  }
  const decomposition = await role("A", DecompositionSchema, common);
  const incomingIds = new Set(decomposition.items.map((item) => item.id));
  state.retiredIds = state.retiredIds.filter((id) => !incomingIds.has(id));
  mergeItems(state, pendingReviewItems(decomposition.items), draft);
  const knownAnswers = new Set(
    draft.answers.filter((answer) => confirmed(answer)).map((answer) => answer.questionId),
  );
  if (context.submit) knownAnswers.add("confirmed_summary");
  for (const retired of decomposition.retired) {
    if (
      !state.items.some((item) => item.id === retired.id) ||
      retired.answerIds.some((answerId) => !knownAnswers.has(answerId))
    )
      throw new ArenaError("事项排除缺少对应的用户确认依据。", 502, "CLARIFICATION_RETIREMENT");
    state.retiredIds = [...new Set([...state.retiredIds, retired.id])];
  }
  state.suggestions = [...new Set([...state.suggestions, ...decomposition.suggestions])];
  function knownForQuestions(item: DecisionItem) {
    if (resolved(draft, item, context.submit)) return true;
    const summary = draft.confirmation?.summary?.challenge;
    const currentGoal = context.editedFields?.goal ?? draft.challenge?.goal;
    const currentDomain = context.editedFields?.domain ?? draft.challenge?.domain;
    return (
      item.topic === "scope" &&
      item.provided?.sourceRef === "original_goal" &&
      concreteProvidedQuote(item.provided.quote) &&
      draft.goal.includes(item.provided.quote) &&
      !!currentGoal?.includes(item.provided.quote) &&
      (!pendingFields.has("goal") ||
        (currentGoal === draft.goal && summary?.goal === draft.goal)) &&
      (!pendingFields.has("domain") || (!!summary && currentDomain === summary.domain)) &&
      !pendingFields.has("budget") &&
      !pendingFields.has("timeHours") &&
      !pendingFields.has("options")
    );
  }
  async function options() {
    const questionableItems = activeItems(state).filter((item) => {
      const answer = decisionAnswer(draft, item);
      return (
        !knownForQuestions(item) &&
        !deferred(answer) &&
        item.dependsOn.every((dependency) => {
          const prior = state.items.find((candidate) => candidate.id === dependency);
          return state.retiredIds.includes(dependency) || (!!prior && knownForQuestions(prior));
        })
      );
    });
    const questionIds = questionableItems.map((item) => item.id);
    const boundedOptions = OptionReviewSchema.extend({
      questions: questionIds.length
        ? z
            .array(
              OptionReviewSchema.shape.questions.element.extend({
                id: z.enum(questionIds as [string, ...string[]]),
                decisionId: z.enum(questionIds as [string, ...string[]]),
              }),
            )
            .min(1)
            .max(3)
        : OptionReviewSchema.shape.questions.max(0),
    });
    const result = await role("B", boundedOptions, {
      ...common,
      items: activeItems(state),
      questionableItems,
      review: state.review,
    });
    const ids = new Set(questionableItems.map((item) => item.id));
    for (const question of result.questions) {
      if (
        !ids.has(question.decisionId) ||
        question.id !== question.decisionId ||
        (["single", "multiple"].includes(question.type) &&
          (question.options.length < 2 ||
            new Set(question.options).size !== question.options.length))
      )
        throw new ArenaError(
          "选项与当前待决定事项不一致，请重新整理。",
          502,
          "CLARIFICATION_QUESTIONS",
        );
      const item = state.items.find((candidate) => candidate.id === question.decisionId)!;
      question.dependsOn = item.dependsOn;
      question.affects = [
        ...new Set([
          ...(question.affects ?? []),
          item.topic === "style" ? ("preferences" as const) : ("constraints" as const),
        ]),
      ];
    }
    if (
      new Set(result.questions.map((question) => question.id)).size !== result.questions.length ||
      (questionableItems.length && !result.questions.length)
    )
      throw new ArenaError("选项审查遗漏了尚待本人决定的事项。", 502, "CLARIFICATION_QUESTIONS");
    state.conflicts = result.conflicts.map((conflict) => conflict.description);
    return result.questions;
  }
  let questions = await options();
  if (context.submit || context.finish || !questions.length) {
    const review = await role("C", HandoffReviewSchema, {
      ...common,
      items: activeItems(state),
      conflicts: state.conflicts,
      submittedRequirements: context.submit ?? null,
    });
    mergeItems(state, pendingReviewItems(review.gaps, true), draft);
    state.conflicts = [...new Set([...state.conflicts, ...review.conflicts])];
    const coverage =
      ["function", "content", "flow", "style"].every((topic) =>
        review.coverage.some((entry) => entry.topic === topic),
      ) &&
      new Set(review.coverage.map((entry) => entry.topic)).size === review.coverage.length &&
      review.coverage.every(
        (entry) =>
          !entry.applicable ||
          (entry.decisionIds.length > 0 &&
            entry.decisionIds.every((decisionId) =>
              activeItems(state).some((item) => item.id === decisionId),
            )),
      );
    const blocked = activeItems(state).some((item) => !resolved(draft, item, context.submit));
    state.review = {
      ...review,
      ready:
        review.ready &&
        coverage &&
        !pendingFields.size &&
        !blocked &&
        !questions.length &&
        !state.conflicts.length &&
        !review.gaps.length,
      fingerprint: clarificationFingerprint(draft, context.submit),
      basedOnRevision: context.revision,
    };
    if (!questions.length && review.gaps.length && !context.finish) questions = await options();
  }
  state.draftOnly = context.finish || !state.review?.ready;
  state.requestedDraft = context.finish;
  state.next = questions.length && !context.finish ? "questions" : "summary";
  const changes = {
    added: state.items
      .filter((item) => !previousItems.some((old) => old.id === item.id))
      .map((item) => item.id),
    retired: decomposition.retired.map((item) => item.id),
    changed: state.items
      .filter((item) => {
        const old = previousItems.find((prior) => prior.id === item.id);
        return (
          (old && JSON.stringify(old) !== JSON.stringify(item)) ||
          (previouslyRetired.has(item.id) && !state.retiredIds.includes(item.id))
        );
      })
      .map((item) => item.id),
    triggerAnswerIds: draft.answers
      .filter(
        (answer) =>
          !state.rounds
            .at(-1)
            ?.answers.some((prior) => JSON.stringify(prior) === JSON.stringify(answer)),
      )
      .map((answer) => answer.questionId),
  };
  state.rounds.push({
    round,
    revision: context.revision,
    questions,
    answers: structuredClone(draft.answers),
    changes,
    runIds: state.runs.slice(runStart).map((run) => run.id),
    createdAt: new Date().toISOString(),
  });
  const confirmedAnswers = draft.answers.filter(
    (answer) =>
      confirmed(answer) &&
      !state.retiredIds.includes(answer.question.decisionId ?? answer.questionId),
  );
  const challenge =
    context.submit?.challenge ??
    ChallengeSchema.parse({
      ...(draft.challenge ?? {}),
      goal: draft.goal.length >= 8 ? draft.goal : `需求细化任务 — ${draft.goal}`,
      constraints: confirmedAnswers
        .filter(
          (answer) =>
            state.items.find(
              (item) => item.id === (answer.question.decisionId ?? answer.questionId),
            )?.topic !== "style",
        )
        .map(formatAnswer)
        .join("\n")
        .slice(0, 3000),
      preferences: confirmedAnswers
        .filter(
          (answer) =>
            state.items.find(
              (item) => item.id === (answer.question.decisionId ?? answer.questionId),
            )?.topic === "style",
        )
        .map(formatAnswer)
        .join("\n")
        .slice(0, 1500),
      options: [],
      ...context.editedFields,
    });
  formatClarification(draft, state, challenge);
  return {
    state,
    questions: questions as IntakeQuestion[],
    challenge,
    assumptions: state.suggestions.slice(0, 6),
    status: state.next === "questions" ? ("questions" as const) : ("summary" as const),
  };
}
