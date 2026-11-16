/**
 * Explicit synthetic API fixtures for the planning UI. No model calls are made.
 * These checks cover presentation, requests, recovery and animation triggers;
 * model comprehension and server invariants are tested separately.
 */
import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import type {
  CreatePlanningInput,
  PlanningAction,
  PlanningAgentId,
  PlanningEvent,
  PlanningQuestion,
  PlanningSnapshot,
} from "../../src/lib/planning-contracts";
import { PLANNING_AGENT_IDS, PLANNING_CONTRACT_VERSION } from "../../src/lib/planning-contracts";
import { DEFAULT_MODEL_ID, MODEL_CATALOG } from "../../src/lib/model-catalog";
import { paperCorners } from "../../src/components/planning/paper-motion";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

const date = "2026-11-16T10:00:00.000Z";
const goal = "合成样本：我想做一个个人网站，展示作品，方便别人联系我。";
const sessionId = "synthetic-planning-ui";
const question: PlanningQuestion = {
  id: "workspace-entry",
  version: 1,
  itemIds: ["entry"],
  title: "这个网站主要给谁看？",
  reason: "受众会影响首页内容和作品的展示顺序。",
  type: "single",
  options: [
    {
      id: "form_first",
      label: "读者与朋友",
      description: "以文章、近况和个人介绍为主。",
      consequences: ["需要持续整理内容"],
    },
    {
      id: "workspace_first",
      label: "招聘方与合作伙伴",
      description: "以代表作品和联系方式为主。",
      consequences: ["先准备少量有代表性的作品"],
    },
  ],
  placeholder: "也可以提出自己的方向",
  unit: "",
  minSelections: 1,
  maxSelections: 1,
  askedBy: "B",
  answerTo: "A",
  status: "active",
  allowUnknown: true,
  allowSkip: true,
};

function initialSnapshot(): PlanningSnapshot {
  return {
    snapshotVersion: 1,
    eventCursor: 0,
    events: [],
    session: {
      contractVersion: PLANNING_CONTRACT_VERSION,
      id: sessionId,
      revision: 0,
      goal,
      modelMode: DEFAULT_MODEL_ID,
      status: "ready",
      productScope: "analysis_and_guidance",
      progress: {
        round: 1,
        questionLimit: 8,
        questionsIssued: 0,
        questionsAnswered: 0,
        questionsRemaining: 8,
        questionSlotsRemaining: 8,
        activeQuestions: 0,
        stage: "understanding",
        budgetExhausted: false,
        endedEarly: false,
        coverage: (
          [
            "goal",
            "resources",
            "time_cost",
            "constraints",
            "risks",
            "implementation",
            "mvp",
          ] as const
        ).map((area) => ({
          area,
          status: "unknown",
          reason: "尚未分析",
          itemIds: [],
          assessedBy: null,
        })),
      },
      expertResults: [],
      agents: PLANNING_AGENT_IDS.map((id, index) => ({
        id,
        name: ["需求理解", "关键取舍", "可行性", "制作路径", "综合分析"][index],
        responsibility: [
          "整理目标与已知信息",
          "找到影响方向的选择",
          "核对资源与风险",
          "安排最小可行版本",
          "整理项目分析",
        ][index],
        status: "idle",
        taskId: null,
        operationId: null,
        taskLabel: "",
        summary: "",
        preview: "",
        startedAt: null,
        finishedAt: null,
      })),
      items: [],
      sourceRecords: [
        { id: "goal-source", kind: "goal", label: "用户目标", text: goal, createdAt: date },
      ],
      questions: [],
      answers: [],
      draft: null,
      review: null,
      report: null,
      capabilities: {
        canAdvance: true,
        canAnswer: false,
        canAddNote: true,
        canPreview: false,
        canConfirm: false,
        canStop: true,
        canStartRound: false,
        reason: "",
      },
      nextAction: "advance",
      activeOperationId: null,
      error: null,
      createdAt: date,
      updatedAt: date,
    },
  };
}

type EventInput = Pick<PlanningEvent, "kind" | "actor" | "title" | "detail"> &
  Partial<PlanningEvent>;
function record(snapshot: PlanningSnapshot, input: EventInput) {
  const seq = snapshot.eventCursor + 1;
  snapshot.events.push({
    id: `synthetic-event-${seq}`,
    seq,
    revision: snapshot.session.revision,
    operationId: null,
    from: null,
    to: null,
    questionId: null,
    questionVersion: null,
    answerId: null,
    itemIds: [],
    createdAt: date,
    ...input,
  });
  snapshot.eventCursor = seq;
  snapshot.snapshotVersion += 1;
}

function finished(snapshot: PlanningSnapshot, role: PlanningAgentId, operationId: string) {
  const agent = snapshot.session.agents.find((entry) => entry.id === role)!;
  Object.assign(agent, {
    status: "completed",
    summary: `明确标注的合成 ${role} 工作结果`,
    taskLabel: `${role} 已完成当前步骤`,
    finishedAt: date,
  });
  snapshot.session.activeOperationId = null;
  record(snapshot, {
    kind: "agent_completed",
    actor: role,
    from: role,
    to: role === "A" ? "B" : role === "B" ? "D" : role === "D" ? "E" : role === "E" ? "C" : "user",
    operationId,
    title: `${role} 完成当前步骤`,
    detail: "合成测试结果，只验证界面交接。",
  });
}

