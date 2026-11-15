import { expect, test, type Page } from "@playwright/test";
import type { ArenaSnapshot, Challenge, ModelMode } from "../../src/lib/contracts";
import type { IntakeAnswer, IntakeDraft } from "../../src/lib/intake-contracts";
import {
  SUMMARY_JOURNAL_KEY,
  SUMMARY_TAB_JOURNAL_KEY,
} from "../../src/components/use-intake-summary";
import { ANSWER_JOURNAL_KEY } from "../../src/components/intake-answer-journal";
import { ARENA_STORAGE_KEY, ARENA_TAB_STORAGE_KEY } from "../../src/components/arena-pointer";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";
import { advanceFixture, fixtureChallenge, fixtureSnapshot } from "./ui.fixture";

// Explicit browser fixtures; every API call is intercepted. No model calls or billing evaluation.
function completedSnapshot() {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  for (let i = 0; i < 5; i++) advanceFixture(snapshot);
  snapshot.versions[0].status = "paused";
  return snapshot;
}
async function restorePointer(page: Page, id: string, oldArena = "") {
  await page.addInitScript(
    ({ key, id, oldArena }) => {
      localStorage.setItem(key, id);
      if (oldArena) localStorage.setItem("strategy-arena:last-id", oldArena);
      sessionStorage.setItem("arena-intro", "1");
    },
    { key: intakeStorageKey, id, oldArena },
  );
}
function health(snapshot: ArenaSnapshot) {
  return {
    status: "ok",
    version: "explicit-ui-fixture",
    commit: "fixture",
    accessGranted: true,
    requiresAccessCode: false,
    model: snapshot.model,
  };
}

