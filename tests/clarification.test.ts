/** Real isolated SQLite and explicit model test doubles. No provider or public-search request. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DecisionItemSchema,
  type DecisionItem,
  type HandoffReview,
} from "../src/lib/clarification-contracts";
import { toStrictToolSchema } from "../src/lib/server/strict-schema";
import type { IntakeDraft, IntakeQuestion, RecordedAnswer } from "../src/lib/intake-contracts";
import { closeDb, db } from "../src/lib/server/db";
import { createArena, newVersion, refreshRequirements } from "../src/lib/server/runtime";
import {
  emptyClarification,
  formatClarification,
  runClarification,
} from "../src/lib/server/clarification";
import { ChallengeSchema } from "../src/lib/contracts";

const fixture = vi.hoisted(() => ({ generate: vi.fn(), gap: false }));
vi.mock("../src/lib/server/model", async (original) => ({
  ...(await original<typeof import("../src/lib/server/model")>()),
  generateStructured: fixture.generate,
}));
import { ModelCallError, resolveModelConfig } from "../src/lib/server/model";
import {
  analyzeIntake,
  createIntake,
  getIntake,
  submitClarificationIntake,
  updateIntake,
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

  it("reconfirms changed requirements and delivers a new version within the same task", async () => {
    const draft = await answeredDraft();
    const first = await submitClarificationIntake(draft.id, owner, {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    if (!("versions" in first)) throw new Error("Expected explicit test-double handoff snapshot");
    const original = first.versions.find((version) => version.id === first.activeVersionId)!;
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
    expect(draft.clarification?.specification).toContain("偏好与风格的摘要修改尚待确认");
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
    expect(confirmed.state.executionPrompt).not.toContain("简洁正式");
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
      expect(result.state.executionPrompt).toContain("原始目标（相关修改待确认）");
      expect(result.state.executionPrompt).not.toContain(`- ${quote}`);
    },
  );

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
    expect(draft.clarification?.executionPrompt).toContain("展示个人作品");
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
