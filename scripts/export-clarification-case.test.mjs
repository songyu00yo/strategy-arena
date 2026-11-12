/** Synthetic SQLite exports only. These checks make no product or model request. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  caseMarkdown,
  exportOptions,
  readClarificationCase,
  redactCase,
  writeCaseExport,
} from "./export-clarification-case.mjs";

function fixture({ answers = true, calls = true, feedback = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "clarification-export-test-"));
  const database = join(directory, "synthetic.sqlite");
  const connection = new DatabaseSync(database);
  connection.exec(`CREATE TABLE intake_drafts(id TEXT PRIMARY KEY,owner TEXT,body TEXT,updated_at INTEGER,submitted_arena_id TEXT);
    CREATE TABLE intake_operations(id TEXT PRIMARY KEY,draft_id TEXT,revision INTEGER);
    CREATE TABLE intake_calls(id TEXT PRIMARY KEY,operation_id TEXT,kind TEXT,state TEXT,usage TEXT,error TEXT,created_at INTEGER);`);
  const draft = {
    id: "draft-private-id",
    owner: "private-owner-id",
    workflow: "clarification",
    revision: 2,
    status: "questions",
    goal: "给张三做PPT，联系13800138000或private@example.com",
    createdAt: "2026-11-12T01:00:00.000Z",
    updatedAt: "2026-11-12T01:01:00.000Z",
    config: { apiKey: "private-key-never-export" },
    answers: answers
      ? [
          {
            questionId: "style",
            question: { id: "style", title: "选择什么风格？" },
            state: "answered",
            value: "简洁正式",
            confirmation: "confirmed",
            confirmedRevision: 2,
          },
        ]
      : [],
    attachments: [],
    sources: [],
    clarification: {
      protocol: "clarification-1",
      items: [],
      retiredIds: [],
      rounds: [],
      runs: [
        {
          id: "run-private",
          operationId: "operation-private",
          repairOf: "call-private",
          role: "A",
          round: 1,
          basedOnRevision: 1,
          status: "completed",
          summary: "合成拆解",
          output: { summary: "合成拆解", items: [], retired: [], suggestions: [] },
          usage: [],
          createdAt: "2026-11-12T01:00:01.000Z",
        },
      ],
      suggestions: [],
      conflicts: [],
      review: null,
      next: "questions",
      draftOnly: true,
      specification: "尚有未决问题",
      executionPrompt: "只处理已确认需求",
      ...(feedback
        ? {
            feedback: [
              {
                kind: "executor_question",
                text: "执行方问是否提供logo",
                createdAt: "2026-11-12T02:00:00.000Z",
                source: "saved-user-feedback",
              },
            ],
          }
        : {}),
    },
  };
  connection
    .prepare("INSERT INTO intake_drafts VALUES(?,?,?,?,?)")
    .run(draft.id, "private-owner-id", JSON.stringify(draft), Date.now(), null);
  if (calls) {
    connection
      .prepare("INSERT INTO intake_operations VALUES(?,?,?)")
      .run("operation-private", draft.id, 1);
    connection.prepare("INSERT INTO intake_calls VALUES(?,?,?,?,?,?,?)").run(
      "call-private",
      "operation-private",
      "clarification_A",
      "completed",
      JSON.stringify({
        reservation: { amount: 0.1 },
        usage: {
          model: "synthetic-test-model",
          inputTokens: 12,
          outputTokens: 8,
          estimatedUsd: 0.001,
        },
      }),
      null,
      Date.now(),
    );
  }
  connection.close();
  return {
    directory,
    database,
    intakeId: draft.id,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("requires explicit valid case classification and selects only existing product records", () => {
  assert.throws(
    () => exportOptions(["--database", "x", "--intake", "y", "--out", "z"]),
    /case-type/,
  );
  assert.throws(
    () => exportOptions(["--database", "x", "--intake", "y", "--case-type", "real", "--out", "z"]),
    /案例类别/,
  );
  const record = fixture({ answers: false });
  try {
    assert.throws(
      () => readClarificationCase({ ...record, caseType: "real_task" }),
      /产品保存的本人回答/,
    );
    assert.equal(
      readClarificationCase({ ...record, caseType: "test_double" }).caseType,
      "test_double",
    );
  } finally {
    record.dispose();
  }
});

test("exports saved questions, answers and model roles without changing SQLite or leaking private fields", () => {
  const fixtureRecord = fixture();
  try {
    const before = readFileSync(fixtureRecord.database);
    const record = readClarificationCase({
      ...fixtureRecord,
      caseType: "test_double",
      redactTerms: ["张三"],
    });
    assert.deepEqual(readFileSync(fixtureRecord.database), before);
    assert.equal(record.caseTypeSource, "operator-declared");
    assert.equal(record.humanIdentityVerifiedByExporter, false);
    assert.equal(record.drafts[0].answers[0].value, "简洁正式");
    assert.equal(record.drafts[0].clarification.runs[0].role, "A");
    assert.equal(record.drafts[0].clarification.runs[0].repairOf, record.calls[0].id);
    assert.equal(record.calls[0].usage.inputTokens, 12);
    const text = JSON.stringify(record);
    for (const privateValue of [
      "private-owner-id",
      "private-key-never-export",
      "13800138000",
      "private@example.com",
      "张三",
      fixtureRecord.intakeId,
      "operation-private",
    ])
      assert.equal(text.includes(privateValue), false, privateValue);
    assert.match(record.drafts[0].originalGoal, /已脱敏/);
    assert.equal(record.executionFeedback.status, "not_recorded");
    assert.match(caseMarkdown(record), /尚无产品保存的执行反馈/);
    const output = writeCaseExport(record, join(fixtureRecord.directory, "export"));
    assert.equal(statSync(join(output, "case.json")).mode & 0o777, 0o600);
    assert.match(readFileSync(join(output, "case.md"), "utf8"), /测试替身/);
    assert.throws(() => writeCaseExport(record, output), /目录已存在/);
  } finally {
    fixtureRecord.dispose();
  }
});

test("keeps recorded feedback and requires usage for a declared simulated real-model case", () => {
  const withoutCalls = fixture({ calls: false });
  const withFeedback = fixture({ feedback: true });
  try {
    assert.throws(
      () => readClarificationCase({ ...withoutCalls, caseType: "simulated_real_model" }),
      /模型用量/,
    );
    const record = readClarificationCase({ ...withFeedback, caseType: "real_task" });
    assert.equal(record.executionFeedback.status, "recorded");
    assert.equal(record.executionFeedback.entries[0].text, "执行方问是否提供logo");
    assert.match(caseMarkdown(record), /执行方问是否提供logo/);
  } finally {
    withoutCalls.dispose();
    withFeedback.dispose();
  }
});

test("redacts common contact and credential patterns while preserving scope and uncertainty", () => {
  const result = redactCase(
    {
      id: "abc",
      text: "abc 尚未确认。邮箱person@example.com，手机号13800138000，证件110101199001010011，api_key=private-secret，Bearer abcdefghijklmnop",
    },
    [],
    ["abc"],
  );
  assert.match(result.id, /^record_/);
  assert.match(result.text, /^abc 尚未确认/);
  for (const privateValue of [
    "person@example.com",
    "13800138000",
    "110101199001010011",
    "private-secret",
    "abcdefghijklmnop",
  ])
    assert.equal(result.text.includes(privateValue), false, privateValue);
});
