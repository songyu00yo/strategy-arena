import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ChallengeSchema, type Challenge } from "../contracts";
import { hasCompleteChoiceAnswer } from "../answer-options";
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
  intent?: "continue" | "preview";
  config: ModelConfig;
  submit?: { challenge: Challenge; assumptions: string[] };
  editedFields?: Partial<Omit<Challenge, "materials">>;
  editedAssumptions?: string[];
  rejectedAssumptions?: string[];
  call: <T>(role: "A" | "B" | "C", request: StructuredRequest<T>) => Promise<T>;
  record: (state: ClarificationState) => void;
}
let cachedProtocolHash: string | undefined;
export function clarificationProtocolHash() {
  if (cachedProtocolHash) return cachedProtocolHash;
  cachedProtocolHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: "clarification-schema-2",
        protocol: CLARIFICATION_PROTOCOL,
        system: CLARIFICATION_SYSTEM,
        roles: CLARIFICATION_ROLES,
        schemas: {
          decomposition: z.toJSONSchema(DecompositionSchema),
          options: z.toJSONSchema(OptionReviewSchema),
          handoff: z.toJSONSchema(HandoffReviewSchema),
        },
      }),
    )
    .digest("hex");
  return cachedProtocolHash;
}
export function clarificationReviewConfig(config: ModelConfig): ModelConfig {
  const override =
    config.provider === "openai" ? "OPENAI_MAX_OUTPUT_TOKENS" : "MODEL_MAX_OUTPUT_TOKENS";
  if (process.env[override] !== undefined) return config;
  return config.maxOutputTokens >= 4200 ? config : { ...config, maxOutputTokens: 4200 };
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
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function confirmedSubmission(draft: IntakeDraft, submission?: ClarificationContext["submit"]) {
  if (submission) return { challenge: submission.challenge, assumptions: submission.assumptions };
  const summary = draft.confirmation?.summary;
  return summary ? { challenge: summary.challenge, assumptions: draft.assumptions } : null;
}
export function clarificationFingerprint(
  draft: IntakeDraft,
  submission?: ClarificationContext["submit"],
) {
  return fingerprint({
    protocolHash: clarificationProtocolHash(),
    goal: draft.goal,
    modelMode: draft.modelMode,
    answers: draft.answers.map((answer) => ({
      questionId: answer.questionId,
      question: answer.question,
      state: answer.state,
      value: answer.value,
      confirmation: answer.confirmation,
      needsReconfirmation: answer.needsReconfirmation,
    })),
    sources: draft.sources,
    attachments: (draft.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      state: attachment.state,
      locations: attachment.locations,
      warnings: attachment.warnings,
    })),
    summary: submission?.challenge ?? draft.challenge,
    submittedRequirements: confirmedSubmission(draft, submission),
    assumptions: submission?.assumptions ?? draft.assumptions,
    pendingFields: submission ? [] : (draft.confirmation?.pendingSummaryFields ?? []),
    items: draft.clarification ? activeItems(draft.clarification) : [],
    conflicts: draft.clarification?.conflicts ?? [],
    feedback: draft.clarification?.feedback ?? [],
  });
}
function analysisFingerprint(draft: IntakeDraft, submission?: ClarificationContext["submit"]) {
  // Unconfirmed new answers can inform C's provisional plan without changing the confirmed graph.
  return fingerprint({
    protocolHash: clarificationProtocolHash(),
    goal: draft.goal,
    modelMode: draft.modelMode,
    answers: draft.answers.filter(confirmed).map((answer) => ({
      questionId: answer.questionId,
      question: answer.question,
      state: answer.state,
      value: answer.value,
      confirmation: answer.confirmation,
      needsReconfirmation: answer.needsReconfirmation,
    })),
    sources: draft.sources,
    attachments: (draft.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      state: attachment.state,
      locations: attachment.locations,
    })),
    summary: submission?.challenge ?? draft.challenge,
    assumptions: submission?.assumptions ?? draft.assumptions,
    feedback: draft.clarification?.feedback ?? [],
  });
}
function hasCurrentAnalysis(draft: IntakeDraft, submission?: ClarificationContext["submit"]) {
  const state = draft.clarification;
  return (
    !!state?.items.length &&
    state.analysisFingerprint === analysisFingerprint(draft, submission) &&
    state.runs.some(
      (run) =>
        run.role === "A" &&
        run.status === "completed" &&
        run.promptHash === clarificationProtocolHash(),
    )
  );
}
export function isCurrentClarificationReview(
  draft: IntakeDraft,
  submission?: ClarificationContext["submit"],
) {
  const state = draft.clarification;
  const run = state?.runs.findLast((entry) => entry.role === "C");
  return (
    !!state?.review &&
    !!run &&
    run.status === "completed" &&
    run.promptHash === clarificationProtocolHash() &&
    state.review.basedOnRevision === run.basedOnRevision &&
    state.review.basedOnRevision <= draft.revision &&
    state.review.fingerprint === clarificationFingerprint(draft, submission)
  );
}
export function decisionAnswer(draft: IntakeDraft, item: DecisionItem): RecordedAnswer | undefined {
  return draft.answers.findLast(
    (answer) => (answer.question.decisionId ?? answer.questionId) === item.id,
  );
}
function confirmed(answer: RecordedAnswer | undefined) {
  if (
    !answer ||
    answer.state !== "answered" ||
    answer.confirmation !== "confirmed" ||
    answer.needsReconfirmation
  )
    return false;
  if (answer.question.type === "single" || answer.question.type === "multiple")
    return hasCompleteChoiceAnswer(answer.question.type, answer.question.options, answer.value);
  const value = Array.isArray(answer.value) ? answer.value.join("、") : answer.value;
  return !!value.trim();
}
function authorizationDecision(answer: RecordedAnswer): "allow" | "deny" | null {
  if (!confirmed(answer) || !answer.question.authorization) return null;
  return explicitDecisionValue(answer.value);
}
function explicitDecisionValue(value: RecordedAnswer["value"]): "allow" | "deny" | null {
  const textValue = (Array.isArray(value) ? value.join(" ") : value).trim();
  if (
    /是否|能否|尚未|还没|未(?:确定|决定|确认)|待定|不确定|不知道|不清楚|再考虑|以后再|同意与否|不一定|也许/.test(
      textValue,
    )
  )
    return null;
  const text = textValue.replace(/^(?:我(?:们)?|本人)(?:明确)?/, "");
  if (
    /^(?:同意|允许|授权)(?!与否|吗|[？?])/.test(text) ||
    /^(?:是(?:的)?|yes|agree|allow)(?:$|[\s，,。！!、（(])/i.test(text)
  )
    return "allow";
  if (
    /^(?:拒绝|不同意|不允许|不授权|不公开|不采集|不需要|不用|仅本人)/.test(text) ||
    /^(?:否|no|deny)(?:$|[\s，,。！!、（(])/i.test(text)
  )
    return "deny";
  return null;
}
function deferred(answer: RecordedAnswer | undefined) {
  return (
    !!answer &&
    !answer.needsReconfirmation &&
    (answer.state !== "answered" ||
      !(Array.isArray(answer.value) ? answer.value.length : answer.value.trim()))
  );
}
export const SUMMARY_FIELDS_BY_TOPIC: Record<DecisionItem["topic"], (keyof Challenge)[]> = {
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
  const existingAnswer = decisionAnswer(draft, item);
  if (existingAnswer?.needsReconfirmation) return false;
  if (confirmed(existingAnswer)) {
    return (
      !existingAnswer!.question.authorization || authorizationDecision(existingAnswer!) !== null
    );
  }
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
function explicitlyRequired(
  draft: IntakeDraft,
  item: DecisionItem,
  submission?: ClarificationContext["submit"],
) {
  const answer = decisionAnswer(draft, item);
  if (
    answer?.question.authorization ||
    draft.questions.some(
      (question) => (question.decisionId ?? question.id) === item.id && question.authorization,
    )
  )
    return true;
  const value = confirmed(answer)
    ? Array.isArray(answer!.value)
      ? answer!.value.join("、")
      : answer!.value
    : "";
  const quote = item.provided && resolved(draft, item, submission) ? item.provided.quote : "";
  return /必须|务必|必需|不可缺少|\b(?:must|required|mandatory)\b/i.test(value + quote);
}
export function hasBlockingUnconfirmedItems(
  draft: IntakeDraft,
  submission?: ClarificationContext["submit"],
) {
  const state = draft.clarification;
  if (!state) return true;
  const items = activeItems(state);
  const required = new Set(
    items
      .filter((item) => item.required || explicitlyRequired(draft, item, submission))
      .map((item) => item.id),
  );
  for (const id of required) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return true;
    for (const dependency of item.dependsOn) {
      if (!state.retiredIds.includes(dependency)) required.add(dependency);
    }
  }
  return items.some((item) => required.has(item.id) && !resolved(draft, item, submission));
}
export function derivePlanningReadiness(
  draft: IntakeDraft,
): import("../intake-contracts").PlanningReadiness {
  if (!hasCurrentAnalysis(draft)) return "not_ready";
  const state = draft.clarification!;
  if (state.requestedDraft) return "previewable";
  if (
    !isCurrentClarificationReview(draft) ||
    !state.review?.ready ||
    hasBlockingUnconfirmedItems(draft) ||
    state.conflicts.length ||
    draft.confirmation?.pendingSummaryFields?.length
  )
    return "previewable";
  return draft.confirmation?.summary &&
    !state.draftOnly &&
    !state.requestedDraft &&
    state.next === "completed"
    ? "handoff_ready"
    : "requirement_ready";
}
function mergeItems(state: ClarificationState, incoming: DecisionItem[], draft: IntakeDraft) {
  const items = new Map(state.items.map((item) => [item.id, item]));
  if (new Set(incoming.map((item) => item.id)).size !== incoming.length)
    throw new ArenaError("需求拆解返回了重复事项，请重新整理。", 502, "CLARIFICATION_DUPLICATE");
  for (const item of incoming) {
    const prior = items.get(item.id);
    if (prior && confirmed(decisionAnswer(draft, prior))) continue;
    const protectedRequired =
      explicitlyRequired(draft, item) ||
      (prior?.required && (prior.topic === "authorization" || explicitlyRequired(draft, prior)));
    items.set(item.id, protectedRequired ? { ...item, required: true } : item);
  }
  state.items = [...items.values()];
}
function protectedRetirementHasSource(
  draft: IntakeDraft,
  item: DecisionItem,
  answerIds: string[],
  baseline: { items: DecisionItem[]; answers?: RecordedAnswer[]; revision?: number },
) {
  const related = new Set(item.dependsOn);
  for (const id of related) {
    const dependency = baseline.items.find((entry) => entry.id === id);
    for (const parent of dependency?.dependsOn ?? []) related.add(parent);
  }
  return answerIds.some((id) => {
    const answer = draft.answers.findLast((entry) => entry.questionId === id);
    if (!confirmed(answer)) return false;
    const decisionId = answer!.question.decisionId ?? answer!.questionId;
    if (decisionId === item.id) {
      if (item.topic === "authorization" || answer!.question.authorization)
        return explicitDecisionValue(answer!.value) === "deny";
      const text = Array.isArray(answer!.value) ? answer!.value.join(" ") : answer!.value;
      return /^(?:我(?:们)?|本人)?(?:取消|删除|移除|撤销|不再需要|不再要求|不需要|不用|不要)/.test(
        text.trim(),
      );
    }
    if (!related.has(decisionId) || !baseline.items.some((entry) => entry.id === decisionId))
      return false;
    if (baseline.answers) {
      const previous = baseline.answers.findLast(
        (entry) => (entry.question.decisionId ?? entry.questionId) === decisionId,
      );
      const semanticValue = (entry: RecordedAnswer) =>
        JSON.stringify(Array.isArray(entry.value) ? [...entry.value].sort() : entry.value.trim());
      return !confirmed(previous) || semanticValue(previous!) !== semanticValue(answer!);
    }
    return (
      baseline.revision !== undefined &&
      answer!.confirmedRevision !== undefined &&
      answer!.confirmedRevision > baseline.revision
    );
  });
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
  assumptionsWereUserEdited = false,
  rejectedAssumptions: readonly string[] = [],
) {
  // Preserve the existing call signature while sourcing facts only from stored confirmations.
  void challenge;
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
    { field: "constraints", label: "要求", value: summary?.constraints },
    { field: "preferences", label: "偏好", value: summary?.preferences },
    { field: "budget", label: "金额上限（人民币元）", value: summary?.budget },
    { field: "timeHours", label: "时间上限（小时）", value: summary?.timeHours },
    { field: "options", label: "备选方案", value: summary?.options },
    { field: "domain", label: "成果领域", value: summary ? domains[summary.domain] : undefined },
  ];
  const formal = draft.answers.filter(
    (answer) =>
      confirmed(answer) &&
      !state.retiredIds.includes(answer.question.decisionId ?? answer.questionId),
  );
  const formalAnswerLines = new Set(formal.map((answer) => formatAnswer(answer).trim()));
  const summaryRequirementLines = summaryFields
    .filter(
      ({ field, value }) =>
        ["constraints", "preferences", "options"].includes(field) &&
        !pendingFields.has(field) &&
        value !== null &&
        value !== undefined,
    )
    .map(({ label, value }) => ({
      label,
      text: (Array.isArray(value) ? value.join("、") : String(value))
        .split("\n")
        .filter((line) => !formalAnswerLines.has(line.trim()))
        .join("\n")
        .trim(),
    }))
    .filter(({ text }) => text.length > 0)
    .map(({ label, text }) => `${label} — ${text}`);
  const ungroupedAnswers = formal.filter(
    (answer) =>
      !state.items.some((item) => item.id === (answer.question.decisionId ?? answer.questionId)),
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
  const projectOverview = [
    ...(state.review?.summary
      ? [
          `- **AI 项目归纳（基于当前确认记录，非新增需求）**：${state.review.projectOverview || state.review.summary}`,
        ]
      : ["- AI 项目归纳：尚无 C 角色总结；以下仅列已确认事实。"]),
    ...(!pendingFields.has("budget") && summary?.budget != null
      ? [`- **预算上限**：¥${summary.budget}（用户确认）`]
      : ["- **预算上限**：未知（未授权支出）"]),
    ...(!pendingFields.has("timeHours") && summary?.timeHours != null
      ? [`- **可投入时间**：${summary.timeHours} 小时（用户确认）`]
      : ["- **可投入时间**：未知（不承诺工期）"]),
    ...(summary && !pendingFields.has("domain")
      ? [`- **成果领域**：${domains[summary.domain]}（用户确认）`]
      : []),
  ];
  const lines = [
    `# ${state.draftOnly || !draft.confirmation?.summary ? "需求草稿 / 预览" : "已确认需求说明"}`,
    "",
    "## 项目概述",
    ...projectOverview,
    "",
    "## 原始输入目标（未自动视为确认）",
    draft.goal,
    "",
    "## 已确认需求（正式依据）",
    ...(summary && !pendingFields.has("goal") && summary.goal.trim() !== draft.goal.trim()
      ? [`- 用户确认后的目标表述 — ${summary.goal}`]
      : []),
    ...summaryRequirementLines.map((line) => `- 用户确认字段：${line}`),
    ...(formal.length || summary ? [] : ["- 尚无正式确认摘要或已确认回答。"]),
  ];
  for (const [topic, heading] of Object.entries(headings)) {
    const answers = formal.filter(
      (answer) =>
        state.items.find((item) => item.id === (answer.question.decisionId ?? answer.questionId))
          ?.topic === topic,
    );
    if (answers.length)
      lines.push(`### ${heading}`, ...answers.map((answer) => `- ${formatAnswer(answer)}`), "");
  }
  if (ungroupedAnswers.length)
    lines.push(
      "### 其他已确认回答",
      ...ungroupedAnswers.map((answer) => `- ${formatAnswer(answer)}`),
      "",
    );
  const missing = draft.attachments
    .filter((attachment) => attachment.state !== "ready")
    .map((attachment) => `${attachment.name} — ${attachment.error || "需要补充或完整读取"}`);
  const active = activeItems(state);
  const confirmedSummary = draft.confirmation?.summary?.challenge;
  const topicLabels: Record<DecisionItem["topic"], string> = {
    scope: "目标与范围",
    function: "功能",
    content: "内容",
    flow: "流程",
    style: "风格",
    acceptance: "验收",
    materials: "材料",
    authorization: "授权",
  };
  const topics: DecisionItem["topic"][] = [
    "scope",
    "function",
    "content",
    "flow",
    "style",
    "acceptance",
    "materials",
    "authorization",
  ];
  const coverageRows = topics.map((topic) => {
    const relevant = active.filter((item) => item.topic === topic);
    const open = relevant.filter((item) => !resolved(draft, item));
    const coverage = state.review?.coverage.find((entry) => entry.topic === topic);
    const cRequired = ["function", "content", "flow", "style"].includes(topic);
    const status = !state.review
      ? "尚未完成 C 角色查漏"
      : coverage
        ? !coverage.applicable
          ? "C 角色判断不适用（需核查理由）"
          : open.length
            ? "存在未解决事项"
            : !coverage.decisionIds.length
              ? "没有可追溯的覆盖事项"
              : "需求层面已覆盖"
        : cRequired
          ? "C 角色未提供覆盖结论"
          : open.length
            ? "存在未解决事项"
            : relevant.length
              ? "事项均已解决（未列入 C 强制覆盖维度）"
              : "未列出该类事项（非 C 强制覆盖维度）";
    return {
      label: topicLabels[topic],
      status,
      reasons: [...(coverage ? [coverage.reason] : []), ...open.map((item) => item.title)].filter(
        Boolean,
      ),
    };
  });
  const budgetKnown = !pendingFields.has("budget") && confirmedSummary?.budget != null;
  const timeKnown = !pendingFields.has("timeHours") && confirmedSummary?.timeHours != null;
  const authorizationGranted = formal.some((answer) => authorizationDecision(answer) === "allow");
  const feasibilityLines = coverageRows.map(
    (row) =>
      `- ${row.label}：${row.status}${row.reasons.length ? `；依据：${row.reasons.join("；")}` : ""}`,
  );
  const reportGaps = [
    ...unresolved.map((item) => `${item.title}${item.required ? "（必需）" : "（可选）"}`),
    ...coverageRows
      .filter(
        (row, index) =>
          ["function", "content", "flow", "style"].includes(topics[index]) &&
          !["需求层面已覆盖", "C 角色判断不适用（需核查理由）"].includes(row.status),
      )
      .map((row) => `${row.label}：${row.status}`),
    ...[...pendingFields].map((field) => `${SUMMARY_FIELD_LABELS[field] ?? field}的摘要修改待确认`),
    ...state.conflicts.map((conflict) => `冲突：${conflict}`),
    ...missing.map((entry) => `材料处理缺口：${entry}`),
    ...(state.review && !state.review.ready ? ["C 角色尚未判定可以正式交接"] : []),
    ...(!budgetKnown ? ["预算上限未知"] : []),
    ...(!timeKnown ? ["可投入时间未知"] : []),
    ...(!state.review ? ["尚无 C 角色查漏结论"] : []),
  ];
  const projectDecisions = active
    .filter((item) => !confirmed(decisionAnswer(draft, item)))
    .map((item) => {
      const provided = item.provided && resolved(draft, item) ? item.provided.quote : null;
      const decision = provided ? `来源提取：${provided}（非逐项确认）` : "待决定";
      return `- **${topicLabels[item.topic]}｜${item.title}**：${decision}。${item.description}${item.acceptance.length ? `；建议验收：${item.acceptance.join("；")}` : ""}`;
    });
  const evidenceLines = draft.sources.map((source) => {
    const origin = source.interpretation ? "model_interpretation" : (source.origin ?? "unknown");
    const status =
      origin === "document"
        ? "附件原文（来源材料，不等同用户确认）"
        : origin === "model_transcription"
          ? "模型转录（需对照原图核验）"
          : origin === "model_interpretation"
            ? "模型解读（推论，不作为原始事实）"
            : "来源不明（不可升级为原始事实）";
    return `- [${source.id}] ${source.filename} · ${source.location} · ${status}`;
  });
  const feasibilityStatusLabels = {
    supported: "初步支持（仍需验证）",
    conditional: "有条件可行",
    unknown: "证据不足/未知",
    blocked: "当前条件下存在阻塞",
  } as const;
  const dimensionLabels = {
    technical: "技术实现",
    resource: "资源与预算",
    data: "数据与材料",
    security: "安全与权限",
    delivery: "交付与运维",
    integration: "系统集成",
  } as const;
  const aiFeasibility = state.review?.feasibility ?? [];
  const aiPlan = state.review?.implementationPlan ?? [];
  const aiTradeoffs = state.review?.tradeoffs ?? [];
  const aiRisks = state.review?.risks ?? [];
  const deliveryPlan = state.review?.deliveryPlan;
  const deliveryPlanLines = deliveryPlan
    ? [
        "### 交付物（AI 规划，待核验）",
        ...deliveryPlan.deliverables.map((entry) => `- ${entry}`),
        "### 验收策略（AI 规划，待核验）",
        ...deliveryPlan.acceptanceStrategy.map((entry) => `- ${entry}`),
      ]
    : [];
  reportGaps.push(
    ...aiFeasibility
      .filter((entry) => entry.status === "blocked")
      .map((entry) => `AI 初步判断存在可行性阻塞（${entry.dimension}）：${entry.assessment}`),
  );
  const aiFeasibilityLines = aiFeasibility.map(
    (entry) =>
      `- ${dimensionLabels[entry.dimension]}：${feasibilityStatusLabels[entry.status]}。判断：${entry.assessment}；依据：${entry.basis}；不确定性：${entry.uncertainty}；验证：${entry.validation}`,
  );
  const aiPlanLines = aiPlan.flatMap((phase, index) => [
    `### ${index + 1}. ${phase.phase}`,
    `目标：${phase.objective}`,
    `任务：${phase.tasks.join("；")}`,
    `依赖：${phase.dependencies.join("；") || "未提供"}`,
    `交付物：${phase.deliverables.join("；") || "未提供"}`,
    `验收：${phase.acceptance.join("；") || "未提供"}`,
    `估算：${phase.estimate}；依据：${phase.estimateBasis}；不确定性：${phase.estimateUncertainty}`,
  ]);
  const tradeoffLines = aiTradeoffs.map(
    (entry) =>
      `- ${entry.decision}：${entry.options.map((option) => `${option.option}（收益：${option.benefit}；代价：${option.cost}）`).join("；")}；AI 暂定建议：${entry.recommendation}；依据：${entry.basis}；不确定性：${entry.uncertainty}`,
  );
  const riskLines = aiRisks.map(
    (entry) =>
      `- ${entry.risk}（可能性：${entry.likelihood}；影响：${entry.impact}）；依据：${entry.basis}；缓解：${entry.mitigation}；不确定性：${entry.uncertainty}`,
  );
  const planStages = [
    "1. 需求冻结：列出已确认答案、未决事项、授权边界和来源；由用户确认后锁定正式需求版本。",
    "2. 条件验证：根据项目目标核查资源、材料、流程和交付环境，保留尚未验证的条件。",
    "3. 分阶段实现：先完成最小闭环，再扩展次要能力；每项任务绑定输入、输出、依赖和验收。",
    "4. 交付验收：按已确认的成果与验收标准逐项检查，保留实际结果和未完成事项。",
    "5. 交接复盘：交付使用或执行说明、已知限制、责任和未完成事项；变更需求另作确认。",
  ];
  lines.push(
    "## 可行性分析",
    "需求确认只代表用户同意该要求，不证明技术上可实现。需求覆盖、资源边界和工程可行性分别判断。",
    ...feasibilityLines,
    `- 预算边界：${budgetKnown ? `用户确认上限 ¥${confirmedSummary!.budget}` : "未知；不得视为预算充足或已授权支出"}`,
    `- 时间边界：${timeKnown ? `用户确认可投入 ${confirmedSummary!.timeHours} 小时` : "未知；不得据此承诺工期"}`,
    `- 外部/敏感操作授权：${authorizationGranted ? "存在明确同意，仍仅限题目所述范围" : "未发现明确同意，不得推定授权"}`,
    `- 技术可行性：${state.review ? "尚需工程验证；C 角色查漏不等同于技术验证" : "未评估；缺少 C 角色查漏及工程验证"}`,
    `- 综合判断：${reportGaps.length ? "可形成阶段性规划，但存在明确缺口，不应承诺无条件完整交付" : "需求覆盖较完整，仍须工程验证后才能作出技术可行性结论"}`,
    "",
    "### C 角色 AI 可行性初判（非实测）",
    ...(aiFeasibilityLines.length
      ? aiFeasibilityLines
      : ["- C 角色未提供结构化技术评估；须补充证据并进行工程验证。"]),
    "",
    "## 尚未正式确认的结构化事项",
    ...projectDecisions.map((entry) => `- ${entry.replace(/^- /, "待确认/材料推断：")}`),
    "",
    "## 产品与实施规划（AI 分析；不扩大用户授权）",
    "以下阶段计划来自 C 角色分析；每阶段包含任务、依赖、交付物、验收和估算依据。缺少的内容不得由执行者自行补成已确认要求。",
    ...(aiPlanLines.length ? aiPlanLines : planStages),
    ...(deliveryPlanLines.length
      ? ["", "## 交付与验收规划（AI 分析，待核验）", ...deliveryPlanLines]
      : []),
    "",
    "## 实施路径与方案取舍（AI 分析，非用户确认）",
    "- 根据已确认目标、活动或产品流程、资源约束和交付环境选择实施方式；不预设必须采用软件、网站或其他特定技术形式。",
    "- 优先采用满足需求且复杂度最低的路径。只有在确实涉及软件系统时，才进一步讨论技术栈、部署、数据模型和第三方依赖。",
    "- 新增费用、外部服务、个人数据处理或不可逆操作必须说明依据、成本、退出路径，并取得相应授权。",
    ...(tradeoffLines.length
      ? tradeoffLines
      : [
          "- C 角色尚未提供有依据的候选实施路径比较；如确实存在多个可行路径，应结合当前目标和约束进行比较。",
        ]),
    "",
    "## 风险、假设与待核实",
    ...(riskLines.length ? riskLines : []),
    "### 当前轮 AI 建议（来源：A 角色，未获用户确认）",
    ...(state.suggestions.length
      ? state.suggestions.map((entry) => `- [AI 建议 / 待核实] ${entry}`)
      : ["- 当前轮没有新的 AI 建议。"]),
    "### 用户保留的暂定假设",
    ...(draft.assumptions.length
      ? draft.assumptions.map(
          (entry) =>
            `- [${assumptionsWereUserEdited ? "用户主动保留 / 尚未证实" : "AI 初始建议 / 尚未由用户编辑"}] ${entry}`,
        )
      : ["- 当前未主动保留暂定假设。"]),
    ...(rejectedAssumptions.length
      ? [
          "### 用户明确删除的建议",
          ...rejectedAssumptions.map((entry) => `- [用户明确拒绝，不得自动恢复] ${entry}`),
        ]
      : []),
    ...(state.conflicts.length
      ? state.conflicts.map((entry) => `- 冲突（待解决）：${entry}`)
      : ["- 当前未记录模型识别出的冲突。"]),
    ...reportGaps.map((entry) => `- 未决/证据缺口：${entry}`),
    ...missing.map((entry) => `- 材料缺口：${entry}`),
    "",
    "## 材料与来源可信度",
    ...(evidenceLines.length ? evidenceLines : ["- 尚未提供附件材料。"]),
    "",
  );
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
    "## 材料处理状态",
    ...(missing.length
      ? missing.map((text) => `- 待处理：${text}`)
      : ["当前附件均已完成读取，或未提供附件。"]),
    "",
    "## 执行反馈",
    "尚无执行反馈。",
  );
  state.specification = lines.join("\n");
  state.executionPrompt = [
    "你是本项目的实施代理。严格遵循本版本需求；不得把 AI 推论、附件转录或未决事项改写成用户确认。",
    `需求版本：${draft.revision}；报告状态：${state.draftOnly || !confirmedSummary ? "预览/草稿，禁止视为正式授权" : "正式需求说明"}`,
    `原始目标（原始输入，不自动视为确认）：${draft.goal}`,
    ...(confirmedSummary
      ? [
          ...(!pendingFields.has("goal") && confirmedSummary.goal.trim() !== draft.goal.trim()
            ? [`用户确认后的目标表述：${confirmedSummary.goal}`]
            : []),
          ...summaryRequirementLines.map((line) => `用户确认字段：${line}`),
          ...summaryFields
            .filter(
              ({ field, value }) =>
                ["budget", "timeHours", "domain"].includes(field) &&
                !pendingFields.has(field) &&
                value !== null &&
                value !== undefined,
            )
            .map(
              ({ label, value }) =>
                `用户确认字段：${label} — ${Array.isArray(value) ? value.join("、") : String(value)}`,
            ),
        ]
      : ["用户尚未确认正式摘要。"]),
    ...active.map((item) => {
      const answer = decisionAnswer(draft, item);
      const value = answer
        ? Array.isArray(answer.value)
          ? answer.value.join("、")
          : answer.value
        : "";
      return `${item.topic}/${item.title}：${confirmed(answer) ? `用户确认：${value}${answer?.question.authorization ? `（单项授权范围为${answer.question.authorization}，仅明确同意时生效）` : ""}` : item.provided && resolved(draft, item) ? `材料/目标提取（未逐项确认）：${item.provided.quote}` : "未决，不得擅自决定"}`;
    }),
    ...ungroupedAnswers.map((answer) => `用户确认回答：${formatAnswer(answer)}`),
    "附件原文、模型转录和模型解读必须分别标注；模型解读不得作为事实。",
    "执行前先做技术可行性验证；需求确认不代表技术可行，也不代表预算、工期或外部操作已获授权。",
    ...(aiFeasibilityLines.length
      ? ["C 角色 AI 可行性初判（非实测）：", ...aiFeasibilityLines]
      : []),
    ...(aiPlanLines.length ? ["C 角色 AI 实施计划（估算与任务均需核验）：", ...aiPlanLines] : []),
    ...(state.review?.projectOverview
      ? [`C 角色 AI 项目概述（非新增确认）：${state.review.projectOverview}`]
      : []),
    ...(deliveryPlanLines.length
      ? ["C 角色 AI 交付与验收规划（待核验）：", ...deliveryPlanLines]
      : []),
    ...(tradeoffLines.length ? ["AI 方案取舍（不是用户确认）：", ...tradeoffLines] : []),
    ...(riskLines.length ? ["AI 风险分析：", ...riskLines] : []),
    ...(state.suggestions.length
      ? [
          "当前轮 AI 建议（A 角色生成，未确认，仅供评估）：",
          ...state.suggestions.map((entry) => `- ${entry}`),
        ]
      : []),
    ...(assumptionsWereUserEdited && draft.assumptions.length
      ? [
          "用户主动保留的暂定假设（仍未证实，不是事实或授权）：",
          ...draft.assumptions.map((entry) => `- ${entry}`),
        ]
      : []),
    ...(rejectedAssumptions.length
      ? ["用户明确拒绝的建议，不得自动恢复：", ...rejectedAssumptions.map((entry) => `- ${entry}`)]
      : []),
    "未经明确同意不得产生费用、发布内容、联系第三方、处理真实个人数据或执行不可逆操作。",
    ...(state.draftOnly ? ["当前为草稿/预览，禁止直接执行；先列出阻塞项并请求用户确认。"] : []),
    ...(reportGaps.length ? ["尚待处理：", ...reportGaps.map((entry) => `- ${entry}`)] : []),
    "实施时逐项记录方案、依据、验证、结果与回滚方式。",
  ].join("\n");
}

function createRoleCaller(context: ClarificationContext, state: ClarificationState, round: number) {
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
    run.inputFingerprint = fingerprint(input);
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
          config: name === "C" ? clarificationReviewConfig(context.config) : context.config,
          allowRepair: name !== "C" && !repairOf,
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
      if (
        name !== "C" &&
        !repairOf &&
        error instanceof ModelCallError &&
        !error.uncertain &&
        repair
      )
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
  return role;
}
function reviewInput(draft: IntakeDraft, state: ClarificationState, context: ClarificationContext) {
  return {
    originalGoal: draft.goal,
    answers: draft.answers,
    confirmedSummary: confirmedSubmission(draft, context.submit),
    editedSummary: context.submit?.challenge ?? draft.challenge,
    assumptions: context.submit?.assumptions ?? draft.assumptions,
    editedAssumptions: context.submit?.assumptions ?? context.editedAssumptions,
    pendingSummaryFields: context.submit ? [] : (draft.confirmation?.pendingSummaryFields ?? []),
    rejectedSuggestions: context.rejectedAssumptions ?? [],
    sources: draft.sources,
    feedback: state.feedback ?? [],
    items: activeItems(state),
    conflicts: state.conflicts,
    submittedRequirements: confirmedSubmission(draft, context.submit),
    caseContext: "用户材料与未确认回答保持来源状态，不得据此推定确认或授权。执行反馈尚未发生。",
  };
}
function applyReview(
  draft: IntakeDraft,
  state: ClarificationState,
  context: ClarificationContext,
  review: z.infer<typeof HandoffReviewSchema>,
  currentConflicts: string[],
) {
  const gaps = review.gaps.map((gap) => {
    if (confirmed(decisionAnswer(draft, gap))) return gap;
    const { provided: omitted, ...pending } = gap;
    void omitted;
    return pending;
  });
  mergeItems(state, gaps, draft);
  state.conflicts = [...new Set([...currentConflicts, ...review.conflicts])];
  const coverage =
    ["function", "content", "flow", "style"].every((topic) =>
      review.coverage.some((entry) => entry.topic === topic),
    ) &&
    new Set(review.coverage.map((entry) => entry.topic)).size === review.coverage.length &&
    review.coverage.every(
      (entry) =>
        !entry.applicable ||
        (entry.decisionIds.length > 0 &&
          entry.decisionIds.every((id) => activeItems(state).some((item) => item.id === id))),
    );
  state.review = {
    ...review,
    ready:
      review.ready &&
      coverage &&
      !hasBlockingUnconfirmedItems(draft, context.submit) &&
      !draft.confirmation?.pendingSummaryFields?.length &&
      !state.conflicts.length,
    fingerprint: "",
    basedOnRevision: context.revision,
  };
  state.review.fingerprint = clarificationFingerprint(draft, context.submit);
}
export async function runProvisionalReview(draft: IntakeDraft, context: ClarificationContext) {
  if (context.finish || context.submit)
    throw new ArenaError(
      "规划预览不能同时结束整理或正式交接。",
      400,
      "CLARIFICATION_PREVIEW_INTENT",
    );
  draft = structuredClone(draft);
  const state = structuredClone(draft.clarification ?? emptyClarification());
  draft.clarification = state;
  if (draft.attachments.some((attachment) => attachment.state !== "ready"))
    throw new ArenaError(
      "部分材料尚未完整读取，请先处理材料缺口后再预览。",
      409,
      "CLARIFICATION_MATERIALS_PENDING",
    );
  if (!hasCurrentAnalysis(draft))
    throw new ArenaError(
      "当前资料或已确认回答已改变，请先继续需求整理，再生成规划预览。",
      409,
      "CLARIFICATION_ANALYSIS_STALE",
    );
  if (!isCurrentClarificationReview(draft)) {
    state.review = null;
    state.specification = "";
    state.executionPrompt = "";
    const role = createRoleCaller(context, state, draft.round);
    const review = await role("C", HandoffReviewSchema, reviewInput(draft, state, context));
    applyReview(draft, state, context, review, state.conflicts);
  }
  state.draftOnly = true;
  const challenge =
    draft.challenge ??
    ChallengeSchema.parse({
      goal: draft.goal.length >= 8 ? draft.goal : `需求细化任务 — ${draft.goal}`,
    });
  formatClarification(
    draft,
    state,
    challenge,
    context.editedAssumptions !== undefined,
    context.rejectedAssumptions ?? [],
  );
  return {
    state,
    questions: structuredClone(draft.questions),
    challenge,
    assumptions: [...draft.assumptions],
    status: draft.questions.length ? ("questions" as const) : ("summary" as const),
  };
}

export async function runClarification(draft: IntakeDraft, context: ClarificationContext) {
  if (context.intent === "preview") return runProvisionalReview(draft, context);
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
  const reuseAnalysis = !!context.submit && hasCurrentAnalysis(draft, context.submit);
  const state = structuredClone(draft.clarification ?? emptyClarification());
  draft.clarification = state;
  const retainedAssumptions = context.submit?.assumptions ?? context.editedAssumptions;
  const rejectedAssumptions = [...new Set(context.rejectedAssumptions ?? [])];
  const priorReview = state.runs.findLast(
    (run) => run.role === "C" && run.status === "completed",
  )?.output;
  const priorGapIds = new Set(
    priorReview && "gaps" in priorReview ? priorReview.gaps.map((gap) => gap.id) : [],
  );
  const previousCReview = state.review;
  if (!reuseAnalysis) {
    state.review = null;
    delete state.analysisFingerprint;
  }
  const round = reuseAnalysis ? draft.round : draft.round + 1;
  const previousItems = structuredClone(state.items);
  const retirementBaseline = {
    items: previousItems,
    answers: state.rounds.at(-1)?.answers,
    revision: state.runs.findLast((run) => run.role === "A" && run.status === "completed")
      ?.basedOnRevision,
  };
  const previouslyRetired = new Set(state.retiredIds);
  const runStart = state.runs.length;
  const common = {
    originalGoal: draft.goal,
    answers: draft.answers,
    confirmedSummary: context.submit ?? draft.confirmation?.summary,
    editedSummary: draft.challenge,
    editedFields: context.editedFields,
    assumptions: retainedAssumptions ?? draft.assumptions,
    editedAssumptions: retainedAssumptions,
    rejectedSuggestions: rejectedAssumptions,
    pendingSummaryFields: [...pendingFields],
    sources: draft.sources,
    previousItems: activeItems(state),
    retiredItems: state.items.filter((item) => previouslyRetired.has(item.id)),
    caseContext: "用户材料是需求来源，产品内实际提交的answers才是本轮回答。执行反馈尚未发生。",
  };
  const role = createRoleCaller(context, state, round);
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
  const decomposition = reuseAnalysis ? null : await role("A", DecompositionSchema, common);
  if (decomposition) {
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
      const previous =
        previousItems.find((item) => item.id === retired.id) ??
        state.items.find((item) => item.id === retired.id)!;
      const protectedItem =
        explicitlyRequired(draft, previous, context.submit) ||
        (previous.required && previous.topic === "authorization");
      if (
        protectedItem &&
        !protectedRetirementHasSource(draft, previous, retired.answerIds, retirementBaseline)
      )
        throw new ArenaError(
          "受保护事项的排除缺少直接关联的确认依据；请确认该事项的拒绝或删除决定，或其已知前置范围的变更。",
          502,
          "CLARIFICATION_RETIREMENT",
        );
      state.retiredIds = [...new Set([...state.retiredIds, retired.id])];
    }
    // Suggestions are a current-round projection. Older A outputs remain immutable in runs.
    // User-retained/edited assumptions live separately in summaryEdits.assumptions / draft.assumptions.
    state.suggestions = [...new Set(decomposition.suggestions)]
      .filter((suggestion) => !rejectedAssumptions.includes(suggestion))
      .slice(0, 12);
  }
  function knownForQuestions(item: DecisionItem) {
    if (decisionAnswer(draft, item)?.needsReconfirmation) return false;
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
  let currentOptionConflicts: string[] | null = null;
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
    if (!questionableItems.length) return [];
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
    currentOptionConflicts = state.conflicts;
    return result.questions;
  }
  let questions: IntakeQuestion[] = reuseAnalysis
    ? draft.questions.filter((question) => {
        const item = state.items.find((entry) => entry.id === (question.decisionId ?? question.id));
        return !!item && !knownForQuestions(item) && !deferred(decisionAnswer(draft, item));
      })
    : await options();
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
  draft.challenge = challenge;
  draft.assumptions =
    retainedAssumptions !== undefined ? [...retainedAssumptions] : state.suggestions.slice(0, 6);
  state.analysisFingerprint = analysisFingerprint(draft, context.submit);
  draft.questions = questions;
  if (previousCReview?.fingerprint === clarificationFingerprint(draft, context.submit))
    state.review = previousCReview;
  if (
    context.submit ||
    context.finish ||
    !questions.length ||
    !hasBlockingUnconfirmedItems(draft, context.submit)
  ) {
    if (!isCurrentClarificationReview(draft, context.submit)) {
      const review = await role("C", HandoffReviewSchema, reviewInput(draft, state, context));
      applyReview(
        draft,
        state,
        context,
        review,
        currentOptionConflicts ?? (reuseAnalysis ? state.conflicts : []),
      );
      if (!questions.length && review.gaps.some((gap) => gap.required) && !context.finish)
        questions = await options();
    }
  }
  // A successful C review is only a preview. Formal status requires the explicit submit action.
  state.draftOnly = !context.submit || context.finish || !state.review?.ready;
  state.requestedDraft = context.finish;
  state.next =
    questions.length && !context.finish && !state.review?.ready ? "questions" : "summary";
  const changes = {
    added: state.items
      .filter((item) => !previousItems.some((old) => old.id === item.id))
      .map((item) => item.id),
    retired: decomposition?.retired.map((item) => item.id) ?? [],
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
  if (state.runs.slice(runStart).some((run) => run.role !== "C"))
    state.rounds.push({
      round,
      revision: context.revision,
      questions: questions.filter(
        (question): question is IntakeQuestion & { decisionId: string } =>
          typeof question.decisionId === "string",
      ),
      answers: structuredClone(draft.answers),
      changes,
      runIds: state.runs.slice(runStart).map((run) => run.id),
      createdAt: new Date().toISOString(),
    });
  if (state.review)
    state.review.fingerprint = clarificationFingerprint(
      { ...draft, challenge, clarification: state },
      context.submit,
    );
  draft.assumptions =
    retainedAssumptions !== undefined ? [...retainedAssumptions] : state.suggestions.slice(0, 6);
  formatClarification(
    draft,
    state,
    challenge,
    retainedAssumptions !== undefined,
    rejectedAssumptions,
  );
  return {
    state,
    questions: questions as IntakeQuestion[],
    challenge,
    assumptions:
      retainedAssumptions !== undefined ? [...retainedAssumptions] : state.suggestions.slice(0, 6),
    status: state.next === "questions" ? ("questions" as const) : ("summary" as const),
  };
}