function analyzed(previous: PlanningSnapshot, operationId: string) {
  const next = structuredClone(previous);
  const answered = next.session.answers.at(-1);
  next.session.revision += 1;
  next.session.items = [
    {
      id: "entry",
      dimension: "flow",
      title: "网站主要受众",
      description:
        answered?.state === "answered"
          ? "面向招聘方与合作伙伴，优先展示代表作品和联系方式。"
          : "网站主要受众尚未明确，先提供两种内容方向。",
      status: answered ? (answered.state === "answered" ? "proposed" : "deferred") : "open",
      required: true,
      dependsOn: [],
      sources: answered
        ? [{ kind: "answer", id: answered.id, quote: answered.text || "暂时不知道" }]
        : [{ kind: "goal", id: "goal-source", quote: goal }],
      confirmation: null,
      reason: "依据回答整理，未决条件保持未决。",
    },
  ];
  next.session.draft = {
    title: "个人网站项目分析",
    summary:
      "你想有一个自己的作品入口，让别人快速了解你，并能直接联系你。第一版可从作品介绍和联系入口开始。",
    sections: [
      {
        id: "entry",
        title: "我们对项目的理解",
        content: next.session.items[0].description,
        itemIds: ["entry"],
        sources: next.session.items[0].sources,
      },
    ],
    changes: [],
  };
  next.session.status = "ready";
  next.session.nextAction = "advance";
  next.session.progress.stage = "clarifying";
  Object.assign(next.session.capabilities, {
    canAdvance: true,
    canAnswer: false,
    canAddNote: true,
    canPreview: true,
    canConfirm: false,
  });
  finished(next, "A", operationId);
  return next;
}

function questioned(previous: PlanningSnapshot, operationId: string, issue = true) {
  const next = structuredClone(previous);
  next.session.questions = issue ? [structuredClone(question)] : next.session.questions;
  next.session.status = issue ? "awaiting_user" : "ready";
  next.session.nextAction = issue ? "answer" : "advance";
  Object.assign(next.session.progress, {
    stage: issue ? "clarifying" : "feasibility",
    questionsIssued: issue ? 1 : next.session.progress.questionsIssued,
    questionSlotsRemaining: issue ? 7 : next.session.progress.questionSlotsRemaining,
    activeQuestions: issue ? 1 : 0,
    endedEarly: !issue,
  });
  Object.assign(next.session.capabilities, {
    canAdvance: !issue,
    canAnswer: issue,
    canAddNote: true,
    canPreview: true,
    canConfirm: false,
  });
  finished(next, "B", operationId);
  if (issue)
    record(next, {
      kind: "question_issued",
      actor: "B",
      from: "B",
      to: "user",
      operationId,
      questionId: question.id,
      questionVersion: question.version,
      itemIds: question.itemIds,
      title: "确认网站受众",
      detail: question.title,
    });
  return next;
}

function answered(previous: PlanningSnapshot, action: Extract<PlanningAction, { kind: "answer" }>) {
  const next = structuredClone(previous);
  const input = action.answers[0];
  const savedQuestion = next.session.questions.find((entry) => entry.id === input.questionId)!;
  next.session.revision += 1;
  const answer = {
    ...input,
    id: `synthetic-answer-${next.session.answers.length + 1}`,
    question: structuredClone(savedQuestion),
    revision: next.session.revision,
    createdAt: date,
  };
  next.session.answers.push(answer);
  savedQuestion.status = "answered";
  for (const item of next.session.items.filter((entry) =>
    savedQuestion.itemIds.includes(entry.id),
  )) {
    item.status = input.state === "answered" ? "needs_review" : "deferred";
    item.confirmation = null;
  }
  const text =
    input.state === "unknown"
      ? "暂时不知道"
      : input.state === "skipped"
        ? "暂时跳过"
        : [
            ...input.optionIds
              .map((id) => savedQuestion.options.find((option) => option.id === id)?.label)
              .filter(Boolean),
            input.text,
          ]
            .filter(Boolean)
            .join("；");
  next.session.sourceRecords.push({
    id: answer.id,
    kind: "answer",
    label: "用户回答",
    text,
    createdAt: date,
  });
  const remaining = next.session.questions.filter((entry) => entry.status === "active").length;
  next.session.status = remaining ? "awaiting_user" : "ready";
  next.session.nextAction = remaining ? "answer" : "advance";
  Object.assign(next.session.progress, {
    questionsAnswered: next.session.progress.questionsAnswered + 1,
    questionsRemaining: Math.max(0, next.session.progress.questionsRemaining - 1),
    activeQuestions: remaining,
    stage: remaining ? "clarifying" : "understanding",
  });
  Object.assign(next.session.capabilities, {
    canAdvance: !remaining,
    canAnswer: !!remaining,
    canAddNote: true,
    canPreview: true,
    canConfirm: false,
  });
  record(next, {
    kind: "answer_saved",
    actor: "user",
    from: "user",
    to: "A",
    operationId: action.operationId,
    answerId: answer.id,
    questionId: savedQuestion.id,
    questionVersion: savedQuestion.version,
    itemIds: savedQuestion.itemIds,
    title: "用户回答已保存",
    detail: text,
  });
  return next;
}

function expert(previous: PlanningSnapshot, role: "D" | "E", operationId: string) {
  const next = structuredClone(previous);
  const summary =
    role === "D"
      ? "一个人可以完成以作品展示为主的第一版。现有作品和可投入时间尚未核实，建议先用静态页面验证内容，不引入复杂后台。"
      : "先选三件作品，整理图片与简短说明；再安排首页、作品页和联系入口。用一个可阅读的版本检查信息顺序，再决定是否需要文章管理。";
  next.session.expertResults.push({
    id: `synthetic-expert-${role}`,
    agentId: role,
    round: 1,
    basedOnRevision: next.session.revision,
    contentFingerprint: "c".repeat(64),
    summary,
    conclusion: "conditional",
    sections: [
      {
        id: `${role}-finding`,
        title: role === "D" ? "资源与风险" : "第一版制作顺序",
        content: summary,
        itemIds: ["entry"],
        sources: next.session.items[0].sources,
      },
    ],
    risks: ["作品素材和投入时间仍需核对。"],
    unknowns: ["用户现有作品数量", "本周可投入的时间"],
    nextSteps:
      role === "D"
        ? ["清点现有作品", "确定第一版范围"]
        : ["整理三件作品", "搭建页面结构", "检查手机阅读和联系入口"],
    minimumViableVersion: "一页个人介绍、三件代表作品和一个联系入口。",
    createdAt: date,
  });
  next.session.status = "ready";
  next.session.nextAction = "advance";
  next.session.progress.stage = role === "D" ? "production" : "synthesizing";
  Object.assign(next.session.capabilities, {
    canAdvance: true,
    canAnswer: false,
    canPreview: false,
    canAddNote: true,
  });
  finished(next, role, operationId);
  next.session.agents.find((entry) => entry.id === role)!.summary = summary;
  return next;
}

