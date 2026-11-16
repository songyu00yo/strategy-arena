/** Planning service integration with explicit structured-model doubles. No provider requests. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlanningAction,
  PlanningAnswerInput,
  PlanningCoverageArea,
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
import {
  actPlanning,
  createPlanning,
  getPlanning,
  planningContentFingerprint,
} from "../src/lib/server/planning";

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
let questionTag = "";
let includeCoverage = true;

function analysisCoverage() {
  const areas: PlanningCoverageArea[] = [
    "goal",
    "resources",
    "time_cost",
    "constraints",
    "risks",
    "implementation",
    "mvp",
  ];
  return includeCoverage
    ? areas.map((area) => ({
        area,
        status: "covered",
        reason: "明确标注的测试分析依据，不代表外部验证。",
        itemIds: [],
      }))
    : [];
}

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
    analysisCoverage: analysisCoverage(),
    nextActions: ["先明确项目要解决的问题，再据当前信息分析可行性。"],
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
          id: `choose_${itemId}${questionTag}`,
          itemIds: [itemId],
          title: `请决定${itemId}的具体行为${questionTag}`,
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

function expert(role: "D" | "E", current = snapshot) {
  return {
    summary: role === "D" ? "当前目标有条件可行，资源仍需核实。" : "先验证最小工作流，再逐步完善。",
    nextActions: ["用最小版本验证用户能否理解提问。", "资源核实前不承诺工期和成本。"],
    analysisCoverage: analysisCoverage(),
    conclusion: "conditional",
    sections: [
      {
        id: `expert-${role}-scope`,
        title: role === "D" ? "可行性依据" : "制作顺序",
        content: "根据现有目标与约束，先做最小验证，再决定扩展。",
        itemIds: current.session.items.map((item) => item.id),
        sources: [source(current)],
      },
    ],
    risks: ["资源未核实时扩大范围会增加成本。"],
    unknowns: ["实际可投入的时间与预算仍需核实。"],
    minimumViableVersion: "先验证一条完整的需求理解和分析阅读流程。",
  };
}

function review(current = snapshot, ready = true) {
  return {
    summary: "对当前方案做明确标注的合成查漏，不代表真实模型质量。",
    ready,
    analysisCoverage: analysisCoverage(),
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
  await finishAnalysis();
  expect(snapshot.session.report).not.toBeNull();
  return snapshot;
}

async function finishAnalysis() {
  for (
    let step = 0;
    step < 6 && snapshot.session.status === "ready" && snapshot.session.nextAction === "advance";
    step++
  )
    await apply({ kind: "advance" });
  expect(snapshot.session.status).toBe("review_ready");
}

function storedState() {
  const row = db()
    .prepare("SELECT body FROM planning_sessions WHERE id=?")
    .get(snapshot.session.id) as { body: string };
  return JSON.parse(row.body);
}

function saveLegacyState(legacy: ReturnType<typeof storedState>) {
  delete legacy.roundState;
  delete legacy.session.progress;
  delete legacy.session.expertResults;
  delete legacy.session.productScope;
  legacy.session.contractVersion = "1.0.0";
  legacy.session.agents = legacy.session.agents.filter((agent: { id: string }) =>
    ["A", "B", "C"].includes(agent.id),
  );
  legacy.config.promptVersion = "requirements-planning-1.0.0";
  legacy.config.schemaVersion = "1.0.0";
  db()
    .prepare("UPDATE planning_sessions SET body=? WHERE id=?")
    .run(JSON.stringify(legacy), snapshot.session.id);
}

beforeEach(() => {
  closeDb();
  vi.resetAllMocks();
  proposed = false;
  questionItemIds = null;
  questionsEnabled = true;
  questionTag = "";
  includeCoverage = true;
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
            : request.name === "planning_feasibility"
              ? expert("D")
              : request.name === "planning_production"
                ? expert("E")
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
  vi.useRealTimers();
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
    expect(snapshot.session.agents.map((agent) => agent.id)).toEqual(["A", "B", "D", "E", "C"]);
    expect(snapshot.session.progress).toMatchObject({
      round: 1,
      questionLimit: 8,
      questionsIssued: 0,
      questionsAnswered: 0,
      questionsRemaining: 8,
      questionSlotsRemaining: 8,
    });
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
    await finishAnalysis();
    const report = snapshot.session.report!;
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.items.filter((item) => item.status === "proposed")).toHaveLength(4);
    expect(snapshot.session.items.every((item) => item.confirmation === null)).toBe(true);
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

  it("enforces eight questions, counts unknown and skipped, then runs D E C without another question", async () => {
    create();
    questionItemIds = ["entry", "questions", "style"];
    await apply({ kind: "advance" });
    let answered = 0;
    for (let batch = 0; batch < 3; batch++) {
      questionTag = `第${batch + 1}批关键取舍`;
      await apply({ kind: "advance" });
      const active = snapshot.session.questions.filter((question) => question.status === "active");
      expect(active).toHaveLength(batch === 2 ? 2 : 3);
      const inputs = active.map((_, index) =>
        answerInput(index % 2 ? "skipped" : "unknown", index),
      );
      await apply({ kind: "answer", answers: inputs });
      answered += active.length;
      expect(snapshot.session.progress.questionsAnswered).toBe(answered);
      expect(snapshot.session.progress.questionsRemaining).toBe(8 - answered);
      await apply({ kind: "advance" });
    }
    expect(snapshot.session.progress).toMatchObject({
      questionLimit: 8,
      questionsIssued: 8,
      questionsAnswered: 8,
      questionsRemaining: 0,
      questionSlotsRemaining: 0,
      budgetExhausted: true,
      stage: "feasibility",
    });
    await finishAnalysis();
    expect(snapshot.session.questions).toHaveLength(8);
    expect(fixture.generate.mock.calls.map(([request]) => request.name).slice(-3)).toEqual([
      "planning_feasibility",
      "planning_production",
      "planning_review",
    ]);
    expect(snapshot.session.capabilities.canAdvance).toBe(false);
    expect(snapshot.session.capabilities.canConfirm).toBe(true);
    expect(snapshot.session.report?.unresolved.join("\n")).toContain("用户暂时不知道");
    expect(snapshot.session.report?.unresolved.join("\n")).toContain("用户选择跳过");
    const before = structuredClone(snapshot.session.items);
    const report = snapshot.session.report!;
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.items).toEqual(before);
    expect(snapshot.session.items.filter((item) => item.status === "deferred")).toHaveLength(3);
    expect(snapshot.session.items.every((item) => item.confirmation === null)).toBe(true);
    const calls = fixture.generate.mock.calls.length;
    await expect(
      actPlanning(snapshot.session.id, owner, action({ kind: "advance" })),
    ).rejects.toThrow();
    expect(fixture.generate).toHaveBeenCalledTimes(calls);
  });

  it("opens only an explicit three-question extension and preserves per-round counts and idempotency", async () => {
    await reachQuestions();
    await apply({ kind: "answer", answers: [answerInput("unknown")] });
    await apply({ kind: "preview" });
    await finishAnalysis();
    const previousAnswers = snapshot.session.answers.length;
    const calls = fixture.generate.mock.calls.length;
    const newRound = action({ kind: "start_round" });
    snapshot = await actPlanning(snapshot.session.id, owner, newRound);
    const duplicate = await actPlanning(snapshot.session.id, owner, newRound);
    expect(duplicate.session.progress).toEqual(snapshot.session.progress);
    expect(fixture.generate).toHaveBeenCalledTimes(calls);
    expect(snapshot.session.progress).toMatchObject({
      round: 2,
      questionLimit: 3,
      questionsIssued: 0,
      questionsAnswered: 0,
      questionsRemaining: 3,
      questionSlotsRemaining: 3,
    });
    expect(snapshot.session.answers).toHaveLength(previousAnswers);
    expect(snapshot.events.filter((event) => event.kind === "round_started")).toHaveLength(1);
    await expect(
      actPlanning(snapshot.session.id, owner, action({ kind: "start_round" })),
    ).rejects.toThrow();
    questionTag = "进一步核对";
    questionItemIds = ["entry", "questions", "style"];
    await apply({ kind: "advance" });
    await apply({ kind: "advance" });
    await apply({
      kind: "answer",
      answers: [answerInput("unknown", 0), answerInput("skipped", 1), answerInput("unknown", 2)],
    });
    await apply({ kind: "advance" });
    await finishAnalysis();
    expect(snapshot.session.progress).toMatchObject({
      round: 2,
      questionLimit: 3,
      questionsIssued: 3,
      questionsAnswered: 3,
      questionsRemaining: 0,
      questionSlotsRemaining: 0,
    });
    expect(snapshot.session.answers).toHaveLength(previousAnswers + 3);
    expect(snapshot.session.expertResults.every((expert) => expert.round === 2)).toBe(true);
  });

  it("passes actual feasibility output into production and both outputs into synthesis", async () => {
    await reachReport();
    const requests = fixture.generate.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.name)).toEqual([
      "planning_analyze",
      "planning_questions",
      "planning_feasibility",
      "planning_production",
      "planning_review",
    ]);
    expect(requests[3].input.expertResults).toHaveLength(1);
    expect(requests[3].input.expertResults[0]).toMatchObject({
      agentId: "D",
      summary: "当前目标有条件可行，资源仍需核实。",
    });
    expect(
      requests[4].input.expertResults.map((expert: { agentId: string }) => expert.agentId),
    ).toEqual(["D", "E"]);
    expect(
      snapshot.session.expertResults.every(
        (expert) => expert.basedOnRevision === snapshot.session.revision,
      ),
    ).toBe(true);
    expect(
      snapshot.events
        .filter((event) => event.kind === "agent_completed")
        .map((event) => event.actor),
    ).toEqual(["A", "B", "D", "E", "C"]);
    expect(snapshot.session.report?.unresolved).toContain("实际可投入的时间与预算仍需核实。");
    expect(snapshot.session.report?.sections.some((section) => section.id === "expert-D")).toBe(
      false,
    );
    expect(snapshot.session.report?.sections.at(-1)?.title).toBe("已知条件与待定项");
  });

  it("delivers and adopts an infeasible conclusion without inventing an unconditional making task", async () => {
    proposed = true;
    questionsEnabled = false;
    create();
    await apply({ kind: "advance" });
    await apply({ kind: "advance" });
    const feasibility = {
      ...expert("D"),
      conclusion: "infeasible",
      summary: "现有约束下无法完成原范围，应先缩减或验证。",
    };
    const production = {
      ...expert("E"),
      conclusion: "infeasible",
      summary: "当前只建议最小验证，不建议直接制作完整产品。",
    };
    const synthesis = review();
    synthesis.report.summary = "当前约束下原范围不可行，可以先做最小验证。";
    synthesis.report.tasks = [];
    fixture.generate
      .mockResolvedValueOnce(result(feasibility))
      .mockResolvedValueOnce(result(production))
      .mockResolvedValueOnce(result(synthesis));
    await finishAnalysis();
    expect(snapshot.session.review?.ready).toBe(true);
    const before = structuredClone(snapshot.session.items);
    const report = snapshot.session.report!;
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.items).toEqual(before);
    expect(snapshot.session.report?.tasks).toEqual([]);
  });

  it("does not refund issued question slots after a note withdraws them", async () => {
    questionItemIds = ["entry", "questions", "style"];
    await reachQuestions();
    expect(snapshot.session.progress.questionSlotsRemaining).toBe(5);
    await apply({ kind: "note", text: "补充：现阶段只关注最小可行版本。", itemIds: [] });
    expect(snapshot.session.progress).toMatchObject({
      questionsIssued: 3,
      questionsAnswered: 0,
      questionSlotsRemaining: 5,
      activeQuestions: 0,
    });
    questionTag = "补充后";
    await apply({ kind: "advance" });
    await apply({ kind: "advance" });
    expect(snapshot.session.progress).toMatchObject({
      questionsIssued: 6,
      questionsAnswered: 0,
      questionSlotsRemaining: 2,
      activeQuestions: 3,
    });
  });

  it("retains D output when E fails and retries E without repeating the feasibility call", async () => {
    proposed = true;
    questionsEnabled = false;
    create();
    for (let step = 0; step < 3; step++) await apply({ kind: "advance" });
    const feasibility = structuredClone(snapshot.session.expertResults);
    fixture.generate.mockRejectedValueOnce(new ModelCallError("制作路径的明确测试失败", false));
    await apply({ kind: "advance" });
    expect(snapshot.session.status).toBe("failed");
    expect(snapshot.session.expertResults).toEqual(feasibility);
    await apply({ kind: "advance" });
    await finishAnalysis();
    expect(fixture.generate.mock.calls.map(([request]) => request.name)).toEqual([
      "planning_analyze",
      "planning_questions",
      "planning_feasibility",
      "planning_production",
      "planning_production",
      "planning_review",
    ]);
    expect(snapshot.session.expertResults.map((expert) => expert.agentId)).toEqual(["D", "E"]);
  });

  it("does not adopt a model's ready claim when analysis coverage was never checked", async () => {
    includeCoverage = false;
    await reachReport();
    expect(snapshot.session.review?.ready).toBe(false);
    expect(
      snapshot.session.review?.blockers.filter((blocker) => blocker.id.startsWith("coverage-")),
    ).toHaveLength(7);
    expect(snapshot.session.capabilities.canConfirm).toBe(false);
    expect(snapshot.session.capabilities.canAdvance).toBe(false);
    expect(snapshot.session.nextAction).toBe("start_round");
    expect(snapshot.session.report?.unresolved.join("\n")).toContain("时间与成本");
  });

  it("rejects unsupported report source attribution while preserving a readable analysis", async () => {
    proposed = true;
    questionsEnabled = false;
    create();
    for (let i = 0; i < 4; i++) await apply({ kind: "advance" });
    const invalid = review();
    invalid.report.sections[0].sources = [
      { kind: "goal", id: source().id, quote: "用户从未说过这句话" },
    ];
    fixture.generate.mockResolvedValueOnce(result(invalid));
    await apply({ kind: "advance" });
    expect(snapshot.session.review?.ready).toBe(false);
    expect(snapshot.session.review?.blockers.some((blocker) => blocker.id === "source-scope")).toBe(
      true,
    );
    expect(snapshot.session.report?.unresolved.join("\n")).toContain("无法对应原文");
    expect(snapshot.session.report?.sections[0].sources).toEqual([]);
  });

  it("upgrades a saved three-role session without inventing expert outputs or losing sources", async () => {
    await reachQuestions();
    const row = db()
      .prepare("SELECT body FROM planning_sessions WHERE id=?")
      .get(snapshot.session.id) as { body: string };
    const legacy = JSON.parse(row.body);
    delete legacy.roundState;
    delete legacy.session.progress;
    delete legacy.session.expertResults;
    delete legacy.session.productScope;
    legacy.session.contractVersion = "1.0.0";
    legacy.session.agents = legacy.session.agents.filter((agent: { id: string }) =>
      ["A", "B", "C"].includes(agent.id),
    );
    legacy.config.promptVersion = "requirements-planning-1.0.0";
    legacy.config.schemaVersion = "1.0.0";
    db()
      .prepare("UPDATE planning_sessions SET body=? WHERE id=?")
      .run(JSON.stringify(legacy), snapshot.session.id);
    const before = structuredClone(snapshot);
    closeDb();
    snapshot = getPlanning(snapshot.session.id, owner);
    expect(snapshot.session.contractVersion).toBe("2.0.0");
    expect(snapshot.session.agents.map((agent) => agent.id)).toEqual(["A", "B", "D", "E", "C"]);
    expect(snapshot.session.expertResults).toEqual([]);
    expect(snapshot.session.questions).toEqual(before.session.questions);
    expect(snapshot.session.sourceRecords).toEqual(before.session.sourceRecords);
    expect(snapshot.session.progress.questionsIssued).toBe(1);
    expect(snapshot.events.filter((event) => event.kind === "session_upgraded")).toHaveLength(1);
    await apply({ kind: "answer", answers: [answerInput()] });
    await apply({ kind: "advance" });
    expect(snapshot.session.status).toBe("ready");
    expect(snapshot.events.filter((event) => event.kind === "session_upgraded")).toHaveLength(1);
  });

  it.each(["preview", "start_round"] as const)(
    "retires legacy active questions before %s without fabricating answers or changing the archived report",
    async (kind) => {
      await reachQuestions();
      const originalQuestions = structuredClone(snapshot.session.questions);
      const originalSources = structuredClone(snapshot.session.sourceRecords);
      const legacy = storedState();
      const generated = review(snapshot, false);
      const oldReport = {
        ...generated.report,
        id: "explicit-legacy-preview",
        basedOnRevision: snapshot.session.revision,
        contentFingerprint: planningContentFingerprint(snapshot.session),
        fingerprint: "explicit-legacy-report-fingerprint",
        status: "draft",
        confirmedAt: null,
        markdown: "# 明确标注的旧版阶段报告测试数据",
      };
      legacy.session.report = oldReport;
      legacy.session.review = {
        id: "legacy-review",
        basedOnRevision: oldReport.basedOnRevision,
        contentFingerprint: oldReport.contentFingerprint,
        ready: false,
        coverage: generated.coverage,
        blockers: generated.blockers,
        risks: generated.risks,
        uncertainties: [],
      };
      legacy.session.status = "awaiting_user";
      legacy.nextRole = "A";
      saveLegacyState(legacy);
      snapshot = getPlanning(snapshot.session.id, owner);
      expect(snapshot.session.questions).toEqual(originalQuestions);
      expect(snapshot.session.report?.fingerprint).toBe(oldReport.fingerprint);
      const request = action({ kind });
      snapshot = await actPlanning(snapshot.session.id, owner, request);
      expect(snapshot.session.answers).toEqual([]);
      expect(snapshot.session.questions.filter((question) => question.status === "active")).toEqual(
        [],
      );
      expect(
        snapshot.session.questions.map((question) => ({ ...question, status: "active" })),
      ).toEqual(originalQuestions);
      expect(snapshot.session.sourceRecords.slice(0, originalSources.length)).toEqual(
        originalSources,
      );
      expect(
        storedState().reportHistory.filter((report: { id: string }) => report.id === oldReport.id),
      ).toEqual([oldReport]);
      const duplicate = await actPlanning(snapshot.session.id, owner, request);
      expect(duplicate.snapshotVersion).toBe(snapshot.snapshotVersion);
      expect(
        storedState().reportHistory.filter((report: { id: string }) => report.id === oldReport.id),
      ).toHaveLength(1);
      if (kind === "preview") {
        expect(snapshot.session.capabilities.canAdvance).toBe(true);
        expect(fixture.generate.mock.calls.at(-1)![0].name).toBe("planning_feasibility");
        await finishAnalysis();
        const current = snapshot.session.report!;
        expect(current.contentFingerprint).toBe(planningContentFingerprint(snapshot.session));
        expect(current.fingerprint).not.toBe(oldReport.fingerprint);
        expect(current.unresolved.join("\n")).toContain(originalQuestions[0].title);
        await expect(
          actPlanning(
            snapshot.session.id,
            owner,
            action({ kind: "confirm", reportId: oldReport.id, fingerprint: oldReport.fingerprint }),
          ),
        ).rejects.toThrow();
        await apply({ kind: "confirm", reportId: current.id, fingerprint: current.fingerprint });
        expect(snapshot.session.status).toBe("completed");
        expect(snapshot.session.answers).toEqual([]);
      } else {
        expect(snapshot.session.progress).toMatchObject({
          round: 2,
          questionLimit: 3,
          questionsIssued: 0,
          questionsAnswered: 0,
          questionSlotsRemaining: 3,
          activeQuestions: 0,
        });
        questionTag = "新一轮";
        await apply({ kind: "advance" });
        await apply({ kind: "advance" });
        expect(snapshot.session.progress).toMatchObject({
          round: 2,
          questionLimit: 3,
          questionsIssued: 1,
          questionsAnswered: 0,
          questionSlotsRemaining: 2,
          activeQuestions: 1,
        });
        expect(snapshot.session.questions[0].status).toBe("withdrawn");
        expect(snapshot.session.answers).toEqual([]);
      }
    },
  );

  it("closes an over-budget legacy session with truthful historical counts and no implicit extra round", async () => {
    await reachQuestions();
    const legacy = storedState();
    const active = structuredClone(snapshot.session.questions[0]);
    legacy.session.questions = [];
    legacy.session.answers = [];
    for (let index = 0; index < 9; index++) {
      const question = {
        ...active,
        id: `legacy-answered-${index}`,
        title: `旧版问题${index + 1}`,
        status: "answered",
      };
      const answerId = `legacy-answer-${index}`;
      legacy.session.questions.push(question);
      legacy.session.answers.push({
        questionId: question.id,
        questionVersion: 1,
        state: "unknown",
        optionIds: [],
        text: "",
        number: null,
        id: answerId,
        question: { ...question, status: "active" },
        createdAt: snapshot.session.createdAt,
        revision: snapshot.session.revision,
      });
      legacy.session.sourceRecords.push({
        id: answerId,
        kind: "answer",
        label: question.title,
        text: `${question.title}\n用户暂时不知道`,
        createdAt: snapshot.session.createdAt,
      });
    }
    legacy.session.questions.push(active);
    saveLegacyState(legacy);
    snapshot = getPlanning(snapshot.session.id, owner);
    expect(snapshot.session.progress).toMatchObject({
      round: 1,
      questionLimit: 8,
      questionsIssued: 10,
      questionsAnswered: 9,
      questionsRemaining: 0,
      questionSlotsRemaining: 0,
      activeQuestions: 0,
    });
    expect(snapshot.session.answers).toHaveLength(9);
    expect(snapshot.session.questions.at(-1)?.status).toBe("withdrawn");
    expect(snapshot.session.status).toBe("ready");
    const calls = fixture.generate.mock.calls.length;
    await finishAnalysis();
    expect(fixture.generate.mock.calls.slice(calls).map(([request]) => request.name)).toEqual([
      "planning_analyze",
      "planning_feasibility",
      "planning_production",
      "planning_review",
    ]);
    expect(snapshot.session.progress).toMatchObject({
      round: 1,
      questionsIssued: 10,
      questionsAnswered: 9,
    });
    expect(snapshot.session.answers).toHaveLength(9);
    expect(snapshot.events.some((event) => event.kind === "round_started")).toBe(false);
  });

  it("keeps an explicit unknown unresolved after an unrelated note even if A proposes a value", async () => {
    await reachQuestions();
    await apply({ kind: "answer", answers: [answerInput("unknown")] });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    await apply({ kind: "note", text: "只修改项目标题，其余信息没有变化。", itemIds: [] });
    proposed = true;
    await apply({ kind: "preview" });
    await finishAnalysis();
    expect(snapshot.session.items.find((item) => item.id === "entry")?.status).toBe("deferred");
    expect(snapshot.session.report?.unresolved.join("\n")).toContain("用户暂时不知道");
    const report = snapshot.session.report!;
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.items.find((item) => item.id === "entry")).toMatchObject({
      status: "deferred",
      confirmation: null,
    });
    expect(snapshot.session.report?.unresolved.join("\n")).toContain("用户暂时不知道");
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

  it("ends questions early without fabricating answers and discloses them in the analysis", async () => {
    await reachQuestions();
    const active = structuredClone(
      snapshot.session.questions.filter((question) => question.status === "active"),
    );
    await apply({ kind: "preview" });
    await finishAnalysis();
    expect(snapshot.session.answers).toEqual([]);
    expect(snapshot.session.questions.filter((question) => question.status === "active")).toEqual(
      [],
    );
    expect(
      snapshot.session.questions
        .filter((question) => question.status === "withdrawn")
        .map((question) => question.title),
    ).toEqual(active.map((question) => question.title));
    expect(snapshot.session.progress.endedEarly).toBe(true);
    expect(snapshot.session.report?.unresolved.join("\n")).toContain(active[0].title);
    expect(snapshot.session.review?.ready).toBe(true);
    expect(snapshot.session.capabilities.canConfirm).toBe(true);
    expect(snapshot.session.report?.status).toBe("draft");
  });

  it("only adopts the exact current analysis and keeps internal instructions out of user markdown", async () => {
    await reachReport();
    const report = snapshot.session.report!;
    expect(snapshot.session.capabilities.canConfirm).toBe(true);
    expect(report.status).toBe("draft");
    expect(report.markdown).toContain("纸面需求工作台执行方案");
    expect(report.executionPrompt).toContain("实际用户回答驱动");
    expect(report.markdown).not.toContain(report.executionPrompt);
    expect(report.markdown).not.toContain("## 执行提示词");
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

  it("invalidates dependent analysis after a correction without promoting adoption to item confirmation", async () => {
    await reachReport();
    const report = snapshot.session.report!;
    await apply({ kind: "confirm", reportId: report.id, fingerprint: report.fingerprint });
    expect(snapshot.session.items.find((item) => item.id === "questions")?.status).toBe("proposed");
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
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
    request.onPreview({ field: "reasoning", text: "不得展示的内部内容" });
    request.onPreview({ field: "nextActions.0", text: "先用最小流程验证用户能否理解问题。" });
    const publicOutput = getPlanning(snapshot.session.id, owner).session.agents.find(
      (agent) => agent.id === "A",
    )?.preview;
    expect(publicOutput).toContain("先用最小流程");
    expect(publicOutput).toContain("进入工作台");
    expect(publicOutput).not.toContain("不得展示");
    clock.mockRestore();
    finish(result(analysis()));
    snapshot = await running;
    expect(snapshot.snapshotVersion).toBeGreaterThan(preview.snapshotVersion);
    expect(snapshot.session.agents.find((agent) => agent.id === "A")?.preview).toBe("");
  });

  it("keeps the previous public summary readable while the same agent updates it", async () => {
    await reachQuestions();
    const previous = snapshot.session.agents.find((agent) => agent.id === "A")!.summary;
    await apply({ kind: "answer", answers: [answerInput()] });
    let finish!: (value: ReturnType<typeof result>) => void;
    fixture.generate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const running = actPlanning(snapshot.session.id, owner, action({ kind: "advance" }));
    const working = getPlanning(snapshot.session.id, owner);
    expect(working.session.agents.find((agent) => agent.id === "A")).toMatchObject({
      status: "running",
      summary: previous,
      preview: "",
    });
    const updated = { ...analysis(), summary: "现在已根据用户回答明确进入时机。" };
    finish(result(updated));
    snapshot = await running;
    expect(snapshot.session.agents.find((agent) => agent.id === "A")?.summary).toContain(
      updated.summary,
    );
    expect(snapshot.session.agents.find((agent) => agent.id === "A")?.summary).not.toContain(
      previous,
    );
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
