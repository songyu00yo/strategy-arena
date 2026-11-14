import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ChallengeSchema,
  type ArenaSnapshot,
  type ArenaVersion,
  type Challenge,
} from "../src/lib/contracts";
import {
  AnswerSchema,
  QuestionSchema,
  type IntakeAnswer,
  type IntakeDraft,
} from "../src/lib/intake-contracts";
import type { RecordedExample, RecordedExamplePayload } from "../src/lib/recorded-examples";
import type { ReplayAction, ReplayActionSource } from "../src/lib/replay-contracts";
import { clarificationFingerprint } from "../src/lib/server/clarification";

export const NEW_EXAMPLES = [
  {
    folder: "personal-site",
    slug: "personal-website",
    title: "个人网站，从模糊想法到确认需求",
    direction: "个人网站",
  },
  { folder: "ppt", slug: "presentation", title: "PPT，逐步明确内容与风格", direction: "PPT" },
  {
    folder: "document",
    slug: "user-guide",
    title: "说明文档，逐步明确结构与交付",
    direction: "说明文档",
  },
  {
    folder: "event-registration",
    slug: "event-registration",
    title: "活动报名页，逐步明确流程与范围",
    direction: "活动报名页",
  },
] as const;

interface CompletedCaseRecord {
  caseType: "simulated_real_model";
  simulationActor: "Codex";
  sourceCommit: string;
  sourceCommits?: string[];
  originalGoal: string;
  initialMaterials: string;
  snapshot: ArenaSnapshot;
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const recordingAlias = (text: string) =>
  text.replace(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
    (id) => `recording-${digest(id).slice(0, 20)}`,
  );
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function currentFingerprint(version: ArenaVersion) {
  const intake = version.intake!;
  const lastReview = version.clarification?.runs.findLast(
    (run) => run.role === "C" && run.status === "completed",
  );
  // Immutable real recordings from this exact protocol retain their original fingerprint algorithm.
  if (lastReview?.promptHash === "3faca167eff0ca1c60d76b74bd4dd99357afdab866cead782549fa9d7246610e")
    return digest(
      JSON.stringify({
        goal: intake.originalGoal,
        answers: intake.answers,
        sources: intake.usedSources,
        summary: version.challenge,
        pendingFields: intake.confirmation?.pendingSummaryFields ?? [],
      }),
    );
  return clarificationFingerprint({
    goal: intake.originalGoal,
    modelMode: version.modelSelection?.requestedMode,
    answers: intake.answers,
    sources: intake.usedSources,
    attachments: intake.attachments ?? [],
    clarification: version.clarification,
    challenge: version.challenge,
    confirmation: intake.confirmation,
  } as IntakeDraft);
}

function completedVersion(record: CompletedCaseRecord) {
  if (record.caseType !== "simulated_real_model" || record.simulationActor !== "Codex")
    throw new Error("公开示例必须明确声明真实模型模拟案例和模拟回答来源。");
  if (!/^[a-f0-9]{40}$/.test(record.sourceCommit)) throw new Error("缺少实际运行提交。");
  const version = record.snapshot.versions.find(
    (item) => item.id === record.snapshot.activeVersionId,
  );
  const state = version?.clarification;
  if (!version || version.workflow !== "clarification" || version.status !== "completed" || !state)
    throw new Error("案例尚未完成需求澄清，不能公开为完整案例。");
  if (
    state.next !== "completed" ||
    state.draftOnly ||
    !state.review?.ready ||
    state.review.gaps.length ||
    state.conflicts.length
  )
    throw new Error("案例存在未完成交接或审查缺口。");
  if (
    !version.intake?.confirmation?.summary ||
    version.intake.confirmation.pendingSummaryFields?.length
  )
    throw new Error("案例缺少最终明确确认。");
  for (const role of ["A", "B", "C"])
    if (
      !state.runs.some(
        (run) =>
          run.role === role &&
          run.status === "completed" &&
          run.callIds?.length &&
          run.usage.length &&
          run.usage.every(
            (usage) => usage.responseId && usage.inputTokens + usage.outputTokens > 0,
          ),
      )
    )
      throw new Error(`案例缺少 ${role} 的实际调用与用量记录。`);
  if (
    version.intake.originalGoal !== record.originalGoal ||
    currentFingerprint(version) !== state.review.fingerprint
  )
    throw new Error("案例来源、最终要求与当前审查版本不一致。");
  if (
    !state.specification.trim() ||
    !state.executionPrompt.trim() ||
    version.requirements?.executionPrompt !== state.executionPrompt
  )
    throw new Error("案例缺少一致的最终需求与执行提示词。");
  if (
    !state.rounds.some((round) => round.questions.length) ||
    !version.intake.answers.some((answer) => answer.confirmation === "confirmed")
  )
    throw new Error("案例缺少实际问题或模拟回答。");
  return version;
}

/** Keep goal, decisions, answers and role outputs verbatim. Only transport/configuration IDs change. */
function publicSnapshot(snapshot: ArenaSnapshot): ArenaSnapshot {
  const privateFields = new Set([
    "owner",
    "ownerId",
    "sessionId",
    "billingAttemptId",
    "runConfiguration",
    "configurationHash",
    "apiKey",
    "baseUrl",
  ]);
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return recordingAlias(value);
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !privateFields.has(key))
        .map(([key, item]) => [key, key === "responseId" ? "[redacted]" : visit(item)]),
    );
  };
  const result = visit(snapshot) as ArenaSnapshot;
  result.model = {
    id: snapshot.model.id,
    configured: false,
    promptVersion: snapshot.model.promptVersion,
    schemaVersion: snapshot.model.schemaVersion,
  };
  return result;
}

