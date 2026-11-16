/** Planning service integration with explicit structured-model doubles. No provider requests. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlanningAction,
  PlanningAnswerInput,
  PlanningDimension,
  PlanningSnapshot,
} from "../src/lib/planning-contracts";

const fixture = vi.hoisted(() => ({ generate: vi.fn(), hold: vi.fn() }));
vi.mock("../src/lib/server/model", async (original) => ({
  ...(await original<typeof import("../src/lib/server/model")>()),
  generateStructured: fixture.generate,
}));
vi.mock("../src/lib/server/billing", async (original) => ({
  ...(await original<typeof import("../src/lib/server/billing")>()),
  holdBilling: fixture.hold,
}));

import { closeDb, db } from "../src/lib/server/db";
import { ModelCallError } from "../src/lib/server/model";
import { actPlanning, createPlanning, getPlanning } from "../src/lib/server/planning";

const owner = "planning-fixture-owner";
const goal = "保留原版纸面视觉，帮助用户把模糊想法逐层细化，并输出可交给 AI 的执行方案。";
const dimensions: PlanningDimension[] = [
  "function",
  "content",
  "flow",
  "style",
  "constraints",
  "delivery",
];
type ActionPayload = PlanningAction extends infer Action
  ? Action extends PlanningAction
    ? Omit<Action, "operationId" | "revision">
    : never
  : never;

let directory = "";
let snapshot: PlanningSnapshot;
let proposed = false;
let questionItemIds: string[] | null = null;
let questionsEnabled = true;

function result(value: unknown) {
  return {
    value,
    usage: {
      inputTokens: 120,
      outputTokens: 80,
      cachedInputTokens: 0,
      estimatedCny: 0,
      estimatedUsd: 0.001,
      provider: "openai" as const,
      currency: "USD" as const,
      model: "gpt-6.1-terra",
      responseId: "explicit-planning-test-double",
      durationMs: 1,
    },
  };
}

function source(current = snapshot) {
  const record = current.session.sourceRecords.find((entry) => entry.kind === "goal");
  if (!record) throw new Error("A planning session must preserve its original goal source.");
  return { kind: "goal" as const, id: record.id, quote: goal };
}

function analysis(current = snapshot) {
  const seeds = [
    {
      id: "entry",
      dimension: "flow" as const,
      title: "进入时机",
      description: "确定什么时候进入工作台",
      dependsOn: [],
    },
    {
      id: "questions",
      dimension: "function" as const,
      title: "问题呈现",
      description: "确定问题的呈现方式",
      dependsOn: ["entry"],
    },
    {
      id: "style",
      dimension: "style" as const,
      title: "视觉要求",
      description: "确定纸面视觉要求",
      dependsOn: [],
    },
    {
      id: "delivery",
      dimension: "delivery" as const,
      title: "交付内容",
      description: "确定可执行交付物",
      dependsOn: [],
    },
  ];
  return {
    summary: "根据用户原始目标和当前回答继续细化；这是明确的测试输出。",
    items: seeds.map((seed) => {
      const previous = current.session.items.find((item) => item.id === seed.id);
      const answered = current.session.answers.some(
        (answer) => answer.state === "answered" && answer.question.itemIds.includes(seed.id),
      );
      return {
        ...seed,
        description: previous?.description ?? seed.description,
        status: proposed || answered ? "proposed" : "open",
        required: true,
        sources: previous?.sources.length ? previous.sources : [source(current)],
        reason: "此项会影响执行方式，需要用户决定或审阅具体建议。",
      };
    }),
  };
}

function questions(current = snapshot) {
  const itemIds =
    questionItemIds ??
    current.session.items
      .filter((item) => ["open", "needs_review", "deferred"].includes(item.status))
      .slice(0, 1)
      .map((item) => item.id);
  return {
    summary: "把当前未决事项变成用户能理解的具体选择。",
    questions: questionsEnabled
      ? itemIds.map((itemId) => ({
          id: `choose_${itemId}`,
          itemIds: [itemId],
          title: `请决定${itemId}的具体行为`,
          reason: "不同选择会改变后续实现。",
          type: "single",
          options: [
            {
              id: "keep",
              label: `保留 ${itemId} 的原版行为`,
              description: "沿用当前已熟悉的交互。",
              consequences: ["优先保持已有习惯"],
            },
            {
              id: "change",
              label: `调整 ${itemId} 的交互`,
              description: "按本轮讨论改成新的交互。",
              consequences: ["需要重新核对相关流程"],
            },
          ],
          placeholder: "也可以补充自己的想法",
          unit: "",
          minSelections: 1,
          maxSelections: 1,
          allowUnknown: true,
          allowSkip: true,
        }))
      : [],
  };
}

function review(current = snapshot, ready = true) {
  return {
    summary: "对当前方案做明确标注的合成查漏，不代表真实模型质量。",
    ready,
    coverage: dimensions.map((dimension) => ({
      dimension,
      status: "covered",
      reason: "合成验收数据中已检查此方面。",
      itemIds: current.session.items
        .filter((item) => item.dimension === dimension)
        .map((item) => item.id),
    })),
    blockers: ready
      ? []
      : [{ id: "missing-entry", itemIds: ["entry"], description: "进入时机仍需决定" }],
    risks: ["需要真人核对交互效果"],
    uncertainties: [],
    report: {
      title: "纸面需求工作台执行方案",
      summary: "实现用户确认的工作台与问题交接。",
      sections: [
        {
          id: "scope",
          title: "执行范围",
          content: "保留纸面视觉，落实用户实际选择。",
          itemIds: current.session.items.map((item) => item.id),
          sources: [source(current)],
        },
      ],
      tasks: [
        {
          id: "implement",
          title: "接入工作台",
          instructions: "依据已确认要求接通提问和回答。",
          dependsOn: [],
          acceptance: ["回答会改变下一轮问题"],
        },
      ],
      risks: ["视觉需要人工检查"],
      unresolved: [],
      acceptance: ["原版纸面视觉保留", "用户回答后继续细化"],
      executionPrompt: "请按本方案实现需求工作台，保留纸面视觉，完成实际用户回答驱动的需求细化。",
    },
  };
}

function create() {
  snapshot = createPlanning(owner, { operationId: randomUUID(), goal, modelMode: "gpt-6.1-terra" });
  return snapshot;
}

function action(payload: ActionPayload, current = snapshot): PlanningAction {
  return {
    ...payload,
    revision: current.session.revision,
    operationId: randomUUID(),
  } as PlanningAction;
}

async function apply(payload: ActionPayload) {
  snapshot = await actPlanning(snapshot.session.id, owner, action(payload));
  return snapshot;
}

function answerInput(
  state: PlanningAnswerInput["state"] = "answered",
  index = 0,
): PlanningAnswerInput {
  const question = snapshot.session.questions.filter((entry) => entry.status === "active")[index];
  if (!question) throw new Error("Expected an actual active question before answering.");
  return {
    questionId: question.id,
    questionVersion: question.version,
    state,
    optionIds: state === "answered" ? [question.options[0].id] : [],
    text: "",
    number: null,
  };
}

async function reachQuestions() {
  create();
  await apply({ kind: "advance" });
  await apply({ kind: "advance" });
  expect(snapshot.session.status).toBe("awaiting_user");
}

async function reachReport() {
  proposed = true;
  questionsEnabled = false;
  create();
  await apply({ kind: "advance" });
  await apply({ kind: "advance" });
  await apply({ kind: "preview" });
  expect(snapshot.session.report).not.toBeNull();
  return snapshot;
}

beforeEach(() => {
  closeDb();
  vi.resetAllMocks();
  proposed = false;
  questionItemIds = null;
  questionsEnabled = true;
  directory = mkdtempSync(join(tmpdir(), "planning-service-"));
  for (const [key, value] of Object.entries({
    ARENA_DATABASE_PATH: join(directory, "planning.sqlite"),
    OPENAI_API_KEY: "synthetic-test-key",
    DEEPSEEK_API_KEY: "synthetic-test-key",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL_ID: "gpt-6.1-terra",
    OPENAI_STRUCTURED_OUTPUT: "strict-tool",
    OPENAI_MAX_OUTPUT_TOKENS: "6000",
    OPENAI_REASONING_EFFORT: "low",
    OPENAI_INPUT_PRICE_PER_MILLION: "1",
    OPENAI_OUTPUT_PRICE_PER_MILLION: "5",
    MODEL_BASE_URL: "https://api.deepseek.com/beta",
    MODEL_ID: "deepseek-flash",
    MODEL_STRUCTURED_OUTPUT: "strict-tool",
    ARENA_DAILY_VISITOR_LIMIT: "100",
  }))
    vi.stubEnv(key, value);
  fixture.generate.mockImplementation(
    async (request: { name: string; schema: { parse: (value: unknown) => unknown } }) => {
      const value =
        request.name === "planning_analyze"
          ? analysis()
          : request.name === "planning_questions"
            ? questions()
            : request.name === "planning_review"
              ? review()
              : (() => {
                  throw new Error(`Unexpected model action: ${request.name}`);
                })();
      return result(request.schema.parse(value));
    },
  );
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("planning sessions with explicit structured-model test doubles", () => {
  it("creates a real empty workspace before any model request and isolates owners", async () => {
    create();
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(snapshot.session).toMatchObject({
      goal,
      status: "ready",
      nextAction: "advance",
      activeOperationId: null,
    });
    expect(snapshot.session.agents.map((agent) => agent.id)).toEqual(["A", "B", "C"]);
    expect(snapshot.events.some((event) => event.kind === "session_created")).toBe(true);
    expect(() => getPlanning(snapshot.session.id, "other-owner")).toThrow();
    await expect(
      actPlanning(snapshot.session.id, "other-owner", action({ kind: "advance" })),
    ).rejects.toThrow();
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-test-key");
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("deduplicates creation and refuses to reuse a creation ID with different content", () => {
    const input = { operationId: randomUUID(), goal, modelMode: "gpt-6.1-terra" };
    const first = createPlanning(owner, input);
    const duplicate = createPlanning(owner, input);
    expect(duplicate.session.id).toBe(first.session.id);
    expect(() => createPlanning(owner, { ...input, goal: "另一份不同的原始目标" })).toThrow();
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("continues beyond two question rounds and passes actual answers into the next analysis", async () => {
    create();
    for (let round = 0; round < 4; round++) {
      await apply({ kind: "advance" });
      await apply({ kind: "advance" });
      expect(snapshot.session.status).toBe("awaiting_user");
      const input = answerInput();
      input.text = `第 ${round + 1} 轮用户亲自补充的具体要求`;
      await apply({ kind: "answer", answers: [input] });
      expect(snapshot.session.answers).toHaveLength(round + 1);
      expect(snapshot.session.status).not.toBe("completed");
      expect(snapshot.session.report).toBeNull();
      expect(snapshot.session.items.every((item) => item.confirmation === null)).toBe(true);
    }
    await apply({ kind: "advance" });
    const request = fixture.generate.mock.calls.at(-1)![0];
    expect(request.name).toBe("planning_analyze");
    expect(JSON.stringify(request.input)).toContain("第 4 轮用户亲自补充的具体要求");
    expect(
      snapshot.session.sourceRecords.filter((record) => record.kind === "answer"),
    ).toHaveLength(4);
    expect(snapshot.session.items.filter((item) => item.status === "proposed")).toHaveLength(4);
    expect(snapshot.session.items.every((item) => item.confirmation === null)).toBe(true);
    await apply({ kind: "advance" });
    await apply({ kind: "preview" });
    const report = snapshot.session.report!;
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.items.filter((item) => item.status === "confirmed")).toHaveLength(4);
    expect(snapshot.session.items.filter((item) => item.confirmation !== null)).toHaveLength(4);
  });

  it("records unknown and skipped answers without treating either as user confirmation", async () => {
    questionItemIds = ["entry", "questions"];
    await reachQuestions();
    await apply({
      kind: "answer",
      answers: [answerInput("unknown", 0), answerInput("skipped", 1)],
    });
    expect(snapshot.session.answers.map((entry) => entry.state)).toEqual(["unknown", "skipped"]);
    for (const item of snapshot.session.items) {
      expect(item.confirmation).toBeNull();
      expect(item.status).not.toBe("confirmed");
    }
    expect(snapshot.session.capabilities.canConfirm).toBe(false);
  });

  it("accepts the user's own direction without forcing an option or claiming the issue is resolved", async () => {
    await reachQuestions();
    const currentQuestion = snapshot.session.questions.find((entry) => entry.status === "active")!;
    const text = "这些选项都不合适。我希望进入后还能直接修改最初的想法。";
    await apply({
      kind: "answer",
      answers: [{ ...answerInput(), optionIds: [], text }],
    });
    expect(snapshot.session.answers.at(-1)).toMatchObject({
      state: "answered",
      optionIds: [],
      text,
    });
    const item = snapshot.session.items.find((entry) => entry.id === currentQuestion.itemIds[0])!;
    expect(item.status).toBe("needs_review");
    expect(item.confirmation).toBeNull();
    await apply({ kind: "advance" });
    const request = fixture.generate.mock.calls.at(-1)![0];
    expect(request.name).toBe("planning_analyze");
    expect(JSON.stringify(request.input)).toContain(text);
  });

  it("keeps unanswered questions intact during preview and rejects an ungrounded ready claim", async () => {
    await reachQuestions();
    const active = structuredClone(
      snapshot.session.questions.filter((question) => question.status === "active"),
    );
    await apply({ kind: "preview" });
    expect(snapshot.session.answers).toEqual([]);
    expect(snapshot.session.questions.filter((question) => question.status === "active")).toEqual(
      active,
    );
    expect(snapshot.session.review?.ready).toBe(false);
    expect(snapshot.session.capabilities.canConfirm).toBe(false);
    expect(snapshot.session.report?.status).toBe("draft");
  });

  it("only confirms the exact current reviewed report and keeps execution instructions in the deliverable", async () => {
    await reachReport();
    const report = snapshot.session.report!;
    expect(snapshot.session.capabilities.canConfirm).toBe(true);
    expect(report.status).toBe("draft");
    expect(report.markdown).toContain("纸面需求工作台执行方案");
    expect(report.executionPrompt).toContain("实际用户回答驱动");
    await expect(
      actPlanning(
        snapshot.session.id,
        owner,
        action({ kind: "confirm", reportId: report.id, fingerprint: "wrong-fingerprint" }),
      ),
    ).rejects.toThrow();
    expect(getPlanning(snapshot.session.id, owner).session.status).not.toBe("completed");
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.session.report).toMatchObject({
      id: report.id,
      status: "confirmed",
      fingerprint: report.fingerprint,
    });
    expect(snapshot.events.filter((event) => event.kind === "report_confirmed")).toHaveLength(1);
  });

  it("invalidates previous review after a user correction and preserves the correction as a source", async () => {
    await reachReport();
    const staleReport = snapshot.session.report!;
    const before = snapshot.session.revision;
    const note = "修改进入时机：提交想法后立即进入三卡工作台。";
    await apply({ kind: "note", text: note, itemIds: ["entry"] });
    expect(snapshot.session.revision).toBeGreaterThan(before);
    expect(snapshot.session.capabilities.canConfirm).toBe(false);
    expect(
      snapshot.session.sourceRecords.some(
        (record) => record.kind === "note" && record.text === note,
      ),
    ).toBe(true);
    await expect(
      actPlanning(
        snapshot.session.id,
        owner,
        action({ kind: "confirm", reportId: staleReport.id, fingerprint: staleReport.fingerprint }),
      ),
    ).rejects.toThrow();
  });

  it("marks a dependent confirmed item for reconsideration when its prerequisite changes", async () => {
    await reachReport();
    const report = snapshot.session.report!;
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.items.find((item) => item.id === "questions")?.status).toBe(
      "confirmed",
    );
    await apply({
      kind: "note",
      text: "进入时机有变化，先进入工作台再开始分析。",
      itemIds: ["entry"],
    });
    const dependent = snapshot.session.items.find((item) => item.id === "questions")!;
    expect(dependent.status).toBe("needs_review");
    expect(dependent.confirmation).toBeNull();
    expect(snapshot.session.items.find((item) => item.id === "entry")?.status).toBe("needs_review");
    expect(snapshot.session.capabilities.canConfirm).toBe(false);
  });

  it("rejects stale question versions and invalid option IDs without saving an answer", async () => {
    await reachQuestions();
    const answer = answerInput();
    await expect(
      actPlanning(
        snapshot.session.id,
        owner,
        action({
          kind: "answer",
          answers: [{ ...answer, questionVersion: answer.questionVersion + 1 }],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      actPlanning(
        snapshot.session.id,
        owner,
        action({ kind: "answer", answers: [{ ...answer, optionIds: ["not-an-option"] }] }),
      ),
    ).rejects.toThrow();
    expect(getPlanning(snapshot.session.id, owner).session.answers).toEqual([]);
  });

  it("deduplicates in-flight and completed actions and rejects concurrent distinct advances", async () => {
    create();
    let finish!: (value: ReturnType<typeof result>) => void;
    fixture.generate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const op = action({ kind: "advance" });
    const running = actPlanning(snapshot.session.id, owner, op);
    const duplicate = await actPlanning(snapshot.session.id, owner, op);
    expect(duplicate.session.status).toBe("working");
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    await expect(
      actPlanning(snapshot.session.id, owner, action({ kind: "advance" }, duplicate)),
    ).rejects.toThrow();
    finish(result(analysis()));
    snapshot = await running;
    const completed = await actPlanning(snapshot.session.id, owner, op);
    expect(completed.session.revision).toBe(snapshot.session.revision);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    await expect(
      actPlanning(snapshot.session.id, owner, {
        ...op,
        kind: "note",
        text: "改成另一份操作",
        itemIds: [],
      }),
    ).rejects.toThrow();
  });

  it("orders streamed previews without changing the semantic revision or replaying business events", async () => {
    create();
    let finish!: (value: ReturnType<typeof result>) => void;
    fixture.generate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const running = actPlanning(snapshot.session.id, owner, action({ kind: "advance" }));
    const before = getPlanning(snapshot.session.id, owner);
    const request = fixture.generate.mock.calls[0][0];
    request.onPreview({ field: "summary", text: "正在整理进入工作台和提问交互。" });
    const preview = getPlanning(snapshot.session.id, owner);
    expect(preview.snapshotVersion).toBeGreaterThan(before.snapshotVersion);
    expect(preview.session.revision).toBe(before.session.revision);
    expect(preview.eventCursor).toBe(before.eventCursor);
    expect(preview.session.agents.find((agent) => agent.id === "A")?.preview).toContain(
      "进入工作台",
    );
    finish(result(analysis()));
    snapshot = await running;
    expect(snapshot.snapshotVersion).toBeGreaterThan(preview.snapshotVersion);
    expect(snapshot.session.agents.find((agent) => agent.id === "A")?.preview).toBe("");
  });

  it("preserves successful analysis when question generation fails and retries only the missing action", async () => {
    create();
    await apply({ kind: "advance" });
    const items = structuredClone(snapshot.session.items);
    fixture.generate.mockRejectedValueOnce(new ModelCallError("明确的测试失败", false));
    await apply({ kind: "advance" });
    expect(snapshot.session.status).toBe("failed");
    expect(snapshot.session.items).toEqual(items);
    await apply({ kind: "advance" });
    expect(fixture.generate.mock.calls.map(([request]) => request.name)).toEqual([
      "planning_analyze",
      "planning_questions",
      "planning_questions",
    ]);
    expect(snapshot.session.status).toBe("awaiting_user");
  });

  it("halts an uncertain model request and refuses a new operation ID as a retry bypass", async () => {
    create();
    fixture.generate.mockRejectedValueOnce(
      new ModelCallError("合成连接中断，费用与结果未知", true),
    );
    await apply({ kind: "advance" });
    expect(snapshot.session.status).toBe("uncertain");
    expect(snapshot.session.capabilities.canAdvance).toBe(false);
    await expect(
      actPlanning(snapshot.session.id, owner, action({ kind: "advance" })),
    ).rejects.toThrow();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    const uncertainCalls = db()
      .prepare("SELECT COUNT(*) AS count FROM planning_calls WHERE state='uncertain'")
      .get() as { count: number };
    expect(uncertainCalls.count).toBe(1);
  });

  it("keeps a stopped session paused when a model response arrives late", async () => {
    create();
    let finish!: (value: ReturnType<typeof result>) => void;
    fixture.generate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const running = actPlanning(snapshot.session.id, owner, action({ kind: "advance" }));
    snapshot = getPlanning(snapshot.session.id, owner);
    await apply({ kind: "stop" });
    expect(snapshot.session.status).toBe("paused");
    finish(result(analysis()));
    snapshot = await running;
    expect(snapshot.session.status).toBe("paused");
    expect(snapshot.session.items).toEqual([]);
    expect(snapshot.events.some((event) => event.kind === "question_issued")).toBe(false);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });

  it("restores persisted decisions and current questions after reopening SQLite", async () => {
    await reachQuestions();
    const before = structuredClone(snapshot);
    closeDb();
    snapshot = getPlanning(before.session.id, owner);
    expect(snapshot.session.questions).toEqual(before.session.questions);
    expect(snapshot.session.items).toEqual(before.session.items);
    expect(snapshot.events).toEqual(before.events);
    expect(snapshot.snapshotVersion).toBe(before.snapshotVersion);
    expect(fixture.generate).toHaveBeenCalledTimes(2);
  });
});
