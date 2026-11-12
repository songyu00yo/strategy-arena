/** Real isolated SQLite and explicit model test doubles. No provider or public-search request. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionItem, HandoffReview } from "../src/lib/clarification-contracts";
import type { IntakeDraft, IntakeQuestion } from "../src/lib/intake-contracts";
import { closeDb, db } from "../src/lib/server/db";
import { createArena, newVersion } from "../src/lib/server/runtime";

const fixture = vi.hoisted(() => ({ generate: vi.fn(), gap: false }));
vi.mock("../src/lib/server/model", async (original) => ({
  ...(await original<typeof import("../src/lib/server/model")>()),
  generateStructured: fixture.generate,
}));
import { ModelCallError } from "../src/lib/server/model";
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