const recordedAnswerSchema = AnswerSchema.extend({
  question: QuestionSchema,
  confirmation: z.enum(["confirmed", "pending"]).optional(),
  confirmedRevision: z.number().int().nonnegative().optional(),
  confirmedAt: z.string().optional(),
  needsReconfirmation: z.boolean().optional(),
});

/** Whitelist replay evidence separately from the unchanged recorded Arena. */
function publicReplayAction(action: ReplayAction): ReplayAction {
  const source = action.source;
  const safe: ReplayAction = {
    id: action.id,
    kind: action.kind,
    round: action.round,
    revision: action.revision,
    ...(action.versionId === undefined ? {} : { versionId: action.versionId }),
    ...(action.sourceRunId === undefined ? {} : { sourceRunId: action.sourceRunId }),
    ...(action.questions === undefined
      ? {}
      : { questions: action.questions.map((question) => QuestionSchema.parse(question)) }),
    ...(action.answers === undefined
      ? {}
      : { answers: action.answers.map((answer) => recordedAnswerSchema.parse(answer)) }),
    ...(action.summary === undefined
      ? {}
      : {
          summary: {
            challenge: ChallengeSchema.parse(action.summary.challenge),
            assumptions: z.array(z.string().max(500)).max(6).parse(action.summary.assumptions),
          },
        }),
    ...(action.createdAt === undefined ? {} : { createdAt: action.createdAt }),
    ...(source === undefined
      ? {}
      : {
          source: {
            kind: source.kind,
            reference: source.reference,
            ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
            ...(source.requestIndex === undefined ? {} : { requestIndex: source.requestIndex }),
            ...(source.method === undefined ? {} : { method: source.method }),
            ...(source.path === undefined ? {} : { path: source.path }),
          },
        }),
  };
  return JSON.parse(recordingAlias(JSON.stringify(safe))) as ReplayAction;
}

interface TraceRequest {
  index: number;
  method: string;
  path: string;
  input: {
    revision?: number;
    answers?: IntakeAnswer[];
    answerMode?: "draft" | "complete";
    challenge?: Challenge;
    assumptions?: string[];
  } | null;
  intentAt: string;
  finishedAt?: string;
  responseFile?: string;
  responseSha256?: string;
  httpStatus?: number;
}

