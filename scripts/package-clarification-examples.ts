import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArenaSnapshot, ArenaVersion } from "../src/lib/contracts";
import type { IntakeDraft } from "../src/lib/intake-contracts";
import type { RecordedExample, RecordedExamplePayload } from "../src/lib/recorded-examples";
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
  return clarificationFingerprint({
    goal: intake.originalGoal,
    answers: intake.answers,
    sources: intake.usedSources,
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
  const alias = (text: string) =>
    text.replace(
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
      (id) => `recording-${digest(id).slice(0, 20)}`,
    );
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return alias(value);
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

export function packageExample(
  record: CompletedCaseRecord,
  definition: (typeof NEW_EXAMPLES)[number],
  sourceFile: string,
  sourceFileSha256: string,
  observedRedundantQuestions: { round: number; id: string }[] = [],
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
      recordingNotes.join(""),
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
  return { metadata, arena };
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
    return packageExample(
      JSON.parse(bytes.toString()) as CompletedCaseRecord,
      definition,
      relative(root, file),
      digest(bytes),
      observations,
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