test("explicit UI fixture: starting fresh during a pending restore releases the loading state", async ({
  page,
}) => {
  const snapshot = completedSnapshot();
  const draft = fixtureIntake({ goal: "【测试替身】此前保存的旧目标" });
  await restorePointer(page, draft.id);
  let release!: () => void;
  let requested = false;
  let returned = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return route.fulfill({ json: health(snapshot) });
    if (path === `/api/intakes/${draft.id}`) {
      requested = true;
      await pending;
      await route.fulfill({ json: draft });
      returned = true;
      return;
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  try {
    await page.goto("/");
    await expect.poll(() => requested).toBe(true);
    await page.getByRole("button", { name: "方案擂台首页", exact: true }).click();
    const goal = page.getByRole("textbox", { name: "你想做什么", exact: true });
    await expect(goal).toBeEnabled();
    await goal.fill("【测试替身】全新的个人目标");
    await expect(page.getByRole("button", { name: "开始梳理", exact: true })).toBeEnabled();
    release();
    await expect.poll(() => returned).toBe(true);
    await expect(goal).toHaveValue("【测试替身】全新的个人目标");
    await expect(page.getByRole("button", { name: "开始梳理", exact: true })).toBeEnabled();
  } finally {
    release();
  }
});

test("explicit UI fixture: model changes first save the current answers, and failed saves keep the old model and local draft", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot();
  let draft = fixtureIntake({
    status: "questions",
    round: 1,
    questions: [
      {
        id: "limits",
        title: "哪些条件必须保留？",
        reason: "测试问题",
        placeholder: "",
        type: "text",
        options: [],
        unit: "",
      },
      {
        id: "private",
        title: "还有哪些个人情况？",
        reason: "测试跳过",
        placeholder: "",
        type: "text",
        options: [],
        unit: "",
      },
      {
        id: "untouched",
        title: "还有哪项信息需要补充？",
        reason: "测试：未作答不代表不知道或跳过",
        placeholder: "",
        type: "text",
        options: [],
        unit: "",
      },
    ],
  });
  const questions = draft.questions;
  await restorePointer(page, draft.id);
  let failSave = true;
  let analyses = 0;
  const patches: {
    revision: number;
    answers?: IntakeAnswer[];
    modelMode?: ModelMode;
    answerMode?: "draft" | "complete";
  }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return route.fulfill({ json: health(snapshot) });
    if (path.endsWith("/analyze")) analyses++;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as (typeof patches)[number];
      patches.push(body);
      expect(body.revision).toBe(draft.revision);
      if (body.answers) {
        expect(body.modelMode).toBeUndefined();
        expect(body.answerMode).toBe("draft");
        expect(body.answers.some((answer) => answer.questionId === "untouched")).toBe(false);
        if (failSave) return route.fulfill({ status: 503, json: { error: "测试：回答同步失败" } });
        draft = {
          ...draft,
          status: "questions",
          questions,
          revision: draft.revision + 1,
          answers: body.answers.map((answer) => ({
            ...answer,
            question: questions.find((question) => question.id === answer.questionId)!,
          })),
        };
      } else {
        expect(body.modelMode).toBe("gpt-6.1-sol");
        expect(body.answerMode).toBeUndefined();
        expect(draft.answers).toHaveLength(2);
        draft = {
          ...draft,
          status: "input",
          questions: [],
          modelMode: body.modelMode!,
          revision: draft.revision + 1,
        };
      }
      return route.fulfill({ json: draft });
    }
    if (path.startsWith("/api/intakes/")) return route.fulfill({ json: draft });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto("/");
  const answer = page.getByRole("textbox", { name: "哪些条件必须保留？", exact: true });
  await answer.fill("测试：不离职，保留当前收入。");
  await page.getByRole("button", { name: "下一题", exact: true }).click();
  await page
    .getByRole("group", { name: "还有哪些个人情况？", exact: true })
    .getByRole("button", { name: "跳过", exact: true })
    .click();
  await page.getByRole("button", { name: "上一题", exact: true }).click();
  const selectSol = async () => {
    const dialog = page.getByRole("dialog", { name: "需求梳理", exact: true });
    await dialog.getByRole("button", { name: "暂存并退出", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: /^选择模型，当前/ }).click();
    await page.getByRole("option", { name: "GPT 6.1 Sol", exact: true }).click();
  };
  await selectSol();
  await expect(page.getByRole("alert").filter({ hasText: "原模型和回答已保留" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择模型，当前GPT 6.1 Terra", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续回答", exact: true }).click();
  await expect(answer).toHaveValue("测试：不离职，保留当前收入。");
  expect(patches).toEqual([
    {
      revision: 0,
      answerMode: "draft",
      answers: [{ questionId: "limits", state: "answered", value: "测试：不离职，保留当前收入。" }],
    },
    {
      revision: 0,
      answerMode: "draft",
      answers: [
        { questionId: "limits", state: "answered", value: "测试：不离职，保留当前收入。" },
        { questionId: "private", state: "skipped", value: "" },
      ],
    },
  ]);
  expect(draft.modelMode).toBe("gpt-6.1-terra");
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), ANSWER_JOURNAL_KEY),
  ).not.toBeNull();
  failSave = false;
  await selectSol();
  await expect(
    page.getByRole("button", { name: "选择模型，当前GPT 6.1 Sol", exact: true }),
  ).toBeVisible();
  expect(patches).toHaveLength(4);
  expect(patches.map((patch) => (patch.answers ? "answers" : "model"))).toEqual([
    "answers",
    "answers",
    "answers",
    "model",
  ]);
  expect(patches[2]).toEqual(patches[1]);
  expect(patches[3]).toEqual({ revision: 1, modelMode: "gpt-6.1-sol" });
  expect(draft.answers).toMatchObject([
    { questionId: "limits", state: "answered", value: "测试：不离职，保留当前收入。" },
    { questionId: "private", state: "skipped" },
  ]);
  expect(draft.modelMode).toBe("gpt-6.1-sol");
  expect(draft.answers.some((answer) => answer.questionId === "untouched")).toBe(false);
  expect(analyses).toBe(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), ANSWER_JOURNAL_KEY)).toBeNull();
});

test("explicit UI fixture: unsent question answers survive refresh and failed sync without starting analysis", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot();
  const draft = fixtureIntake({
    status: "questions",
    round: 1,
    questions: [
      {
        id: "limits",
        title: "哪些条件必须保留？",
        reason: "测试问题",
        placeholder: "",
        type: "text",
        options: [],
        unit: "",
      },
    ],
  });
  await restorePointer(page, draft.id);
  let analyses = 0;
  let answerSaves = 0;
  const patches: { revision: number; answers: IntakeAnswer[]; answerMode: string }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return route.fulfill({ json: health(snapshot) });
    if (path.endsWith("/analyze")) analyses++;
    if (route.request().method() === "PATCH") {
      answerSaves++;
      patches.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { error: "测试：暂时离线" } });
    }
    if (path.startsWith("/api/intakes/")) return route.fulfill({ json: draft });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "哪些条件必须保留？", exact: true });
  await field.fill("测试：不离职，保留当前收入。");
  await expect(
    page.getByRole("status").filter({ hasText: "回答已保存在当前标签页" }),
  ).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "需求梳理", exact: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "继续回答", exact: true })).toBeFocused();
  expect(answerSaves).toBe(0);
  expect(analyses).toBe(0);
  await page.getByRole("button", { name: "继续回答", exact: true }).click();
  await expect(field).toHaveValue("测试：不离职，保留当前收入。");
  await page.reload();
  await expect(field).toHaveValue("测试：不离职，保留当前收入。");
  expect(answerSaves).toBe(0);
  expect(analyses).toBe(0);
  await page.getByRole("button", { name: "提交本轮并继续", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "测试：暂时离线" })).toBeVisible();
  await expect.poll(() => answerSaves).toBe(2);
  expect(patches).toEqual([
    {
      revision: 0,
      answerMode: "draft",
      answers: [{ questionId: "limits", state: "answered", value: "测试：不离职，保留当前收入。" }],
    },
    {
      revision: 0,
      answerMode: "complete",
      answers: [{ questionId: "limits", state: "answered", value: "测试：不离职，保留当前收入。" }],
    },
  ]);
  expect(analyses).toBe(0);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), ANSWER_JOURNAL_KEY),
  ).not.toBeNull();
  await page.reload();
  await expect(field).toHaveValue("测试：不离职，保留当前收入。");
});