type TraceResponse = Partial<IntakeDraft> & Partial<ArenaSnapshot>;

function responseVersion(response: TraceResponse) {
  return response.versions?.find((version) => version.id === response.activeVersionId);
}

function snapshotReplayActions(
  version: ArenaVersion,
  sourceFile: string,
  sourceFileSha256: string,
): ReplayAction[] {
  const state = version.clarification!;
  const source: ReplayActionSource = {
    kind: "snapshot",
    reference: sourceFile,
    sha256: sourceFileSha256,
  };
  const actions: ReplayAction[] = state.rounds
    .filter((round) => round.questions.length)
    .map((round) => ({
      id: `replay-snapshot-questions-${round.round}`,
      kind: "questions",
      round: round.round,
      revision: round.revision,
      versionId: version.id,
      sourceRunId: state.runs.findLast((run) => round.runIds.includes(run.id) && run.role === "B")
        ?.id,
      questions: round.questions,
      createdAt: round.createdAt,
      source,
    }));
  const finalRun = state.runs.findLast((run) => run.role === "C" && run.status === "completed");
  const summary = version.intake?.confirmation?.summary;
  if (summary)
    actions.push({
      id: "replay-snapshot-summary-confirm",
      kind: "summary_confirm",
      round: finalRun?.round ?? state.rounds.at(-1)!.round,
      revision: summary.revision,
      versionId: version.id,
      sourceRunId: finalRun?.id,
      answers: version.intake!.answers,
      createdAt: summary.confirmedAt,
      source,
    });
  if (summary && state.next === "completed")
    actions.push({
      id: "replay-snapshot-handoff",
      kind: "handoff",
      round: finalRun?.round ?? state.rounds.at(-1)!.round,
      revision: summary.revision,
      versionId: version.id,
      sourceRunId: finalRun?.id,
      createdAt: version.createdAt,
      source,
    });
  return actions;
}

