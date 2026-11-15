// Explicit synthetic UI fixtures. Every API request is intercepted, with no real model calls.
import { expect, test, type Page } from "@playwright/test";
import type { ArenaSnapshot, Challenge } from "../../src/lib/contracts";
import type { ClarificationState } from "../../src/lib/clarification-contracts";
import type {
  IntakeAnswer,
  IntakeDraftResponse,
  IntakeQuestion,
} from "../../src/lib/intake-contracts";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";
import { fixtureChallenge, fixtureSnapshot } from "./ui.fixture";

const optionalQuestions: Array<IntakeQuestion & { decisionId: string }> = [
  {
    id: "event_note",
    decisionId: "event_note",
    title: "【测试替身】补充活动备注",
    reason: "可选备注用于完善安排。",
    type: "text",
    options: [],
    placeholder: "",
    unit: "",
  },
  {
    id: "event_photo",
    decisionId: "event_photo",
    title: "【测试替身】是否准备活动照片",
    reason: "照片为可选材料。",
    type: "single",
    options: ["准备", "不准备"],
    placeholder: "",
    unit: "",
  },
];
const requiredQuestion: IntakeQuestion & { decisionId: string } = {
  id: "event_permission",
  decisionId: "event_permission",
  title: "【测试替身】请本人确认活动场地授权",
  reason: "正式交接前需要明确授权。",
  authorization: "仅限本次校园读书会的场地使用",
  type: "single",
  options: ["已获授权", "尚未获授权"],
  placeholder: "",
  unit: "",
};
const changedPreference = "【测试替身】修改后优先保证无障碍参与。";