test("explicit UI fixture: summary saves serialize, preserve newer edits and recover the unsaved tail across refresh", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot();
  let draft = fixtureIntake({
    revision: 5,
    status: "summary",
    challenge: structuredClone(fixtureChallenge),
    assumptions: ["测试：可删除的假设", "测试：保留的假设"],
  });
  await restorePointer(page, draft.id);
  let saves = 0;
  let releaseFirst!: () => void;
  let startedFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/health") return route.fulfill({ json: health(snapshot) });
    if (!pathname.startsWith("/api/intakes"))
      return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        revision: number;
        summary: { challenge: Challenge; assumptions: string[] };
      };
      expect(body.revision).toBe(draft.revision);
      saves++;
      const next: IntakeDraft = {
        ...draft,
        revision: draft.revision + 1,
        challenge: body.summary.challenge,
        assumptions: body.summary.assumptions,
      };
      if (saves === 1) {
        startedFirst();
        await firstGate;
      }
      draft = next;
      return route.fulfill({ json: draft });
    }
    return route.fulfill({ json: draft });
  });
  try {
    await page.goto("/");
    const constraints = page.getByRole("textbox", { name: "必须满足的限制", exact: true });
    await constraints.fill("测试第一版限制。");
    await firstStarted;
    await expect(page.getByRole("status").filter({ hasText: "摘要保存中…" })).toBeVisible();
    await constraints.fill("测试最新限制：不离职，保留当前收入。");
    releaseFirst();
    await expect(constraints).toHaveValue("测试最新限制：不离职，保留当前收入。");
    await expect(
      page.getByRole("status").filter({ hasText: "摘要草稿已保存，提交后确认" }),
    ).toBeVisible();
    expect(draft.challenge?.constraints).toBe("测试最新限制：不离职，保留当前收入。");
    expect(saves).toBe(2);
    await page.getByRole("button", { name: "预算、时间与备选方案", exact: true }).click();
    await page.getByRole("spinbutton", { name: "可投入金额（人民币）", exact: true }).fill("123");
    await page.getByRole("button", { name: "移除第 1 条假设", exact: true }).click();
    // Reload immediately, before the debounce expires; the journal is synchronous with the edit.
    await page.reload();
    await expect(page.getByRole("heading", { name: "这是我们理解的任务。" })).toBeVisible();
    await page.getByRole("button", { name: "预算、时间与备选方案", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "必须满足的限制", exact: true })).toHaveValue(
      "测试最新限制：不离职，保留当前收入。",
    );
    await expect(
      page.getByRole("spinbutton", { name: "可投入金额（人民币）", exact: true }),
    ).toHaveValue("123");
    await expect(page.getByRole("button", { name: "移除第 1 条假设", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "移除第 2 条假设", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "摘要草稿已保存，提交后确认" }),
    ).toBeVisible();
    expect(draft.challenge?.budget).toBe(123);
    expect(draft.assumptions).toEqual(["测试：保留的假设"]);
    expect(await page.evaluate((key) => localStorage.getItem(key), SUMMARY_JOURNAL_KEY)).toBeNull();
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), SUMMARY_TAB_JOURNAL_KEY),
    ).toBeNull();
    await page.reload();
    await expect(page.getByRole("heading", { name: "这是我们理解的任务。" })).toBeVisible();
    await page.getByRole("button", { name: "预算、时间与备选方案", exact: true }).click();
    await expect(
      page.getByRole("spinbutton", { name: "可投入金额（人民币）", exact: true }),
    ).toHaveValue("123");
    await expect(page.getByRole("textbox", { name: "必须满足的限制", exact: true })).toHaveValue(
      draft.challenge!.constraints,
    );
    // A stale journal must not silently overwrite a newer canonical server revision.
    const stale = {
      draftId: draft.id,
      baseRevision: draft.revision,
      challenge: { ...draft.challenge!, constraints: "测试本机待恢复限制。" },
      assumptions: draft.assumptions,
      updatedAt: new Date().toISOString(),
    };
    draft = {
      ...draft,
      revision: draft.revision + 1,
      challenge: { ...draft.challenge!, constraints: "测试服务器新限制。" },
    };
    await page.evaluate(({ key, entry }) => localStorage.setItem(key, JSON.stringify(entry)), {
      key: SUMMARY_JOURNAL_KEY,
      entry: stale,
    });
    const beforeConflict = saves;
    await page.reload();
    await expect(
      page.getByRole("alert").filter({ hasText: "本机还有尚未保存的摘要修改。" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "必须满足的限制", exact: true })).toHaveValue(
      "测试服务器新限制。",
    );
    expect(saves).toBe(beforeConflict);
    await page.getByRole("button", { name: "恢复本机未保存的修改", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "摘要草稿已保存，提交后确认" }),
    ).toBeVisible();
    expect(draft.challenge?.constraints).toBe("测试本机待恢复限制。");
  } finally {
    releaseFirst();
  }
});

