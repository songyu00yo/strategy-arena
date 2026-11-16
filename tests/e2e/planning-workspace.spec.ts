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
import { DEFAULT_MODEL_ID, MODEL_CATALOG } from "../../src/lib/model-catalog";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

const date = "2026-11-16T10:00:00.000Z";
const goal = "测试：保留纸面视觉，先进入三 Agent 工作台，再一起把执行方案想清楚。";
const sessionId = "synthetic-planning-ui";
const question: PlanningQuestion = {
  id: "workspace-entry",
  version: 1,
  itemIds: ["entry"],
  title: "你希望什么时候进入工作台？",
  reason: "这是合成交互样本：进入时机会影响第一次等待分析的位置。",
  type: "single",
  options: [
    {
      id: "form_first",
      label: "先填完表单再进入",
      description: "在入口收集全部信息。",
      consequences: ["进入前需要回答更多问题"],
    },
    {
      id: "workspace_first",
      label: "先进入三 Agent 工作台",
      description: "进入后再逐步讨论具体要求。",
      consequences: ["问题从工作台右侧展开"],
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
      contractVersion: "1.0.0",
      id: sessionId,
      revision: 0,
      goal,
      modelMode: DEFAULT_MODEL_ID,
      status: "ready",
      agents: (["A", "B", "C"] as const).map((id, index) => ({
        id,
        name: ["需求分析", "问题设计", "方案查漏"][index],
        responsibility: ["把想法拆成具体事项", "把未决事项变成问题", "检查方案是否能执行"][index],
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
    to: role === "A" ? "B" : "C",
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
      title: "工作台进入时机",
      description:
        answered?.state === "answered"
          ? "提交想法后立即进入工作台，随后在右侧回答问题。"
          : "进入时机仍需要用户决定。",
      status: answered ? (answered.state === "answered" ? "proposed" : "deferred") : "open",
      required: true,
      dependsOn: [],
      sources: answered
        ? [{ kind: "answer", id: answered.id, quote: answered.text || "暂时不知道" }]
        : [{ kind: "goal", id: "goal-source", quote: goal }],
      confirmation: null,
      reason: "一次回答不会自动确认整项需求，最终以当前报告的显式确认作为依据。",
    },
  ];
  next.session.draft = {
    title: "工作台执行方案草稿",
    summary: "合成样本：保留原版视觉，依据用户原话逐步完善。",
    sections: [
      {
        id: "entry",
        title: "进入时机",
        content: next.session.items[0].description,
        itemIds: ["entry"],
        sources: next.session.items[0].sources,
      },
    ],
    changes: [],
  };
  next.session.status = "ready";
  next.session.nextAction = "advance";
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
  next.session.nextAction = issue ? "answer" : "review";
  Object.assign(next.session.capabilities, {
    canAdvance: false,
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
      title: "请决定进入时机",
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
    id: "synthetic-answer-1",
    question: structuredClone(savedQuestion),
    revision: next.session.revision,
    createdAt: date,
  };
  next.session.answers.push(answer);
  savedQuestion.status = "answered";
  next.session.items[0].status = input.state === "answered" ? "needs_review" : "deferred";
  next.session.items[0].confirmation = null;
  const text = input.state === "unknown" ? "暂时不知道" : input.text;
  next.session.sourceRecords.push({
    id: answer.id,
    kind: "answer",
    label: "用户回答",
    text,
    createdAt: date,
  });
  next.session.status = "ready";
  next.session.nextAction = "advance";
  Object.assign(next.session.capabilities, {
    canAdvance: true,
    canAnswer: false,
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
    questionId: question.id,
    questionVersion: question.version,
    itemIds: question.itemIds,
    title: "用户回答已保存",
    detail: text,
  });
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
        reason: ready ? "已形成待用户确认的具体建议" : "用户尚未决定进入时机",
        itemIds: ["entry"],
      },
    ],
    blockers: ready
      ? []
      : [
          {
            id: "entry-unknown",
            itemIds: ["entry"],
            description: "进入时机仍未知，不能替用户作出决定。",
          },
        ],
    risks: [],
    uncertainties: ready ? [] : ["进入时机未知"],
  };
  next.session.report = {
    id: "synthetic-report-1",
    basedOnRevision: next.session.revision,
    contentFingerprint,
    fingerprint: "a".repeat(64),
    status: "draft",
    title: "纸面工作台执行方案 · 合成样本",
    summary: "依据已保存的用户原话形成的合成执行方案，等待用户审阅。",
    sections: structuredClone(next.session.draft!.sections),
    tasks: [
      {
        id: "entry-task",
        title: "接通工作台入口",
        instructions: "保存目标后进入工作台；后续问题从右侧展开。",
        dependsOn: [],
        acceptance: ["创建完成即可看到三 Agent 工作台", "服务保存后才显示回答回执"],
      },
    ],
    risks: [],
    unresolved: ready ? [] : ["进入时机未知"],
    acceptance: ["用户确认当前文档后才能归档"],
    executionPrompt:
      "合成执行提示词：请实现当前确认的纸面工作台与右侧问题交接，并验证回答保存事件。",
    markdown: "# 纸面工作台执行方案\n\n明确标注的合成浏览器测试文档。",
    confirmedAt: null,
  };
  next.session.status = "review_ready";
  next.session.nextAction = ready ? "confirm" : "advance";
  Object.assign(next.session.capabilities, {
    canAdvance: !ready,
    canAnswer: false,
    canAddNote: true,
    canPreview: true,
    canConfirm: ready,
    reason: ready ? "" : "进入时机仍未知，当前草稿不能确认。",
  });
  finished(next, "C", operationId);
  record(next, {
    kind: "report_ready",
    actor: "C",
    from: "C",
    to: "user",
    operationId,
    title: "当前方案可以审阅",
    detail: "合成测试文档，不代表真实模型输出。",
  });
  return next;
}

type HeldAction = { body: PlanningAction; route: Route; taken: boolean };
async function installSyntheticApi(page: Page, initial = initialSnapshot()) {
  let state = structuredClone(initial);
  let advanceCount = 0;
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
        const role = body.kind === "preview" ? "C" : ++advanceCount % 2 ? "A" : "B";
        state.session.status = "working";
        state.session.activeOperationId = body.operationId;
        Object.assign(state.session.capabilities, {
          canAdvance: false,
          canAnswer: false,
          canAddNote: false,
          canPreview: false,
          canConfirm: false,
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

test("synthetic API: immediate workspace, manual choice, saved-event receipt and current-report confirmation", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const api = await installSyntheticApi(page);
  await page.goto("/");
  await page.getByLabel("你想解决什么问题？", { exact: true }).fill(goal);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  const firstAnalysis = await api.next("advance");

  // A's response is still pending. Empty, real-role boards must already be present.
  await expect(page.getByRole("heading", { name: goal })).toBeVisible();
  await expect(page.locator("[data-planning-agent]")).toHaveCount(3);
  for (const role of ["A", "B", "C"])
    await expect(page.locator(`[data-planning-agent="${role}"]`)).toBeVisible();
  await expect(page.locator(".p-unwritten")).toHaveCount(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(api.creates).toHaveLength(1);
  expect(api.actions).toHaveLength(1);
  expect(api.snapshot.session.items).toEqual([]);
  await screenshot(page, testInfo, "desktop-before-model-response");

  await api.reply(firstAnalysis, analyzed(api.snapshot, firstAnalysis.body.operationId));
  const firstQuestions = await api.next("advance");
  await api.reply(firstQuestions, questioned(api.snapshot, firstQuestions.body.operationId));
  const paper = page.getByRole("dialog", { name: question.title, exact: true });
  await expect(paper).toBeVisible();
  await expect(paper.getByRole("radio")).toHaveCount(2);
  await expect(paper.getByRole("radio").nth(0)).not.toBeChecked();
  await expect(paper.getByRole("radio").nth(1)).not.toBeChecked();
  await expect
    .poll(() =>
      paper.evaluate((element) =>
        element.getAnimations().every((animation) => animation.playState !== "running"),
      ),
    )
    .toBe(true);
  const box = await paper.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThan(720);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  await screenshot(page, testInfo, "desktop-right-question");
  await paper.getByRole("radio", { name: /先进入三 Agent 工作台/ }).check();
  const supplement = "不要先填长表单；问题从右侧出现，保留当前纸面视觉。";
  await paper.getByLabel("也可以补充，或提出自己的方向", { exact: true }).fill(supplement);
  await paper.getByRole("button", { name: "把回答递回去", exact: true }).click();
  const save = await api.next("answer");
  expect(save.body).toMatchObject({
    kind: "answer",
    answers: [
      {
        questionId: question.id,
        questionVersion: 1,
        state: "answered",
        optionIds: ["workspace_first"],
        text: supplement,
        number: null,
      },
    ],
  });
  await expect(paper.getByRole("button", { name: "正在保存", exact: true })).toBeDisabled();
  await expect(page.locator(".p-receipt-content")).toHaveCount(0);
  expect(api.snapshot.events.filter((event) => event.kind === "answer_saved")).toHaveLength(0);

  if (save.body.kind !== "answer") throw new Error("Expected an answer action");
  // Keep the POST hanging after the synthetic server has saved the answer.
  // Only polling GET can reveal answer_saved for this exact operationId.
  // The UI must release its pending lock and continue without replaying POST.
  api.publish(answered(api.snapshot, save.body));
  const receipt = page.locator(".p-receipt-content");
  await expect(
    receipt.getByRole("heading", { name: "你的回答，已经收到。", exact: true }),
  ).toBeVisible();
  await expect(receipt).toContainText(supplement);
  expect(api.snapshot.session.items[0].confirmation).toBeNull();
  await expect(page.locator("dialog.p-paper")).toHaveCount(0);

  const refinement = await api.next("advance");
  await api.reply(refinement, analyzed(api.snapshot, refinement.body.operationId));
  const followupQuestions = await api.next("advance");
  await api.reply(
    followupQuestions,
    questioned(api.snapshot, followupQuestions.body.operationId, false),
  );
  await page.getByRole("button", { name: "查漏并整理方案", exact: true }).click();
  const preview = await api.next("preview");
  await api.reply(preview, reviewed(api.snapshot, preview.body.operationId, true));
  const report = page.getByRole("dialog", { name: "纸面工作台执行方案 · 合成样本", exact: true });
  const acknowledge = report.getByRole("checkbox", {
    name: "我已读过当前方案，确认它表达了我的决定。",
    exact: true,
  });
  const confirm = report.getByRole("button", { name: "确认这份方案", exact: true });
  await expect(report).toBeVisible();
  await expect(acknowledge).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await report.getByRole("button", { name: "执行提示词", exact: true }).click();
  await expect(report.locator(".p-execution-prompt")).toHaveText(
    api.snapshot.session.report!.executionPrompt,
  );
  await report.getByRole("button", { name: "执行方案", exact: true }).click();
  await acknowledge.check();
  await expect(confirm).toBeEnabled();

  // A newly published report must invalidate the checkbox for the earlier hash.
  const updated = api.snapshot;
  updated.session.report!.id = "synthetic-report-2";
  updated.session.report!.fingerprint = "b".repeat(64);
  updated.session.report!.summary = "合成第二稿：补充当前验收条件，需要重新阅读确认。";
  record(updated, {
    kind: "report_ready",
    actor: "C",
    title: "方案第二稿已更新",
    detail: updated.session.report!.summary,
  });
  api.publish(updated);
  await expect(report).toContainText(updated.session.report!.summary, { timeout: 10_000 });
  await expect(acknowledge).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await acknowledge.check();
  await confirm.click();
  const confirmation = await api.next("confirm");
  expect(confirmation.body).toMatchObject({
    kind: "confirm",
    revision: updated.session.revision,
    reportId: "synthetic-report-2",
    fingerprint: "b".repeat(64),
  });
  const final = api.snapshot;
  final.session.status = "completed";
  final.session.nextAction = "none";
  final.session.report!.status = "confirmed";
  final.session.report!.confirmedAt = date;
  Object.assign(final.session.capabilities, {
    canAdvance: false,
    canAnswer: false,
    canPreview: false,
    canConfirm: false,
    canStop: false,
  });
  record(final, {
    kind: "report_confirmed",
    actor: "user",
    operationId: confirmation.body.operationId,
    title: "用户确认当前方案",
    detail: "只确认本次提交的报告版本与指纹。",
  });
  final.session.items[0].status = "confirmed";
  final.session.items[0].confirmation = {
    answerId: null,
    eventId: final.events.at(-1)!.id,
    revision: final.session.revision,
  };
  await api.reply(confirmation, final);
  await expect(report.getByLabel("用户已确认", { exact: true })).toBeVisible();
  await screenshot(page, testInfo, "desktop-confirmed-report");
  await report.getByRole("button", { name: "收起方案", exact: true }).click();

  await page.reload();
  await expect(page.getByRole("button", { name: "打开执行方案", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".p-event-paper.is-answer_saved")).toHaveCount(1);
  expect(api.creates).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "confirm")).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

test("synthetic API: mobile recovery keeps drafts, avoids replay and preserves unknown as unconfirmed", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const initial = questioned(
    analyzed(initialSnapshot(), "synthetic-initial-A"),
    "synthetic-initial-B",
  );
  const api = await installSyntheticApi(page, initial);
  await page.goto(`/?planning=${sessionId}`);
  await expect(page.locator("[data-planning-agent]")).toHaveCount(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const shelf = page
    .locator(".p-pending-questions")
    .getByRole("button", { name: new RegExp(question.title) });
  await shelf.click();
  let paper = page.getByRole("dialog", { name: question.title, exact: true });
  await expect(paper).toBeVisible();
  await expect(paper.getByRole("radio").nth(0)).not.toBeChecked();
  await expect(paper.getByRole("radio").nth(1)).not.toBeChecked();
  await paper.getByRole("radio").nth(1).check();
  const draft = "这条暂存文字还没有提交，不应被写成已确认需求。";
  await paper.getByLabel("也可以补充，或提出自己的方向", { exact: true }).fill(draft);

  await page.reload();
  await expect(page.locator("[data-planning-agent]")).toHaveCount(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await shelf.click();
  paper = page.getByRole("dialog", { name: question.title, exact: true });
  await expect(paper.getByRole("radio").nth(1)).toBeChecked();
  await expect(paper.getByLabel("也可以补充，或提出自己的方向", { exact: true })).toHaveValue(
    draft,
  );
  const box = await paper.boundingBox();
  expect(box).not.toBeNull();
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
  if (save.body.kind !== "answer") throw new Error("Expected an answer action");
  await api.reply(save, answered(api.snapshot, save.body));
  await expect(page.locator("dialog.p-paper")).toHaveCount(0);
  await expect(page.locator(".p-event-paper.is-answer_saved")).toContainText("暂时不知道");
  expect(api.snapshot.session.items[0].confirmation).toBeNull();

  const refinement = await api.next("advance");
  await api.reply(refinement, analyzed(api.snapshot, refinement.body.operationId));
  const noQuestion = await api.next("advance");
  await api.reply(noQuestion, questioned(api.snapshot, noQuestion.body.operationId, false));
  await page.getByRole("button", { name: "查漏并整理方案", exact: true }).click();
  const preview = await api.next("preview");
  await api.reply(preview, reviewed(api.snapshot, preview.body.operationId, false));
  const report = page.getByRole("dialog", { name: "纸面工作台执行方案 · 合成样本", exact: true });
  await expect(report).toBeVisible();
  await expect(report).toContainText("进入时机仍未知，不能替用户作出决定。");
  await expect(report.getByRole("checkbox")).toBeDisabled();
  await expect(report.getByRole("button", { name: "确认这份方案", exact: true })).toBeDisabled();
  await expect(report.getByLabel("用户已确认", { exact: true })).toHaveCount(0);
  await screenshot(page, testInfo, "mobile-unknown-blocks-confirmation");
  await report.getByRole("button", { name: "收起方案", exact: true }).click();
  await page.getByRole("button", { name: /已经想清楚的，和还没定下的。/ }).click();
  await expect(page.locator(".p-item.is-deferred")).toContainText("暂缓");
  await expect(page.locator(".p-item.is-confirmed")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("[data-planning-agent]")).toHaveCount(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".p-event-paper.is-answer_saved")).toHaveCount(1);
  expect(api.creates).toHaveLength(0);
  expect(api.actions.filter((entry) => entry.body.kind === "answer")).toHaveLength(1);
  expect(api.actions.filter((entry) => entry.body.kind === "confirm")).toHaveLength(0);
  expect(api.snapshot.session.answers[0].state).toBe("unknown");
  expect(api.snapshot.session.items[0].confirmation).toBeNull();
  expect(api.reads).toBeGreaterThanOrEqual(3);
});