function summaryDraft(): IntakeDraftResponse {
  const challenge = { ...fixtureChallenge, goal: "【测试替身】组织校园读书会并核对活动安排。" };
  const state: ClarificationState = {
    protocol: "clarification-1",
    items: optionalQuestions.map((question) => ({
      id: question.decisionId,
      topic: "flow",
      title: question.title,
      description: question.reason,
      dependsOn: [],
      required: false,
      acceptance: [],
      sourceRefs: [],
    })),
    retiredIds: [],
    runs: [],
    rounds: [],
    suggestions: [],
    conflicts: [],
    review: {
      summary: "【测试替身】当前候选规划可以核对。",
      ready: true,
      coverage: [],
      gaps: [],
      conflicts: [],
      fingerprint: "synthetic-review",
      basedOnRevision: 4,
    },
    next: "questions",
    draftOnly: true,
    specification: "# 【测试替身】原规划\n\n原摘要尚未修改。",
    executionPrompt: "【测试替身】原执行提示词。",
  };
  state.items.push({
    id: "summary_preference",
    topic: "style",
    title: "【测试替身】摘要中的活动偏好",
    description: "仅显示有效本人确认来源。",
    required: false,
    dependsOn: [],
    acceptance: [],
    sourceRefs: ["confirmed_summary"],
    provided: { sourceRef: "confirmed_summary", quote: fixtureChallenge.preferences },
  });
  state.runs = (["A", "B"] as const).map((role) => ({
    id: `synthetic-initial-${role}`,
    operationId: "synthetic-initial",
    role,
    round: 1,
    basedOnRevision: 3,
    status: "completed",
    summary: `【测试替身】${role} 已完成。`,
    output:
      role === "A"
        ? { summary: "【测试替身】活动事项", items: state.items, retired: [], suggestions: [] }
        : { summary: "【测试替身】可选活动问题", questions: optionalQuestions, conflicts: [] },
    usage: [],
    createdAt: "2026-11-01T00:00:00.000Z",
  }));
  const priorAnswer = {
    questionId: optionalQuestions[0].id,
    question: optionalQuestions[0],
    state: "answered" as const,
    value: "【测试替身】上一轮本人确认的备注。",
    confirmation: "confirmed" as const,
  };
  state.rounds = [
    {
      round: 1,
      revision: 3,
      questions: structuredClone(optionalQuestions),
      answers: [structuredClone(priorAnswer)],
      changes: { added: [], retired: [], changed: [], triggerAnswerIds: [] },
      runIds: state.runs.map((run) => run.id),
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ];
  return {
    ...fixtureIntake({
      id: "synthetic-summary-reconfirmation",
      workflow: "clarification",
      revision: 4,
      goal: challenge.goal,
      challenge,
      status: "questions",
      round: 1,
      questions: structuredClone(optionalQuestions),
      queuedQuestions: [],
      answers: [structuredClone(priorAnswer)],
      clarification: state,
      confirmation: {
        history: [],
        pendingSummaryFields: [],
        summary: {
          revision: 3,
          confirmedAt: "2026-11-01T00:00:00.000Z",
          challenge: structuredClone(challenge),
        },
      },
    }),
    activity: { operationId: null, calls: [] },
    readiness: "requirement_ready",
  };
}

type Patch = {
  revision: number;
  summary?: { challenge: Challenge; assumptions: string[] };
  answers?: IntakeAnswer[];
  answerMode?: string;
};
type Analysis = { operationId: string; intent: string; finish: boolean };

async function installReconfirmationService(
  page: Page,
  returnQuestions: boolean,
  summarySave?: Promise<void>,
) {
  let draft = summaryDraft();
  let snapshot: ArenaSnapshot | null = null;
  const model = configureFixtureModels(fixtureSnapshot()).model;
  const patches: Patch[] = [];
  const analyses: Analysis[] = [];
  const submissions: Array<{ challenge: Challenge; assumptions: string[] }> = [];
  const unexpected: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", accessGranted: true, model } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "b".repeat(64), hasRecoveryCode: false } });
    if (path === `/api/intakes/${draft.id}` && request.method() === "GET")
      return route.fulfill({ json: draft });
    if (path === `/api/intakes/${draft.id}` && request.method() === "PATCH") {
      const body = request.postDataJSON() as Patch;
      patches.push(body);
      if (body.revision !== draft.revision)
        return route.fulfill({ status: 409, json: { error: "Synthetic revision conflict" } });
      if (body.summary) {
        await summarySave;
        draft = {
          ...draft,
          challenge: body.summary.challenge,
          assumptions: body.summary.assumptions,
          readiness: "not_ready",
          answers: draft.answers.map((answer) => ({
            ...answer,
            confirmation: "pending",
            needsReconfirmation: true,
          })),
          confirmation: { ...draft.confirmation!, pendingSummaryFields: ["preferences"] },
          clarification: {
            ...draft.clarification!,
            review: null,
            specification: "",
            executionPrompt: "",
          },
        };
      }
      if (body.answers) {
        const answers = new Map(draft.answers.map((answer) => [answer.questionId, answer]));
        for (const answer of body.answers) {
          const question = optionalQuestions.find((question) => question.id === answer.questionId)!;
          answers.set(answer.questionId, { ...answer, question, confirmation: "pending" });
        }
        draft = { ...draft, answers: [...answers.values()] };
      }
      draft = { ...draft, revision: draft.revision + 1 };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}/analyze` && request.method() === "POST") {
      const body = request.postDataJSON() as Analysis;
      analyses.push(body);
      draft = {
        ...draft,
        revision: draft.revision + 1,
        readiness: "previewable",
        status: "questions",
        clarification: {
          ...draft.clarification!,
          review: null,
          specification: "",
          executionPrompt: "",
        },
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}/submit` && request.method() === "POST") {
      const body = request.postDataJSON() as { challenge: Challenge; assumptions: string[] };
      submissions.push(body);
      if (returnQuestions) {
        draft = {
          ...draft,
          revision: draft.revision + 1,
          status: "questions",
          round: 2,
          questions: [requiredQuestion],
          readiness: "previewable",
          clarification: {
            ...draft.clarification!,
            items: [
              ...draft.clarification!.items,
              {
                id: requiredQuestion.decisionId,
                topic: "authorization",
                title: requiredQuestion.title,
                description: requiredQuestion.reason,
                dependsOn: [],
                required: true,
                acceptance: [],
                sourceRefs: [],
              },
            ],
          },
        };
        return route.fulfill({ json: draft });
      }
      const formalState: ClarificationState = {
        ...draft.clarification!,
        next: "completed",
        draftOnly: false,
        review: {
          summary: "【测试替身】本人确认摘要后审查通过。",
          ready: true,
          coverage: [],
          gaps: [],
          conflicts: [],
          fingerprint: "synthetic-final-review",
          basedOnRevision: draft.revision,
        },
        specification: "# 【测试替身】正式需求规划\n\n已记录本人确认的无障碍参与要求。",
        executionPrompt: "【测试替身】依据本人确认的摘要执行。",
      };
      formalState.runs = [
        ...formalState.runs,
        {
          id: "synthetic-final-C",
          operationId: "synthetic-final-submit",
          role: "C",
          round: draft.round,
          basedOnRevision: draft.revision,
          status: "completed",
          summary: formalState.review!.summary,
          output: formalState.review!,
          usage: [],
          createdAt: "2026-11-01T00:00:01.000Z",
        },
      ];
      snapshot = configureFixtureModels(fixtureSnapshot());
      snapshot.versions[0] = {
        ...snapshot.versions[0],
        workflow: "clarification",
        status: "completed",
        challenge: body.challenge,
        clarification: formalState,
        intake: {
          id: draft.id,
          originalGoal: draft.goal,
          answers: draft.answers,
          assumptions: draft.assumptions,
          usedSources: [],
          usage: [],
          confirmation: draft.confirmation,
        },
      };
      return route.fulfill({ status: 201, json: snapshot });
    }
    if (snapshot && path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
    if (snapshot && path === `/api/arenas/${snapshot.id}/events`)
      return route.fulfill({ contentType: "text/event-stream", body: ": synthetic heartbeat\n\n" });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Explicit synthetic API boundary" } });
  });
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: draft.id,
  });
  return { patches, analyses, submissions, unexpected, read: () => draft };
}