test("explicit UI fixture: committed submit with a lost response recovers the same arena on refresh ahead of an old last-arena pointer", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot();
  snapshot.id = "fixture-committed-arena";
  let draft = fixtureIntake({
    revision: 5,
    status: "summary",
    challenge: structuredClone(fixtureChallenge),
  });
  await restorePointer(page, draft.id, "fixture-old-arena");
  let submissions = 0;
  let analyses = 0;
  let oldArenaReads = 0;
  const order: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return route.fulfill({ json: health(snapshot) });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (path === "/api/arenas/fixture-old-arena") {
      oldArenaReads++;
      return route.fulfill({
        status: 500,
        json: { error: "Old arena must not preempt pending intake recovery" },
      });
    }
    if (path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
    if (!path.startsWith("/api/intakes"))
      return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
    if (path.endsWith("/analyze")) analyses++;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(draft.revision);
      draft = {
        ...draft,
        revision: draft.revision + 1,
        challenge: body.summary.challenge,
        assumptions: body.summary.assumptions,
      };
      order.push("save-summary");
    }
    if (path.endsWith("/submit")) {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(draft.revision);
      expect(draft.challenge?.constraints).toBe("测试提交前最后修正：保留收入。");
      submissions++;
      order.push("submit");
      draft = { ...draft, revision: draft.revision + 1, status: "submitted", arenaId: snapshot.id };
      // The server has committed, but the browser never receives the successful response.
      return route.abort("failed");
    }
    return route.fulfill({ json: draft });
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "必须满足的限制", exact: true })
    .fill("测试提交前最后修正：保留收入。");
  await page.getByRole("button", { name: "确认摘要并开始推演", exact: true }).click();
  await expect.poll(() => submissions).toBe(1);
  expect(order).toEqual(["save-summary", "submit"]);
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBe(draft.id);
  await page.reload();
  await expect(page.locator(".c-root")).toBeVisible();
  expect(
    await page.evaluate(
      ({ tab, shared }) => ({
        tab: sessionStorage.getItem(tab),
        shared: localStorage.getItem(shared),
      }),
      { tab: ARENA_TAB_STORAGE_KEY, shared: ARENA_STORAGE_KEY },
    ),
  ).toEqual({
    tab: snapshot.id,
    shared: "fixture-old-arena",
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBeNull();
  expect(submissions).toBe(1);
  expect(analyses).toBe(0);
  expect(oldArenaReads).toBe(0);
});

