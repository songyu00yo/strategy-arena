/** Export existing product records through a read-only SQLite connection. No model requests. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const CASE_TYPES = ["real_task", "simulated_real_model", "test_double"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const list = (value) => (Array.isArray(value) ? value : []);

export function exportOptions(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !["--database", "--intake", "--case-type", "--out", "--redact-file"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options[key]
    )
      throw new Error("参数无效，请运行 --help 查看用法。");
    options[key] = value;
  }
  for (const key of ["--database", "--intake", "--case-type", "--out"])
    if (!options[key]) throw new Error(`缺少参数 ${key}。`);
  if (!CASE_TYPES.includes(options["--case-type"]))
    throw new Error("案例类别必须是 real_task、simulated_real_model 或 test_double。");
  return options;
}

/** Extra exact terms let the operator remove names and private project vocabulary. */
export function redactCase(value, terms = [], identifiers = []) {
  const aliases = new Map(
    [...new Set(identifiers)]
      .filter(Boolean)
      .map((identifier) => [identifier, `record_${hash(identifier).slice(0, 16)}`]),
  );
  const clean = (text) => {
    for (const term of [...terms].filter(Boolean).sort((a, b) => b.length - a.length))
      text = text.replaceAll(term, "[已脱敏]");
    return text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
      .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[手机号已脱敏]")
      .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "[证件号已脱敏]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]{12,})/g, "[凭据已脱敏]")
      .replace(/\b(?:api[_-]?key|secret|password|token)\s*[=:：]\s*[^\s,，;；]+/gi, "[凭据已脱敏]");
  };
  const visit = (item) =>
    typeof item === "string"
      ? clean(aliases.get(item) ?? item)
      : Array.isArray(item)
        ? item.map(visit)
        : item && typeof item === "object"
          ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]))
          : item;
  return visit(value);
}

function usageRecord(value) {
  if (!value || typeof value !== "object") return null;
  const usage = value.usage ?? value;
  return Object.fromEntries(
    [
      "model",
      "provider",
      "currency",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "estimatedCny",
      "estimatedUsd",
      "durationMs",
    ]
      .filter((key) => usage[key] !== undefined)
      .map((key) => [key, usage[key]]),
  );
}
function draftRecord(draft) {
  const state = draft.clarification;
  return {
    id: draft.id,
    workflow: draft.workflow ?? "legacy",
    revision: draft.revision,
    status: draft.status,
    originalGoal: draft.goal,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    answers: list(draft.answers).map(
      ({
        questionId,
        question,
        state,
        value,
        confirmation,
        confirmedRevision,
        confirmedAt,
        needsReconfirmation,
      }) => ({
        questionId,
        question,
        state,
        value,
        confirmation,
        confirmedRevision,
        confirmedAt,
        needsReconfirmation,
      }),
    ),
    confirmation: draft.confirmation ?? null,
    attachments: list(draft.attachments).map(
      ({ id, name, state, sourceAttachmentId, warnings, error }) => ({
        id,
        name: basename(name),
        state,
        sourceAttachmentId,
        warnings,
        error,
      }),
    ),
    sources: list(draft.sources).map(
      ({ id, attachmentId, filename, location, origin, interpretation }) => ({
        id,
        attachmentId,
        filename: basename(filename),
        location,
        origin,
        interpretation,
      }),
    ),
    clarification: state
      ? {
          protocol: state.protocol,
          items: state.items,
          retiredIds: state.retiredIds,
          rounds: state.rounds,
          runs: list(state.runs).map(
            ({
              id,
              operationId,
              repairOf,
              callIds,
              role,
              round,
              basedOnRevision,
              status,
              summary,
              output,
              usage,
              createdAt,
            }) => ({
              id,
              operationId,
              repairOf,
              callIds,
              role,
              round,
              basedOnRevision,
              status,
              summary,
              output,
              usage: list(usage).map(usageRecord),
              createdAt,
            }),
          ),
          suggestions: state.suggestions,
          conflicts: state.conflicts,
          review: state.review,
          next: state.next,
          draftOnly: state.draftOnly,
          requestedDraft: state.requestedDraft,
          specification: state.specification,
          executionPrompt: state.executionPrompt,
        }
      : null,
  };
}

