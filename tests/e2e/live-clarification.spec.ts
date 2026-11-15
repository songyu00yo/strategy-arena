// Explicit synthetic UI fixtures. No model calls, user projects or evaluation results.
import { expect, test, type Page } from "@playwright/test";
import type {
  IntakeAnswer,
  IntakeDraftResponse,
  IntakeQuestion,
} from "../../src/lib/intake-contracts";
import type { ClarificationState } from "../../src/lib/clarification-contracts";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";
import { fixtureChallenge, fixtureSnapshot } from "./ui.fixture";

const questions: Array<IntakeQuestion & { decisionId: string }> = [
  {
    id: "activity_format",
    decisionId: "activity_format",
    title: "【测试替身】读书会采用什么形式？",
    reason: "形式将影响活动流程。",
    type: "single",
    options: ["主题分享", "小组讨论", "其他（请补充）"],
    placeholder: "",
    unit: "",
  },
  {
    id: "activity_materials",
    decisionId: "activity_materials",
    title: "【测试替身】准备哪些材料？",
    reason: "材料用于后续实施规划。",
    type: "multiple",
    options: ["纸本书", "其他（请补充）"],
    placeholder: "",
    unit: "",
  },
];

function clarification(): ClarificationState {
  return {
    protocol: "clarification-1",
    items: questions.map((question) => ({
      id: question.id,
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
    review: null,
    next: "questions",
    draftOnly: true,
    specification: "",
    executionPrompt: "",
  };
}

function liveDraft(): IntakeDraftResponse {
  return {
    ...fixtureIntake({
      workflow: "clarification",
      goal: "【测试替身】想组织校园读书会，还没有决定活动形式。",
      clarification: clarification(),
    }),
    activity: { operationId: null, calls: [] },
    readiness: "not_ready",
  };
}

function completedQuestions(draft: IntakeDraftResponse, operationId: string): IntakeDraftResponse {
  const state = draft.clarification!;
  return {
    ...draft,
    revision: draft.revision + 1,
    round: 1,
    status: "questions",
    questions: structuredClone(questions),
    challenge: { ...fixtureChallenge, goal: draft.goal, budget: null, timeHours: null },
    activity: { operationId: null, calls: [] },
    readiness: "previewable",
    clarification: {
      ...state,
      runs: [
        {
          id: "fixture-call-A",
          callIds: ["fixture-call-A"],
          operationId,
          role: "A",
          round: 1,
          basedOnRevision: draft.revision,
          status: "completed",
          summary: "【测试替身】需要明确活动形式与材料。",
          output: { summary: "拆分活动事项", items: state.items, retired: [], suggestions: [] },
          usage: [],
          createdAt: draft.createdAt,
        },
        {
          id: "fixture-call-B",
          callIds: ["fixture-call-B"],
          operationId,
          role: "B",
          round: 1,
          basedOnRevision: draft.revision,
          status: "completed",
          summary: "【测试替身】已准备两道具体问题。",
          output: { summary: "提供活动选项", questions, conflicts: [] },
          usage: [],
          createdAt: draft.createdAt,
        },
      ],
    },
  };
}

async function installService(
  page: Page,
  initial: IntakeDraftResponse,
  firstAnalysis?: Promise<void>,
) {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  let draft = structuredClone(initial);
  const analyses: Array<{ intent?: string; finish?: boolean; operationId: string }> = [];
  const patches: Array<{ answers?: IntakeAnswer[]; answerMode?: string }> = [];
  const forbiddenRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", accessGranted: true, model: snapshot.model } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "a".repeat(64), hasRecoveryCode: false } });
    if (path === "/api/intakes" && request.method() === "POST") {
      const body = request.postDataJSON();
      draft = { ...draft, goal: body.goal, modelMode: body.modelMode };
      return route.fulfill({ status: 201, json: draft });
    }
    if (path === `/api/intakes/${draft.id}` && request.method() === "PATCH") {
      const body = request.postDataJSON();
      patches.push(body);
      const answers = new Map(draft.answers.map((answer) => [answer.questionId, answer]));
      for (const answer of (body.answers ?? []) as IntakeAnswer[]) {
        const question = questions.find((item) => item.id === answer.questionId)!;
        answers.set(answer.questionId, {
          ...answer,
          question,
          confirmation: body.answerMode === "complete" ? "confirmed" : "pending",
        });
      }
      draft = { ...draft, revision: draft.revision + 1, answers: [...answers.values()] };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}/analyze`) {
      const body = request.postDataJSON();
      analyses.push(body);
      if (body.intent === "preview") {
        draft = {
          ...draft,
          revision: draft.revision + 1,
          readiness: "previewable",
          clarification: {
            ...draft.clarification!,
            specification: "【测试替身】当前规划保留未决定的活动材料。",
            executionPrompt: "【测试替身】请依据已确认要求执行，未决事项先核对。",
            draftOnly: true,
          },
        };
      } else if (analyses.length === 1) {
        draft = {
          ...draft,
          revision: draft.revision + 1,
          status: "analyzing",
          activity: {
            operationId: body.operationId,
            calls: [
              {
                callId: "fixture-call-A",
                operationId: body.operationId,
                role: "A",
                state: "running",
                startedAt: Date.now(),
              },
            ],
          },
        };
        await firstAnalysis;
        draft = completedQuestions(draft, body.operationId);
      }
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}` && request.method() === "GET")
      return route.fulfill({ json: draft });
    forbiddenRequests.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Explicit synthetic UI boundary" } });
  });
  return { analyses, patches, forbiddenRequests, read: () => draft };
}