function reviewed(previous: PlanningSnapshot, operationId: string, ready: boolean) {
  const next = structuredClone(previous);
  const contentFingerprint = "c".repeat(64);
  next.session.review = {
    id: "synthetic-review-1",
    basedOnRevision: next.session.revision,
    contentFingerprint,
    ready,
    coverage: [
      {
        dimension: "flow",
        status: ready ? "covered" : "open",
        reason: ready ? "已形成明确分析，并保留未核实条件" : "分析尚未覆盖受众影响",
        itemIds: ["entry"],
      },
    ],
    blockers: ready
      ? []
      : [
          {
            id: "entry-unknown",
            itemIds: ["entry"],
            description: "分析尚未说明受众未知会怎样影响制作方向。",
          },
        ],
    risks: [],
    uncertainties: ["可投入时间尚未核实"],
  };
  next.session.report = {
    id: "synthetic-report-1",
    basedOnRevision: next.session.revision,
    contentFingerprint,
    fingerprint: "a".repeat(64),
    status: "draft",
    title: "个人网站项目分析 · 合成样本",
    summary:
      "你想通过个人网站展示自己的作品，让有兴趣的人了解你的能力并取得联系。以小范围的静态作品展示起步具有可行性，素材和时间还需要核对。",
    sections: structuredClone(next.session.draft!.sections).map((section, index) => ({
      ...section,
      content:
        index === 0
          ? `${section.content}\n\n给 AI 的执行说明：INTERNAL_BODY_MUST_NOT_RENDER`
          : section.content,
    })),
    tasks: [
      {
        id: "entry-task",
        title: "整理首批作品",
        instructions: "选三件作品，分别整理一张主图、一段背景说明和自己的贡献。",
        dependsOn: [],
        acceptance: ["陌生人能看懂每件作品的用途", "联系方式可以使用"],
      },
    ],
    risks: ["现有素材不足时，先缩小展示范围。"],
    unresolved: [
      "可投入时间尚未核实",
      ...next.session.items
        .filter((item) => ["open", "needs_review", "deferred"].includes(item.status))
        .map((item) => item.description),
    ],
    acceptance: ["读者能了解项目目的、可行条件与第一步安排"],
    executionPrompt: "INTERNAL_PROMPT_MUST_NOT_RENDER：你是执行模型，请按内部协议处理。",
    markdown: "# INTERNAL_MARKDOWN_MUST_NOT_EXPORT\n\n只用于证明导出不使用未经筛选的内部文本。",
    confirmedAt: null,
  };
  next.session.status = "review_ready";
  next.session.nextAction = ready ? "confirm" : "start_round";
  next.session.progress.stage = "report";
  Object.assign(next.session.capabilities, {
    canAdvance: false,
    canAnswer: false,
    canAddNote: true,
    canPreview: false,
    canConfirm: ready,
    canStartRound: true,
    reason: ready ? "" : "分析还未说明未决条件的影响。",
  });
  finished(next, "C", operationId);
  record(next, {
    kind: "report_ready",
    actor: "C",
    from: "C",
    to: "user",
    operationId,
    title: "项目分析已整理",
    detail: "合成测试文档，不代表真实模型输出。",
  });
  return next;
}