export function readClarificationCase({ database, intakeId, caseType, redactTerms = [] }) {
  if (!CASE_TYPES.includes(caseType)) throw new Error("案例类别无效。");
  const path = resolve(database);
  if (!existsSync(path)) throw new Error("产品数据库不存在。");
  const connection = new DatabaseSync(path, { readOnly: true });
  try {
    connection.exec("PRAGMA query_only=ON; BEGIN;");
    const selected = connection
      .prepare("SELECT id,owner,body FROM intake_drafts WHERE id=?")
      .get(intakeId);
    if (!selected) throw new Error("找不到指定的产品草稿。");
    const draft = JSON.parse(selected.body);
    if (draft.workflow !== "clarification" || !draft.clarification)
      throw new Error("指定记录尚无需求澄清流程数据。");
    const arenaId = draft.arenaId ?? draft.link?.arenaId;
    let related = [selected];
    let versions = [];
    if (arenaId) {
      const arena = connection.prepare("SELECT owner FROM arenas WHERE id=?").get(arenaId);
      if (!arena || arena.owner !== selected.owner) throw new Error("关联任务的记录归属不一致。");
      related = connection
        .prepare(
          "SELECT id,owner,body FROM intake_drafts WHERE owner=? AND (id=? OR submitted_arena_id=? OR json_extract(body,'$.link.arenaId')=?) ORDER BY updated_at,id",
        )
        .all(selected.owner, intakeId, arenaId, arenaId);
      versions = connection
        .prepare("SELECT id,body FROM versions WHERE arena_id=? ORDER BY number")
        .all(arenaId)
        .map((row) => {
          const version = JSON.parse(row.body);
          return {
            id: version.id,
            number: version.number,
            parentVersionId: version.parentVersionId,
            createdAt: version.createdAt,
            changeReason: version.changeReason,
            status: version.status,
            requirements: version.requirements ?? null,
          };
        });
    }
    const drafts = related.map((row) => JSON.parse(row.body));
    if (caseType === "real_task" && !drafts.some((item) => list(item.answers).length))
      throw new Error("真实任务需要已有产品保存的本人回答。请先在产品中回答问题。");
    const placeholders = related.map(() => "?").join(",");
    const calls = connection
      .prepare(
        `SELECT c.id,c.operation_id,c.kind,c.state,c.usage,c.error,c.created_at,o.draft_id,o.revision FROM intake_calls c JOIN intake_operations o ON o.id=c.operation_id WHERE o.draft_id IN (${placeholders}) ORDER BY c.created_at,c.rowid`,
      )
      .all(...related.map((row) => row.id))
      .map((row) => ({
        id: row.id,
        operationId: row.operation_id,
        draftId: row.draft_id,
        kind: row.kind,
        state: row.state,
        basedOnRevision: row.revision,
        usage: row.usage ? usageRecord(JSON.parse(row.usage)) : null,
        reservation: row.usage ? (JSON.parse(row.usage).reservation ?? null) : null,
        error: row.error,
        createdAt: row.created_at,
      }));
    const hasModelUsage = calls.some((call) => call.usage?.model);
    if (caseType === "simulated_real_model" && !hasModelUsage)
      throw new Error("模拟场景真实模型案例需要已保存的模型用量记录。");
    const feedback = drafts.flatMap((item) =>
      list(item.clarification?.feedback).map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        createdAt: entry.createdAt,
        source: entry.source,
      })),
    );
    const record = {
      schemaVersion: 1,
      kind: "clarification-case-export",
      caseType,
      caseTypeSource: "operator-declared",
      exportedAt: new Date().toISOString(),
      selectedIntakeId: intakeId,
      answerSource: "saved-product-records",
      humanIdentityVerifiedByExporter: false,
      hasRecordedModelUsage: hasModelUsage,
      drafts: drafts.map(draftRecord),
      versions,
      calls,
      executionFeedback: {
        status: feedback.length ? "recorded" : "not_recorded",
        entries: feedback,
      },
      limitations: [
        "类别由导出者声明，导出工具核对产品存档及调用记录。",
        "仅保留已有回答与反馈，未写入新的用户答案或验收结论。",
        "自动脱敏覆盖常见联系方式和凭据，私有人名与项目术语可通过脱敏词表补充。",
      ],
    };
    const identifiers = [
      arenaId,
      ...related.map((row) => row.id),
      ...versions.flatMap((row) => [row.id, row.parentVersionId]),
      ...calls.flatMap((row) => [row.id, row.operationId]),
      ...drafts.flatMap((item) =>
        list(item.attachments).flatMap((attachment) => [
          attachment.id,
          attachment.sourceAttachmentId,
        ]),
      ),
    ];
    connection.exec("COMMIT;");
    return redactCase(record, redactTerms, identifiers);
  } finally {
    connection.close();
  }
}