/** Recover saved request order and accepted states, without inventing pointer or timing data. */
export function replayActionsFromRecords(
  record: CompletedCaseRecord,
  directory: string,
  sourceFile: string,
  sourceFileSha256: string,
): ReplayAction[] {
  const version = completedVersion(record);
  const fallback = () => snapshotReplayActions(version, sourceFile, sourceFileSha256);
  const manifestFile = join(directory, "manifest.json");
  if (!existsSync(manifestFile)) return fallback();
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
    intakeId: string;
    requests: TraceRequest[];
  };
  if (manifest.intakeId !== version.intake?.id) throw new Error("操作清单与完成草稿不一致。");
  const intakePath = `/api/intakes/${manifest.intakeId}`;
  const relevant = manifest.requests.filter(
    (request) => request.path === "/api/intakes" || request.path.startsWith(intakePath),
  );
  const trace = relevant.map((request) => {
    const prefix = String(request.index).padStart(3, "0");
    const requestFile = `raw/${prefix}-request.json`;
    const responseFile = `raw/${prefix}-response.json`;
    if (
      request.responseFile !== responseFile ||
      !existsSync(join(directory, requestFile)) ||
      !existsSync(join(directory, responseFile))
    )
      return null;
    const requestBytes = readFileSync(join(directory, requestFile));
    const responseBytes = readFileSync(join(directory, responseFile));
    const rawRequest = JSON.parse(requestBytes.toString()) as TraceRequest;
    const response = JSON.parse(responseBytes.toString()) as TraceResponse;
    for (const key of ["index", "method", "path", "input", "intentAt"] as const)
      if (canonical(rawRequest[key]) !== canonical(request[key]))
        throw new Error("操作请求与来源清单不一致。");
    if (request.responseSha256 !== digest(JSON.stringify(response)))
      throw new Error("操作响应与来源摘要不一致。");
    return { request, response, requestFile, responseFile, requestBytes, responseBytes };
  });
  if (!trace.length || trace.some((entry) => entry === null)) return fallback();
  const actions: ReplayAction[] = [];
  let priorDraft: TraceResponse | undefined;
  let knownRuns = new Set<string>();
  let priorIndex = 0;
  let completedHandoff = false;
  const sourceDirectory = dirname(sourceFile).replaceAll("\\", "/");
  for (const entry of trace) {
    if (!entry) continue;
    const { request, response, requestFile, responseFile, requestBytes, responseBytes } = entry;
    if (request.index <= priorIndex) throw new Error("操作请求序号必须保留原始顺序。");
    priorIndex = request.index;
    const resultVersion = responseVersion(response);
    const state = resultVersion?.clarification ?? response.clarification;
    const runs = state?.runs ?? [];
    const newRuns = runs.filter((run) => !knownRuns.has(run.id));
    const round =
      newRuns[0]?.round ?? response.round ?? state?.rounds.at(-1)?.round ?? priorDraft?.round ?? 0;
    const revision = request.input?.revision;
    const requestSource: ReplayActionSource = {
      kind: "api_request",
      reference: `${sourceDirectory}/${requestFile}`,
      sha256: digest(requestBytes),
      requestIndex: request.index,
      method: request.method,
      path: request.path,
    };
    const responseSource: ReplayActionSource = {
      ...requestSource,
      kind: "snapshot",
      reference: `${sourceDirectory}/${responseFile}`,
      sha256: digest(responseBytes),
    };
    const add = (action: Omit<ReplayAction, "id" | "versionId">) =>
      actions.push({
        id: `replay-${request.index}-${action.kind}-${actions.length}`,
        versionId: version.id,
        ...action,
      });
    const isSubmit = request.method === "POST" && request.path === `${intakePath}/submit`;
    const isAnswers = request.method === "PATCH" && request.path === intakePath;
    const succeeded =
      request.httpStatus !== undefined && request.httpStatus >= 200 && request.httpStatus < 300;
    if ((isSubmit || isAnswers) && !Number.isInteger(revision))
      throw new Error("操作来源缺少请求版本。");
    if (isSubmit && (!request.input?.challenge || !Array.isArray(request.input.assumptions)))
      return fallback();
    if (isSubmit)
      add({
        kind: "summary_submit",
        round,
        revision: revision!,
        sourceRunId: newRuns.find((run) => run.role === "A")?.id,
        summary: {
          challenge: request.input!.challenge!,
          assumptions: request.input!.assumptions!,
        },
        createdAt: request.intentAt,
        source: requestSource,
      });
    if (isAnswers && succeeded && request.input?.answers) {
      const questions = priorDraft?.questions;
      if (!questions?.length || priorDraft?.round === undefined || !response.answers)
        throw new Error("回答来源缺少对应的完整补问题组。");
      const accepted = request.input.answers.map((input) => {
        const answer = response.answers!.find((item) => item.questionId === input.questionId);
        if (
          !answer ||
          !questions.some((question) => question.id === input.questionId) ||
          canonical(AnswerSchema.parse(answer)) !== canonical(AnswerSchema.parse(input))
        )
          throw new Error("回答请求与已保存的回答不一致。");
        return answer;
      });
      const answeredRound = priorDraft.round;
      const anchor = priorDraft.clarification?.runs.findLast(
        (run) => run.round === answeredRound && run.role === "B",
      )?.id;
      for (const answer of accepted)
        add({
          kind: "answer",
          round: answeredRound,
          revision: revision!,
          sourceRunId: anchor,
          questions,
          answers: [answer],
          createdAt: request.intentAt,
          source: requestSource,
        });
      if (request.input.answerMode === "complete") {
        if (accepted.length !== questions.length) throw new Error("本轮确认缺少完整的已保存回答。");
        add({
          kind: "round_confirm",
          round: answeredRound,
          revision: revision!,
          sourceRunId: anchor,
          questions,
          answers: accepted,
          createdAt: request.intentAt,
          source: requestSource,
        });
      }
    }
    if (
      request.method === "POST" &&
      succeeded &&
      (request.path === `${intakePath}/analyze` || isSubmit) &&
      response.status === "questions" &&
      response.questions?.length
    )
      add({
        kind: "questions",
        round: response.round!,
        revision: response.revision!,
        sourceRunId: runs.findLast((run) => run.round === response.round && run.role === "B")?.id,
        questions: response.questions,
        createdAt: response.updatedAt,
        source: responseSource,
      });
    if (
      isSubmit &&
      succeeded &&
      !completedHandoff &&
      newRuns.some((run) => run.role === "C" && run.status === "completed") &&
      resultVersion?.status === "completed" &&
      resultVersion.clarification?.next === "completed" &&
      resultVersion.clarification.review?.ready &&
      resultVersion.intake?.confirmation?.summary
    ) {
      if (
        response.id !== record.snapshot.id ||
        resultVersion.id !== version.id ||
        canonical(resultVersion) !== canonical(version)
      )
        throw new Error("最终提交响应与完成案例不一致。");
      const summary = resultVersion.intake.confirmation.summary;
      const anchor = newRuns.findLast((run) => run.role === "C")?.id;
      add({
        kind: "summary_confirm",
        round,
        revision: summary.revision,
        sourceRunId: anchor,
        summary: {
          challenge: summary.challenge,
          assumptions: request.input!.assumptions!,
        },
        createdAt: summary.confirmedAt,
        source: responseSource,
      });
      add({
        kind: "handoff",
        round,
        revision: summary.revision,
        sourceRunId: anchor,
        createdAt: resultVersion.createdAt,
        source: responseSource,
      });
      completedHandoff = true;
    }
    if (response.round !== undefined && response.answers) priorDraft = response;
    if (state) knownRuns = new Set(runs.map((run) => run.id));
  }
  return completedHandoff ? actions : fallback();
}