test("explicit UI fixture: a third round preserves untouched authorization until explicitly skipped and confirms only entered answers", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot();
  const questions: IntakeDraft["questions"] = [
    {
      id: "style",
      title: "这份演示文稿采用哪种风格？",
      reason: "演示数据，风格由本人选择。",
      placeholder: "",
      type: "single",
      options: ["简洁正式", "活泼插画"],
      unit: "",
    },
    {
      id: "materials",
      title: "已有最终图片材料吗？",
      reason: "演示数据，缺失材料继续保持未决。",
      placeholder: "",
      type: "text",
      options: [],
      unit: "",
    },
    {
      id: "authorization",
      title: "是否授权使用公开素材？",
      reason: "演示数据，未作答不能自动授权。",
      placeholder: "",
      type: "single",
      options: ["仅允许公开授权素材", "全部使用本人材料"],
      unit: "",
    },
  ];
  let draft = fixtureIntake({ status: "questions", round: 3, questions });
  await restorePointer(page, draft.id);
  const patches: { revision: number; answers: IntakeAnswer[]; answerMode: string }[] = [];
  const expectedPatches = [
    {
      revision: 0,
      answerMode: "draft",
      answers: [{ questionId: "style", state: "answered", value: "简洁正式" }],
    },
    {
      revision: 1,
      answerMode: "draft",
      answers: [{ questionId: "materials", state: "unknown", value: "" }],
    },
    {
      revision: 2,
      answerMode: "draft",
      answers: [{ questionId: "authorization", state: "skipped", value: "" }],
    },
    {
      revision: 3,
      answerMode: "complete",
      answers: [
        { questionId: "style", state: "answered", value: "简洁正式" },
        { questionId: "materials", state: "unknown", value: "" },
        { questionId: "authorization", state: "skipped", value: "" },
      ],
    },
  ];
  let analyses = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return route.fulfill({ json: health(snapshot) });
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      patches.push(body);
      expect(body).toEqual(expectedPatches[patches.length - 1]);
      expect(body.revision).toBe(draft.revision);
      const accepted: IntakeDraft["answers"] = body.answers.map((answer: IntakeAnswer) => ({
        ...answer,
        question: questions.find((question) => question.id === answer.questionId)!,
        confirmation:
          body.answerMode === "complete" && answer.state === "answered" ? "confirmed" : "pending",
      }));
      draft = {
        ...draft,
        revision: draft.revision + 1,
        answers: [
          ...draft.answers.filter(
            (answer) => !accepted.some((entry) => entry.questionId === answer.questionId),
          ),
          ...accepted,
        ],
      };
    }
    if (path.endsWith("/analyze")) {
      analyses++;
      expect(route.request().postDataJSON()).toMatchObject({
        revision: 4,
        finish: false,
        intent: "continue",
      });
      draft = {
        ...draft,
        revision: draft.revision + 1,
        round: 4,
        questions: [
          {
            ...questions[0],
            id: "audience",
            title: "这份演示文稿给谁阅读？",
            type: "text",
            options: [],
          },
        ],
      };
    }
    if (path.startsWith("/api/intakes/")) return route.fulfill({ json: draft });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto("/");
  await expect(page.getByText("第 3 轮", { exact: false })).toBeVisible();
  const style = page.getByRole("radio", { name: "简洁正式", exact: true });
  await expect(style).not.toBeChecked();
  await expect(page.getByRole("radio", { name: "活泼插画", exact: true })).not.toBeChecked();
  await style.check();
  await page.getByRole("button", { name: "下一题", exact: true }).click();
  await page
    .getByRole("group", { name: "已有最终图片材料吗？", exact: true })
    .getByRole("button", { name: "暂时不知道", exact: true })
    .click();
  await page.getByRole("button", { name: "下一题", exact: true }).click();
  await expect.poll(() => patches.length).toBe(2);
  await page.getByRole("button", { name: "提交本轮并继续", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "请填写这题的答案，或选择暂时不知道、跳过。" }),
  ).toBeVisible();
  expect(patches).toEqual(expectedPatches.slice(0, 2));
  expect(analyses).toBe(0);
  expect(draft.answers.some((answer) => answer.questionId === "authorization")).toBe(false);
  expect(draft.answers.every((answer) => answer.confirmation === "pending")).toBe(true);
  await page
    .getByRole("group", { name: "是否授权使用公开素材？", exact: true })
    .getByRole("button", { name: "跳过", exact: true })
    .click();
  await page.getByRole("button", { name: "提交本轮并继续", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "这份演示文稿给谁阅读？", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("第 4 轮", { exact: false })).toBeVisible();
  expect(patches).toEqual(expectedPatches);
  expect(analyses).toBe(1);
  expect(draft.answers).toMatchObject([
    { questionId: "style", state: "answered", value: "简洁正式", confirmation: "confirmed" },
    { questionId: "materials", state: "unknown", value: "", confirmation: "pending" },
    { questionId: "authorization", state: "skipped", value: "", confirmation: "pending" },
  ]);
  const authorization = draft.answers.find((answer) => answer.questionId === "authorization")!;
  expect(authorization.confirmedRevision).toBeUndefined();
  expect(authorization.confirmedAt).toBeUndefined();
});
