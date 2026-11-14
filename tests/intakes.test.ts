/** Service integration with an explicit structured-model test double; never sends network requests. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { atomic, closeDb, db } from "../src/lib/server/db";
import {
  IntakeAnalysisSchema,
  UpdateIntakeSchema,
  type IntakeDraft,
  type IntakeQuestion,
} from "../src/lib/intake-contracts";
const fixture = vi.hoisted(() => ({ generate: vi.fn(), hold: vi.fn() }));
vi.mock("../src/lib/server/model", async (original) => ({
  ...(await original<typeof import("../src/lib/server/model")>()),
  generateStructured: fixture.generate,
}));
vi.mock("../src/lib/server/billing", async (original) => ({
  ...(await original<typeof import("../src/lib/server/billing")>()),
  holdBilling: fixture.hold,
}));
import { ModelCallError } from "../src/lib/server/model";
import * as parser from "../src/lib/server/attachment-parser";
import {
  addIntakeAttachment,
  analyzeIntake,
  createIntake,
  createFollowUpIntake,
  getIntake,
  getIntakeAttachment,
  removeIntakeAttachment,
  selectIntakePages,
  submitIntake,
  updateIntake,
} from "../src/lib/server/intakes";
const goal = "在现有时间和预算内选择合适的入门课程";
function analysis(overrides: Partial<z.infer<typeof IntakeAnalysisSchema>> = {}) {
  return {
    ready: true,
    goal,
    constraints: "",
    preferences: "",
    options: [],
    domain: "learning" as const,
    budget: -1,
    budgetQuote: "",
    timeHours: -1,
    timeQuote: "",
    assumptions: [],
    questions: [],
    ...overrides,
  };
}
function question(id = "budget"): IntakeQuestion {
  return {
    id,
    title: `请确认${id}的限制`,
    reason: "会改变可行性",
    placeholder: "填写或跳过",
    type: "text",
    options: [],
    unit: "",
  };
}
function operation(draft: IntakeDraft, finish = false) {
  return { revision: draft.revision, operationId: randomUUID(), finish };
}
function result(value: unknown) {
  return {
    value,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      estimatedCny: 0,
      estimatedUsd: 0.001,
      provider: "openai",
      currency: "USD",
      model: "gpt-6.1-terra",
      responseId: "synthetic-intake",
      durationMs: 1,
    },
  };
}
beforeEach(() => {
  closeDb();
  vi.resetAllMocks();
  vi.stubEnv("ARENA_INTAKE_EXPIRY_ENABLED", undefined);
  for (const [key, value] of Object.entries({
    ARENA_DATABASE_PATH: ":memory:",
    OPENAI_API_KEY: "synthetic",
    DEEPSEEK_API_KEY: "synthetic",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL_ID: "gpt-6.1-terra",
    OPENAI_STRUCTURED_OUTPUT: "strict-tool",
    OPENAI_MAX_OUTPUT_TOKENS: "2200",
    OPENAI_REASONING_EFFORT: "low",
    OPENAI_INPUT_PRICE_PER_MILLION: "1",
    OPENAI_OUTPUT_PRICE_PER_MILLION: "5",
    MODEL_BASE_URL: "https://api.deepseek.com/beta",
    MODEL_ID: "deepseek-flash",
    MODEL_STRUCTURED_OUTPUT: "strict-tool",
    ARENA_DAILY_VISITOR_LIMIT: "30",
  }))
    vi.stubEnv(key, value);
  fixture.generate.mockResolvedValue(result(analysis()));
});
afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("guided task preparation with synthetic model output", () => {
  it("saves partial answers before a model change without inventing skipped or unknown answers", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const questions = [question("headcount"), question("permission"), question("untouched")];
    fixture.generate.mockResolvedValueOnce(result(analysis({ ready: false, questions })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "draft",
      answers: [
        { questionId: "headcount", state: "answered", value: "只有两名成员" },
        { questionId: "permission", state: "skipped", value: "" },
      ],
    });
    expect(draft).toMatchObject({ status: "questions", round: 1, questions });
    expect(draft.answers.map((answer) => answer.questionId)).toEqual(["headcount", "permission"]);
    expect(getIntake(draft.id, "alice").answers).toEqual(draft.answers);
    const recorded = structuredClone(draft.answers);
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, modelMode: "gpt-6.1-sol" });
    expect(draft.answers).toEqual(recorded);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    fixture.generate.mockResolvedValueOnce(result(analysis({ ready: false, questions })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.questions.map((entry) => entry.id)).toEqual(["untouched"]);
    expect(draft.answers).toEqual(recorded);
  });

  it("finishing a partially saved round preserves omitted draft answers without confirming them", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question()] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "draft",
      answers: [{ questionId: "budget", state: "answered", value: "100元" }],
    });
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, answers: [] });
    expect(draft.answers).toHaveLength(1);
    expect(draft.answers[0]).toMatchObject({
      questionId: "budget",
      state: "answered",
      value: "100元",
      confirmation: "pending",
    });
  });

  it("accepts the optional draft-save mode only with answers, keeping legacy completion compatible", () => {
    expect(UpdateIntakeSchema.safeParse({ revision: 0, answerMode: "draft" }).success).toBe(false);
    expect(
      UpdateIntakeSchema.safeParse({ revision: 0, answers: [], answerMode: "draft" }).success,
    ).toBe(true);
    expect(UpdateIntakeSchema.safeParse({ revision: 0, answers: [] }).success).toBe(true);
  });

  it("defaults to Terra, isolates owners and omits private configuration", () => {
    const draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    expect(draft).toMatchObject({
      goal,
      modelMode: "gpt-6.1-terra",
      revision: 0,
      status: "input",
      usage: [],
    });
    expect(() => getIntake(draft.id, "bob")).toThrow("无权访问");
    expect(draft).not.toHaveProperty("config");
  });
  it("continues beyond two rounds and only summarizes early on explicit request", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question()] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft).toMatchObject({ status: "questions", round: 1 });
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answers: [{ questionId: "budget", state: "unknown", value: "" }],
    });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question(), question("permission")] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.questions.map((item) => item.id)).toEqual(["permission"]);
    expect(draft.round).toBe(2);
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "complete",
      answers: [{ questionId: "permission", state: "skipped", value: "" }],
    });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question("another")] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft).toMatchObject({ status: "questions", round: 3 });
    expect(draft.answers.map((answer) => answer.state)).toEqual(["unknown", "skipped"]);
    expect(fixture.generate.mock.calls.at(-1)?.[0].input.mustSummarize).toBe(false);
    draft = await analyzeIntake(draft.id, "alice", operation(draft, true));
    expect(draft.status).toBe("summary");
    expect(draft.answers.at(-1)).toMatchObject({ questionId: "another", state: "skipped" });
    expect(draft.answers.every((answer) => answer.confirmation !== "confirmed")).toBe(true);
    expect(fixture.generate.mock.calls.at(-1)?.[0].input.mustSummarize).toBe(true);
  });
  it("validates current choice questions and invalidates them on goal edits", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(
        analysis({
          ready: false,
          questions: [{ ...question(), type: "single", options: ["100元", "200元"] }],
        }),
      ),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(() =>
      updateIntake(draft.id, "alice", {
        revision: draft.revision,
        answers: [{ questionId: "budget", state: "answered", value: "999元" }],
      }),
    ).toThrow("答案格式");
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      goal: "使用现有设备修复无法开机的电脑",
    });
    expect(draft).toMatchObject({ questions: [], answers: [], round: 0, status: "input" });
    expect(() =>
      updateIntake(draft.id, "alice", {
        revision: draft.revision,
        answers: [{ questionId: "budget", state: "answered", value: "100元" }],
      }),
    ).toThrow("没有等待回答");
  });
  it("persists a summary edit with revision protection and keeps materials server-owned", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const summary = {
      challenge: {
        goal,
        constraints: "只有两名成员",
        preferences: "先做最简单的本地版本",
        options: [],
        materials: "客户端伪造材料",
        domain: "general" as const,
        budget: 120,
        timeHours: 6,
      },
      assumptions: ["先核实是否已有合适设备"],
    };
    expect(() => updateIntake(draft.id, "alice", { revision: draft.revision, summary })).toThrow(
      "还没有可编辑的摘要",
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    const priorRevision = draft.revision;
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, summary });
    const restored = getIntake(draft.id, "alice");
    expect(restored.revision).toBe(priorRevision + 1);
    expect(restored.challenge).toMatchObject({
      constraints: "只有两名成员",
      preferences: "先做最简单的本地版本",
      budget: 120,
      timeHours: 6,
    });
    expect(restored.assumptions).toEqual(summary.assumptions);
    expect(restored.challenge!.materials).not.toContain("客户端伪造材料");
    expect(restored.challenge!.materials).toContain("用户明确保存的摘要修正");
    expect(() => updateIntake(draft.id, "alice", { revision: priorRevision, summary })).toThrow(
      "草稿已更新",
    );
    expect(() =>
      updateIntake(draft.id, "alice", { revision: draft.revision, goal, summary }),
    ).toThrow("单独保存任务摘要");
    expect(restored).not.toHaveProperty("summaryEdits");
  });
  it("preserves unresolved answers and explicit summary corrections when switching models", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question("headcount")] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answers: [{ questionId: "headcount", state: "unknown", value: "" }],
    });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question("permission")] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answers: [{ questionId: "permission", state: "skipped", value: "" }],
    });
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    const editedGoal = "使用现有两名成员完成基础课程与作品展示";
    const summary = {
      challenge: {
        ...draft.challenge!,
        goal: editedGoal,
        constraints: "只有两名成员，不得增人",
        preferences: "先验证设备，再考虑其他步骤",
        budget: 90,
      },
      assumptions: ["现有设备是否可用仍待核实"],
    };
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, summary });
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, modelMode: "gpt-6.1-sol" });
    expect(draft.answers.map((answer) => answer.state)).toEqual(["unknown", "skipped"]);
    expect(draft.round).toBe(2);
    fixture.generate.mockResolvedValueOnce(
      result(
        analysis({
          ready: false,
          goal: "雇用五名成员重做目标",
          constraints: "允许增至五名成员",
          preferences: "优先购买设备",
          questions: [question("headcount"), question("new_question")],
          assumptions: ["AI改写的旧假设"],
        }),
      ),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft, true));
    expect(draft).toMatchObject({ round: 2, status: "summary", questions: [] });
    expect(draft.challenge).toMatchObject({
      goal: editedGoal,
      constraints: "只有两名成员，不得增人",
      preferences: "先验证设备，再考虑其他步骤",
      budget: 90,
    });
    expect(draft.assumptions).toEqual(summary.assumptions);
    const call = fixture.generate.mock.calls.at(-1)![0];
    expect(call.input).toMatchObject({
      mustSummarize: true,
      answeredQuestionIds: ["headcount", "permission"],
      summaryEdits: {
        provenance: "user-edited-draft",
        fields: { constraints: "只有两名成员，不得增人" },
      },
    });
    expect(call.config.id).toBe("gpt-6.1-sol");
    expect(call.input.materials).toContain("当前硬限制：只有两名成员，不得增人");
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      goal: "改为准备一个独立的线下课程分享活动",
    });
    expect(draft).toMatchObject({ round: 0, answers: [], status: "input" });
  });
  it("never invents resource totals or silently rewrites a sufficiently detailed goal", async () => {
    let draft = createIntake("alice", {
      goal: "每周可投入5小时，希望选择一门合适的入门课程",
      modelMode: "gpt-6.1-terra",
    });
    fixture.generate.mockResolvedValueOnce(
      result(
        analysis({
          goal: "雇用三人完成商业产品",
          budget: 100,
          budgetQuote: "预算100元",
          timeHours: 5,
          timeQuote: "5小时",
        }),
      ),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.challenge).toMatchObject({
      goal: "每周可投入5小时，希望选择一门合适的入门课程",
      budget: null,
      timeHours: null,
    });
    expect(draft.assumptions.join(" ")).toContain("未换算为总工时");
    expect(draft.challenge?.materials).toContain(draft.goal);
  });
  it("does not turn savings or property into a spending budget", async () => {
    let draft = createIntake("alice", {
      goal: "选择一台合适电脑；存款50000元，愿意花多少未定",
      modelMode: "gpt-6.1-terra",
    });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ budget: 50000, budgetQuote: "存款50000元" })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.challenge?.budget).toBeNull();
    expect(draft.assumptions.join(" ")).toContain("支出上限");
  });
  it("accepts directly quoted total budgets and total hours", async () => {
    let draft = createIntake("alice", {
      goal: "完成课程学习；预算上限100元；总工时最多10小时",
      modelMode: "gpt-6.1-terra",
    });
    fixture.generate.mockResolvedValueOnce(
      result(
        analysis({
          budget: 100,
          budgetQuote: "预算上限100元",
          timeHours: 10,
          timeQuote: "总工时最多10小时",
        }),
      ),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.challenge).toMatchObject({ budget: 100, timeHours: 10 });
  });
  it.each([
    "我有12小时可用",
    "可用工时12小时",
    "共12小时可投入",
    "我有12小时可用，预计课程耗时8小时",
  ])("keeps a clear existing Chinese available-time statement: %s", async (source) => {
    let draft = createIntake("alice", {
      goal: `请按我已有的时间比较三条学习路线：${source}`,
      modelMode: "gpt-6.1-terra",
    });
    const timeQuote = source.split("，")[0];
    fixture.generate.mockResolvedValueOnce(result(analysis({ timeHours: 12, timeQuote })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.challenge?.timeHours).toBe(12);
  });
  it("keeps directly quoted English CNY and total-hour caps from the uploaded document", async () => {
    let draft = createIntake("alice", {
      goal: "请根据附件整理三条路线及明确资源上限",
      modelMode: "gpt-6.1-terra",
    });
    draft = await addIntakeAttachment(
      draft.id,
      "alice",
      Buffer.from("The spending cap is CNY 300; total work cap is 12 hours."),
      "brief.txt",
    );
    fixture.generate.mockResolvedValueOnce(
      result(
        analysis({
          budget: 300,
          budgetQuote: "The spending cap is CNY 300",
          timeHours: 12,
          timeQuote: "total work cap is 12 hours",
        }),
      ),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.challenge).toMatchObject({ budget: 300, timeHours: 12 });
    expect(draft.assumptions.join(" ")).not.toContain("未找到");
    const call = fixture.generate.mock.calls[0][0];
    expect(call.system).toContain("options最多3项");
    expect(call.system).toContain("assumptions最多6项");
    expect(call.system).toContain("英文来源也须原样引用");
  });
  it.each([
    {
      source: "Savings: CNY 50000. Spending budget is not yet decided.",
      value: { budget: 50000, budgetQuote: "Savings: CNY 50000" },
    },
    {
      source: "Vendor quote: CNY 300; estimated project duration: 12 hours.",
      value: {
        budget: 300,
        budgetQuote: "Vendor quote: CNY 300",
        timeHours: 12,
        timeQuote: "estimated project duration: 12 hours",
      },
    },
    {
      source: "My budget is USD 300; available work is 12 hours per week.",
      value: {
        budget: 300,
        budgetQuote: "My budget is USD 300",
        timeHours: 12,
        timeQuote: "12 hours",
      },
    },
    {
      source: "这门课程时长12小时，报价300元。",
      value: { budget: 300, budgetQuote: "报价300元", timeHours: 12, timeQuote: "课程时长12小时" },
    },
  ])(
    "does not convert savings, quotations, foreign currency or recurring/estimated duration into caps: $source",
    async ({ source, value }) => {
      let draft = createIntake("alice", {
        goal: "请根据现有材料比较三条可行学习路线",
        modelMode: "gpt-6.1-terra",
      });
      draft = await addIntakeAttachment(draft.id, "alice", Buffer.from(source), "facts.txt");
      fixture.generate.mockResolvedValueOnce(result(analysis(value)));
      draft = await analyzeIntake(draft.id, "alice", operation(draft));
      expect(draft.challenge).toMatchObject({ budget: null, timeHours: null });
    },
  );
  it("handles a short original goal with faithful expanded summary and retained original text", async () => {
    let draft = createIntake("alice", { goal: "我要减肥", modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ goal: "希望比较适合自己的体重管理行动路线" })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft, true));
    expect(draft.goal).toBe("我要减肥");
    expect(draft.challenge?.goal).toBe("希望比较适合自己的体重管理行动路线");
    expect(draft.challenge?.materials).toContain("用户原始目标：我要减肥");
  });
  it("keeps a model-format normalization record private while persisting its original parameters", async () => {
    const draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const original = `${JSON.stringify(analysis())}}`;
    fixture.generate.mockResolvedValueOnce({
      ...result(analysis()),
      formatNormalization: {
        kind: "single-redundant-trailing-object-brace",
        originalOutput: original,
        originalOutputSha256: "synthetic-hash",
        removedSuffix: "}",
        removedOffset: original.length - 1,
      },
    });
    const prepared = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(prepared.status).toBe("summary");
    const call = db()
      .prepare(
        "SELECT c.usage FROM intake_calls c JOIN intake_operations o ON o.id=c.operation_id WHERE o.draft_id=?",
      )
      .get(draft.id) as { usage: string };
    expect(JSON.parse(call.usage).formatNormalization).toMatchObject({
      originalOutput: original,
      removedSuffix: "}",
    });
    expect(JSON.stringify(prepared)).not.toContain("originalOutput");
  });
  it("deduplicates in-flight and completed operations and rejects reused payloads", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    fixture.generate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const initial = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const op = operation(initial),
      promise = analyzeIntake(initial.id, "alice", op);
    const duplicate = await analyzeIntake(initial.id, "alice", op);
    expect(duplicate.status).toBe("analyzing");
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(() =>
      updateIntake(initial.id, "alice", {
        revision: duplicate.revision,
        goal: "新的不同目标要修改",
      }),
    ).toThrow("正在读取");
    finish(result(analysis()));
    const completed = await promise;
    expect((await analyzeIntake(initial.id, "alice", op)).revision).toBe(completed.revision);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    await expect(analyzeIntake(initial.id, "alice", { ...op, finish: true })).rejects.toThrow(
      "另一份输入",
    );
  });
  it("keeps uncertain reservations and never automatically retries the paid request", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockRejectedValueOnce(new ModelCallError("合成连接中断，完成状态未知", true));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.status).toBe("uncertain");
    expect(draft.reservedUsd).toBeGreaterThan(0);
    await expect(analyzeIntake(draft.id, "alice", operation(draft))).rejects.toThrow("结果待确认");
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });
  it("freezes the complete model configuration and refuses drift before another bill", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question()] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, answers: [] });
    vi.stubEnv("OPENAI_MAX_OUTPUT_TOKENS", "2400");
    await expect(analyzeIntake(draft.id, "alice", operation(draft))).rejects.toThrow("配置已变化");
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });
  it("recovers a process interruption conservatively and still records late actual usage", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    fixture.generate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const op = operation(draft),
      promise = analyzeIntake(draft.id, "alice", op);
    db()
      .prepare("UPDATE intake_operations SET updated_at=? WHERE id=?")
      .run(Date.now() - 600000, op.operationId);
    expect(getIntake(draft.id, "alice").status).toBe("uncertain");
    expect(fixture.hold).toHaveBeenCalledTimes(1);
    finish(result(analysis()));
    const late = await promise;
    expect(late.status).toBe("uncertain");
    expect(late.usage).toHaveLength(1);
    expect(late.reservedUsd).toBe(0);
  });
});
describe("attachment sources and atomic confirmation", () => {
  it("uses real filename/location headers, bounds materials and omits stored bytes/images", async () => {
    let draft = createIntake("alice", {
      goal: "比较火星拍摄计划的设备选择",
      modelMode: "gpt-6.1-terra",
    });
    const text = `${"普通说明没有关键信息。".repeat(2400)}\n火星拍摄计划需要先确认设备许可。`;
    draft = await addIntakeAttachment(draft.id, "alice", Buffer.from(text), "../计划材料.txt");
    expect(draft.attachments[0]).toMatchObject({ name: "计划材料.txt", state: "ready" });
    expect(draft.sources.some((source) => source.text.includes("火星拍摄计划需要先确认"))).toBe(
      true,
    );
    expect(JSON.stringify(draft)).not.toMatch(/data:image|"parsed"|"bytes"/);
    expect(draft.sources.every((source) => source.origin === "document")).toBe(true);
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.challenge!.materials.length).toBeLessThanOrEqual(20000);
    expect(draft.challenge!.materials).toContain("文件：计划材料.txt；位置：");
    for (const source of draft.sources) expect(draft.challenge!.materials).toContain(source.text);
    expect(draft.challenge!.materials).toContain("本次读取范围");
    expect(draft.sources.some((source) => source.location.includes("字符"))).toBe(true);
    expect(() => getIntakeAttachment(draft.id, "bob", draft.attachments[0].id)).toThrow("无权访问");
  });
  it("stores a corrupt file as failed and supports removal without losing the goal", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await addIntakeAttachment(draft.id, "alice", Buffer.from("bad-format"), "broken.png");
    expect(draft.attachments[0]).toMatchObject({ state: "failed" });
    expect(draft.attachments[0].error).toBeTruthy();
    draft = removeIntakeAttachment(draft.id, "alice", draft.attachments[0].id);
    expect(draft.attachments).toEqual([]);
    expect(draft.goal).toBe(goal);
  });
  it("limits PDF pages before invoking the parser and preserves an explicit selection state", async () => {
    const parsed = vi
      .spyOn(parser, "parseAttachment")
      .mockRejectedValueOnce(
        new parser.AttachmentParseError("needs_page_selection", "请选择页码", 50),
      );
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await addIntakeAttachment(draft.id, "alice", Buffer.from("synthetic-pdf"), "long.pdf");
    expect(draft.attachments[0]).toMatchObject({ state: "needs_pages", pageCount: 50 });
    await expect(analyzeIntake(draft.id, "alice", operation(draft))).rejects.toThrow("页码");
    await expect(
      selectIntakePages(draft.id, "alice", draft.attachments[0].id, [1, 1]),
    ).rejects.toThrow("不要重复");
    parsed.mockResolvedValueOnce({
      kind: "document",
      chunks: [{ location: "第 2 页", text: "只有此页被读取" }],
      images: [],
      warnings: ["只读第2页"],
      pageCount: 50,
    });
    draft = await selectIntakePages(draft.id, "alice", draft.attachments[0].id, [2]);
    expect(draft.sources[0]).toMatchObject({ location: "第 2 页", text: "只有此页被读取" });
  });
  it("reuses billed image batches across question rounds and invalidates them when changing model", async () => {
    vi.spyOn(parser, "parseAttachment").mockResolvedValue({
      kind: "document",
      chunks: [{ location: "图像转录（需核对）!A1", text: "真实文档单元格文字" }],
      images: [
        { location: "图片1", width: 1, height: 1, dataUrl: "data:image/png;base64,c3ludGhldGlj" },
      ],
      warnings: [],
    });
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await addIntakeAttachment(
      draft.id,
      "alice",
      Buffer.from("synthetic-image"),
      "mixed.pdf",
    );
    fixture.generate
      .mockResolvedValueOnce(
        result({
          readings: [
            {
              location: "图片1",
              transcription: "预算100元",
              interpretation: "柱状图似乎比较成本",
              uncertain: "标签较模糊",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(result(analysis({ ready: false, questions: [question()] })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.attachments[0].interpreted).toBe(true);
    expect(draft.sources.find((source) => source.text === "真实文档单元格文字")).toMatchObject({
      origin: "document",
      interpretation: false,
    });
    expect(draft.sources.find((source) => source.text === "预算100元")).toMatchObject({
      origin: "model_transcription",
      interpretation: false,
    });
    expect(draft.sources.find((source) => source.interpretation)).toMatchObject({
      origin: "model_interpretation",
      interpretation: true,
    });
    expect(JSON.stringify(draft)).not.toContain("base64");
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, answers: [] });
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(
      fixture.generate.mock.calls.filter((call) => call[0].name === "read_material"),
    ).toHaveLength(1);
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, modelMode: "gpt-6.1-sol" });
    expect(draft.attachments[0].interpreted).toBe(false);
    expect(draft.sources).toHaveLength(1);
    expect(draft.sources[0]).toMatchObject({
      text: "真实文档单元格文字",
      origin: "document",
      interpretation: false,
    });
  });
  it("creates one arena on replay and stores the exact original goal, answers, sources and usage audit", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await addIntakeAttachment(
      draft.id,
      "alice",
      Buffer.from("仅使用现有设备，已有两名成员。"),
      "条件.txt",
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    const payload = {
      revision: draft.revision,
      challenge: { ...draft.challenge!, materials: "客户端伪造的材料" },
      assumptions: ["用户已确认的假设"],
    };
    const first = submitIntake(draft.id, "alice", payload),
      second = submitIntake(draft.id, "alice", payload);
    expect(second.id).toBe(first.id);
    expect(first.versions[0].intake).toMatchObject({
      id: draft.id,
      originalGoal: goal,
      assumptions: ["用户已确认的假设"],
      usage: [expect.objectContaining({ model: "gpt-6.1-terra" })],
    });
    expect(first.versions[0].challenge.materials).not.toContain("客户端伪造");
    expect(first.versions[0].challenge.materials).toContain("条件.txt");
    expect(first.versions[0].modelSelection?.modelId).toBe("gpt-6.1-terra");
    expect(getIntake(draft.id, "alice").status).toBe("submitted");
  });
  it("submits guided discussions for multiple owners beyond the disabled daily quota", async () => {
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "false");
    vi.stubEnv("ARENA_DAILY_VISITOR_LIMIT", "1");
    for (const owner of ["alice", "bob"]) {
      for (let index = 0; index < 2; index++) {
        let draft = createIntake(owner, { goal, modelMode: "gpt-6.1-terra" });
        draft = await analyzeIntake(draft.id, owner, operation(draft));
        const payload = { revision: draft.revision, challenge: draft.challenge!, assumptions: [] };
        const arena = submitIntake(draft.id, owner, payload);
        expect(submitIntake(draft.id, owner, payload).id).toBe(arena.id);
      }
      expect(db().prepare("SELECT count FROM visitor_runs WHERE owner=?").get(owner)).toMatchObject(
        {
          count: 2,
        },
      );
    }
    expect(fixture.generate).toHaveBeenCalledTimes(4);
  });
});

describe("explicit confirmation and linked follow-up with synthetic model output", () => {
  it.each([
    {
      selectedMode: "真实报名",
      confirmedScope: "同意仅在本次活动收集报名昵称，不公开或转交",
      expectedConstraint: "真实报名仅收集本次活动报名昵称，不公开或转交，不收集手机号，不用于营销",
    },
    {
      selectedMode: "仅界面演示",
      confirmedScope: "仅使用虚构数据，不接入真实报名服务，不收集真实信息",
      expectedConstraint: "仅界面演示，使用虚构数据，不接入真实报名服务，不收集或提交真实个人信息",
    },
  ])(
    "follows the explicitly submitted $selectedMode branch with a synthetic model",
    async ({ selectedMode, confirmedScope, expectedConstraint }) => {
      let draft = createIntake("alice", {
        goal: "【演示数据】我想制作活动报名页面，请逐步确认具体功能和使用范围",
        modelMode: "gpt-6.1-terra",
      });
      const modeQuestion: IntakeQuestion = {
        ...question("registration_mode"),
        title: "报名页面需要承担什么用途？",
        type: "single",
        options: ["真实报名", "仅界面演示"],
        affects: ["constraints", "options"],
      };
      fixture.generate.mockResolvedValueOnce(
        result(analysis({ ready: false, questions: [modeQuestion] })),
      );
      draft = await analyzeIntake(draft.id, "alice", operation(draft));
      expect(draft.answers).toEqual([]);
      draft = updateIntake(draft.id, "alice", {
        revision: draft.revision,
        answerMode: "complete",
        answers: [{ questionId: modeQuestion.id, state: "answered", value: selectedMode }],
      });
      expect(draft.answers[0]).toMatchObject({ confirmation: "confirmed", value: selectedMode });
      // This explicit model substitute chooses its next question from the submitted answer.
      fixture.generate.mockImplementationOnce((request) => {
        const mode = request.input.answers.find(
          (answer: { questionId: string }) => answer.questionId === modeQuestion.id,
        ).value;
        const isReal = mode === "真实报名";
        const scope: IntakeQuestion = {
          ...question("registration_scope"),
          title: isReal ? "是否同意以下单项报名信息范围？" : "请确认演示数据的使用边界",
          type: "single",
          dependsOn: [modeQuestion.id],
          affects: ["constraints"],
          options: isReal
            ? ["同意仅在本次活动收集报名昵称，不公开或转交", "拒绝收集真实信息"]
            : ["仅使用虚构数据，不接入真实报名服务，不收集真实信息", "暂不确定"],
          ...(isReal ? { authorization: "仅在本次活动收集报名昵称，不公开或转交" } : {}),
        };
        return result(analysis({ ready: false, questions: [scope] }));
      });
      draft = await analyzeIntake(draft.id, "alice", operation(draft));
      const scopeQuestion = draft.questions[0];
      expect(scopeQuestion.dependsOn).toEqual([modeQuestion.id]);
      expect(scopeQuestion.options).toContain(confirmedScope);
      draft = updateIntake(draft.id, "alice", {
        revision: draft.revision,
        answerMode: "complete",
        answers: [{ questionId: scopeQuestion.id, state: "answered", value: confirmedScope }],
      });
      fixture.generate.mockImplementationOnce((request) => {
        const answers = request.input.answers as Array<{
          questionId: string;
          value: string;
          confirmation?: string;
        }>;
        expect(answers.every((answer) => answer.confirmation === "confirmed")).toBe(true);
        const mode = answers.find((answer) => answer.questionId === modeQuestion.id)!.value;
        const scope = answers.find((answer) => answer.questionId === scopeQuestion.id)!.value;
        expect(scope).toBe(confirmedScope);
        return result(
          analysis({
            constraints:
              mode === "真实报名"
                ? "真实报名仅收集本次活动报名昵称，不公开或转交，不收集手机号，不用于营销"
                : "仅界面演示，使用虚构数据，不接入真实报名服务，不收集或提交真实个人信息",
            options: [mode],
            assumptions: ["AI建议增加手机号与营销通知，尚未授权"],
          }),
        );
      });
      draft = await analyzeIntake(draft.id, "alice", operation(draft));
      expect(draft.challenge?.constraints).toBe(expectedConstraint);
      expect(draft.challenge?.options).toEqual([selectedMode]);
      const arena = submitIntake(draft.id, "alice", {
        revision: draft.revision,
        challenge: draft.challenge!,
        assumptions: draft.assumptions,
      });
      const version = arena.versions[0];
      expect(version.challenge.constraints).toBe(expectedConstraint);
      expect(version.requirements?.executionPrompt).toContain(expectedConstraint);
      expect(version.requirements?.executionPrompt).toContain(confirmedScope);
      expect(version.requirements?.executionPrompt).not.toContain("AI建议增加手机号与营销通知");
      expect(version.requirements?.suggestions.join(" ")).toContain(
        "AI建议增加手机号与营销通知，尚未授权",
      );
      const scopeAnswer = version.intake?.answers.find(
        (answer) => answer.questionId === scopeQuestion.id,
      );
      expect(scopeAnswer).toMatchObject({ value: confirmedScope, confirmation: "confirmed" });
      if (selectedMode === "真实报名") {
        expect(scopeAnswer?.question.authorization).toBe("仅在本次活动收集报名昵称，不公开或转交");
        expect(version.requirements?.executionPrompt).toContain(
          "授权仅在用户明确同意的单项范围内生效",
        );
      } else {
        expect(scopeAnswer?.question.authorization).toBeUndefined();
        expect(version.requirements?.executionPrompt).not.toContain("同意仅在本次活动收集报名昵称");
        expect(version.challenge.constraints).toContain("不接入真实报名服务");
        expect(version.challenge.constraints).toContain("不收集或提交真实个人信息");
      }
    },
  );

  it("keeps automatic draft saves pending and only confirms explicitly submitted answers", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const questions = [question("budget"), question("unknown"), question("skipped")];
    fixture.generate.mockResolvedValueOnce(result(analysis({ ready: false, questions })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    const answers = [
      { questionId: "budget", state: "answered" as const, value: "100元" },
      { questionId: "unknown", state: "unknown" as const, value: "" },
      { questionId: "skipped", state: "skipped" as const, value: "" },
    ];
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answers,
      answerMode: "draft",
    });
    expect(draft.answers.every((answer) => answer.confirmation === "pending")).toBe(true);
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answers,
      answerMode: "complete",
    });
    expect(draft.answers[0]).toMatchObject({
      confirmation: "confirmed",
      confirmedRevision: draft.revision,
    });
    expect(draft.answers.slice(1).every((answer) => answer.confirmation === "pending")).toBe(true);
  });

  it("preserves an untouched question as unanswered after confirming only the supplied answer", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question("style"), question("authorization")] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "complete",
      answers: [{ questionId: "style", state: "answered", value: "简洁" }],
    });
    expect(draft.answers.find((answer) => answer.questionId === "authorization")).toMatchObject({
      state: "answered",
      value: "",
      confirmation: "pending",
    });
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.answers.find((answer) => answer.questionId === "authorization")).toMatchObject({
      state: "answered",
      value: "",
      confirmation: "pending",
    });
    expect(fixture.generate.mock.calls.at(-1)?.[0].input.materials).toContain("用户未作答，待确认");
  });

  it("invalidates only the changed answer and dependent answers while retaining prior confirmations", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const questions = [
      { ...question("budget"), affects: ["budget"] as const },
      { ...question("flow"), dependsOn: ["budget"], affects: ["constraints"] as const },
      { ...question("style"), affects: ["preferences"] as const },
    ].map((entry) => ({ ...entry, affects: [...entry.affects] }));
    fixture.generate.mockResolvedValueOnce(result(analysis({ ready: false, questions })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "complete",
      answers: questions.map((entry) => ({
        questionId: entry.id,
        state: "answered",
        value: entry.id === "style" ? "简洁" : "原始答案",
      })),
    });
    const originalStyle = structuredClone(
      draft.answers.find((answer) => answer.questionId === "style"),
    );
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "draft",
      answers: [{ questionId: "budget", state: "answered", value: "修改后的答案" }],
    });
    expect(draft.answers.find((answer) => answer.questionId === "budget")).toMatchObject({
      confirmation: "pending",
      value: "修改后的答案",
    });
    expect(draft.answers.find((answer) => answer.questionId === "budget")).not.toHaveProperty(
      "confirmedAt",
    );
    expect(draft.answers.find((answer) => answer.questionId === "flow")).toMatchObject({
      confirmation: "pending",
    });
    expect(draft.answers.find((answer) => answer.questionId === "style")).toEqual(originalStyle);
    expect(draft.confirmation?.pendingSummaryFields).toEqual(
      expect.arrayContaining(["budget", "constraints"]),
    );
    expect(draft.confirmation?.pendingSummaryFields).not.toContain("preferences");
    expect(
      draft.confirmation?.history[0].answers.find((answer) => answer.questionId === "budget"),
    ).toMatchObject({ confirmation: "confirmed", value: "原始答案" });
  });

  it("reopens a dependent question only after its upstream answer changes", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const questions = [
      question("budget"),
      { ...question("flow"), dependsOn: ["budget"] },
      question("style"),
    ];
    fixture.generate.mockResolvedValueOnce(result(analysis({ ready: false, questions })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "complete",
      answers: questions.map((entry) => ({
        questionId: entry.id,
        state: "answered",
        value: "原答案",
      })),
    });
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "draft",
      answers: [{ questionId: "budget", state: "answered", value: "新答案" }],
    });
    fixture.generate.mockResolvedValueOnce(result(analysis({ ready: false, questions })));
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.questions.map((entry) => entry.id)).toEqual(["budget", "flow"]);
    expect(fixture.generate.mock.calls.at(-1)?.[0].input.pendingConfirmationIds).toEqual(
      expect.arrayContaining(["budget", "flow"]),
    );
    expect(draft.answers.find((answer) => answer.questionId === "style")?.confirmation).toBe(
      "confirmed",
    );
  });

  it("deduplicates punctuation variants and keeps unknown answers unresolved", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question("style")] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "complete",
      answers: [{ questionId: "style", state: "unknown", value: "" }],
    });
    fixture.generate.mockResolvedValueOnce(
      result(
        analysis({
          ready: false,
          questions: [
            { ...question("renamed_style"), title: "请确认style的限制？" },
            question("content"),
          ],
        }),
      ),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.questions.map((entry) => entry.id)).toEqual(["content"]);
    expect(draft.answers[0]).toMatchObject({ state: "unknown", confirmation: "pending" });
  });

  it("records authorization scope through the original choice control without selecting a default", async () => {
    let draft = createIntake("alice", {
      goal: "制作活动报名页面，并核对可使用的个人信息范围",
      modelMode: "gpt-6.1-terra",
    });
    const permission = {
      ...question("permission"),
      type: "single" as const,
      options: ["同意", "拒绝", "待定"],
      authorization: "仅在本次活动收集报名昵称，不公开或转交",
    };
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [permission] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft.answers).toEqual([]);
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      answerMode: "complete",
      answers: [{ questionId: "permission", state: "answered", value: "拒绝" }],
    });
    expect(draft.answers[0]).toMatchObject({
      confirmation: "confirmed",
      value: "拒绝",
      question: { authorization: permission.authorization },
    });
  });

  it("keeps summary autosaves unconfirmed and confirms the summary only on explicit submission", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    draft = updateIntake(draft.id, "alice", {
      revision: draft.revision,
      summary: {
        challenge: { ...draft.challenge!, preferences: "简洁风格" },
        assumptions: ["尚未确定真实报名或界面演示"],
      },
    });
    expect(draft.confirmation?.summary).toBeUndefined();
    const stored = JSON.parse(
      (db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as { body: string })
        .body,
    );
    expect(stored.summaryEdits.provenance).toBe("user-edited-draft");
    const arena = submitIntake(draft.id, "alice", {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    expect(arena.versions[0].intake?.confirmation?.summary?.challenge.preferences).toBe("简洁风格");
    expect(arena.versions[0].requirements?.confirmed.join(" ")).not.toContain("尚未确定真实报名");
    expect(arena.versions[0].requirements?.suggestions.join(" ")).toContain("尚未确定真实报名");
  });

  it("inherits the source version's pending fields and allows a confirmed style answer to update its summary", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ preferences: "原有风格", constraints: "原有功能限制" })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    const arena = submitIntake(draft.id, "alice", {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: [],
    });
    const version = arena.versions[0];
    version.intake!.confirmation!.pendingSummaryFields = ["constraints"];
    let linked = atomic(() =>
      createFollowUpIntake(arena.id, version, "alice", ["请选择页面风格？"]),
    )!;
    expect(linked.confirmation?.pendingSummaryFields).toEqual(["constraints"]);
    linked = updateIntake(linked.id, "alice", {
      revision: linked.revision,
      answerMode: "complete",
      answers: [
        { questionId: linked.questions[0].id, state: "answered", value: "使用简洁纸面风格" },
      ],
    });
    fixture.generate.mockResolvedValueOnce(
      result(
        analysis({ preferences: "使用简洁纸面风格", constraints: "模型试图覆盖原有功能限制" }),
      ),
    );
    linked = await analyzeIntake(linked.id, "alice", operation(linked));
    expect(linked.challenge?.preferences).toBe("使用简洁纸面风格");
    expect(linked.challenge?.constraints).toBe("原有功能限制");
    expect(linked.confirmation?.pendingSummaryFields).toEqual(
      expect.arrayContaining(["constraints", "preferences"]),
    );
  });

  it("rejects writes to a supplement after its linked task version changes", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    const arena = submitIntake(draft.id, "alice", {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: [],
    });
    const linked = atomic(() =>
      createFollowUpIntake(arena.id, arena.versions[0], "alice", ["请选择风格？"]),
    )!;
    db()
      .prepare("UPDATE arenas SET active_version_id=? WHERE id=?")
      .run("synthetic-newer-version", arena.id);
    expect(() =>
      updateIntake(linked.id, "alice", {
        revision: linked.revision,
        answers: [{ questionId: linked.questions[0].id, state: "answered", value: "旧版回答" }],
        answerMode: "complete",
      }),
    ).toThrow("任务版本已变化");
    expect(getIntake(linked.id, "alice").answers).toEqual(linked.answers);
    await expect(analyzeIntake(linked.id, "alice", operation(linked))).rejects.toThrow(
      "任务版本已变化",
    );
  });

  it("links supplementary drafts to a version, copies readable source files and retains paused progress", async () => {
    let draft = createIntake("alice", {
      goal: "制作一份介绍活动流程的PPT并核对需要的材料",
      modelMode: "gpt-6.1-terra",
    });
    const bytes = Buffer.from("活动流程：开场、分组讨论、总结。示例材料。");
    draft = await addIntakeAttachment(draft.id, "alice", bytes, "活动流程.txt");
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    const arena = submitIntake(draft.id, "alice", {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: [],
    });
    const linked = atomic(() =>
      createFollowUpIntake(arena.id, arena.versions[0], "alice", [
        "请选择PPT的风格？",
        "请选择PPT的风格!",
        "需要几页内容？",
        "需要哪种流程？",
        "还有哪些补充？",
      ]),
    )!;
    expect(linked.link).toEqual({ arenaId: arena.id, versionId: arena.activeVersionId });
    expect(linked.questions).toHaveLength(3);
    expect(linked.queuedQuestions).toHaveLength(1);
    expect(linked.attachments[0].sourceAttachmentId).toBe(draft.attachments[0].id);
    expect(
      getIntakeAttachment(linked.id, "alice", linked.attachments[0].id).bytes.equals(bytes),
    ).toBe(true);
    expect(linked.sources[0].filename).toBe("活动流程.txt");
    expect(linked.sources[0].id).toBe(draft.sources[0].id);
    expect(linked.sources[0].attachmentId).toBe(linked.attachments[0].id);
    expect(() => getIntake(linked.id, "bob")).toThrow("无权访问");
    expect(
      atomic(() => createFollowUpIntake(arena.id, arena.versions[0], "alice", ["其他问题"]))!.id,
    ).toBe(linked.id);
    db()
      .prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?")
      .run(Date.now() - 25 * 60 * 60 * 1000, linked.id);
    createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    expect(getIntake(linked.id, "alice").link?.versionId).toBe(arena.activeVersionId);
    const answerSaved = updateIntake(linked.id, "alice", {
      revision: linked.revision,
      answerMode: "complete",
      answers: linked.questions.map((entry) => ({
        questionId: entry.id,
        state: "unknown",
        value: "",
      })),
    });
    const next = await analyzeIntake(linked.id, "alice", operation(answerSaved));
    expect(next.questions.map((entry) => entry.title)).toEqual(["还有哪些补充？"]);
    expect(next.round).toBe(2);
  });
});

describe("lazy retention at every existing-draft read entry", () => {
  const expiredAt = () => Date.now() - 24 * 60 * 60 * 1000 - 1000;
  it.each(["draft GET", "attachment GET", "new clarification cleanup"] as const)(
    "retains an expired legacy draft and its attachment with expiry disabled through %s",
    async (entry) => {
      vi.stubEnv("ARENA_INTAKE_EXPIRY_ENABLED", "false");
      let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
      const bytes = Buffer.from("synthetic retained legacy material");
      draft = await addIntakeAttachment(draft.id, "alice", bytes, "retained-legacy.txt");
      db().prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?").run(expiredAt(), draft.id);
      const stored = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id);
      expect(() => getIntake(draft.id, "bob")).toThrow("无权访问");
      expect(() => getIntakeAttachment(draft.id, "bob", draft.attachments[0].id)).toThrow(
        "无权访问",
      );
      if (entry === "draft GET") expect(getIntake(draft.id, "alice").id).toBe(draft.id);
      else if (entry === "attachment GET")
        expect(
          getIntakeAttachment(draft.id, "alice", draft.attachments[0].id).bytes.equals(bytes),
        ).toBe(true);
      else
        expect(
          createIntake("bob", { goal, modelMode: "gpt-6.1-terra", workflow: "clarification" })
            .workflow,
        ).toBe("clarification");
      expect(getIntake(draft.id, "alice")).toEqual(draft);
      expect(db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id)).toEqual(
        stored,
      );
      expect(
        getIntakeAttachment(draft.id, "alice", draft.attachments[0].id).bytes.equals(bytes),
      ).toBe(true);
      expect(() => getIntake(draft.id, "bob")).toThrow("无权访问");
      expect(fixture.generate).not.toHaveBeenCalled();
      expect(fixture.hold).not.toHaveBeenCalled();
    },
  );
  it("rejects and deletes an expired unsubmitted draft and its attachments on GET", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await addIntakeAttachment(
      draft.id,
      "alice",
      Buffer.from("private expired input"),
      "old.txt",
    );
    db().prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?").run(expiredAt(), draft.id);
    expect(() => getIntake(draft.id, "bob")).toThrow("无权访问");
    expect(db().prepare("SELECT id FROM intake_drafts WHERE id=?").get(draft.id)).toBeTruthy();
    expect(() => getIntake(draft.id, "alice")).toThrow("未找到");
    expect(db().prepare("SELECT id FROM intake_drafts WHERE id=?").get(draft.id)).toBeUndefined();
    expect(
      db().prepare("SELECT id FROM intake_attachments WHERE draft_id=?").get(draft.id),
    ).toBeUndefined();
    expect(() => getIntakeAttachment(draft.id, "alice", draft.attachments[0].id)).toThrow("未找到");
  });
  it("deletes expired bytes and an orphan operation that never recorded a call or reservation", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await addIntakeAttachment(
      draft.id,
      "alice",
      Buffer.from("private expired bytes"),
      "old.txt",
    );
    const operationId = randomUUID();
    db()
      .prepare(
        "INSERT INTO intake_operations(id,draft_id,revision,body,state,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(operationId, draft.id, draft.revision, "{}", "pending", expiredAt());
    db().prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?").run(expiredAt(), draft.id);
    expect(() => getIntakeAttachment(draft.id, "alice", draft.attachments[0].id)).toThrow("未找到");
    expect(
      db().prepare("SELECT id FROM intake_operations WHERE draft_id=?").get(draft.id),
    ).toBeUndefined();
    expect(
      db().prepare("SELECT id FROM intake_calls WHERE operation_id=?").get(operationId),
    ).toBeUndefined();
    expect(fixture.hold).not.toHaveBeenCalled();
  });
  it.each(
    (["draft GET", "attachment GET", "new draft cleanup"] as const).flatMap((entry) => [
      { entry, expiry: "default", setting: undefined },
      { entry, expiry: "disabled", setting: "false" },
    ]),
  )(
    "recovers a dispatched call after a 25h restart through $entry with expiry $expiry",
    async ({ entry, setting }) => {
      vi.stubEnv("ARENA_INTAKE_EXPIRY_ENABLED", setting);
      const directory = mkdtempSync(join(tmpdir(), "arena-intake-restart-"));
      closeDb();
      vi.stubEnv("ARENA_DATABASE_PATH", join(directory, "intakes.sqlite"));
      try {
        let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
        const bytes = Buffer.from("material for an interrupted provider request");
        draft = await addIntakeAttachment(draft.id, "alice", bytes, "interrupted.txt");
        fixture.generate.mockReturnValueOnce(new Promise(() => {}));
        const op = operation(draft);
        void analyzeIntake(draft.id, "alice", op);
        expect(fixture.generate).toHaveBeenCalledTimes(1);
        const call = db()
          .prepare("SELECT id FROM intake_calls WHERE operation_id=? AND state='pending'")
          .get(op.operationId) as { id: string };
        expect(call).toBeTruthy();
        const reservation = getIntake(draft.id, "alice").reservedUsd;
        expect(reservation).toBeGreaterThan(0);
        const interruptedAt = Date.now() - 25 * 60 * 60 * 1000;
        db()
          .prepare("UPDATE intake_operations SET updated_at=? WHERE id=?")
          .run(interruptedAt, op.operationId);
        db()
          .prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?")
          .run(interruptedAt, draft.id);
        // Reopen persisted state with no original worker or provider response available.
        closeDb();
        fixture.generate.mockReset();
        if (entry === "draft GET") expect(getIntake(draft.id, "alice").status).toBe("uncertain");
        else if (entry === "attachment GET")
          expect(
            getIntakeAttachment(draft.id, "alice", draft.attachments[0].id).bytes.equals(bytes),
          ).toBe(true);
        else createIntake("bob", { goal, modelMode: "gpt-6.1-terra" });
        const recovered = getIntake(draft.id, "alice");
        expect(recovered).toMatchObject({ status: "uncertain", reservedUsd: reservation });
        expect(
          getIntakeAttachment(draft.id, "alice", draft.attachments[0].id).bytes.equals(bytes),
        ).toBe(true);
        expect(
          db().prepare("SELECT state FROM intake_operations WHERE id=?").get(op.operationId),
        ).toMatchObject({ state: "uncertain" });
        expect(
          db().prepare("SELECT state FROM intake_calls WHERE id=?").get(call.id),
        ).toMatchObject({ state: "uncertain" });
        expect(fixture.hold).toHaveBeenCalledExactlyOnceWith(call.id);
        await expect(analyzeIntake(draft.id, "alice", operation(recovered))).rejects.toThrow(
          "结果待确认",
        );
        expect(fixture.generate).not.toHaveBeenCalled();
      } finally {
        closeDb();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("retains an expired reservation even when its local call record is missing", () => {
    const draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const body = { ...draft, status: "analyzing", reservedUsd: 0.02 };
    db()
      .prepare("UPDATE intake_drafts SET body=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(body), expiredAt(), draft.id);
    expect(getIntake(draft.id, "alice")).toMatchObject({ status: "uncertain", reservedUsd: 0.02 });
    expect(fixture.hold).not.toHaveBeenCalled();
    expect(fixture.generate).not.toHaveBeenCalled();
  });
  it.each(["draft", "operation", "call"] as const)(
    "retains an expired %s uncertainty record through owned reads and new-draft cleanup",
    async (uncertainRecord) => {
      let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
      const bytes = Buffer.from("unknown request audit material");
      draft = await addIntakeAttachment(draft.id, "alice", bytes, "unknown.txt");
      const operationId = randomUUID();
      const callId = randomUUID();
      db()
        .prepare(
          "INSERT INTO intake_operations(id,draft_id,revision,body,state,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          operationId,
          draft.id,
          draft.revision,
          "{}",
          uncertainRecord === "operation" ? "uncertain" : "completed",
          expiredAt(),
        );
      db()
        .prepare(
          "INSERT INTO intake_calls(id,operation_id,kind,state,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          callId,
          operationId,
          "analysis",
          uncertainRecord === "call" ? "uncertain" : "completed",
          expiredAt(),
        );
      if (uncertainRecord === "draft") {
        const body = JSON.parse(
          (
            db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
              body: string;
            }
          ).body,
        );
        body.status = "uncertain";
        db()
          .prepare("UPDATE intake_drafts SET body=? WHERE id=?")
          .run(JSON.stringify(body), draft.id);
      }
      db().prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?").run(expiredAt(), draft.id);
      expect(() => getIntake(draft.id, "bob")).toThrow("无权访问");
      expect(getIntake(draft.id, "alice").id).toBe(draft.id);
      expect(
        getIntakeAttachment(draft.id, "alice", draft.attachments[0].id).bytes.equals(bytes),
      ).toBe(true);
      createIntake("bob", { goal, modelMode: "gpt-6.1-terra" });
      createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
      expect(getIntake(draft.id, "alice").id).toBe(draft.id);
      expect(
        db().prepare("SELECT id FROM intake_operations WHERE id=?").get(operationId),
      ).toBeTruthy();
      expect(db().prepare("SELECT id FROM intake_calls WHERE id=?").get(callId)).toBeTruthy();
      expect(fixture.generate).not.toHaveBeenCalled();
      expect(fixture.hold).not.toHaveBeenCalled();
    },
  );
  it("retains submitted drafts and their source files beyond the idle window", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    const bytes = Buffer.from("submitted source retained for audit");
    draft = await addIntakeAttachment(draft.id, "alice", bytes, "retained.txt");
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    submitIntake(draft.id, "alice", {
      revision: draft.revision,
      challenge: draft.challenge!,
      assumptions: draft.assumptions,
    });
    db().prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?").run(expiredAt(), draft.id);
    expect(getIntake(draft.id, "alice").status).toBe("submitted");
    expect(
      getIntakeAttachment(draft.id, "alice", draft.attachments[0].id).bytes.equals(bytes),
    ).toBe(true);
  });
  it("retains an expired draft only while its pending operation is still active", async () => {
    let draft = createIntake("alice", { goal, modelMode: "gpt-6.1-terra" });
    draft = await addIntakeAttachment(draft.id, "alice", Buffer.from("active input"), "active.txt");
    const operationId = randomUUID();
    db()
      .prepare(
        "INSERT INTO intake_operations(id,draft_id,revision,body,state,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(operationId, draft.id, draft.revision, "{}", "pending", Date.now());
    db().prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?").run(expiredAt(), draft.id);
    expect(getIntake(draft.id, "alice").id).toBe(draft.id);
    expect(getIntakeAttachment(draft.id, "alice", draft.attachments[0].id).name).toBe("active.txt");
    db()
      .prepare("UPDATE intake_operations SET updated_at=? WHERE id=?")
      .run(Date.now() - 241000, operationId);
    expect(() => getIntakeAttachment(draft.id, "alice", draft.attachments[0].id)).toThrow("未找到");
  });
});