export function packageExample(
  record: CompletedCaseRecord,
  definition: (typeof NEW_EXAMPLES)[number],
  sourceFile: string,
  sourceFileSha256: string,
  observedRedundantQuestions: { round: number; id: string }[] = [],
  replayActions?: ReplayAction[],
): RecordedExamplePayload {
  const original = completedVersion(record);
  for (const observation of observedRedundantQuestions)
    if (
      !original.clarification!.rounds.some(
        (round) =>
          round.round === observation.round &&
          round.questions.some((question) => question.id === observation.id),
      )
    )
      throw new Error("冗余问题说明未关联到实际记录。");
  const recordingNotes = observedRedundantQuestions.map(
    ({ round }) => `本记录保留第${round}轮的一次冗余确认，完整过程未删减。`,
  );
  const arena = publicSnapshot(record.snapshot);
  const version = arena.versions.find((item) => item.id === arena.activeVersionId)!;
  if (currentFingerprint(version) !== original.clarification!.review!.fingerprint)
    throw new Error("脱敏改变了确认内容，需要人工核对后单独处理。");
  const usage = original.intake!.usage;
  const metadata: RecordedExample = {
    workflow: "clarification",
    caseType: "simulated_real_model",
    simulationActor: "Codex",
    initialMaterials: record.initialMaterials,
    slug: definition.slug,
    title: definition.title,
    direction: definition.direction,
    question: record.originalGoal,
    summary: original.clarification!.review!.summary,
    modelId: original.modelSelection?.modelId ?? arena.model.id,
    generatedAt: original.createdAt,
    sourceCommit: record.sourceCommit,
    sourceCommits: record.sourceCommits ?? [record.sourceCommit],
    qualityNote:
      "需求与回答由 Codex 技术模拟，问题和审查来自真实模型。已保存最终需求与执行提示词，尚无执行反馈。" +
      recordingNotes.join("") +
      (replayActions
        ? replayActions.some((action) => action.source?.kind === "api_request")
          ? "操作回放依据保存的API请求与快照重建，播放节奏为示意。"
          : "操作回看采用已有快照，操作意图缺少完整记录。"
        : ""),
    versionCount: arena.versions.length,
    sourceFile,
    sourceFileSha256,
    sourceCapturedAt: original.createdAt,
    sourceVersionIds: arena.versions.map((item) => item.id),
    sourceVersionPointer: `/snapshot/versions/${record.snapshot.versions.indexOf(original)}`,
    sourceVersionContentSha256: digest(canonical(version)),
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    recordedCostUsd:
      (original.costUsd ?? 0) + usage.reduce((sum, item) => sum + (item.estimatedUsd ?? 0), 0),
    recordedCostCny: original.costCny + usage.reduce((sum, item) => sum + item.estimatedCny, 0),
    redactions: [
      "owner/session/configuration fields omitted",
      "transport identifiers replaced with recording-local aliases",
      "provider response identifiers replaced with [redacted]",
      "model configuration marked unavailable in read-only replay",
      "goal, questions, answers and model output text retained verbatim",
    ],
  };
  return {
    metadata,
    arena,
    ...(replayActions === undefined
      ? {}
      : { replayActions: replayActions.map(publicReplayAction) }),
  };
}