async function editAndReconfirm(
  page: Page,
  returnQuestions: boolean,
  reducedMotion: "reduce" | "no-preference" = "reduce",
) {
  await page.emulateMedia({ reducedMotion });
  const service = await installReconfirmationService(page, returnQuestions);
  await page.goto("/");
  const paper = page.getByRole("dialog", { name: "需求梳理", exact: true });
  await expect(paper).toBeVisible();
  await expect(
    page.locator('[data-motion-anchor="decision-summary_preference"] > span'),
  ).toHaveText("已确认");
  await paper
    .getByRole("textbox", { name: optionalQuestions[0].title, exact: true })
    .fill("【测试替身】保留本人手填的备注。");
  await paper.getByRole("button", { name: "核对并交接需求", exact: true }).click();
  await expect(paper).toHaveAccessibleName("需求梳理");
  await paper.getByRole("textbox", { name: "你更在意的事", exact: true }).fill(changedPreference);
  await expect.poll(() => service.patches.filter((patch) => patch.summary).length).toBe(1);
  expect(service.read().confirmation?.pendingSummaryFields).toEqual(["preferences"]);
  expect(service.read().readiness).toBe("not_ready");
  await expect(page.locator('[data-motion-anchor="decision-event_note"] > span')).toHaveText(
    "待重新确认",
  );
  expect(service.read().clarification?.rounds[0].answers[0].confirmation).toBe("confirmed");
  expect(service.read().answers[0].needsReconfirmation).toBe(true);
  await expect(
    page.locator('[data-motion-anchor="decision-summary_preference"] > span'),
  ).not.toHaveText("已确认");
  await test.info().attach("summary-edit-pending", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  expect(service.submissions).toHaveLength(0);
  await paper.getByRole("button", { name: "重新梳理需求", exact: true }).click();
  await expect.poll(() => service.analyses.length).toBe(1);
  expect(service.analyses[0]).toMatchObject({ intent: "continue", finish: false });
  expect(
    service.patches.filter((patch) => patch.answers).every((patch) => patch.answerMode === "draft"),
  ).toBe(true);
  expect(service.read().answers).toHaveLength(1);
  expect(service.read().answers[0]).toMatchObject({
    questionId: optionalQuestions[0].id,
    state: "answered",
    value: "【测试替身】保留本人手填的备注。",
    confirmation: "pending",
  });
  expect(service.read().questions).toEqual(optionalQuestions);
  expect(service.read().answers.some((answer) => answer.state === "skipped")).toBe(false);
  expect(service.read().clarification?.specification).toBe("");
  expect(service.submissions).toHaveLength(0);
  await paper.getByRole("button", { name: "核对并交接需求", exact: true }).click();
  const confirm = paper.getByRole("button", { name: "确认当前摘要并查漏", exact: true });
  await expect(confirm).toBeEnabled();
  await test.info().attach("summary-explicit-reconfirmation", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await confirm.click();
  await expect.poll(() => service.submissions.length).toBe(1);
  expect(service.submissions[0].challenge.preferences).toBe(changedPreference);
  return { service, paper };
}

test("synthetic summary reconfirmation: edited pending summary reaches explicit server review and result", async ({
  page,
}) => {
  const { service } = await editAndReconfirm(page, false);
  const result = page.locator('[data-experience-mode="result"]');
  await expect(result).toBeVisible();
  await expect(result.getByText("已记录本人确认的无障碍参与要求。", { exact: true })).toBeVisible();
  await expect(result.getByRole("button", { name: "回放历史过程", exact: true })).toBeVisible();
  await expect(result.locator('[data-motion-anchor="decision-event_note"] > span')).toHaveText(
    "待确认",
  );
  await expect(page.locator(".replay-pointer, .c-root.theater")).toHaveCount(0);
  expect(service.unexpected).toEqual([]);
  await test.info().attach("formal-result", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("synthetic summary reconfirmation: server returns a new required question to the same paper", async ({
  page,
}) => {
  const { service, paper } = await editAndReconfirm(page, true);
  await expect(paper.locator(`[data-question-id="${requiredQuestion.id}"]`)).toBeVisible();
  await expect(paper.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(
    paper.getByRole("heading", { name: "这是我们理解的任务。", exact: true }),
  ).toBeHidden();
  await expect(page.locator('[data-experience-mode="result"]')).toHaveCount(0);
  expect(service.submissions).toHaveLength(1);
  expect(service.unexpected).toEqual([]);
});

test("synthetic natural handoff: final real C seals and archives once while the result is immediately available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1600 });
  const { service } = await editAndReconfirm(page, false, "no-preference");
  const result = page.locator('[data-experience-mode="result"]');
  await expect(result).toBeVisible();
  const seal = page.locator('[data-motion-event="run:synthetic-final-C"]');
  await expect(seal).toBeVisible();
  await expect(seal).toHaveAttribute("data-motion-source", "agent-C");
  await expect(seal).toHaveAttribute("data-motion-target", "conclusion");
  const sample = await seal.evaluate((node) => {
    const animation = node
      .getAnimations()
      .find((animation) => animation.effect?.getComputedTiming().duration === 2600);
    return {
      duration: animation?.effect?.getComputedTiming().duration,
      time: Number(animation?.currentTime),
    };
  });
  expect(sample.duration).toBe(2600);
  expect(sample.time).toBeLessThan(2600);
  await expect(result.getByRole("button", { name: "查看详细规划", exact: true })).toBeEnabled();
  await expect(result.getByText("已记录本人确认的无障碍参与要求。", { exact: true })).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const completed = JSON.parse(
            sessionStorage.getItem("live-paper-events:synthetic-summary-reconfirmation") ?? "[]",
          ) as string[];
          return completed.filter((id) => id.includes("synthetic-final-C"));
        }),
      { timeout: 10000 },
    )
    .toEqual([
      "run:synthetic-final-C",
      "archive:synthetic-final-C:report",
      "archive:synthetic-final-C:prompt",
    ]);
  await expect(page.locator('[data-motion-event*="synthetic-final-C"]')).toHaveCount(0);
  await expect(page.locator(".replay-pointer, .c-root.theater")).toHaveCount(0);
  expect(service.submissions).toHaveLength(1);
  expect(service.unexpected).toEqual([]);
  await page.reload();
  await expect(page.locator('[data-experience-mode="result"]')).toBeVisible();
  await expect(page.locator(".live-motion-note")).toHaveCount(0);
  expect(service.submissions).toHaveLength(1);
  expect(service.unexpected).toEqual([]);
});

for (const width of [1101, 1200, 1280]) {
  test(`synthetic compact paper: all card headings fit with the paper open at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const service = await installReconfirmationService(page, false);
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "需求梳理", exact: true })).toBeVisible();
    const bounds = await page.locator(".live-agent-card > header").evaluateAll((headers) =>
      headers.map((header) => {
        const outer = header.getBoundingClientRect();
        return [...header.children].every((child) => {
          const inner = child.getBoundingClientRect();
          return inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
        });
      }),
    );
    expect(bounds).toEqual([true, true, true]);
    expect(service.unexpected).toEqual([]);
  });
}

test("synthetic report freshness: closing the paper preserves local summary invalidation before save", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await installReconfirmationService(page, false, gate);
  try {
    await page.goto("/");
    const paper = page.getByRole("dialog", { name: "需求梳理", exact: true });
    await paper.getByRole("button", { name: "核对并交接需求", exact: true }).click();
    const preview = paper.getByRole("region", { name: "规划报告预览", exact: true });
    await preview.getByRole("button", { name: "查看完整预览", exact: true }).click();
    await expect(
      preview.getByRole("button", { name: "导出 Markdown 预览", exact: true }),
    ).toBeEnabled();
    await paper.getByRole("textbox", { name: "你更在意的事", exact: true }).fill(changedPreference);
    await expect(preview.getByRole("button", { name: "查看完整预览", exact: true })).toBeDisabled();
    await expect(
      preview.getByRole("button", { name: "导出 Markdown 预览", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('[data-experience-mode="live"] .live-report')).toHaveCount(0);
    await paper.getByRole("button", { name: "暂存并退出", exact: true }).click();
    await expect(paper).toHaveCount(0);
    await expect(page.locator('[data-experience-mode="live"] .live-report')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "导出 Markdown", exact: true })).toHaveCount(0);
    expect(service.read().readiness).toBe("requirement_ready");
    expect(service.analyses).toHaveLength(0);
    expect(service.unexpected).toEqual([]);
  } finally {
    release();
  }
});

test("synthetic summary conflict: questions permit explicit recovery without bypassing the conflict", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const service = await installReconfirmationService(page, false);
  const initial = summaryDraft();
  await page.addInitScript(
    (journal) =>
      sessionStorage.setItem("strategy-arena:intake-tab-summary", JSON.stringify(journal)),
    {
      draftId: initial.id,
      baseRevision: 1,
      challenge: { ...initial.challenge!, preferences: changedPreference },
      assumptions: [],
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
  );
  await page.goto("/");
  const paper = page.getByRole("dialog", { name: "需求梳理", exact: true });
  const recover = paper.getByRole("button", { name: "恢复本机未保存的修改", exact: true });
  await expect(recover).toBeEnabled();
  await expect(page.locator('[data-experience-mode="live"] .live-report')).toHaveCount(0);
  expect(service.patches).toHaveLength(0);
  await recover.click();
  await expect.poll(() => service.patches.filter((patch) => patch.summary).length).toBe(1);
  expect(service.read().challenge?.preferences).toBe(changedPreference);
  expect(service.read().confirmation?.pendingSummaryFields).toEqual(["preferences"]);
  expect(service.analyses).toHaveLength(0);
  expect(service.submissions).toHaveLength(0);
  expect(service.unexpected).toEqual([]);
});

test("synthetic lifecycle: a failed history open preserves the active analysis and releases its operation lock", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const seed = summaryDraft();
  const oldGoal = "【测试替身】上次保存的活动草稿目标。";
  const newGoal = "【测试替身】本人修改后重新整理校园读书会。";
  const historyGoal = "【测试替身】暂时无法打开的历史草稿";
  let draft: IntakeDraftResponse = {
    ...seed,
    goal: oldGoal,
    status: "input",
    challenge: null,
    questions: [],
    answers: [],
    readiness: "not_ready",
    confirmation: { history: [] },
    clarification: {
      ...seed.clarification!,
      runs: [],
      rounds: [],
      review: null,
      specification: "",
      executionPrompt: "",
    },
  };
  let releaseAnalysis!: () => void;
  let releaseHistory!: () => void;
  const analysisGate = new Promise<void>((resolve) => {
    releaseAnalysis = resolve;
  });
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const analyses: Analysis[] = [];
  const abortedAnalyses: string[] = [];
  const unexpected: string[] = [];
  let historyStarted = false;
  const model = configureFixtureModels(fixtureSnapshot()).model;
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname.endsWith("/analyze"))
      abortedAnalyses.push(request.failure()?.errorText ?? "failed");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", accessGranted: true, model } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "b".repeat(64), hasRecoveryCode: false } });
    if (path === "/api/arenas") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/intakes")
      return route.fulfill({
        json: {
          items: [
            {
              id: "synthetic-unavailable-history",
              goal: historyGoal,
              status: "input",
              updatedAt: 1793491200000,
            },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/intakes/synthetic-unavailable-history") {
      historyStarted = true;
      await historyGate;
      return route.fulfill({ status: 503, json: { error: "【测试替身】历史草稿暂不可读取。" } });
    }
    if (path === `/api/intakes/${draft.id}` && request.method() === "GET")
      return route.fulfill({ json: draft });
    if (path === `/api/intakes/${draft.id}` && request.method() === "PATCH") {
      const body = request.postDataJSON() as Patch & { goal?: string };
      if (body.revision !== draft.revision)
        return route.fulfill({ status: 409, json: { error: "Synthetic revision conflict" } });
      const answers = new Map(draft.answers.map((answer) => [answer.questionId, answer]));
      for (const answer of body.answers ?? []) {
        answers.set(answer.questionId, {
          ...answer,
          question: optionalQuestions.find((question) => question.id === answer.questionId)!,
          confirmation: body.answerMode === "complete" ? "confirmed" : "pending",
        });
      }
      draft = {
        ...draft,
        goal: body.goal ?? draft.goal,
        answers: [...answers.values()],
        revision: draft.revision + 1,
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}/analyze` && request.method() === "POST") {
      const body = request.postDataJSON() as Analysis;
      analyses.push(body);
      if (analyses.length === 1) {
        draft = {
          ...draft,
          revision: draft.revision + 1,
          status: "analyzing",
          activity: {
            operationId: body.operationId,
            calls: [
              {
                callId: "synthetic-held-A",
                operationId: body.operationId,
                role: "A",
                state: "running",
                startedAt: Date.now(),
              },
            ],
          },
        };
        await analysisGate;
      }
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "questions",
        round: 1,
        questions: structuredClone(optionalQuestions),
        challenge: { ...fixtureChallenge, goal: draft.goal },
        readiness: "previewable",
        activity: { operationId: null, calls: [] },
        clarification: {
          ...seed.clarification!,
          review: null,
          specification: "",
          executionPrompt: "",
          rounds: [],
          runs: seed.clarification!.runs.map((run) => ({ ...run, operationId: body.operationId })),
        },
      };
      return route.fulfill({ json: draft }).catch(() => {});
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Explicit synthetic lifecycle boundary" } });
  });
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: draft.id,
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "目标与材料", exact: true }).click();
    await page.getByRole("textbox", { name: "你想做什么", exact: true }).fill(newGoal);
    await page.getByRole("button", { name: "开始梳理", exact: true }).click();
    await expect.poll(() => analyses.length).toBe(1);
    await page.getByRole("button", { name: "我的历史", exact: true }).click();
    const history = page.getByRole("dialog", { name: "我的历史与恢复码", exact: true });
    await history.getByRole("button", { name: new RegExp(historyGoal) }).click();
    await expect.poll(() => historyStarted).toBe(true);
    await expect(page.locator(".home-connection-state")).toBeVisible();
    expect(analyses).toHaveLength(1);
    releaseHistory();
    await expect(page.locator(".global-error")).toContainText("历史草稿暂不可读取");
    await expect(history).toHaveCount(0);
    await expect(page.locator('[data-experience-mode="live"] h1')).toHaveText(newGoal);
    await expect(page.getByRole("textbox", { name: "你想做什么", exact: true })).toHaveValue(
      newGoal,
    );
    expect(abortedAnalyses).toEqual([]);
    expect(analyses).toHaveLength(1);
    releaseAnalysis();
    const paper = page.getByRole("dialog", { name: "需求梳理", exact: true });
    await expect(paper).toBeVisible();
    await paper
      .getByRole("textbox", { name: optionalQuestions[0].title, exact: true })
      .fill("【测试替身】失败恢复后本人填写备注。");
    await paper.getByRole("button", { name: "下一题", exact: true }).click();
    await paper.getByRole("radio", { name: "准备", exact: true }).check();
    await paper.getByRole("button", { name: "提交本轮并继续", exact: true }).click();
    await expect.poll(() => analyses.length).toBe(2);
    expect(
      analyses.every((analysis) => analysis.intent === "continue" && analysis.finish === false),
    ).toBe(true);
    expect(abortedAnalyses).toEqual([]);
    expect(unexpected).toEqual([]);
  } finally {
    releaseHistory();
    releaseAnalysis();
  }
});
