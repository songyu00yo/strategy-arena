/** Real isolated SQLite and explicit model test doubles. No provider or public-search request. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DecisionItemSchema,
  HandoffReviewSchema,
  type DecisionItem,
  type HandoffReview,
} from "../src/lib/clarification-contracts";
import { toStrictToolSchema } from "../src/lib/server/strict-schema";
import type { IntakeDraft, IntakeQuestion, RecordedAnswer } from "../src/lib/intake-contracts";
import { closeDb, db } from "../src/lib/server/db";
import { createArena, newVersion, refreshRequirements } from "../src/lib/server/runtime";
import {
  emptyClarification,
  clarificationFingerprint,
  clarificationProtocolHash,
  clarificationReviewConfig,
  formatClarification,
  runClarification,
} from "../src/lib/server/clarification";
import { ChallengeSchema } from "../src/lib/contracts";

const fixture = vi.hoisted(() => ({ generate: vi.fn(), estimate: vi.fn(), gap: false }));
vi.mock("../src/lib/server/model", async (original) => {
  const actual = await original<typeof import("../src/lib/server/model")>();
  fixture.estimate.mockImplementation(actual.estimateStructuredCall);
  return {
    ...actual,
    generateStructured: fixture.generate,
    estimateStructuredCall: fixture.estimate,
  };
});
import { ModelCallError, resolveModelConfig } from "../src/lib/server/model";
import {
  analyzeIntake,
  createIntake,
  getIntake,
  submitClarificationIntake,
  updateIntake,
  addIntakeAttachment,
  removeIntakeAttachment,
} from "../src/lib/server/intakes";

const owner = "explicit-clarification-test-owner";
const goal = "做一个活动报名成果，先逐项问清楚我的实际用途";
function item(
  id: string,
  topic: DecisionItem["topic"],
  title: string,
  dependsOn: string[] = [],
): DecisionItem {
  return {
    id,
    topic,
    title,
    description: `测试待定事项：${title}`,
    dependsOn,
    required: true,
    acceptance: [`${title}符合本人确认`],
    sourceRefs: [],
  };
}
function question(
  decision: DecisionItem,
  options: string[] = [],
): IntakeQuestion & { decisionId: string } {
  return {
    id: decision.id,
    decisionId: decision.id,
    title: decision.title,
    reason: "会改变成果要求",
    placeholder: "按实际情况回答",
    type: options.length ? "single" : "text",
    options,
    unit: "",
    dependsOn: decision.dependsOn,
    affects:
      decision.topic === "style"
        ? ["preferences"]
        : decision.topic === "scope"
          ? ["constraints", "options"]
          : ["constraints"],
  };
}
function answersFrom(
  input: unknown,
): Map<
  string,
  { value: string; state: string; confirmation?: string; needsReconfirmation?: boolean }
> {
  const answers = new Map<
    string,
    { value: string; state: string; confirmation?: string; needsReconfirmation?: boolean }
  >();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.questionId === "string" && typeof record.state === "string") {
      answers.set(record.questionId, {
        value: Array.isArray(record.value) ? record.value.join("、") : String(record.value ?? ""),
        state: record.state,
        confirmation: typeof record.confirmation === "string" ? record.confirmation : undefined,
        needsReconfirmation: record.needsReconfirmation === true,
      });
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(input);
  return answers;
}
function scenario(input: unknown) {
  const answers = answersFrom(input);
  const ppt = JSON.stringify(input).includes("PPT");
  const purpose = item(
    "purpose",
    "scope",
    ppt ? "这份PPT用于现场汇报还是阅读材料？" : "需要真实报名还是仅做界面演示？",
  );
  const style = item("style", "style", "请选择视觉风格", ["purpose"]);
  const live = answers.get("purpose")?.value === "真实报名";
  const detail = ppt
    ? item("ppt_content", "content", "PPT需要哪些内容？", ["purpose"])
    : live
      ? item("real_fields", "function", "真实报名需要收集哪些信息？", ["purpose"])
      : item("demo_content", "content", "演示需要展示哪些示例内容？", ["purpose"]);
  const items = [purpose, style, ...(answers.get("purpose")?.state === "answered" ? [detail] : [])];
  if (fixture.gap)
    items.push(item("privacy", "authorization", "是否允许公开报名信息？", ["purpose"]));
  return { answers, purpose, style, detail, items, ppt, live };
}
function modelValue(name: string, input: unknown) {
  const { answers, purpose, style, detail, items, ppt, live } = scenario(input);
  if (name === "clarification_decompose")
    return {
      summary: "明确标注的测试替身拆解",
      items,
      retired:
        answers.get("purpose")?.value === "仅做界面演示" &&
        (input as { previousItems?: DecisionItem[] }).previousItems?.some(
          (entry) => entry.id === "real_fields",
        )
          ? [
              {
                id: "real_fields",
                reason: "本人改为界面演示，真实资料收集退出范围",
                answerIds: ["purpose"],
              },
            ]
          : answers.get("purpose")?.value === "真实报名" &&
              (input as { previousItems?: DecisionItem[] }).previousItems?.some(
                (entry) => entry.id === "demo_content",
              )
            ? [
                {
                  id: "demo_content",
                  reason: "本人恢复真实报名，演示样例内容退出范围",
                  answerIds: ["purpose"],
                },
              ]
            : [],
      suggestions: ["测试模型建议采用蓝色，尚未得到本人确认"],
    };
  if (name === "clarification_options") {
    const unanswered = items.filter((entry) => {
      const existing = answers.get(entry.id);
      const pending =
        !existing ||
        existing.needsReconfirmation ||
        (existing.state === "answered" && existing.confirmation !== "confirmed");
      return pending && entry.dependsOn.every((id) => answers.get(id)?.state === "answered");
    });
    const questions = unanswered
      .slice(0, 3)
      .map((entry) =>
        question(
          entry,
          entry.id === purpose.id
            ? ppt
              ? ["现场汇报", "阅读材料"]
              : ["真实报名", "仅做界面演示"]
            : entry.id === style.id
              ? ["简洁正式", "活泼明亮"]
              : entry.id === detail.id
                ? ppt
                  ? ["背景与结论", "逐页演讲提纲"]
                  : live
                    ? ["姓名与联系方式", "仅收集昵称"]
                    : ["虚构示例名单", "空白表单"]
                : ["仅本人查看", "允许公开"],
        ),
      );
    return { summary: "测试替身依据当前回答生成具体选项", questions, conflicts: [] };
  }
  if (name === "clarification_review") {
    const topics: HandoffReview["coverage"][number]["topic"][] = [
      "scope",
      "function",
      "content",
      "flow",
      "style",
      "acceptance",
      "materials",
      "authorization",
    ];
    return {
      summary: "独立C测试替身检查交接覆盖",
      ready: !fixture.gap || answers.has("privacy"),
      coverage: topics.map((topic) => ({
        topic,
        applicable: items.some((entry) => entry.topic === topic),
        reason: items.some((entry) => entry.topic === topic)
          ? "已有对应决策事项"
          : "本测试成果无需另设此事项",
        decisionIds: items.filter((entry) => entry.topic === topic).map((entry) => entry.id),
      })),
      gaps:
        fixture.gap && !answers.has("privacy")
          ? [item("privacy", "authorization", "是否允许公开报名信息？", ["purpose"])]
          : [],
      conflicts: [],
    };
  }
  throw new Error(`Unexpected model request in test double: ${name}`);
}
function response(value: unknown) {
  return {
    value,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      estimatedCny: 0,
      estimatedUsd: 0.001,
      provider: "openai" as const,
      currency: "USD" as const,
      model: "gpt-6.1-terra",
      responseId: "explicit-clarification-test-double",
      durationMs: 1,
    },
  };
}
function operation(draft: IntakeDraft) {
  return { revision: draft.revision, operationId: randomUUID(), finish: false };
}
function answer(
  draft: IntakeDraft,
  values: Record<string, string>,
  state: "answered" | "unknown" | "skipped" = "answered",
) {
  return updateIntake(draft.id, owner, {
    revision: draft.revision,
    answerMode: "complete",
    answers: draft.questions.map((entry) => ({
      questionId: entry.id,
      state,
      value: state === "answered" ? values[entry.id] : "",
    })),
  });
}
async function next(draft: IntakeDraft) {
  return analyzeIntake(draft.id, owner, operation(draft));
}
function create(goalText = goal) {
  return createIntake(owner, {
    goal: goalText,
    modelMode: "gpt-6.1-terra",
    workflow: "clarification",
  });
}
async function answeredDraft(purpose = "仅做界面演示", goalText = goal) {
  let draft = await next(create(goalText));
  draft = await next(answer(draft, { purpose }));
  const detail =
    purpose === "真实报名"
      ? "real_fields"
      : goalText.includes("PPT")
        ? "ppt_content"
        : "demo_content";
  draft = await next(
    answer(draft, {
      style: "简洁正式",
      [detail]: goalText.includes("PPT")
        ? "背景与结论"
        : purpose === "真实报名"
          ? "仅收集昵称"
          : "虚构示例名单",
    }),
  );
  return draft;
}

beforeEach(() => {
  closeDb();
  fixture.gap = false;
  fixture.generate.mockReset();
  fixture.estimate.mockClear();
  for (const [key, value] of Object.entries({
    ARENA_DATABASE_PATH: ":memory:",
    OPENAI_API_KEY: "explicit-test-double",
    DEEPSEEK_API_KEY: "",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL_ID: "gpt-6.1-terra",
    OPENAI_STRUCTURED_OUTPUT: "strict-tool",
    OPENAI_MAX_OUTPUT_TOKENS: "2200",
    OPENAI_REASONING_EFFORT: "low",
    OPENAI_INPUT_PRICE_PER_MILLION: "1",
    OPENAI_OUTPUT_PRICE_PER_MILLION: "5",
    ARENA_DAILY_VISITOR_LIMIT: "100",
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in clarification test-double suite");
    }),
  );
  fixture.generate.mockImplementation(async (request) =>
    response(modelValue(request.name, request.input)),
  );
});
afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("explicit clarification workflow with model test doubles", () => {
  it.each([
    "goal",
    "constraints",
    "preferences",
    "budget",
    "timeHours",
    "options",
    "domain",
    "assumptions",
  ] as const)("invalidates both report outputs when summary $0 changes", async (field) => {
    const draft = await answeredDraft();
    const challenge = { ...draft.challenge! };
    const changes = {
      goal: "更改为明确的新目标并继续逐项确认",
      constraints: "不得采集联系方式",
      preferences: "新的风格",
      budget: 10,
      timeHours: 8,
      options: ["单页成果"],
      domain: "work" as const,
    };
    if (field !== "assumptions") Object.assign(challenge, { [field]: changes[field] });
    const updated = updateIntake(draft.id, owner, {
      revision: draft.revision,
      summary: {
        challenge,
        assumptions: field === "assumptions" ? ["新增待核实前提"] : draft.assumptions,
      },
    });
    expect(updated.clarification).toMatchObject({
      review: null,
      specification: "",
      executionPrompt: "",
      draftOnly: true,
    });
    const stored = JSON.parse(
      (db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as { body: string })
        .body,
    ) as IntakeDraft;
    expect(stored.clarification?.specification).toBe("");
    expect(stored.clarification?.executionPrompt).toBe("");
    expect(updated.confirmation?.history.at(-1)?.answers).toEqual(draft.answers);
    expect(updated.clarification?.runs).toEqual(draft.clarification?.runs);
    expect(updated.confirmation?.summary).toEqual(draft.confirmation?.summary);
  });

  it("invalidates historical draft edits, downstream confirmations and obsolete question queues", async () => {
    const draft = await answeredDraft("真实报名");
    const body = JSON.parse(
      (db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as { body: string })
        .body,
    ) as IntakeDraft;
    body.queuedQuestions = [question(item("obsolete", "content", "过期问题"))];
    const downstream = item("export_fields", "function", "导出字段", ["real_fields"]);
    const independent = item("independent", "style", "独立偏好");
    const independentAnswer: RecordedAnswer = {
      questionId: independent.id,
      question: question(independent),
      state: "answered",
      value: "保持原样",
      confirmation: "confirmed",
    };
    body.answers.push(
      {
        questionId: downstream.id,
        question: question(downstream),
        state: "answered",
        value: "导出原字段",
        confirmation: "confirmed",
      },
      independentAnswer,
    );
    const originalAnswers = structuredClone(body.answers);
    db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(JSON.stringify(body), draft.id);
    const updated = updateIntake(draft.id, owner, {
      revision: draft.revision,
      answerMode: "draft",
      answers: [{ questionId: "purpose", state: "answered", value: "仅做界面演示" }],
    });
    expect(updated.queuedQuestions).toEqual([]);
    expect(updated.answers.find((entry) => entry.questionId === "purpose")).toMatchObject({
      confirmation: "pending",
      needsReconfirmation: true,
    });
    expect(updated.answers.find((entry) => entry.questionId === "real_fields")).toMatchObject({
      confirmation: "pending",
      needsReconfirmation: true,
    });
    expect(updated.answers.find((entry) => entry.questionId === downstream.id)).toMatchObject({
      confirmation: "pending",
      needsReconfirmation: true,
    });
    expect(updated.answers.find((entry) => entry.questionId === independent.id)).toEqual(
      independentAnswer,
    );
    expect(updated.clarification).toMatchObject({
      review: null,
      specification: "",
      executionPrompt: "",
    });
    expect(getIntake(draft.id, owner).answers).toEqual(updated.answers);
    expect(updated.confirmation?.history.at(-1)?.answers).toEqual(originalAnswers);
  });

  it.each([{ assumptions: [] as string[] }, { assumptions: ["用户改写的暂定前提，仍待核实"] }])(
    "preserves user-retained assumptions through reload and explicit analysis: %j",
    async ({ assumptions }) => {
      const draft = await answeredDraft();
      const removed = draft.assumptions[0];
      expect(removed).toBeTruthy();
      updateIntake(draft.id, owner, {
        revision: draft.revision,
        summary: { challenge: draft.challenge!, assumptions },
      });
      const saved = getIntake(draft.id, owner);
      expect(saved.assumptions).toEqual(assumptions);
      expect(saved.clarification?.specification).toBe("");
      const before = fixture.generate.mock.calls.length;
      const analyzed = await next(saved);
      expect(analyzed.assumptions).toEqual(assumptions);
      expect(analyzed.clarification?.suggestions).toEqual(assumptions);
      for (const [request] of fixture.generate.mock.calls.slice(before)) {
        expect(request.input.assumptions).toEqual(assumptions);
        expect(request.input.editedAssumptions).toEqual(assumptions);
      }
      expect(analyzed.clarification?.specification).not.toContain(removed);
      expect(analyzed.clarification?.executionPrompt).not.toContain(removed);
      expect(analyzed.confirmation?.summary).toBeUndefined();
      expect(
        analyzed.clarification?.runs.some(
          (run) =>
            run.role === "A" &&
            "suggestions" in run.output &&
            run.output.suggestions.includes(removed),
        ),
      ).toBe(true);
      expect(getIntake(draft.id, owner).assumptions).toEqual(assumptions);
    },
  );

  it("invalidates reports after model and attachment changes", async () => {
    let draft = await answeredDraft();
    draft = updateIntake(draft.id, owner, { revision: draft.revision, modelMode: "gpt-6.1-sol" });
    expect(draft.clarification).toMatchObject({
      review: null,
      specification: "",
      executionPrompt: "",
    });
    draft = await next(draft);
    draft = await addIntakeAttachment(
      draft.id,
      owner,
      Buffer.from("明确标记的测试材料"),
      "test.txt",
    );
    expect(draft.clarification).toMatchObject({
      review: null,
      specification: "",
      executionPrompt: "",
    });
    draft = await next(draft);
    const removed = removeIntakeAttachment(draft.id, owner, draft.attachments[0].id);
    expect(removed.clarification).toMatchObject({
      review: null,
      specification: "",
      executionPrompt: "",
    });
  });

  it.each(["summary", "analyzing", "uncertain"] as const)(
    "projects old protocol reports without mutating the stored $0 draft or call locks",
    async (status) => {
      const draft = await answeredDraft();
      const body = JSON.parse(
        (
          db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
            body: string;
          }
        ).body,
      );
      body.clarificationPromptHash = "legacy-protocol";
      body.status = status;
      body.reservedUsd = 0.4;
      body.clarification.next = "completed";
      const operationId = randomUUID();
      db()
        .prepare(
          "INSERT INTO intake_operations(id,draft_id,revision,body,state,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          operationId,
          draft.id,
          draft.revision,
          "{}",
          status === "uncertain" ? "uncertain" : "pending",
          Date.now(),
        );
      const serialized = JSON.stringify(body);
      db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(serialized, draft.id);
      const operations = db()
        .prepare("SELECT * FROM intake_operations WHERE draft_id=?")
        .all(draft.id);
      const calls = db().prepare("SELECT * FROM intake_calls ORDER BY rowid").all();
      const projected = getIntake(draft.id, owner);
      expect(projected).toMatchObject({ status, revision: draft.revision, reservedUsd: 0.4 });
      expect(projected.clarification).toMatchObject({
        review: null,
        specification: "",
        executionPrompt: "",
        draftOnly: true,
      });
      expect(projected.answers).toEqual(body.answers);
      expect(projected.confirmation).toEqual(body.confirmation);
      expect(
        (
          db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
            body: string;
          }
        ).body,
      ).toBe(serialized);
      expect(
        db().prepare("SELECT * FROM intake_operations WHERE draft_id=?").all(draft.id),
      ).toEqual(operations);
      expect(db().prepare("SELECT * FROM intake_calls ORDER BY rowid").all()).toEqual(calls);
    },
  );

  it("binds reports to final summary content and hides changed-input reports read-only", async () => {
    const draft = await answeredDraft();
    expect(draft.clarification?.review?.fingerprint).toBe(clarificationFingerprint(draft));
    expect(draft.clarification?.specification).not.toBe("");
    const row = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
      body: string;
    };
    const body = JSON.parse(row.body);
    body.modelMode = "gpt-6.1-sol";
    const changed = JSON.stringify(body);
    db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(changed, draft.id);
    expect(getIntake(draft.id, owner).clarification?.specification).toBe("");
    expect(
      (db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as { body: string })
        .body,
    ).toBe(changed);
  });

  it("includes attachment state, provenance and feedback in the content fingerprint", () => {
    const draft = create();
    draft.sources = [
      {
        id: "s1",
        attachmentId: "a1",
        filename: "test.txt",
        location: "1",
        text: "材料",
        interpretation: false,
        origin: "document",
      },
    ];
    draft.attachments = [
      {
        id: "a1",
        name: "test.txt",
        size: 6,
        state: "ready",
        imageCount: 0,
        interpreted: false,
        locations: ["1"],
        warnings: [],
      },
    ];
    draft.clarification = emptyClarification();
    const initial = clarificationFingerprint(draft);
    for (const change of [
      (value: IntakeDraft) => {
        value.sources[0].origin = "model_transcription";
      },
      (value: IntakeDraft) => {
        value.attachments[0].state = "failed";
      },
      (value: IntakeDraft) => {
        value.clarification!.feedback = [
          { kind: "user_change", text: "变更需求", createdAt: "test", source: "user" },
        ];
      },
    ]) {
      const changed = structuredClone(draft);
      change(changed);
      expect(clarificationFingerprint(changed)).not.toBe(initial);
    }
    draft.revision++;
    expect(clarificationFingerprint(draft)).toBe(initial);
  });

  it.each([undefined, "1800", "4000", "5000", "6000"])(
    "reserves and sends the same C configuration with explicit output override %s",
    async (override) => {
      vi.stubEnv("OPENAI_MAX_OUTPUT_TOKENS", override);
      await answeredDraft();
      const requests = fixture.generate.mock.calls.map(([request]) => request);
      for (const request of requests) {
        const expected = override
          ? Number(override)
          : request.name === "clarification_review"
            ? 4200
            : 2200;
        expect(request.config.maxOutputTokens).toBe(expected);
        const reserved = fixture.estimate.mock.calls.find(
          ([estimate]) => estimate.name === request.name && estimate.config === request.config,
        );
        expect(reserved).toBeDefined();
      }
      expect(requests.find((request) => request.name === "clarification_review").allowRepair).toBe(
        false,
      );
    },
  );

  it.each([undefined, "1800", "4000", "5000", "6000"])(
    "respects DeepSeek explicit output override %s",
    (override) => {
      vi.stubEnv("MODEL_MAX_OUTPUT_TOKENS", override);
      const config = {
        ...resolveModelConfig("gpt-6.1-terra"),
        provider: "deepseek" as const,
        maxOutputTokens: override ? Number(override) : 2200,
      };
      expect(clarificationReviewConfig(config).maxOutputTokens).toBe(
        override ? Number(override) : 4200,
      );
      expect(config.maxOutputTokens).toBe(override ? Number(override) : 2200);
    },
  );

  it("does not retry a failed C report or create a formal version", async () => {
    const draft = await answeredDraft();
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_review") {
        expect(request.allowRepair).toBe(false);
        throw new ModelCallError("明确标注的C截断/结构错误测试替身", false, response(null).usage, {
          feedback: "结构不完整",
          rejectedOutput: "{",
        });
      }
      return response(modelValue(request.name, request.input));
    });
    const prior = fixture.generate.mock.calls.length;
    const failed = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in failed).toBe(false);
    expect(getIntake(draft.id, owner)).toMatchObject({
      status: "failed",
      clarification: { review: null, specification: "", executionPrompt: "" },
    });
    expect(fixture.generate.mock.calls.slice(prior).map(([request]) => request.name)).toEqual([
      "clarification_decompose",
      "clarification_options",
      "clarification_review",
    ]);
    expect(db().prepare("SELECT count(*) AS count FROM arenas").get()).toMatchObject({ count: 0 });
    expect(
      db().prepare("SELECT state,usage FROM intake_calls ORDER BY rowid DESC LIMIT 1").get(),
    ).toMatchObject({
      state: "failed",
      usage: expect.stringContaining("explicit-clarification-test-double"),
    });
  });

  it("rejects an old protocol completed draft at the final createArena boundary", async () => {
    const draft = await answeredDraft();
    const row = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
      body: string;
    };
    const body = JSON.parse(row.body);
    body.clarificationPromptHash = "legacy";
    body.clarification.next = "completed";
    db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(JSON.stringify(body), draft.id);
    expect(() =>
      createArena(draft.challenge!, owner, draft.modelMode, {
        intakeId: draft.id,
        revision: draft.revision,
      }),
    ).toThrow("需求查漏协议已更新");
  });

  it("rejects stale completed retries and rechecks old-protocol reports after a quota failure", async () => {
    let draft = await answeredDraft();
    const staleRevision = draft.revision;
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "true");
    vi.stubEnv("ARENA_DAILY_VISITOR_LIMIT", "1");
    createArena(ChallengeSchema.parse({ goal: "占用测试配额的独立任务" }), owner, "gpt-6.1-terra");
    await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    draft = getIntake(draft.id, owner);
    expect(draft.clarification?.next).toBe("completed");
    const row = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
      body: string;
    };
    const body = JSON.parse(row.body);
    body.clarificationPromptHash = "legacy-completed";
    db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(JSON.stringify(body), draft.id);
    vi.stubEnv("ARENA_DAILY_VISITOR_LIMIT", "100");
    await expect(
      submitClarificationIntake(draft.id, owner, {
        revision: staleRevision,
        challenge: draft.challenge!,
        assumptions: [],
      }),
    ).rejects.toMatchObject({ code: "STALE_INTAKE" });
    const before = fixture.generate.mock.calls.length;
    const delivered = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in delivered).toBe(true);
    expect(fixture.generate.mock.calls.length - before).toBe(3);
    expect(
      JSON.parse(
        (
          db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
            body: string;
          }
        ).body,
      ).clarificationPromptHash,
    ).toBe(clarificationProtocolHash());
  });

  it("allows one concurrent explicit submit to create the version", async () => {
    const draft = await answeredDraft();
    const input = {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    };
    const results = await Promise.allSettled([
      submitClarificationIntake(draft.id, owner, input),
      submitClarificationIntake(draft.id, owner, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(db().prepare("SELECT count(*) AS count FROM arenas").get()).toMatchObject({ count: 1 });
    expect(db().prepare("SELECT count(*) AS count FROM versions").get()).toMatchObject({
      count: 1,
    });
  });

  it("opts in without changing legacy drafts and persists independent A and B calls before user questions", async () => {
    expect(createIntake(owner, { goal, modelMode: "gpt-6.1-terra" }).workflow).toBeUndefined();
    const draft = await next(create());
    expect(draft.workflow).toBe("clarification");
    expect(draft.status).toBe("questions");
    expect(draft.questions).toHaveLength(1);
    expect(draft.questions[0].options).toEqual(["真实报名", "仅做界面演示"]);
    expect(fixture.generate.mock.calls.map(([request]) => request.name)).toEqual([
      "clarification_decompose",
      "clarification_options",
    ]);
    expect(draft.clarification?.runs.map((run) => run.role)).toEqual(["A", "B"]);
    expect(new Set(draft.clarification?.runs.map((run) => run.id)).size).toBe(2);
    for (const run of draft.clarification?.runs ?? []) {
      expect(run.usage).toHaveLength(1);
      expect(run.callIds).toEqual([run.id]);
    }
    expect(getIntake(draft.id, owner).clarification).toEqual(draft.clarification);
    expect(() => getIntake(draft.id, "other-owner")).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains clarification answers and role records beyond the legacy 24-hour draft window", async () => {
    const draft = await next(create());
    const staleTime = Date.now() - 3 * 24 * 60 * 60 * 1000;
    db().prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?").run(staleTime, draft.id);
    createIntake(owner, { goal: "新的临时任务触发原有草稿维护", modelMode: "gpt-6.1-terra" });
    const restored = getIntake(draft.id, owner);
    expect(restored.clarification?.runs).toEqual(draft.clarification?.runs);
    expect(restored.questions).toEqual(draft.questions);
    expect(restored.answers).toEqual(draft.answers);
  });

  it("rejects an old C readiness fingerprint when the saved requirements have changed", async () => {
    const draft = await answeredDraft();
    expect(draft.clarification?.review?.ready).toBe(true);
    expect(draft.clarification?.draftOnly).toBe(true);
    const changed = structuredClone(draft);
    changed.goal = "本人已更换目标，旧查漏结论不能继续使用";
    changed.challenge = { ...changed.challenge!, goal: changed.goal };
    changed.revision++;
    changed.clarification!.next = "completed";
    db()
      .prepare("UPDATE intake_drafts SET body=? WHERE id=?")
      .run(JSON.stringify(changed), changed.id);
    expect(() =>
      createArena(changed.challenge!, owner, changed.modelMode, {
        intakeId: changed.id,
        revision: changed.revision,
      }),
    ).toThrow("需求尚未完成当前版本的查漏与确认");
    expect(db().prepare("SELECT COUNT(*) AS count FROM arenas").get()).toMatchObject({ count: 0 });
    expect(getIntake(changed.id, owner).goal).toBe(changed.goal);
  });

  it("changes concrete follow-up questions from the submitted actual-registration or demo choice", async () => {
    let actual = await next(create());
    actual = await next(answer(actual, { purpose: "真实报名" }));
    expect(actual.questions.map((entry) => entry.id)).toContain("real_fields");
    expect(actual.questions.find((entry) => entry.id === "real_fields")?.options).toEqual([
      "姓名与联系方式",
      "仅收集昵称",
    ]);
    let demo = await next(create());
    demo = await next(answer(demo, { purpose: "仅做界面演示" }));
    expect(demo.questions.map((entry) => entry.id)).toContain("demo_content");
    expect(demo.questions.map((entry) => entry.id)).not.toContain("real_fields");
    expect(demo.clarification?.rounds.at(-1)?.changes.triggerAnswerIds).toContain("purpose");
  });

  it("handles PPT content through the same workflow and keeps C's handoff review independently recorded", async () => {
    const draft = await answeredDraft("现场汇报", "准备一份PPT，逐项确认汇报内容和视觉风格");
    expect(draft.status).toBe("summary");
    expect(draft.clarification?.runs.some((run) => run.role === "C")).toBe(true);
    expect(draft.answers.find((entry) => entry.questionId === "ppt_content")?.value).toBe(
      "背景与结论",
    );
    const submission = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in submission).toBe(true);
    expect(
      fixture.generate.mock.calls.filter(([request]) => request.name === "clarification_review")
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(getIntake(draft.id, owner).status).toBe("submitted");
  });

  it.each(["unknown", "skipped"] as const)(
    "preserves %s without confirming a default or repeatedly asking the same question",
    async (state) => {
      let draft = await next(create());
      draft = await next(answer(draft, {}, state));
      expect(draft.answers.find((entry) => entry.questionId === "purpose")).toMatchObject({
        state,
        value: "",
      });
      expect(draft.answers.find((entry) => entry.questionId === "purpose")?.confirmation).not.toBe(
        "confirmed",
      );
      expect(draft.questions.map((entry) => entry.id)).not.toContain("purpose");
      expect(draft.clarification?.draftOnly).toBe(true);
      expect(draft.clarification?.executionPrompt).toContain("当前为草稿");
      expect(draft.clarification?.executionPrompt).not.toContain(
        "需要真实报名还是仅做界面演示？ — 真实报名",
      );
    },
  );

  it("returns new questions when the independent review finds a gap at submission", async () => {
    const draft = await answeredDraft();
    fixture.gap = true;
    const result = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in result).toBe(false);
    const pending = result as IntakeDraft;
    expect(pending.status).toBe("questions");
    expect(pending.questions.map((entry) => entry.id)).toContain("privacy");
    expect(pending.arenaId).toBeNull();
    expect(pending.clarification?.review?.gaps.map((entry) => entry.id)).toContain("privacy");
    const answered = await next(answer(pending, { privacy: "仅本人查看" }));
    expect(answered.status).toBe("summary");
    const delivered = await submitClarificationIntake(answered.id, owner, {
      revision: answered.revision,
      challenge: answered.challenge!,
      assumptions: answered.assumptions,
    });
    expect("versions" in delivered).toBe(true);
    expect(getIntake(answered.id, owner).clarification?.review?.ready).toBe(true);
  });

  it("retires the affected real-data branch after the user changes the purpose to a demo", async () => {
    let draft = await answeredDraft("真实报名");
    draft = updateIntake(draft.id, owner, {
      revision: draft.revision,
      answerMode: "complete",
      answers: [{ questionId: "purpose", state: "answered", value: "仅做界面演示" }],
    });
    draft = await next(draft);
    expect(draft.clarification?.retiredIds).toContain("real_fields");
    expect(draft.questions.map((entry) => entry.id)).toContain("demo_content");
    draft = await next(answer(draft, { style: "简洁正式", demo_content: "虚构示例名单" }));
    expect(draft.status).toBe("summary");
    expect(draft.clarification?.executionPrompt).not.toContain("仅收集昵称");
    expect(draft.challenge?.constraints).not.toContain("真实报名需要收集哪些信息");
    expect(
      draft.clarification?.rounds.some((round) => round.changes.retired.includes("real_fields")),
    ).toBe(true);
    draft = updateIntake(draft.id, owner, {
      revision: draft.revision,
      answerMode: "complete",
      answers: [{ questionId: "purpose", state: "answered", value: "真实报名" }],
    });
    draft = await next(draft);
    expect(draft.clarification?.retiredIds).not.toContain("real_fields");
    expect(draft.clarification?.retiredIds).toContain("demo_content");
    expect(draft.questions.map((entry) => entry.id)).toContain("real_fields");
    draft = await next(answer(draft, { style: "简洁正式", real_fields: "姓名与联系方式" }));
    expect(draft.status).toBe("summary");
    expect(draft.clarification?.executionPrompt).toContain("姓名与联系方式");
    expect(draft.challenge?.constraints).not.toContain("虚构示例名单");
    expect(
      draft.clarification?.rounds.some((round) => round.changes.changed.includes("real_fields")),
    ).toBe(true);
  });

  it.each([
    { quote: "风格采用简洁正式", expected: "summary" },
    { quote: "风格采用炫彩背景", expected: "questions" },
  ])(
    "checks verbatim original-goal evidence before treating a provided requirement as resolved: $quote",
    async ({ quote, expected }) => {
      fixture.generate.mockImplementation(async (request) => {
        const providedItem = {
          ...item("style", "style", "请选择视觉风格"),
          provided: { sourceRef: "original_goal", quote },
        };
        if (request.name === "clarification_decompose")
          return response({
            summary: "原话引用测试替身",
            items: [providedItem],
            retired: [],
            suggestions: [],
          });
        if (request.name === "clarification_options")
          return response({
            summary: "只对真正待确认事项提问",
            questions: (request.input.questionableItems as DecisionItem[]).map((entry) =>
              question(entry, ["简洁正式", "活泼明亮"]),
            ),
            conflicts: [],
          });
        return response({
          summary: "独立C覆盖检查",
          ready: true,
          coverage: ["function", "content", "flow", "style"].map((topic) => ({
            topic,
            applicable: topic === "style",
            reason: "逐项适用性检查",
            decisionIds: topic === "style" ? ["style"] : [],
          })),
          gaps: [],
          conflicts: [],
        });
      });
      const draft = await next(create("准备一份十页PPT，风格采用简洁正式"));
      expect(draft.status).toBe(expected);
      expect(draft.answers).toEqual([]);
      if (expected === "summary") {
        expect(draft.questions).toEqual([]);
        expect(draft.clarification?.specification).toContain("风格采用简洁正式");
        expect(draft.clarification?.review?.ready).toBe(true);
      } else {
        expect(draft.questions.map((entry) => entry.id)).toContain("style");
        expect(draft.clarification?.executionPrompt).not.toContain("风格采用炫彩背景");
      }
    },
  );

  it("accepts an already confirmed decision that covers several review topics", async () => {
    const draft = await answeredDraft();
    fixture.generate.mockImplementation(async (request) => {
      const value = modelValue(request.name, request.input);
      if (request.name !== "clarification_review") return response(value);
      return response({
        ...value,
        ready: true,
        coverage: ["function", "content", "flow", "style"].map((topic) => ({
          topic,
          applicable: true,
          reason: "真实PPT与说明文档覆盖形状的测试替身，确认要求可跨分类引用",
          decisionIds: ["purpose", "style"],
        })),
      });
    });
    const result = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in result).toBe(true);
    expect(getIntake(draft.id, owner).clarification?.review?.ready).toBe(true);
  });

  it("rejects review coverage that cites a nonexistent decision", async () => {
    const draft = await answeredDraft();
    fixture.generate.mockImplementation(async (request) => {
      const value = modelValue(request.name, request.input);
      if (request.name !== "clarification_review") return response(value);
      return response({
        ...value,
        ready: true,
        coverage: ["function", "content", "flow", "style"].map((topic) => ({
          topic,
          applicable: true,
          reason: "明确标注的无效引用测试替身",
          decisionIds: ["missing_decision"],
        })),
      });
    });
    const result = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in result).toBe(false);
    expect(getIntake(draft.id, owner).clarification?.review?.ready).toBe(false);
  });

  it("blocks formal handoff when C claims readiness without the required topic coverage", async () => {
    const draft = await answeredDraft();
    fixture.generate.mockImplementation(async (request) => {
      const value = modelValue(request.name, request.input);
      return response(
        request.name === "clarification_review" ? { ...value, ready: true, coverage: [] } : value,
      );
    });
    const result = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in result).toBe(false);
    const pending = result as IntakeDraft;
    expect(pending.arenaId).toBeNull();
    expect(pending.clarification?.review?.ready).toBe(false);
    expect(pending.clarification?.draftOnly).toBe(true);
  });

  it("upgrades a legacy clarification prompt hash without discarding the draft or its answers", async () => {
    const draft = await answeredDraft();
    const row = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
      body: string;
    };
    const stored = JSON.parse(row.body) as Record<string, unknown>;
    stored.clarificationPromptHash = "legacy-clarification-prompt-hash";
    const legacyState = stored.clarification as Record<string, unknown>;
    legacyState.specification = "旧协议生成的报告";
    legacyState.executionPrompt = "旧协议生成的提示词";
    db()
      .prepare("UPDATE intake_drafts SET body=? WHERE id=?")
      .run(JSON.stringify(stored), draft.id);

    const before = getIntake(draft.id, owner);
    const updated = await analyzeIntake(draft.id, owner, {
      revision: before.revision,
      operationId: randomUUID(),
      finish: false,
    });
    expect(updated.answers).toEqual(before.answers);
    expect(updated.confirmation).toEqual(before.confirmation);
    expect(updated.clarification?.runs.slice(0, before.clarification!.runs.length)).toEqual(
      before.clarification!.runs,
    );
    expect(updated.clarification?.review).not.toBeNull();
    expect(updated.clarification?.specification).not.toContain("旧协议生成的报告");
    expect(updated.clarification?.executionPrompt).not.toContain("旧协议生成的提示词");
    expect(updated.clarification?.draftOnly).toBe(true);
  });

  it("preserves the uncertain-request lock when a draft has an older prompt hash", async () => {
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_options")
        throw new ModelCallError("明确标记的未知结果测试替身", true);
      return response(modelValue(request.name, request.input));
    });
    const draft = await next(create());
    expect(draft.status).toBe("uncertain");
    const row = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
      body: string;
    };
    const stored = JSON.parse(row.body) as Record<string, unknown>;
    stored.clarificationPromptHash = "legacy-uncertain-prompt-hash";
    db()
      .prepare("UPDATE intake_drafts SET body=? WHERE id=?")
      .run(JSON.stringify(stored), draft.id);

    await expect(next(getIntake(draft.id, owner))).rejects.toMatchObject({
      code: "INTAKE_UNCERTAIN",
    });
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(getIntake(draft.id, owner).status).toBe("uncertain");
    expect(db().prepare("SELECT state FROM intake_calls ORDER BY rowid").all()).toMatchObject([
      { state: "completed" },
      { state: "uncertain" },
    ]);
  });

  it("reconfirms changed requirements and delivers a new version within the same task", async () => {
    const draft = await answeredDraft();
    const first = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    if (!("versions" in first)) throw new Error("Expected explicit test-double handoff snapshot");
    const original = first.versions.find((version) => version.id === first.activeVersionId)!;
    expect(original.clarification?.draftOnly).toBe(false);
    const changed = newVersion(
      first.id,
      owner,
      { ...original.challenge, preferences: "活泼明亮" },
      "本人修改视觉风格",
      undefined,
      undefined,
      { baseVersionId: original.id },
    );
    const waiting = changed.versions.find((version) => version.id === changed.activeVersionId)!;
    expect(waiting.status).toBe("paused");
    expect(waiting.workflow).toBe("clarification");
    let followUp = getIntake(waiting.waitingForIntake!.id, owner);
    expect(followUp.workflow).toBe("clarification");
    followUp = await next(
      answer(
        followUp,
        Object.fromEntries(followUp.questions.map((entry) => [entry.id, "活泼明亮"])),
      ),
    );
    if (followUp.status === "questions")
      followUp = await next(answer(followUp, { style: "活泼明亮" }));
    expect(followUp.status).toBe("summary");
    const delivered = await submitClarificationIntake(followUp.id, owner, {
      revision: followUp.revision,
      challenge: followUp.challenge!,
      assumptions: followUp.assumptions,
    });
    if (!("versions" in delivered)) throw new Error("Expected revised handoff snapshot");
    expect(delivered.id).toBe(first.id);
    expect(delivered.activeVersionId).not.toBe(original.id);
    const current = delivered.versions.find((version) => version.id === delivered.activeVersionId)!;
    expect(current.workflow).toBe("clarification");
    expect(current.status).toBe("completed");
    expect(current.clarification?.executionPrompt).toContain("活泼明亮");
    expect(
      delivered.versions.find((version) => version.id === original.id)?.clarification
        ?.executionPrompt,
    ).toBe(original.clarification?.executionPrompt);
    const historical = delivered.versions.find((version) => version.id === original.id)!;
    expect(historical.challenge).toEqual(original.challenge);
    expect(historical.intake).toEqual(original.intake);
    expect(historical.clarification).toEqual(original.clarification);
    expect(delivered.steps.filter((step) => step.versionId === current.id)).toEqual([]);
  });

  it("keeps first-candidate summary edits pending through analysis and confirms them only on explicit submission", async () => {
    let draft = await answeredDraft();
    expect(draft.confirmation?.summary).toBeUndefined();
    const priorAnswers = structuredClone(draft.answers);
    draft = updateIntake(draft.id, owner, {
      revision: draft.revision,
      summary: {
        challenge: { ...draft.challenge!, preferences: "活泼明亮" },
        assumptions: draft.assumptions,
      },
    });
    expect(draft.confirmation?.history.at(-1)?.answers).toEqual(priorAnswers);
    expect(draft.answers.find((entry) => entry.questionId === "style")).toMatchObject({
      confirmation: "pending",
      needsReconfirmation: true,
    });
    expect(draft.answers.find((entry) => entry.questionId === "purpose")?.confirmation).toBe(
      "confirmed",
    );
    draft = await next(draft);
    expect(draft.clarification?.draftOnly).toBe(true);
    expect(draft.clarification?.review?.ready ?? false).toBe(false);
    expect(draft.clarification?.executionPrompt).not.toContain("活泼明亮");
    expect(draft.clarification?.executionPrompt).not.toContain("简洁正式");
    expect(draft.confirmation?.pendingSummaryFields).toContain("preferences");
    expect(draft.clarification?.specification).toBe("");
    expect(draft.questions.map((entry) => entry.id)).toContain("style");
    draft = await next(answer(draft, { style: "活泼明亮" }));
    const submitted = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    if (!("versions" in submitted))
      throw new Error("Expected explicitly confirmed revised handoff");
    const result = submitted.versions.find((version) => version.id === submitted.activeVersionId)!;
    expect(result.clarification?.executionPrompt).toContain("活泼明亮");
    expect(result.clarification?.executionPrompt).not.toContain("简洁正式");
  });

  it("does not use an old original-goal quote to approve a pending style edit", async () => {
    const challenge = ChallengeSchema.parse({
      goal: "制作一份PPT，采用简洁正式的风格",
      preferences: "简洁正式",
    });
    const draft: IntakeDraft = {
      ...create(challenge.goal),
      challenge,
      confirmation: {
        history: [],
        summary: { revision: 1, confirmedAt: new Date().toISOString(), challenge },
        pendingSummaryFields: ["preferences"],
      },
      clarification: emptyClarification(),
    };
    const edited = {
      ...challenge,
      goal: "制作一份PPT并采用本次确认的风格",
      preferences: "新的活泼风格",
    };
    async function execute(explicit: boolean) {
      return runClarification(draft, {
        operationId: randomUUID(),
        revision: draft.revision,
        config: resolveModelConfig(draft.modelMode),
        finish: false,
        editedFields: { preferences: edited.preferences },
        ...(explicit ? { submit: { challenge: edited, assumptions: [] } } : {}),
        call: async <T>(role: "A" | "B" | "C", request: { input: unknown }) => {
          const decision = {
            ...item("style", "style", "视觉风格"),
            provided: {
              sourceRef: explicit ? "confirmed_summary" : "original_goal",
              quote: explicit ? edited.preferences : "简洁正式",
            },
          };
          const value =
            role === "A"
              ? { summary: "测试A", items: [decision], retired: [], suggestions: [] }
              : role === "B"
                ? {
                    summary: "测试B",
                    questions: (
                      request.input as { questionableItems: DecisionItem[] }
                    ).questionableItems.map((entry) =>
                      question(entry, ["简洁正式", "新的活泼风格"]),
                    ),
                    conflicts: [],
                  }
                : {
                    summary: "测试C",
                    ready: true,
                    coverage: ["function", "content", "flow", "style"].map((topic) => ({
                      topic,
                      applicable: topic === "style",
                      reason: "测试覆盖",
                      decisionIds: topic === "style" ? ["style"] : [],
                    })),
                    gaps: [],
                    conflicts: [],
                  };
          return value as T;
        },
        record: () => {},
      });
    }
    const pending = await execute(false);
    expect(pending.state.draftOnly).toBe(true);
    expect(pending.state.review?.ready ?? false).toBe(false);
    expect(pending.state.executionPrompt).not.toContain("已确认偏好 — 新的活泼风格");
    expect(pending.state.specification).toContain("偏好与风格的摘要修改尚待确认");
    const confirmed = await execute(true);
    expect(confirmed.state.review?.ready).toBe(true);
    expect(confirmed.state.executionPrompt).toContain("新的活泼风格");
    expect(confirmed.state.executionPrompt).toContain(
      `原始目标（原始输入，不自动视为确认）：${challenge.goal}`,
    );
    const currentInstructions = confirmed.state.executionPrompt
      .split("\n")
      .filter((line) => !line.startsWith("原始目标（"))
      .join("\n");
    expect(currentInstructions).not.toContain("简洁正式");
  });

  it.each([
    { field: "budget" as const, quote: "预算100元", value: 200 },
    { field: "timeHours" as const, quote: "总工时10小时", value: 20 },
    { field: "domain" as const, quote: "制作PPT", value: "work" as const },
  ])(
    "keeps pending $field changes from being resolved by an older original-goal quote",
    async ({ field, quote, value }) => {
      const challenge = ChallengeSchema.parse({
        goal: "制作PPT，预算100元，总工时10小时",
        budget: 100,
        timeHours: 10,
      });
      const draft: IntakeDraft = {
        ...create(challenge.goal),
        challenge,
        confirmation: {
          history: [],
          summary: { revision: 1, confirmedAt: new Date().toISOString(), challenge },
          pendingSummaryFields: [field],
        },
      };
      const decision = {
        ...item("scope", "scope", "确认最新成果范围与投入"),
        provided: { sourceRef: "original_goal", quote },
      };
      const result = await runClarification(draft, {
        operationId: randomUUID(),
        revision: draft.revision,
        config: resolveModelConfig(draft.modelMode),
        finish: false,
        editedFields: { [field]: value },
        call: async <T>(role: "A" | "B" | "C", request: { input: unknown }) => {
          if (role === "A")
            return {
              summary: "测试原文来源",
              items: [decision],
              retired: [],
              suggestions: [],
            } as T;
          if (role === "B")
            return {
              summary: "需要确认修改",
              questions: (
                request.input as { questionableItems: DecisionItem[] }
              ).questionableItems.map((entry) => question(entry, ["确认修改", "进一步补充"])),
              conflicts: [],
            } as T;
          throw new Error("Pending changes must not reach a ready handoff");
        },
        record: () => {},
      });
      expect(result.status).toBe("questions");
      expect(result.state.draftOnly).toBe(true);
      expect(result.state.executionPrompt).toContain("原始目标（原始输入，不自动视为确认）");
      expect(result.state.executionPrompt).not.toContain(`- ${quote}`);
    },
  );

  it("adds evidence-bounded planning sections without invoking a model", () => {
    const draft = create();
    const state = emptyClarification();
    state.draftOnly = true;
    formatClarification(draft, state, ChallengeSchema.parse({ goal }));

    expect(state.specification).toContain("# 需求草稿");
    for (const heading of [
      "可行性分析",
      "已确认需求（正式依据）",
      "产品与实施规划",
      "风险、假设与待核实",
    ])
      expect(state.specification).toContain(`## ${heading}`);
    expect(state.specification).toContain("需求确认只代表用户同意该要求，不证明技术上可实现");
    expect(state.specification).toContain("5. 发布复盘");
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps report suggestions, conflicts and unread materials visible outside confirmed facts", () => {
    const draft = create();
    draft.attachments = [
      {
        id: "incomplete-material",
        name: "未读材料.pdf",
        size: 12,
        state: "needs_pages",
        imageCount: 0,
        interpreted: false,
        locations: [],
        warnings: [],
        error: "缺少第2页",
      },
    ];
    const state = emptyClarification();
    state.draftOnly = true;
    state.suggestions = ["建议购买外部服务"];
    state.conflicts = ["用户对公开范围的回答冲突"];
    formatClarification(draft, state, ChallengeSchema.parse({ goal }));

    const facts = state.specification.split("## 已确认需求（正式依据）\n")[1].split("\n## ")[0];
    expect(facts).not.toContain(state.suggestions[0]);
    expect(facts).not.toContain(state.conflicts[0]);
    expect(state.specification).toContain("AI 建议/假设（待确认或验证）：建议购买外部服务");
    expect(state.specification).toContain("冲突（待解决）：用户对公开范围的回答冲突");
    expect(state.specification).toContain("材料缺口：未读材料.pdf — 缺少第2页");
    expect(state.specification).toContain("材料处理缺口：未读材料.pdf — 缺少第2页");
    expect(state.specification).not.toContain("综合判断：需求覆盖较完整");
    expect(state.executionPrompt).not.toContain(state.suggestions[0]);
  });

  it("keeps original input and unconfirmed summary values out of the confirmed-facts section", () => {
    const draft = create("原始目标尚待细化，请继续向我提问");
    const state = emptyClarification();
    state.draftOnly = true;
    const inferred = ChallengeSchema.parse({
      goal: draft.goal,
      constraints: "模型推断必须购买收费服务",
      preferences: "模型推断采用炫彩风格",
    });
    formatClarification(draft, state, inferred);

    const facts = state.specification.split("## 已确认需求（正式依据）\n")[1].split("\n## ")[0];
    expect(state.specification).toContain(`## 原始输入目标（未自动视为确认）\n${draft.goal}`);
    expect(facts).not.toContain(draft.goal);
    expect(facts).not.toContain(inferred.constraints);
    expect(facts).not.toContain(inferred.preferences);
    expect(facts).toContain("尚无正式确认摘要或已确认回答");
  });

  it("does not report complete coverage before C has reviewed the current requirements", () => {
    const draft = create();
    const state = emptyClarification();
    state.draftOnly = true;
    formatClarification(draft, state, ChallengeSchema.parse({ goal }));

    expect(state.review).toBeNull();
    expect(state.specification).toContain("功能：尚未完成 C 角色查漏");
    expect(state.specification).toContain("内容：尚未完成 C 角色查漏");
    expect(state.specification).toContain("流程：尚未完成 C 角色查漏");
    expect(state.specification).not.toContain("需求层面已覆盖");
    expect(state.specification).not.toContain("综合判断：需求覆盖较完整");
  });

  it("preserves unknown confirmed budget and time as evidence gaps", () => {
    const summary = ChallengeSchema.parse({ goal, budget: null, timeHours: null });
    const draft: IntakeDraft = {
      ...create(),
      challenge: summary,
      confirmation: {
        history: [],
        summary: { revision: 1, confirmedAt: new Date().toISOString(), challenge: summary },
      },
    };
    const state = emptyClarification();
    formatClarification(draft, state, summary);

    expect(state.specification).not.toContain("授权与资源：已覆盖");
    expect(state.specification).toContain("预算边界：未知");
    expect(state.specification).toContain("时间边界：未知");
    expect(state.specification).not.toContain("综合判断：需求覆盖较完整");
    expect(state.executionPrompt).not.toContain("金额上限（人民币元） — 0");
    expect(state.executionPrompt).not.toContain("时间上限（小时） — 0");
  });

  it("withholds pending summary and retired answers from confirmed report facts", () => {
    const summary = ChallengeSchema.parse({
      goal,
      constraints: "未确认的公开报名要求",
      budget: 300,
      timeHours: 12,
    });
    const draft: IntakeDraft = {
      ...create(),
      challenge: summary,
      confirmation: {
        history: [],
        summary: { revision: 1, confirmedAt: new Date().toISOString(), challenge: summary },
        pendingSummaryFields: ["goal", "constraints", "budget", "timeHours"],
      },
    };
    const retired = item("retired_detail", "content", "旧版收集内容");
    draft.answers = [
      {
        questionId: retired.id,
        question: question(retired),
        state: "answered",
        value: "旧版收集身份证号",
        confirmation: "confirmed",
      },
    ];
    const state = emptyClarification();
    state.items = [retired];
    state.retiredIds = [retired.id];
    state.draftOnly = true;
    formatClarification(draft, state, summary);

    const facts = state.specification.split("## 已确认需求（正式依据）\n")[1].split("\n## ")[0];
    expect(facts).not.toContain(summary.goal);
    expect(facts).not.toContain(summary.constraints);
    expect(facts).not.toContain("金额上限（人民币元） — 300");
    expect(facts).not.toContain("旧版收集身份证号");
    expect(state.specification).toContain("要求的摘要修改尚待确认");
    expect(state.specification).toContain("金额的摘要修改尚待确认");
    expect(state.specification).toContain("预算边界：未知");
    expect(state.specification).toContain("时间边界：未知");
    expect(state.executionPrompt).not.toContain(`用户确认摘要：${summary.goal}`);
  });

  it("requires confirmation of undecided tasks and preserves explicit delegation boundaries", () => {
    const draft = create();
    const state = emptyClarification();
    state.draftOnly = true;
    state.items = [item("storage", "function", "如何保存报名信息")];
    formatClarification(draft, state, ChallengeSchema.parse({ goal }));

    expect(state.specification).toContain(
      "未确认事项先向用户确认；用户已明确授权自定的事项，按授权范围处理并记录依据",
    );
    expect(state.specification).not.toContain("采用可撤销默认值");
    expect(state.executionPrompt).toContain("未决，不得擅自决定");
    expect(state.executionPrompt).toContain("当前为草稿/预览，禁止直接执行");
  });

  it("keeps legacy C reports readable while requiring report fields in the strict output schema", () => {
    const legacy = { summary: "旧查漏记录", ready: false, coverage: [], gaps: [], conflicts: [] };
    const parsed = HandoffReviewSchema.parse(legacy);
    const strict = toStrictToolSchema(z.toJSONSchema(HandoffReviewSchema));
    const reportFields = ["feasibility", "implementationPlan", "tradeoffs", "risks"] as const;
    for (const field of reportFields) {
      expect(parsed[field]).toEqual([]);
      expect(strict.required).toContain(field);
    }
    expect(JSON.stringify(strict)).not.toContain('"default"');
    expect(strict.additionalProperties).toBe(false);
    expect(
      HandoffReviewSchema.safeParse({
        ...legacy,
        feasibility: [{ dimension: "technical", status: "supported" }],
      }).success,
    ).toBe(false);
  });

  it("exports every confirmed advanced summary field including zero while withholding pending or inferred values", () => {
    // Stored zero-hour records remain readable. New inputs keep the existing positive-hour validator.
    const summary = {
      ...ChallengeSchema.parse({
        goal: "准备一份已经确定范围的汇报文稿",
        budget: 0,
        timeHours: 12,
        options: ["文字报告", "演示文稿"],
        domain: "work",
      }),
      timeHours: 0,
    };
    const draft: IntakeDraft = {
      ...create(summary.goal),
      challenge: summary,
      confirmation: {
        history: [],
        summary: { revision: 1, confirmedAt: new Date().toISOString(), challenge: summary },
      },
    };
    const inferred = {
      ...summary,
      budget: 999,
      timeHours: 888,
      options: ["模型建议的备选"],
      domain: "creation" as const,
    };
    const state = emptyClarification();
    formatClarification(draft, state, inferred);
    for (const output of [state.specification, state.executionPrompt]) {
      expect(output).toContain("金额上限（人民币元） — 0");
      expect(output).toContain("时间上限（小时） — 0");
      expect(output).toContain("备选方案 — 文字报告、演示文稿");
      expect(output).toContain("成果领域 — 工作业务");
      expect(output).not.toContain("999");
      expect(output).not.toContain("888");
      expect(output).not.toContain("模型建议的备选");
    }
    draft.confirmation!.pendingSummaryFields = ["budget", "timeHours", "options", "domain"];
    formatClarification(draft, state, inferred);
    for (const label of ["金额上限（人民币元）", "时间上限（小时）", "备选方案", "成果领域"])
      expect(state.executionPrompt).not.toContain(`已确认${label} —`);
    expect(state.specification).toContain("金额的摘要修改尚待确认");
    delete draft.confirmation!.summary;
    draft.confirmation!.pendingSummaryFields = [];
    formatClarification(draft, state, inferred);
    expect(state.executionPrompt).not.toContain("金额上限（人民币元）");
    expect(state.executionPrompt).not.toContain("时间上限（小时）");
  });

  it("does not promote unconfirmed challenge fields or model-derived sources into confirmed facts", () => {
    const draft = create();
    draft.challenge = ChallengeSchema.parse({
      goal: "模型暂时整理出的项目目标描述",
      constraints: "模型暂时推断的硬性要求",
      preferences: "模型暂时推断的视觉偏好",
      budget: null,
      timeHours: null,
    });
    draft.sources = [
      {
        id: "S-doc",
        attachmentId: "a1",
        filename: "brief.md",
        location: "第 1 段",
        text: "原文",
        interpretation: false,
        origin: "document",
      },
      {
        id: "S-trans",
        attachmentId: "a2",
        filename: "scan.png",
        location: "第 1 页",
        text: "转录",
        interpretation: false,
        origin: "model_transcription",
      },
      {
        id: "S-interp",
        attachmentId: "a3",
        filename: "scan.png",
        location: "第 1 页",
        text: "解读",
        interpretation: true,
        origin: "model_interpretation",
      },
      {
        id: "S-unknown",
        attachmentId: "a4",
        filename: "old.pdf",
        location: "第 2 页",
        text: "来源未记录",
        interpretation: false,
      },
    ];
    const state = emptyClarification();
    formatClarification(draft, state, draft.challenge);
    expect(state.specification).toContain("原始输入目标（未自动视为确认）");
    expect(state.specification).not.toContain("用户确认的摘要");
    expect(state.specification).not.toContain("模型暂时推断的硬性要求");
    expect(state.specification).toContain("附件原文（来源材料，不等同用户确认）");
    expect(state.specification).toContain("模型转录（需对照原图核验）");
    expect(state.specification).toContain("模型解读（推论，不作为原始事实）");
    expect(state.specification).toContain("来源不明（不可升级为原始事实）");
    expect(state.specification).toContain("尚未完成 C 角色查漏");
    expect(state.specification).toContain("预算上限未知");
    expect(state.specification).toContain("可投入时间未知");
    expect(state.executionPrompt).toContain("用户尚未确认正式摘要");
    expect(state.executionPrompt).not.toContain("模型暂时推断的视觉偏好");

    const reviewed = emptyClarification();
    reviewed.draftOnly = true;
    reviewed.review = {
      summary: "【AI分析】初步可行，但需验证 API 限制",
      ready: false,
      coverage: [],
      gaps: [],
      conflicts: [],
      feasibility: [
        {
          dimension: "technical",
          status: "conditional",
          assessment: "可采用现有系统能力，但尚未验证并发上限",
          basis: "依据原始目标和用户确认的功能范围；没有服务端压测数据",
          uncertainty: "实际并发能力未知",
          validation: "在目标环境执行 50 并发压力测试并记录 P95 延迟",
        },
      ],
      implementationPlan: [
        {
          phase: "最小闭环",
          objective: "验证用户主路径",
          tasks: ["实现提交表单", "保存结果"],
          dependencies: ["确认数据字段"],
          deliverables: ["可运行的端到端演示"],
          acceptance: ["成功提交后可读取结果"],
          estimate: "待验证，暂不承诺工时",
          estimateBasis: "尚无目标环境和人员投入信息",
          estimateUncertainty: "接口复杂度和数据权限未核实",
        },
      ],
      tradeoffs: [
        {
          decision: "数据保存方式",
          options: [
            { option: "本地保存", benefit: "实现简单", cost: "跨设备同步弱" },
            { option: "服务端保存", benefit: "便于管理", cost: "需要权限与隐私设计" },
          ],
          recommendation: "先根据是否需要跨设备管理再决定",
          basis: "目前用户未确认管理端需求",
          uncertainty: "数据保留期限和权限未知",
        },
      ],
      risks: [
        {
          risk: "个人信息被未授权访问",
          likelihood: "unknown",
          impact: "high",
          basis: "尚未确定访问角色与数据字段",
          mitigation: "先最小化采集并设计访问控制，再做安全测试",
          uncertainty: "具体数据类型和部署环境未明确",
        },
      ],
      fingerprint: "test-fingerprint",
      basedOnRevision: draft.revision,
    };
    formatClarification(draft, reviewed, draft.challenge!);
    expect(reviewed.specification).toContain("C 角色 AI 可行性初判（非实测）");
    expect(reviewed.specification).toContain("50 并发压力测试");
    expect(reviewed.specification).toContain("最小闭环");
    expect(reviewed.specification).toContain("数据保存方式");
    expect(reviewed.specification).toContain("个人信息被未授权访问");
    expect(reviewed.executionPrompt).toContain("AI 风险分析");

    const legacyReview = emptyClarification();
    legacyReview.review = {
      summary: "旧记录的 C 查漏摘要",
      ready: false,
      coverage: [],
      gaps: [],
      conflicts: [],
      fingerprint: "legacy",
      basedOnRevision: draft.revision,
    } as NonNullable<typeof legacyReview.review>;
    formatClarification(draft, legacyReview, draft.challenge!);
    expect(legacyReview.specification).toContain("C 角色未提供结构化技术评估");
  });

  it("omits retired answers from the new-mode API requirements while preserving legacy reading", async () => {
    const draft = await answeredDraft("真实报名");
    const snapshot = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    if (!("versions" in snapshot)) throw new Error("Expected test-double snapshot");
    const version = structuredClone(
      snapshot.versions.find((entry) => entry.id === snapshot.activeVersionId)!,
    );
    version.clarification!.retiredIds = ["real_fields"];
    version.intake!.confirmation!.summary!.challenge.constraints = "当前只交付界面演示";
    refreshRequirements(version);
    expect(version.requirements?.confirmed.join("\n")).not.toContain("真实报名需要收集哪些信息");
    const legacy = structuredClone(version);
    delete legacy.workflow;
    delete legacy.clarification;
    refreshRequirements(legacy);
    expect(legacy.requirements?.confirmed.join("\n")).toContain("真实报名需要收集哪些信息");
  });

  it("expresses an empty provided object in the strict schema while retaining optional legacy reads", async () => {
    const pending = {
      ...item("style", "style", "视觉风格"),
      provided: { sourceRef: "", quote: "" },
    };
    expect(DecisionItemSchema.parse(pending).provided).toEqual({ sourceRef: "", quote: "" });
    expect(DecisionItemSchema.parse(item("style", "style", "视觉风格")).provided).toBeUndefined();
    const strict = toStrictToolSchema(z.toJSONSchema(DecisionItemSchema));
    expect(strict.required).toContain("provided");
    const provided = (strict.properties as Record<string, Record<string, unknown>>).provided;
    expect(provided.required).toEqual(["sourceRef", "quote"]);
    const quote = (provided.properties as Record<string, Record<string, unknown>>).quote;
    expect(new RegExp(String(quote.pattern)).test("")).toBe(true);
    fixture.generate.mockImplementation(async (request) =>
      response(
        request.name === "clarification_decompose"
          ? { summary: "明确未决来源", items: [pending], retired: [], suggestions: [] }
          : {
              summary: "先问未决风格",
              questions: [question(pending, ["简洁正式", "活泼明亮"])],
              conflicts: [],
            },
      ),
    );
    const draft = await next(create("准备一份PPT，视觉风格还没有决定"));
    expect(draft.status).toBe("questions");
    expect(draft.questions[0].id).toBe("style");
  });

  it("reproduces unknown provided quotes from the simulated-input real run using explicit test doubles", async () => {
    // The provider output shape comes from real-model-smoke.json. Every call here is a test double.
    const topics: DecisionItem["topic"][] = [
      "scope",
      "content",
      "function",
      "flow",
      "style",
      "materials",
      "acceptance",
    ];
    const items = topics.map((topic, index) => ({
      ...item(`smoke_${topic}`, topic, `确认${topic}的具体要求`, index ? ["smoke_scope"] : []),
      provided: { sourceRef: "original_goal", quote: index ? "具体没想好" : "我想做一个个人网站" },
    }));
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_decompose")
        return response({
          summary: "重现真实输出中的未决引用",
          items,
          retired: [],
          suggestions: [],
        });
      const eligible = request.input.questionableItems as DecisionItem[];
      return response({
        summary: "对当前相关缺口生成选项",
        questions: eligible
          .slice(0, 3)
          .map((entry) => question(entry, ["先提供具体要求", "补充参考材料"])),
        conflicts: [],
      });
    });
    const draft = await next(create("【真实输出复现用测试替身】我想做一个个人网站，具体没想好。"));
    expect(draft.status).toBe("questions");
    expect(draft.questions.length).toBeGreaterThan(0);
    expect(draft.questions.length).toBeLessThanOrEqual(3);
    expect(draft.questions.map((entry) => entry.id)).toContain("smoke_content");
    expect(draft.clarification?.executionPrompt).not.toContain("- 具体没想好");
    expect(draft.clarification?.specification).not.toContain("- 具体没想好");
    expect(draft.clarification?.draftOnly).toBe(true);
    expect(draft.answers).toEqual([]);
  });

  it.each(["保留不知道和跳过选项", "未知事项要独立列出"])(
    "retains an explicit rule that mentions unknown states: %s",
    async (quote) => {
      const decision = {
        ...item("unknown_rule", "flow", "未知信息处理规则"),
        provided: { sourceRef: "original_goal", quote },
      };
      fixture.generate.mockImplementation(async (request) => {
        if (request.name === "clarification_decompose")
          return response({
            summary: "按本人明确规则拆解",
            items: [decision],
            retired: [],
            suggestions: [],
          });
        if (request.name === "clarification_options")
          return response({ summary: "该规则已明确，无需重复提问", questions: [], conflicts: [] });
        return response({
          summary: "独立检查明确规则",
          ready: true,
          coverage: ["function", "content", "flow", "style"].map((topic) => ({
            topic,
            applicable: topic === "flow",
            reason: "规则适用性检查",
            decisionIds: topic === "flow" ? [decision.id] : [],
          })),
          gaps: [],
          conflicts: [],
        });
      });
      const draft = await next(create(`实现一个需求细化工具，${quote}。`));
      expect(draft.status).toBe("summary");
      expect(draft.questions).toEqual([]);
      expect(draft.clarification?.review?.ready).toBe(true);
      expect(draft.clarification?.specification).toContain(`- ${quote}`);
      expect(draft.clarification?.executionPrompt).toContain(`- ${quote}`);
    },
  );

  it("keeps C's actual gaps unresolved across retries instead of accepting the same provided quote again", async () => {
    const scope = {
      ...item("review_scope", "scope", "网站主要服务什么目的？"),
      provided: { sourceRef: "original_goal", quote: "我想做一个个人网站" },
    };
    const content = {
      ...item("review_content", "content", "需要展示什么内容？", [scope.id]),
      provided: { sourceRef: "original_goal", quote: "具体没想好" },
    };
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_decompose")
        return response({
          summary: "明确标注的真实输出形状复现",
          items: [scope],
          retired: [],
          suggestions: [],
        });
      if (request.name === "clarification_options")
        return response({
          summary: "根据当前依赖提问",
          questions: (request.input.questionableItems as DecisionItem[])
            .slice(0, 3)
            .map((entry) => question(entry, ["展示个人作品", "发布学习文章"])),
          conflicts: [],
        });
      return response({
        summary: "C指出成果类型还没有说明具体用途",
        ready: false,
        coverage: ["scope", "function", "content", "flow", "style"].map((topic) => ({
          topic,
          applicable: topic === "scope" || topic === "content",
          reason: "测试重现查漏",
          decisionIds: topic === "scope" ? [scope.id] : topic === "content" ? [content.id] : [],
        })),
        gaps: [scope, content],
        conflicts: [],
      });
    });
    let draft = await next(create("【真实输出复现用测试替身】我想做一个个人网站，具体没想好。"));
    expect(draft.status).toBe("questions");
    expect(draft.questions.map((entry) => entry.id)).toEqual([scope.id]);
    expect(draft.clarification?.runs.map((run) => run.role)).toEqual(["A", "B", "C", "B"]);
    expect(
      draft.clarification?.items.find((entry) => entry.id === scope.id)?.provided,
    ).toBeUndefined();
    const recordedC = draft.clarification?.runs.find((run) => run.role === "C")?.output;
    expect(recordedC && "gaps" in recordedC ? recordedC.gaps[0].provided?.quote : "").toBe(
      scope.provided.quote,
    );
    draft = await next(draft);
    expect(draft.questions.map((entry) => entry.id)).toEqual([scope.id]);
    expect(draft.clarification?.executionPrompt).not.toContain(`- ${scope.provided.quote}`);
    draft = await next(answer(draft, { [scope.id]: "展示个人作品" }));
    expect(draft.questions.map((entry) => entry.id)).toContain(content.id);
    expect(draft.questions.map((entry) => entry.id)).not.toContain(scope.id);
    expect(draft.answers.find((entry) => entry.questionId === scope.id)?.confirmation).toBe(
      "confirmed",
    );
    expect(draft.answers.find((entry) => entry.questionId === scope.id)?.value).toBe(
      "展示个人作品",
    );
    expect(draft.clarification?.executionPrompt).toBe("");
  });

  async function crossDecisionReference(
    sourceRef = "html_file",
    sourceConfirmation: "confirmed" | "pending" = "confirmed",
    needsReconfirmation = false,
  ) {
    // Reproduces the saved shape of the 14-round real-model simulation, using test doubles only.
    const quote = "明确授权执行者在已确认范围内决定具体色值、字号和间距。";
    const source = {
      ...item("html_file", "scope", "希望保存为什么文件名？"),
      provided: { sourceRef: "", quote: "" },
    };
    const authorization = {
      ...item("implementation_authorization", "authorization", "哪些实现细节由执行者决定？", [
        source.id,
      ]),
      sourceRefs: [sourceRef],
      provided: { sourceRef, quote },
    };
    fixture.generate.mockImplementation(async (request) => {
      const hasAnswer = (request.input.answers as RecordedAnswer[]).some(
        (entry) => entry.questionId === source.id,
      );
      if (request.name === "clarification_decompose")
        return response({
          summary: "跨事项实际回答引用复现",
          items: hasAnswer ? [source, authorization] : [source],
          retired: [],
          suggestions: [],
        });
      if (request.name === "clarification_options")
        return response({
          summary: "仅询问真正待决定的事项",
          questions: (request.input.questionableItems as DecisionItem[]).map((entry) =>
            question(entry),
          ),
          conflicts: [],
        });
      return response({
        summary: "独立查漏意见",
        ready: true,
        coverage: ["scope", "function", "content", "flow", "style", "authorization"].map(
          (topic) => ({
            topic,
            applicable: topic === "scope" || topic === "authorization",
            reason: "依据已保存的实际确认检查",
            decisionIds:
              topic === "scope" ? [source.id] : topic === "authorization" ? [authorization.id] : [],
          }),
        ),
        gaps: [],
        conflicts: [],
      });
    });
    let draft = await next(
      create("【明确标注的模拟案例】准备一个本地展示的静态成果，具体实现要求逐项确认。"),
    );
    draft = answer(draft, { html_file: `文件名为 demo-portfolio.html。${quote}` });
    const row = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
      body: string;
    };
    const saved = JSON.parse(row.body) as IntakeDraft;
    saved.confirmation = {
      history: [],
      summary: {
        revision: 1,
        confirmedAt: new Date().toISOString(),
        challenge: ChallengeSchema.parse({ goal: saved.goal, constraints: quote }),
      },
      pendingSummaryFields: ["constraints"],
    };
    saved.answers[0].confirmation = sourceConfirmation;
    saved.answers[0].needsReconfirmation = needsReconfirmation;
    db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(JSON.stringify(saved), saved.id);
    return { draft: await next(draft), quote };
  }

  it("accepts a verbatim cross-decision confirmed answer despite pending aggregate summary confirmation", async () => {
    const referenced = await crossDecisionReference();
    let { draft } = referenced;
    const { quote } = referenced;
    expect(draft.status).toBe("summary");
    expect(draft.questions).toEqual([]);
    expect(draft.clarification?.draftOnly).toBe(true);
    expect(draft.clarification?.review?.ready).toBe(false);
    expect(draft.confirmation?.pendingSummaryFields).toContain("constraints");
    expect(draft.answers.find((entry) => entry.questionId === "html_file")).toMatchObject({
      confirmation: "confirmed",
      needsReconfirmation: false,
    });
    expect(draft.clarification?.executionPrompt).toContain(`- ${quote}`);
    draft = await next(draft);
    expect(draft.questions).toEqual([]);
    expect(draft.clarification?.review?.ready).toBe(false);
    const submitted = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    if (!("versions" in submitted))
      throw new Error("Explicit summary confirmation should complete the test handoff");
    const version = submitted.versions.find((entry) => entry.id === submitted.activeVersionId)!;
    expect(version.clarification?.review?.ready).toBe(true);
    expect(version.status).toBe("completed");
  });

  it.each([
    { sourceRef: "html_file", confirmation: "pending" as const, invalidated: false },
    { sourceRef: "html_file", confirmation: "confirmed" as const, invalidated: true },
    { sourceRef: "confirmed_summary", confirmation: "confirmed" as const, invalidated: false },
  ])(
    "continues to protect invalidated answer or pending-summary sources: %o",
    async ({ sourceRef, confirmation, invalidated }) => {
      const { draft, quote } = await crossDecisionReference(sourceRef, confirmation, invalidated);
      expect(draft.status).toBe("questions");
      expect(draft.questions.length).toBeGreaterThan(0);
      expect(draft.clarification?.review?.ready ?? false).toBe(false);
      expect(draft.clarification?.draftOnly).toBe(true);
      expect(draft.clarification?.executionPrompt).not.toContain(`- ${quote}`);
    },
  );

  function scopeWithPendingSummary(
    pendingSummaryFields: NonNullable<IntakeDraft["confirmation"]>["pendingSummaryFields"] = [
      "constraints",
    ],
    challengeGoal = "我想做一个个人网站，具体没想好。",
    quote = "我想做一个个人网站",
    reviewGap = false,
  ) {
    // Explicit test double for the saved original-goal scope source and aggregate pending shape.
    const scope = {
      ...item("site_type", "scope", "确认要制作的成果类型"),
      sourceRefs: ["original_goal"],
      provided: { sourceRef: "original_goal", quote },
    };
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_decompose")
        return response({
          summary: "已知目标来源的测试替身",
          items: [scope],
          retired: [],
          suggestions: [],
        });
      if (request.name === "clarification_options")
        return response({
          summary: "按当前待问事项排题",
          questions: (request.input.questionableItems as DecisionItem[]).map((entry) =>
            question(entry),
          ),
          conflicts: [],
        });
      return response({
        summary: "独立检查摘要确认状态",
        ready: !reviewGap,
        coverage: ["scope", "function", "content", "flow", "style"].map((topic) => ({
          topic,
          applicable: topic === "scope",
          reason: "测试目标来源覆盖",
          decisionIds: topic === "scope" ? [scope.id] : [],
        })),
        gaps: reviewGap ? [scope] : [],
        conflicts: [],
      });
    });
    const draft = create("我想做一个个人网站，具体没想好。");
    draft.challenge = ChallengeSchema.parse({ goal: challengeGoal, constraints: "已补充的内容" });
    draft.confirmation = {
      history: [],
      summary: {
        revision: draft.revision,
        confirmedAt: new Date().toISOString(),
        challenge: { ...draft.challenge, constraints: "上一版内容" },
      },
      pendingSummaryFields,
    };
    db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(JSON.stringify(draft), draft.id);
    return { draft, scope };
  }

  it.each([
    { pending: ["constraints"] },
    // The public simulation's round 8 marked goal dirty although all three goal values match.
    { pending: ["goal", "constraints"] },
    { pending: ["goal", "domain", "constraints"] },
  ] as const)(
    "does not reask unchanged scope while summary fields remain pending: %o",
    async ({ pending }) => {
      const seeded = scopeWithPendingSummary([...pending]);
      let draft = await next(seeded.draft);
      expect(draft.status).toBe("summary");
      expect(draft.questions).toEqual([]);
      expect(draft.clarification?.review?.ready).toBe(false);
      expect(draft.clarification?.draftOnly).toBe(true);
      expect(draft.confirmation?.pendingSummaryFields).toEqual([...pending]);
      expect(draft.clarification?.executionPrompt).not.toContain(
        `- ${seeded.scope.provided.quote}`,
      );
      expect(draft.clarification?.specification).toContain("要求的摘要修改尚待确认");
      draft = await next(draft);
      expect(draft.questions).toEqual([]);
      expect(draft.clarification?.review?.ready).toBe(false);
      const submitted = await submitClarificationIntake(draft.id, owner, {
        revision: draft.revision,
        challenge: draft.challenge!,
        assumptions: draft.assumptions,
      });
      if (!("versions" in submitted)) throw new Error("Explicit summary submission should finish");
      const version = submitted.versions.find((entry) => entry.id === submitted.activeVersionId)!;
      expect(version.clarification?.review?.ready).toBe(true);
      expect(version.clarification?.executionPrompt).toContain(`- ${seeded.scope.provided.quote}`);
    },
  );

  it.each([
    { pending: ["constraints"], goal: "我想做一个个人网站，具体没想好。", quote: "具体没想好" },
    { pending: ["goal", "constraints"], goal: "我想做一个个人网站，改为销售产品" },
    { pending: ["domain", "constraints"], changedDomain: "work" },
    { pending: ["constraints"], goal: "改为制作一份用于汇报的PPT" },
    { pending: ["goal", "constraints"], withoutSummary: true },
    { pending: ["domain", "constraints"], withoutSummary: true },
    { pending: ["goal", "constraints"], confirmedGoal: "上一版是制作一份演示文稿" },
  ] as const)("still asks when the current goal is unknown or changed: %o", async (entry) => {
    const { draft, scope } = scopeWithPendingSummary(
      [...entry.pending],
      "goal" in entry ? entry.goal : undefined,
      "quote" in entry ? entry.quote : undefined,
    );
    if ("changedDomain" in entry && entry.changedDomain)
      draft.challenge!.domain = entry.changedDomain;
    if ("withoutSummary" in entry) delete draft.confirmation!.summary;
    if ("confirmedGoal" in entry && entry.confirmedGoal)
      draft.confirmation!.summary!.challenge.goal = entry.confirmedGoal;
    db().prepare("UPDATE intake_drafts SET body=? WHERE id=?").run(JSON.stringify(draft), draft.id);
    const result = await next(draft);
    expect(result.status).toBe("questions");
    expect(result.questions.map((question) => question.id)).toContain(scope.id);
    expect(result.clarification?.review?.ready ?? false).toBe(false);
  });

  it("still asks C's concrete gap even when the original goal is otherwise known", async () => {
    const { draft, scope } = scopeWithPendingSummary(undefined, undefined, undefined, true);
    const result = await next(draft);
    expect(result.questions.map((question) => question.id)).toContain(scope.id);
    expect(
      result.clarification?.items.find((item) => item.id === scope.id)?.provided,
    ).toBeUndefined();
    expect(result.clarification?.runs.map((run) => run.role)).toEqual(["A", "B", "C", "B"]);
    expect(result.clarification?.review?.ready).toBe(false);
  });

  it("keeps a newer saved answer when a prior A response returns after the draft revision changed", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    fixture.generate.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof response>>((done) => {
          resolve = done;
        }),
    );
    const created = create();
    const running = next(created);
    const row = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(created.id) as {
      body: string;
    };
    const newer = JSON.parse(row.body) as IntakeDraft;
    newer.status = "input";
    newer.revision++;
    newer.goal = "新的本人目标，旧结果不得覆盖";
    newer.answers = [
      {
        questionId: "purpose",
        question: question(item("purpose", "scope", "需要真实报名还是仅做界面演示？"), [
          "真实报名",
          "仅做界面演示",
        ]),
        state: "answered",
        value: "仅做界面演示",
        confirmation: "confirmed",
      },
    ];
    db()
      .prepare("UPDATE intake_drafts SET body=? WHERE id=?")
      .run(JSON.stringify(newer), created.id);
    resolve(response(modelValue("clarification_decompose", { originalGoal: goal, answers: [] })));
    const result = await running;
    expect(result.goal).toBe(newer.goal);
    expect(result.revision).toBe(newer.revision);
    expect(result.answers).toEqual(newer.answers);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(getIntake(created.id, owner).answers).toEqual(newer.answers);
  });

  it("labels an explicitly requested early handoff as a draft with unresolved decisions", async () => {
    const created = create();
    const draft = await analyzeIntake(created.id, owner, { ...operation(created), finish: true });
    expect(draft.status).toBe("summary");
    expect(draft.clarification?.draftOnly).toBe(true);
    expect(draft.clarification?.runs.some((run) => run.role === "C")).toBe(true);
    expect(draft.clarification?.specification).toContain("需求草稿");
    expect(draft.clarification?.specification).toContain("阻塞交接");
    expect(draft.answers).toEqual([]);
    const result = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect("versions" in result).toBe(true);
    const saved = getIntake(draft.id, owner);
    expect(saved.clarification?.draftOnly).toBe(true);
    expect(saved.clarification?.specification).toContain("需求草稿");
    expect(saved.answers).toEqual([]);
  });

  it("repairs the recorded seven-option B format failure once without rerunning A or truncating choices", async () => {
    // Reproduction of the real simulated-input failure. These calls are explicit test doubles.
    let draft = await next(create());
    const feedback = "questions.1.options: too_big（最多6项；maximum=6；实收7项）";
    let rejectedOutput = "";
    fixture.generate.mockImplementation(async (request) => {
      const value = modelValue(request.name, request.input);
      if (request.name !== "clarification_options") return response(value);
      if (!request.input.repairFeedback) {
        const rejected = structuredClone(value) as { questions: IntakeQuestion[] };
        rejected.questions[1].options = [
          "旧选项一",
          "旧选项二",
          "旧选项三",
          "旧选项四",
          "旧选项五",
          "旧选项六",
          "旧选项七",
        ];
        rejectedOutput = JSON.stringify(rejected);
        expect(request.allowRepair).toBe(true);
        throw new ModelCallError("模拟记录中的选项数量错误", false, response(null).usage, {
          feedback,
          rejectedOutput,
        });
      }
      expect(request.allowRepair).toBe(false);
      expect(request.input.repairFeedback).toBe(feedback);
      expect(request.input.rejectedOutput).toBe(rejectedOutput);
      return response(value);
    });
    draft = await next(answer(draft, { purpose: "真实报名" }));
    expect(draft.status).toBe("questions");
    expect(draft.questions.find((entry) => entry.id === "real_fields")?.options).toEqual([
      "姓名与联系方式",
      "仅收集昵称",
    ]);
    const runs = draft.clarification!.runs;
    const failed = runs.find((run) => run.role === "B" && run.status === "failed")!;
    const repaired = runs.find((run) => run.repairOf === failed.id)!;
    expect(repaired.status).toBe("completed");
    expect(repaired.id).not.toBe(failed.id);
    expect(repaired.basedOnRevision).toBe(failed.basedOnRevision);
    expect("error" in failed.output && failed.output.repair?.rejectedOutput).toBe(rejectedOutput);
    for (const run of [failed, repaired]) {
      expect(run.callIds).toEqual([run.id]);
      expect(run.usage).toHaveLength(1);
    }
    expect(
      fixture.generate.mock.calls.filter(([request]) => request.name === "clarification_decompose"),
    ).toHaveLength(2);
    expect(
      fixture.generate.mock.calls.filter(([request]) => request.name === "clarification_options"),
    ).toHaveLength(3);
    expect(draft.usage).toHaveLength(5);
    expect(draft.usage.reduce((sum, usage) => sum + (usage.estimatedUsd ?? 0), 0)).toBeCloseTo(
      0.005,
    );
    expect(draft.reservedUsd).toBe(0);
    expect(db().prepare("SELECT kind,state FROM intake_calls ORDER BY rowid").all()).toMatchObject([
      { state: "completed" },
      { state: "completed" },
      { state: "completed" },
      { state: "failed" },
      { state: "completed" },
    ]);
  });

  it("stops after the one allowed role repair fails and preserves both paid failures", async () => {
    const repair = {
      feedback: "questions.0.options: too_big",
      rejectedOutput: "明确标注的两次格式失败测试",
    };
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_options")
        throw new ModelCallError("测试格式仍无效", false, response(null).usage, repair);
      return response(modelValue(request.name, request.input));
    });
    const draft = await next(create());
    expect(draft.status).toBe("failed");
    expect(draft.clarification?.runs.map((run) => [run.role, run.status])).toEqual([
      ["A", "completed"],
      ["B", "failed"],
      ["B", "failed"],
    ]);
    const failed = draft.clarification!.runs.filter((run) => run.role === "B");
    expect(failed[1].repairOf).toBe(failed[0].id);
    expect(fixture.generate).toHaveBeenCalledTimes(3);
    expect(fixture.generate.mock.calls[2][0].allowRepair).toBe(false);
    expect(draft.usage).toHaveLength(3);
    expect(draft.questions).toEqual([]);
  });

  it.each([
    { name: "unknown provider outcome", uncertain: true },
    { name: "known network failure without format metadata", uncertain: false },
  ])("does not retry a role for $name", async ({ uncertain }) => {
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_options")
        throw new ModelCallError(
          "模拟网络或调用结果未知",
          uncertain,
          undefined,
          uncertain ? { feedback: "不得据此重试", rejectedOutput: "" } : undefined,
        );
      return response(modelValue(request.name, request.input));
    });
    const draft = await next(create());
    expect(draft.status).toBe(uncertain ? "uncertain" : "failed");
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(draft.clarification?.runs).toHaveLength(2);
    expect(draft.clarification?.runs.some((run) => run.repairOf)).toBe(false);
  });

  it("retains A's completed work and recorded failure when B fails instead of inventing questions", async () => {
    fixture.generate.mockImplementation(async (request) => {
      if (request.name === "clarification_options")
        throw new ModelCallError("Explicit synthetic B failure", false, response(null).usage);
      return response(modelValue(request.name, request.input));
    });
    const created = create();
    const failed = await next(created);
    expect(failed.status).toBe("failed");
    expect(
      failed.clarification?.runs.map((run) => ({ role: run.role, status: run.status })),
    ).toEqual([
      { role: "A", status: "completed" },
      { role: "B", status: "failed" },
    ]);
    expect(failed.questions).toEqual([]);
    expect(db().prepare("SELECT kind,state FROM intake_calls ORDER BY rowid").all()).toMatchObject([
      { state: "completed" },
      { state: "failed" },
    ]);
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