type HeldAction = { body: PlanningAction; route: Route; taken: boolean };
async function installSyntheticApi(page: Page, initial = initialSnapshot()) {
  let state = structuredClone(initial);
  let reads = 0;
  const creates: CreatePlanningInput[] = [];
  const actions: HeldAction[] = [];
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        version: "synthetic-planning-ui-only",
        commit: "fixture",
        accessGranted: true,
        requiresAccessCode: false,
        identityBootstrap: false,
        model: {
          id: "fixture-not-a-model",
          configured: true,
          promptVersion: "explicit-fixture",
          schemaVersion: "1.0.0",
          models: MODEL_CATALOG.map((model) => ({ ...model, configured: true })),
        },
      },
    }),
  );
  await page.route(/\/api\/planning(?:\/.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/planning" && request.method() === "POST") {
      const body = request.postDataJSON() as CreatePlanningInput;
      creates.push(body);
      state.session.goal = body.goal;
      state.session.modelMode = body.modelMode;
      record(state, {
        kind: "session_created",
        actor: "system",
        operationId: body.operationId,
        title: "工作台已建立",
        detail: "创建不等待任何模型输出。",
      });
      await route.fulfill({ status: 201, json: state });
      return;
    }
    if (path === `/api/planning/${sessionId}` && request.method() === "GET") {
      reads += 1;
      await route.fulfill({ json: state });
      return;
    }
    if (path === `/api/planning/${sessionId}/actions` && request.method() === "POST") {
      const body = request.postDataJSON() as PlanningAction;
      expect(body.revision).toBe(state.session.revision);
      actions.push({ body, route, taken: false });
      if (body.kind === "advance" || body.kind === "preview") {
        const role: PlanningAgentId =
          body.kind === "preview"
            ? "D"
            : (
                {
                  understanding: "A",
                  clarifying: "B",
                  feasibility: "D",
                  production: "E",
                  synthesizing: "C",
                  report: "C",
                } as const
              )[state.session.progress.stage];
        if (body.kind === "preview") {
          state.session.questions.forEach((entry) => {
            if (entry.status === "active") entry.status = "withdrawn";
          });
          state.session.progress.endedEarly = true;
          state.session.progress.activeQuestions = 0;
          state.session.progress.stage = "feasibility";
        }
        state.session.status = "working";
        state.session.activeOperationId = body.operationId;
        Object.assign(state.session.capabilities, {
          canAdvance: false,
          canAnswer: false,
          canAddNote: false,
          canPreview: false,
          canConfirm: false,
          canStartRound: false,
        });
        Object.assign(state.session.agents.find((entry) => entry.id === role)!, {
          status: "running",
          operationId: body.operationId,
          taskId: `synthetic-${role}`,
          taskLabel: `${role} 正在处理当前任务`,
          startedAt: date,
        });
        record(state, {
          kind: "agent_started",
          actor: role,
          operationId: body.operationId,
          title: `${role} 开始工作`,
          detail: "请求暂由测试保持，尚未返回工作结果。",
        });
      }
      // Deliberately keep this request pending until the test supplies its result.
      return;
    }
    throw new Error(`Unexpected synthetic planning API request: ${request.method()} ${path}`);
  });
  return {
    creates,
    actions,
    get snapshot() {
      return structuredClone(state);
    },
    get reads() {
      return reads;
    },
    publish(value: PlanningSnapshot) {
      state = structuredClone(value);
    },
    async next(kind: PlanningAction["kind"]) {
      await expect
        .poll(() => actions.filter((entry) => !entry.taken && entry.body.kind === kind).length)
        .toBe(1);
      const pending = actions.find((entry) => !entry.taken && entry.body.kind === kind)!;
      pending.taken = true;
      return pending;
    },
    async reply(pending: HeldAction, value: PlanningSnapshot) {
      state = structuredClone(value);
      await pending.route.fulfill({ json: state });
    },
    async reject(pending: HeldAction) {
      await pending.route.fulfill({
        status: 409,
        json: { error: "合成保存失败，请重试。", code: "FIXTURE_SAVE_FAILED" },
      });
    },
    async lose(pending: HeldAction) {
      await pending.route.abort("failed");
    },
  };
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`synthetic-planning-${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await testInfo.attach(`Synthetic planning API fixture: ${name}`, {
    path,
    contentType: "image/png",
  });
}

async function finishExperts(api: Awaited<ReturnType<typeof installSyntheticApi>>, ready = true) {
  const feasibility = await api.next("advance");
  await api.reply(feasibility, expert(api.snapshot, "D", feasibility.body.operationId));
  const production = await api.next("advance");
  await api.reply(production, expert(api.snapshot, "E", production.body.operationId));
  const synthesis = await api.next("advance");
  await api.reply(synthesis, reviewed(api.snapshot, synthesis.body.operationId, ready));
}

async function openReport(page: Page) {
  const report = page.getByRole("dialog", { name: "个人网站项目分析 · 合成样本", exact: true });
  if (!(await report.isVisible()))
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
  await expect(report).toBeVisible();
  return report;
}

function adopted(previous: PlanningSnapshot, operationId: string) {
  const next = structuredClone(previous);
  next.session.status = "completed";
  next.session.nextAction = "none";
  next.session.report!.status = "confirmed";
  next.session.report!.confirmedAt = date;
  Object.assign(next.session.capabilities, {
    canAdvance: false,
    canAnswer: false,
    canPreview: false,
    canConfirm: false,
    canStop: false,
    canStartRound: true,
  });
  record(next, {
    kind: "report_confirmed",
    actor: "user",
    operationId,
    title: "已采用当前分析",
    detail: "采用报告不改变仍未确定的项目条件。",
  });
  return next;
}

test("synthetic API: five-agent workspace, automatic single choice, persisted receipt and reader-only report", async ({
  page,
}, testInfo) => {
  test.setTimeout(70_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const api = await installSyntheticApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "你想做些什么？", exact: true })).toBeVisible();
  await expect(page.getByText("让想法，有处落笔。", { exact: true })).toHaveCount(0);
  await screenshot(page, testInfo, "home");
  await page.getByLabel("你想做些什么？", { exact: true }).fill(goal);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  const firstAnalysis = await api.next("advance");

  // No model result exists, but all real-role workspaces are already available.
  await expect(page.getByRole("heading", { name: goal, exact: true })).toBeVisible();
  await expect(page.locator("[data-planning-agent]")).toHaveCount(5);
  for (const role of PLANNING_AGENT_IDS)
    await expect(page.locator(`[data-planning-agent="${role}"]`)).toBeVisible();
  expect(api.snapshot.session.items).toEqual([]);
  expect(api.snapshot.session.expertResults).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await screenshot(page, testInfo, "desktop-before-model-response");

  const streaming = api.snapshot;
  streaming.session.agents[0].preview =
    "你希望建立自己的作品入口，让招聘方看到代表项目，并能快速联系你。";
  streaming.snapshotVersion += 1;
  api.publish(streaming);
  await expect(page.locator('[data-planning-agent="A"]')).toContainText(
    streaming.session.agents[0].preview,
  );
  await api.reply(firstAnalysis, analyzed(api.snapshot, firstAnalysis.body.operationId));
  const firstQuestions = await api.next("advance");
  await api.reply(firstQuestions, questioned(api.snapshot, firstQuestions.body.operationId));
  const paper = page.getByRole("dialog", { name: question.title, exact: true });
  await expect(paper).toBeVisible();
  await expect(paper.getByRole("radio")).toHaveCount(2);
  for (const radio of await paper.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  await expect
    .poll(() =>
      paper.evaluate((element) =>
        element.getAnimations().every((animation) => animation.playState !== "running"),
      ),
    )
    .toBe(true);
  const box = await paper.boundingBox();
  expect(box!.x).toBeGreaterThan(700);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  await screenshot(page, testInfo, "desktop-right-question");
  await paper.getByRole("button", { name: "自己填写", exact: true }).click();
  const supplement = "先整理三件代表作品，保留邮件联系入口，不急着做复杂后台。";
  await paper.getByLabel("补充或自己的方向", { exact: true }).fill(supplement);
  await paper.getByRole("radio", { name: "招聘方与合作伙伴", exact: true }).check();
  const save = await api.next("answer");
  expect(save.body).toMatchObject({
    kind: "answer",
    answers: [
      {
        questionId: question.id,
        state: "answered",
        optionIds: ["workspace_first"],
        text: supplement,
      },
    ],
  });
  await expect(paper.getByRole("radio").nth(1)).toBeDisabled();
  await expect(page.locator(".p-receipt-content")).toHaveCount(0);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(1);

  if (save.body.kind !== "answer") throw new Error("Expected answer");
  // A GET proves the write completed while the POST remains pending.
  api.publish(answered(api.snapshot, save.body));
  await expect(page.locator(".p-receipt-content")).toContainText(supplement);
  await expect(page.locator("dialog.p-paper")).toHaveCount(0);
  const refinement = await api.next("advance");
  await api.reply(refinement, analyzed(api.snapshot, refinement.body.operationId));
  const noMoreQuestions = await api.next("advance");
  await api.reply(
    noMoreQuestions,
    questioned(api.snapshot, noMoreQuestions.body.operationId, false),
  );
  const lowerRowBeforeExperts = await page.locator(".p-slot-E").boundingBox();
  await finishExperts(api);
  await expect(page.getByRole("button", { name: "查看分析", exact: true }).first()).toBeVisible();
  const lowerRowAfterExperts = await page.locator(".p-slot-E").boundingBox();
  expect(Math.abs(lowerRowAfterExperts!.y - lowerRowBeforeExperts!.y)).toBeLessThan(2);
  await expect(page.locator(".p-manuscript")).not.toContainText("INTERNAL_BODY_MUST_NOT_RENDER");
  const report = await openReport(page);
  await expect(report.getByRole("checkbox")).toHaveCount(0);
  await expect(
    report.getByText(
      /INTERNAL_(?:PROMPT_MUST_NOT_RENDER|MARKDOWN_MUST_NOT_EXPORT|BODY_MUST_NOT_RENDER)/,
    ),
  ).toHaveCount(0);
  await expect(report.getByRole("button", { name: "执行提示词", exact: true })).toHaveCount(0);
  await expect(report).toContainText("可投入时间尚未核实");

  const downloadEvent = page.waitForEvent("download");
  await report.getByRole("button", { name: "下载分析", exact: true }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const document = Buffer.concat(chunks).toString("utf8");
  expect(document).toContain("个人网站项目分析");
  expect(document).toContain("可投入时间尚未核实");
  expect(document).not.toMatch(/INTERNAL_|fingerprint|operationId|synthetic-report-1|"c"\.repeat/);
  expect(document).not.toContain("c".repeat(64));

  // A new report version is the one the adoption action must name.
  const updated = api.snapshot;
  updated.session.report!.id = "synthetic-report-2";
  updated.session.report!.fingerprint = "b".repeat(64);
  updated.session.report!.summary = "合成第二版：第一版只展示三件作品，资料和时间仍需核对。";
  record(updated, {
    kind: "report_ready",
    actor: "C",
    title: "分析已更新",
    detail: updated.session.report!.summary,
  });
  api.publish(updated);
  await expect(report).toContainText(updated.session.report!.summary, { timeout: 10_000 });
  await report.getByRole("button", { name: "采用这份分析", exact: true }).click();
  const confirmation = await api.next("confirm");
  expect(confirmation.body).toMatchObject({
    kind: "confirm",
    reportId: "synthetic-report-2",
    fingerprint: "b".repeat(64),
    revision: updated.session.revision,
  });
  await api.reply(confirmation, adopted(api.snapshot, confirmation.body.operationId));
  await expect(report.getByLabel("已采用当前分析", { exact: true })).toBeVisible();
  expect(api.snapshot.session.items[0].status).toBe("proposed");
  expect(api.snapshot.session.items[0].confirmation).toBeNull();
  await screenshot(page, testInfo, "desktop-adopted-report");
  await report.getByRole("button", { name: "收起分析", exact: true }).click();
  await page.reload();
  await expect(page.locator("[data-planning-agent]")).toHaveCount(5);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(api.creates).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "confirm")).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "start_round")).toHaveLength(0);
  expect(pageErrors).toEqual([]);
});

test("synthetic API: mobile text draft survives refresh and unknown remains unknown after adopting analysis", async ({
  page,
}, testInfo) => {
  test.setTimeout(50_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const initial = questioned(
    analyzed(initialSnapshot(), "synthetic-initial-A"),
    "synthetic-initial-B",
  );
  initial.session.questions[0] = {
    ...initial.session.questions[0],
    type: "text",
    options: [],
    minSelections: null,
    maxSelections: null,
  };
  const api = await installSyntheticApi(page, initial);
  await page.goto(`/?planning=${sessionId}`);
  await expect(page.locator("[data-planning-agent]")).toHaveCount(5);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const open = () =>
    page
      .getByRole("button", { name: new RegExp(question.title) })
      .first()
      .click();
  await open();
  let paper = page.getByRole("dialog", { name: question.title, exact: true });
  const draft = "先展示我做过的几个项目，但我还没决定主要面向谁。";
  await paper.getByLabel("你的想法", { exact: true }).fill(draft);
  expect(api.actions).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await open();
  paper = page.getByRole("dialog", { name: question.title, exact: true });
  await expect(paper.getByLabel("你的想法", { exact: true })).toHaveValue(draft);
  const box = await paper.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await expect(paper.getByRole("button", { name: "暂时不知道", exact: true })).toBeInViewport();
  await screenshot(page, testInfo, "mobile-restored-question");
  await paper.getByRole("button", { name: "暂时不知道", exact: true }).click();
  const save = await api.next("answer");
  expect(save.body).toMatchObject({
    kind: "answer",
    answers: [{ state: "unknown", optionIds: [], text: "", number: null }],
  });
  if (save.body.kind !== "answer") throw new Error("Expected answer");
  await api.reply(save, answered(api.snapshot, save.body));
  await expect(page.locator("dialog.p-paper")).toHaveCount(0);
  const refinement = await api.next("advance");
  await api.reply(refinement, analyzed(api.snapshot, refinement.body.operationId));
  const noQuestion = await api.next("advance");
  await api.reply(noQuestion, questioned(api.snapshot, noQuestion.body.operationId, false));
  await finishExperts(api);
  const report = await openReport(page);
  await expect(report).toContainText("网站主要受众尚未明确");
  await screenshot(page, testInfo, "mobile-analysis-with-unknowns");
  await report.getByRole("button", { name: "采用这份分析", exact: true }).click();
  const confirmation = await api.next("confirm");
  await api.reply(confirmation, adopted(api.snapshot, confirmation.body.operationId));
  expect(api.snapshot.session.items[0].status).toBe("deferred");
  expect(api.snapshot.session.items[0].confirmation).toBeNull();
  expect(api.snapshot.session.answers[0].state).toBe("unknown");
  await report.getByRole("button", { name: "收起分析", exact: true }).click();
  await page.reload();
  await expect(page.locator("[data-planning-agent]")).toHaveCount(5);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "confirm")).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "start_round")).toHaveLength(0);
});

test("synthetic API: keyboard browsing never submits, failed selection is retained, saved selection opens next question", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const initial = questioned(analyzed(initialSnapshot(), "initial-A"), "initial-B");
  const nextQuestion: PlanningQuestion = {
    ...structuredClone(question),
    id: "available-time",
    title: "每周能为第一版留出多少时间？",
    type: "number",
    options: [],
    unit: "小时",
    minSelections: null,
    maxSelections: null,
    itemIds: ["time"],
  };
  initial.session.questions.push(nextQuestion);
  initial.session.items.push({
    ...structuredClone(initial.session.items[0]),
    id: "time",
    title: "可投入时间",
    dimension: "constraints",
  });
  initial.session.progress.questionsIssued = 2;
  initial.session.progress.questionSlotsRemaining = 6;
  initial.session.progress.activeQuestions = 2;
  const api = await installSyntheticApi(page, initial);
  await page.goto(`/?planning=${sessionId}`);
  await page
    .getByRole("button", { name: new RegExp(question.title) })
    .first()
    .click();
  let paper = page.getByRole("dialog", { name: question.title, exact: true });
  await expect(paper).toBeVisible();
  await paper.getByRole("button", { name: "暂时收起问题", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(api.actions).toHaveLength(0);
  await page
    .getByRole("button", { name: new RegExp(question.title) })
    .first()
    .click();
  paper = page.getByRole("dialog", { name: question.title, exact: true });
  await expect(paper).toBeVisible();
  await paper.getByRole("radio").first().focus();
  await page.keyboard.press("ArrowDown");
  expect(api.actions).toHaveLength(0);
  await page.keyboard.press("Space");
  const failed = await api.next("answer");
  expect(failed.body).toMatchObject({
    kind: "answer",
    answers: [{ optionIds: ["workspace_first"] }],
  });
  await api.reject(failed);
  await expect(paper).toContainText("合成保存失败");
  await expect(paper.getByRole("radio").nth(1)).toBeChecked();
  await expect(page.locator(".p-receipt-content")).toHaveCount(0);
  await paper.getByRole("button", { name: "重试保存", exact: true }).click();
  const save = await api.next("answer");
  if (save.body.kind !== "answer") throw new Error("Expected answer");
  await api.reply(save, answered(api.snapshot, save.body));
  paper = page.getByRole("dialog", { name: nextQuestion.title, exact: true });
  await expect(paper).toBeVisible();
  expect(api.actions.filter((entry) => entry.body.kind === "advance")).toHaveLength(0);
  await paper.getByLabel("你的数值（小时）", { exact: true }).fill("0");
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(2);
  await screenshot(page, testInfo, "desktop-question-relay");
  await paper.getByRole("button", { name: "继续", exact: true }).click();
  const number = await api.next("answer");
  expect(number.body).toMatchObject({
    kind: "answer",
    answers: [{ questionId: "available-time", number: 0, text: "" }],
  });
  if (number.body.kind !== "answer") throw new Error("Expected numeric answer");
  const final = answered(api.snapshot, number.body);
  final.session.status = "paused";
  final.session.nextAction = "none";
  final.session.capabilities.canAdvance = false;
  await api.reply(number, final);
  await expect(page.locator("dialog.p-paper")).toHaveCount(0);
  expect(api.snapshot.session.answers).toHaveLength(2);
});

function richSnapshot() {
  let value = analyzed(initialSnapshot(), "rich-A");
  const titles = [
    "展示目的",
    "首批作品",
    "联系入口",
    "手机阅读",
    "文章内容",
    "制作时间",
    "公开信息",
    "第一版范围",
  ];
  const details = [
    "让招聘方快速了解自己的能力和代表作品。",
    "先挑选三件作品，说明背景、职责和成果。",
    "首页保留邮件地址与常用社交链接。",
    "优先确保手机上的文字和作品图片清楚可读。",
    "文章可以作为后续扩展，第一版不需要后台。",
    "本周能投入多少时间仍未核实。",
    "只公开用户主动提供的姓名、头像与联系方式。",
    "先完成介绍、作品和联系三个部分，再评估扩展。",
  ];
  value.session.items = titles.map((title, index) => ({
    ...structuredClone(value.session.items[0]),
    id: index === 0 ? "entry" : `item-${index}`,
    title,
    description: details[index],
    dimension: (
      [
        "function",
        "content",
        "flow",
        "style",
        "content",
        "constraints",
        "constraints",
        "delivery",
      ] as const
    )[index],
    status: index === 5 ? "deferred" : "proposed",
    required: index < 4,
    reason: index === 5 ? "用户暂时不知道" : "由已有目标和回答整理",
  }));
  value.session.questions = value.session.items.map((item, index) => ({
    ...structuredClone(question),
    id: `rich-question-${index}`,
    title: `${item.title}怎么安排？`,
    itemIds: [item.id],
    type: "text",
    options: [],
    minSelections: null,
    maxSelections: null,
    status: "answered",
  }));
  value.session.answers = value.session.questions.map((entry, index) => ({
    id: `rich-answer-${index}`,
    questionId: entry.id,
    questionVersion: entry.version,
    question: { ...entry, status: "active" },
    state: index === 5 ? "unknown" : "answered",
    optionIds: [],
    text: index === 5 ? "" : details[index],
    number: null,
    createdAt: date,
    revision: value.session.revision,
  }));
  value.session.answers.forEach((answer, index) => {
    const text = answer.state === "unknown" ? "暂时不知道" : answer.text;
    value.session.sourceRecords.push({
      id: answer.id,
      kind: "answer",
      label: titles[index],
      text,
      createdAt: date,
    });
    value.session.items[index].sources = [{ kind: "answer", id: answer.id, quote: text }];
    record(value, {
      kind: "answer_saved",
      actor: "user",
      from: "user",
      to: "A",
      title: titles[index],
      detail: text,
      answerId: answer.id,
      questionId: answer.questionId,
      questionVersion: answer.questionVersion,
      itemIds: [value.session.items[index].id],
      createdAt: new Date(Date.parse(date) + index * 60000).toISOString(),
    });
  });
  value.session.draft!.sections = value.session.items.map((item, index) => ({
    id: `section-${index}`,
    title: item.title,
    content: item.description,
    itemIds: [item.id],
    sources: item.sources,
  }));
  for (let index = 0; index < 18; index++) {
    const role = PLANNING_AGENT_IDS[index % PLANNING_AGENT_IDS.length];
    record(value, {
      kind: "agent_completed",
      actor: role,
      from: role,
      to: PLANNING_AGENT_IDS[(index + 1) % PLANNING_AGENT_IDS.length],
      title: titles[index % titles.length],
      detail: details[index % details.length],
      itemIds: [value.session.items[index % 8].id],
      createdAt: new Date(Date.parse(date) + (index + 8) * 60000).toISOString(),
    });
  }
  value = expert(value, "D", "rich-D");
  value = expert(value, "E", "rich-E");
  value.session.agents.find((agent) => agent.id === "B")!.summary =
    "受众和第一版内容已明确；保留可投入时间这一项未知，先给出两档制作安排。";
  value.session.agents.find((agent) => agent.id === "B")!.status = "completed";
  value.session.agents.find((agent) => agent.id === "C")!.status = "running";
  value.session.agents.find((agent) => agent.id === "C")!.taskLabel = "整理可行条件与制作顺序";
  value.session.agents.find((agent) => agent.id === "C")!.preview =
    "目前适合先做一个内容完整、维护简单的作品网站。关键风险是素材准备和投入时间，第一版可以用静态页面完成，文章后台留到下一阶段。";
  value.session.status = "working";
  value.session.activeOperationId = "rich-live-C";
  value.session.nextAction = "none";
  value.session.progress = {
    ...value.session.progress,
    questionsIssued: 8,
    questionsAnswered: 8,
    questionsRemaining: 0,
    questionSlotsRemaining: 0,
    activeQuestions: 0,
    stage: "synthesizing",
    budgetExhausted: true,
    coverage: value.session.progress.coverage.map((entry, index) => ({
      ...entry,
      status: index === 2 ? "partial" : "covered",
      reason: index === 2 ? "可投入时间仍待核实" : details[index],
      itemIds: [value.session.items[index].id],
      assessedBy: index < 2 ? "A" : index < 5 ? "D" : "E",
    })),
  };
  Object.assign(value.session.capabilities, {
    canAdvance: false,
    canAnswer: false,
    canPreview: false,
    canAddNote: false,
    canConfirm: false,
    canStartRound: false,
  });
  return value;
}

test("synthetic API: dense public workbench exposes live findings and readable history without prompt controls", async ({
  page,
}, testInfo) => {
  test.setTimeout(35_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const api = await installSyntheticApi(page, richSnapshot());
  await page.goto(`/?planning=${sessionId}`);
  await expect(page.locator("[data-planning-agent]")).toHaveCount(5);
  await expect(page.locator('[data-planning-agent="D"]')).toContainText("一个人可以完成");
  await expect(page.locator('[data-planning-agent="E"]')).toContainText("先选三件作品");
  await expect(page.locator('[data-planning-agent="C"]')).toContainText("目前适合先做一个");
  await expect(page.getByRole("button", { name: "执行提示词", exact: true })).toHaveCount(0);
  await screenshot(page, testInfo, "desktop-dense-live-analysis");
  // The animation anchor is the visible paper frame, even after its prose scrolls.
  const scrollablePaper = page.locator('[data-planning-agent="D"] .p-agent-paper');
  const readCorners = paperCorners as (
    element: HTMLElement | SVGElement,
  ) => ReturnType<typeof paperCorners>;
  const beforeScroll = await scrollablePaper.evaluate(readCorners);
  const scrolled = await scrollablePaper.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  const afterScroll = await scrollablePaper.evaluate(readCorners);
  for (let index = 0; index < beforeScroll.length; index++) {
    expect(Math.abs(afterScroll[index].x - beforeScroll[index].x)).toBeLessThan(2);
    expect(Math.abs(afterScroll[index].y - beforeScroll[index].y)).toBeLessThan(2);
  }
  await scrollablePaper.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page
    .getByRole("region", { name: "项目档案", exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.locator(".p-log-entry > summary").first().click();
  await screenshot(page, testInfo, "desktop-project-archive");
  await page.getByLabel("按角色筛选日志", { exact: true }).selectOption("D");
  await expect(page.locator(".p-log-entry .actor-D").first()).toBeVisible();
  await expect(page.locator(".p-log-entry .p-log-actor:not(.actor-D)")).toHaveCount(0);
  await page.getByLabel("按角色筛选日志", { exact: true }).selectOption("all");
  await page.getByLabel("查找记录和事项", { exact: true }).fill("制作时间");
  await expect(page.locator(".p-item-sheet")).toHaveCount(1);
  await expect(page.locator(".p-item-sheet")).toContainText("制作时间");
  await page.getByLabel("查找记录和事项", { exact: true }).fill("");
  await expect(page.locator(".p-item-sheet")).toHaveCount(8);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await screenshot(page, testInfo, "laptop-dense-live-analysis");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, testInfo, "mobile-dense-live-analysis");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: /查看正在分析的/ }).click();
  await expect(page.locator('[data-planning-agent="C"]')).toBeInViewport({ ratio: 0.5 });
  await screenshot(page, testInfo, "mobile-current-analysis");
  await page
    .getByRole("region", { name: "项目档案", exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await screenshot(page, testInfo, "mobile-project-archive");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(api.actions).toHaveLength(0);
});

test("synthetic API: reaching the question boundary stops at the report until an explicit additional round", async ({
  page,
}, testInfo) => {
  test.setTimeout(35_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const initial = reviewed(richSnapshot(), "boundary-C", true);
  initial.session.progress.stage = "report";
  const api = await installSyntheticApi(page, initial);
  await page.goto(`/?planning=${sessionId}`);
  await expect(page.locator("[data-planning-agent]")).toHaveCount(5);
  await expect(page.getByRole("button", { name: /再问\s*3\s*题/ }).first()).toBeVisible();
  await expect.poll(() => api.reads).toBeGreaterThanOrEqual(2);
  expect(api.actions).toHaveLength(0);
  await screenshot(page, testInfo, "desktop-bounded-report");
  await page
    .getByRole("button", { name: /再问\s*3\s*题/ })
    .first()
    .click();
  const start = await api.next("start_round");
  expect(start.body).toMatchObject({ kind: "start_round" });
  const next = api.snapshot;
  next.session.status = "ready";
  next.session.nextAction = "advance";
  next.session.report = null;
  next.session.review = null;
  next.session.progress = {
    ...next.session.progress,
    round: 2,
    questionLimit: 3,
    questionsIssued: 0,
    questionsAnswered: 0,
    questionsRemaining: 3,
    questionSlotsRemaining: 3,
    activeQuestions: 0,
    stage: "understanding",
    budgetExhausted: false,
    endedEarly: false,
  };
  Object.assign(next.session.capabilities, {
    canAdvance: true,
    canConfirm: false,
    canStartRound: false,
  });
  record(next, {
    kind: "round_started",
    actor: "user",
    operationId: start.body.operationId,
    title: "开始补充分析",
    detail: "本轮最多三个问题。",
  });
  await api.reply(start, next);
  await api.next("advance");
  expect(api.actions.filter((entry) => entry.body.kind === "start_round")).toHaveLength(1);
});

test("synthetic API: a late saved receipt clears recovery blocking without resending the answer", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const initial = questioned(analyzed(initialSnapshot(), "recovery-A"), "recovery-B");
  const api = await installSyntheticApi(page, initial);
  await page.goto(`/?planning=${sessionId}`);
  await page
    .getByRole("button", { name: new RegExp(question.title) })
    .first()
    .click();
  const paper = page.getByRole("dialog", { name: question.title, exact: true });
  await paper.getByRole("radio", { name: "招聘方与合作伙伴", exact: true }).check();
  const lost = await api.next("answer");
  if (lost.body.kind !== "answer") throw new Error("Expected answer");
  await api.lose(lost);
  await expect(paper.getByRole("button", { name: "核对保存状态", exact: true })).toBeVisible();
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(1);
  api.publish(answered(api.snapshot, lost.body));
  await expect(page.locator("dialog.p-paper")).toHaveCount(0);
  await api.next("advance");
  await expect(page.getByText("保存结果待核对，回答已保留。", { exact: true })).toHaveCount(0);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(1);
});

test("synthetic API: finishing questions early reveals expert work before the model response", async ({
  page,
}, testInfo) => {
  test.setTimeout(40_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const initial = questioned(analyzed(initialSnapshot(), "early-A"), "early-B");
  const api = await installSyntheticApi(page, initial);
  await page.goto(`/?planning=${sessionId}`);
  await page
    .getByRole("button", { name: new RegExp(question.title) })
    .first()
    .click();
  const paper = page.getByRole("dialog", { name: question.title, exact: true });
  await paper.getByRole("button", { name: "先看分析", exact: true }).click();
  const preview = await api.next("preview");
  await expect(page.locator("dialog.p-paper")).toHaveCount(0);
  await expect(page.locator('[data-planning-agent="D"]')).toHaveAttribute("data-status", "running");
  expect(api.snapshot.session.progress.endedEarly).toBe(true);
  expect(api.snapshot.session.questions[0].status).toBe("withdrawn");
  expect(api.snapshot.session.answers).toEqual([]);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(0);
  await screenshot(page, testInfo, "desktop-early-analysis");
  await api.reply(preview, expert(api.snapshot, "D", preview.body.operationId));
  const production = await api.next("advance");
  await api.reply(production, expert(api.snapshot, "E", production.body.operationId));
  const synthesis = await api.next("advance");
  await api.reply(synthesis, reviewed(api.snapshot, synthesis.body.operationId, true));
  const report = await openReport(page);
  await expect(report).toContainText("网站主要受众尚未明确");
  expect(api.actions.filter((entry) => entry.body.kind === "preview")).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(0);
});