function replaceFile(path: string, contents: string) {
  writeFileSync(`${path}.tmp`, contents);
  renameSync(`${path}.tmp`, path);
}

export function publishExamples(recordsDirectory: string, root: string) {
  const payloads = NEW_EXAMPLES.map((definition) => {
    const file = join(recordsDirectory, definition.folder, "completed-record.json");
    const bytes = readFileSync(file);
    const contextFile = join(recordsDirectory, definition.folder, "trial-context.json");
    const observations = existsSync(contextFile)
      ? (JSON.parse(readFileSync(contextFile, "utf8")).observedRedundantQuestions ?? [])
      : [];
    const record = JSON.parse(bytes.toString()) as CompletedCaseRecord;
    const sourceFile = relative(root, file);
    const sourceFileSha256 = digest(bytes);
    return packageExample(
      record,
      definition,
      sourceFile,
      sourceFileSha256,
      observations,
      replayActionsFromRecords(record, dirname(file), sourceFile, sourceFileSha256),
    );
  });
  for (const payload of payloads)
    replaceFile(
      join(root, "public/recorded-examples", `${payload.metadata.slug}.json`),
      JSON.stringify(payload, null, 2) + "\n",
    );
  const metadataFile = join(root, "src/lib/recorded-examples.ts");
  const prefix = readFileSync(metadataFile, "utf8").split("// Metadata only:")[0];
  replaceFile(
    metadataFile,
    `${prefix}// Metadata only: completed real-model clarification simulations.\nexport const RECORDED_EXAMPLES: RecordedExample[] = ${JSON.stringify(
      payloads.map((payload) => payload.metadata),
      null,
      2,
    )};\n`,
  );
  for (const slug of ["learning", "career", "creation", "course-site"]) {
    const file = join(root, "public/recorded-examples", `${slug}.json`);
    if (existsSync(file)) unlinkSync(file);
  }
  return payloads;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error(
      "用法：pnpm exec tsx scripts/package-clarification-examples.ts RECORDS_DIRECTORY",
    );
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const payloads = publishExamples(resolve(process.argv[2]), root);
  process.stdout.write(
    JSON.stringify(
      payloads.map(({ metadata }) => ({
        slug: metadata.slug,
        sourceCommit: metadata.sourceCommit,
        recordedCostUsd: metadata.recordedCostUsd,
      })),
      null,
      2,
    ) + "\n",
  );
}
