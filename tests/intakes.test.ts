/** Service integration with an explicit structured-model test double; never sends network requests. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeDb, db } from "../src/lib/server/db";
import {
  IntakeAnalysisSchema,
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
  it("asks at most two rounds, records skipped/unknown answers, then summarizes", async () => {
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
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, answers: [] });
    fixture.generate.mockResolvedValueOnce(
      result(analysis({ ready: false, questions: [question("another")] })),
    );
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(draft).toMatchObject({ status: "summary", questions: [] });
    expect(draft.answers.map((answer) => answer.state)).toEqual(["unknown", "skipped"]);
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
      "尚未生成",
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
  it("preserves answers, skipped states, round limits and explicit summary corrections when switching models", async () => {
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
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
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
        provenance: "user-confirmed-summary",
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
    ).rejects.toThrow("不重复");
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
      kind: "image",
      chunks: [],
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
      "chart.png",
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
    expect(draft.sources.some((source) => source.interpretation)).toBe(true);
    expect(JSON.stringify(draft)).not.toContain("base64");
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, answers: [] });
    draft = await analyzeIntake(draft.id, "alice", operation(draft));
    expect(
      fixture.generate.mock.calls.filter((call) => call[0].name === "read_material"),
    ).toHaveLength(1);
    draft = updateIntake(draft.id, "alice", { revision: draft.revision, modelMode: "gpt-6.1-sol" });
    expect(draft.attachments[0].interpreted).toBe(false);
    expect(draft.sources).toEqual([]);
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
});

describe("lazy retention at every existing-draft read entry", () => {
  const expiredAt = () => Date.now() - 24 * 60 * 60 * 1000 - 1000;
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
  it("deletes expired bytes on direct attachment GET, including stale local pending records", async () => {
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
    db()
      .prepare("INSERT INTO intake_calls(id,operation_id,kind,state,created_at) VALUES(?,?,?,?,?)")
      .run(randomUUID(), operationId, "analysis", "pending", expiredAt());
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