export function caseMarkdown(record) {
  const categories = {
    real_task: "真实任务",
    simulated_real_model: "模拟场景与真实模型",
    test_double: "测试替身",
  };
  const lines = [
    "# 需求澄清案例记录",
    "",
    `案例类别为 ${categories[record.caseType]}（${record.caseType}），由导出者声明。`,
    "",
    "回答与反馈来自产品存档。导出工具只整理记录。",
    "",
  ];
  for (const draft of record.drafts) {
    lines.push(
      `## 草稿 ${draft.id}`,
      "",
      `状态为 ${draft.status}，修订号为 ${draft.revision}。`,
      "",
      "### 原始目标",
      "",
      draft.originalGoal,
      "",
      "### 问题与回答",
      "",
    );
    for (const answer of draft.answers)
      lines.push(
        `- ${answer.question.title}`,
        `  - 回答状态为 ${answer.state}，确认状态为 ${answer.confirmation ?? "未记录"}。`,
        `  - 保存内容为 ${Array.isArray(answer.value) ? answer.value.join("、") : answer.value || "未填写"}。`,
      );
    if (!draft.answers.length) lines.push("尚无产品保存的回答。");
    lines.push("", "### 角色调用与轮次", "");
    for (const run of draft.clarification?.runs ?? [])
      lines.push(
        `- 第 ${run.round} 轮，角色 ${run.role}，依据修订号 ${run.basedOnRevision}，状态为 ${run.status}。${run.summary}`,
      );
    if (!draft.clarification?.runs?.length) lines.push("尚无角色调用记录。");
    lines.push(
      "",
      "### 确认后的需求",
      "",
      draft.clarification?.specification || "尚未生成。",
      "",
      "### 执行提示词",
      "",
      draft.clarification?.executionPrompt || "尚未生成。",
      "",
      "### 未决与审查",
      "",
      ...(draft.clarification?.conflicts ?? []).map((entry) => `- ${entry}`),
    );
    for (const gap of draft.clarification?.review?.gaps ?? [])
      lines.push(`- ${gap.title}。${gap.description}`);
    if (!draft.clarification?.conflicts?.length && !draft.clarification?.review?.gaps?.length)
      lines.push("存档未列出审查缺口。");
    lines.push("");
  }
  lines.push("## 执行反馈", "");
  if (!record.executionFeedback.entries.length) lines.push("尚无产品保存的执行反馈。");
  for (const entry of record.executionFeedback.entries)
    lines.push(`- ${entry.createdAt}，${entry.kind}，来源为 ${entry.source}。${entry.text}`);
  lines.push("", "## 记录边界", "", ...record.limitations.map((entry) => `- ${entry}`), "");
  return lines.join("\n");
}

export function writeCaseExport(record, output) {
  const directory = resolve(output);
  if (existsSync(directory)) throw new Error("导出目录已存在，请选择新目录以保留原记录。");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "case.json"), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(join(directory, "case.md"), caseMarkdown(record), { mode: 0o600, flag: "wx" });
  return directory;
}

export function exportMain(args = process.argv.slice(2)) {
  const options = exportOptions(args);
  if (options.help) {
    console.log(
      "node scripts/export-clarification-case.mjs --database /absolute/product.sqlite --intake DRAFT_ID --case-type real_task|simulated_real_model|test_double --out /absolute/new-export-directory [--redact-file /absolute/terms.json]\n脱敏词表为 JSON 字符串数组。只读取产品库，不加载环境文件、不调用模型。反馈仅采用产品存档，未记录时显示尚无。",
    );
    return;
  }
  const terms = options["--redact-file"]
    ? JSON.parse(readFileSync(options["--redact-file"], "utf8"))
    : [];
  if (!Array.isArray(terms) || terms.some((term) => typeof term !== "string" || !term.trim()))
    throw new Error("脱敏词表必须是非空字符串组成的 JSON 数组。");
  const record = readClarificationCase({
    database: options["--database"],
    intakeId: options["--intake"],
    caseType: options["--case-type"],
    redactTerms: terms,
  });
  const directory = writeCaseExport(record, options["--out"]);
  console.log(
    JSON.stringify({ directory, caseType: record.caseType, productWrites: 0, modelRequests: 0 }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    exportMain();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "导出失败。");
    process.exitCode = 1;
  }
}