test("live fixture: three agents appear before analysis returns and answers stay manual", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await installService(page, liveDraft(), pending);
  try {
    await page.goto("/");
    await page.getByLabel("你想做什么", { exact: true }).fill(liveDraft().goal);
    await page.getByRole("button", { name: "开始梳理", exact: true }).click();
    const workspace = page.locator('[data-experience-mode="live"]');
    await expect(workspace).toBeVisible();
    for (const role of ["A", "B", "C"])
      await expect(workspace.locator(`[data-motion-anchor="agent-${role}"]`)).toBeVisible();
    await expect.poll(() => service.analyses.length).toBe(1);
    await expect(page.getByRole("dialog", { name: "需求梳理", exact: true })).toHaveCount(0);
    release();
    const dialog = page.getByRole("dialog", { name: "需求梳理", exact: true });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("live-right-paper.png"), fullPage: true });
    await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(page.locator(".replay-pointer")).toHaveCount(0);
    await dialog.getByRole("radio", { name: "主题分享", exact: true }).check();
    await dialog.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
    expect(service.analyses).toHaveLength(1);
    await dialog.getByRole("checkbox", { name: "其他（请补充）", exact: true }).check();
    const detail = dialog.getByRole("textbox", {
      name: "补充“其他（请补充）”的具体内容",
      exact: true,
    });
    const geometry = await dialog.locator(".gi-other-answer").evaluate((node) => {
      const field = node.querySelector("textarea")!.getBoundingClientRect();
      const help = node.querySelector("small")!.getBoundingClientRect();
      return { fieldBottom: field.bottom, helpTop: help.top };
    });
    expect(geometry.helpTop).toBeGreaterThanOrEqual(geometry.fieldBottom);
    await detail.fill("手工制作的阅读卡片");
    await page.screenshot({ path: testInfo.outputPath("live-other-answer.png"), fullPage: true });
    await dialog.getByRole("button", { name: "提交本轮并继续", exact: true }).click();
    await expect.poll(() => service.analyses.length).toBe(2);
    expect(service.patches.some((body) => body.answerMode === "complete")).toBe(true);
    expect(service.read().answers.map((answer) => answer.value)).toEqual([
      "主题分享",
      ["其他（请补充）：手工制作的阅读卡片"],
    ]);
    expect(service.forbiddenRequests).toEqual([]);
  } finally {
    release();
  }
});

test("live fixture: dismissed paper stays closed and preview preserves unanswered questions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const draft = completedQuestions(liveDraft(), "fixture-initial-operation");
  const service = await installService(page, draft);
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: draft.id,
  });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "需求梳理", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "暂存并退出", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-experience-mode="live"]')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "先看当前规划", exact: true }).click();
  await expect.poll(() => service.analyses.length).toBe(1);
  expect(service.analyses[0]).toMatchObject({ intent: "preview", finish: false });
  expect(service.read().questions).toEqual(questions);
  expect(service.read().answers.some((answer) => answer.state === "skipped")).toBe(false);
  expect(service.patches.some((body) => body.answerMode === "complete")).toBe(false);
  expect(service.forbiddenRequests).toEqual([]);
});

test("live fixture: native paper retargets continuously and releases its motion effects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const draft = completedQuestions(liveDraft(), "fixture-motion-operation");
  await installService(page, draft);
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: draft.id,
  });
  await page.goto("/");
  const paper = page.locator('[data-motion-anchor="question-paper"]');
  await expect(paper).toHaveAttribute("data-live-motion", "receiving");
  await paper.evaluate((node) => {
    const samples: Array<{ width: number; x: number; y: number; time: number }> = [];
    (window as Window & { livePaperSamples?: typeof samples }).livePaperSamples = samples;
    const sample = () => {
      const rect = node.getBoundingClientRect();
      const effect = node
        .getAnimations()
        .find((animation) => animation.effect?.getComputedTiming().duration === 1550);
      samples.push({
        width: innerWidth,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        time: Number(effect?.currentTime ?? 1550),
      });
      if (node.isConnected && node.hasAttribute("data-live-motion")) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await expect
    .poll(() =>
      paper.evaluate((node) =>
        Number(
          node
            .getAnimations()
            .find((animation) => animation.effect?.getComputedTiming().duration === 1550)
            ?.currentTime ?? 1550,
        ),
      ),
    )
    .toBeGreaterThan(450);
  await page.setViewportSize({ width: 1320, height: 900 });
  await expect(paper).not.toHaveAttribute("data-live-motion");
  const samples = await page.evaluate(
    () =>
      (
        window as Window & {
          livePaperSamples?: Array<{ width: number; x: number; y: number; time: number }>;
        }
      ).livePaperSamples ?? [],
  );
  const changedAt = samples.findIndex(
    (entry, index) => index > 0 && entry.width !== samples[index - 1].width,
  );
  expect(changedAt).toBeGreaterThan(0);
  const before = samples[changedAt - 1];
  const after = samples[changedAt];
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(40);
  expect(
    samples.every((entry, index) => index === 0 || entry.time >= samples[index - 1].time),
  ).toBe(true);
  expect(await paper.evaluate((node) => (node as HTMLElement).style.willChange)).toBe("");
  expect(
    await paper.evaluate((node) =>
      node
        .getAnimations()
        .some((animation) => animation.effect?.getComputedTiming().duration === 1550),
    ),
  ).toBe(false);
});
