import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { IntakeDraft } from "../../src/lib/intake-contracts";
import { ANSWER_JOURNAL_KEY, answerJournalScope } from "../../src/components/intake-answer-journal";
import {
  INTAKE_DRAFT_STORAGE_KEY,
  INTAKE_TAB_STORAGE_KEY,
} from "../../src/components/intake-draft-pointer";
import { ARENA_STORAGE_KEY, ARENA_TAB_STORAGE_KEY } from "../../src/components/arena-pointer";
import {
  SUMMARY_JOURNAL_KEY,
  SUMMARY_TAB_JOURNAL_KEY,
} from "../../src/components/intake-summary-journal";
import { configureFixtureModels, fixtureIntake } from "./intake.fixture";
import { advanceFixture, fixtureChallenge, fixtureSnapshot } from "./ui.fixture";

// Explicit synthetic UI fixtures. Every API is intercepted; no real model or billing is used.
const firstId = "synthetic-tab-draft-a";
const secondId = "synthetic-tab-draft-b";
const firstQuestion = "合成问题A：哪些限制必须保留？";
const secondQuestion = "合成问题B：希望采用哪条路线？";
const unsentAnswer = "合成未发送回答A：不能离职，也不能动用应急资金。";
const firstArenaId = "synthetic-tab-arena-a";
const secondArenaId = "synthetic-tab-arena-b";
const firstArenaGoal = "合成推演A：比较不离职的进修路线";
const secondArenaGoal = "合成推演B：比较视频的制作路线";
function questionDraft(id: string, title: string): IntakeDraft {
  return fixtureIntake({
    id,
    goal:
      id === firstId ? "合成任务A：在现有条件内选择进修路线" : "合成任务B：选择下一步的制作路线",
    status: "questions",
    round: 1,
    questions: [
      {
        id: "limits",
        title,
        reason: "合成测试问题",
        placeholder: "",
        type: "text",
        options: [],
        unit: "",
      },
    ],
  });
}
function completedSnapshot(id = "synthetic-tab-submitted-arena") {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  snapshot.id = id;
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  snapshot.versions[0].status = "paused";
  return snapshot;
}
async function installTabFixture(
  context: BrowserContext,
  first = questionDraft(firstId, firstQuestion),
  discussionFlow = false,
) {
  const drafts = new Map<string, IntakeDraft>(discussionFlow ? [] : [[first.id, first]]);
  const snapshot = completedSnapshot();
  const arenas = new Map([[snapshot.id, snapshot]]);
  const requests: string[] = [];
  const pageRequests: { page: Page; request: string }[] = [];
  const unexpected: string[] = [];
  let creations = 0;
  let denied: { status: number; code: string } | null = null;
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push(`${method} ${path}`);
    pageRequests.push({ page: request.frame().page(), request: `${method} ${path}` });
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-tab-fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (path === "/api/intakes" && method === "POST") {
      const input = request.postDataJSON();
      const id = discussionFlow && creations++ === 0 ? firstId : secondId;
      const draft = fixtureIntake({ id, goal: input.goal, modelMode: input.modelMode });
      drafts.set(id, draft);
      return route.fulfill({ status: 201, json: draft });
    }
    const match = path.match(/^\/api\/intakes\/([^/]+)(?:\/(analyze|submit))?$/);
    if (match) {
      const [, id, action] = match;
      if (id === firstId && denied && method === "GET")
        return route.fulfill({
          status: denied.status,
          json: { code: denied.code, error: "合成测试：原草稿无法访问" },
        });
      if (discussionFlow && action === "analyze" && method === "POST" && drafts.has(id)) {
        const current = drafts.get(id)!;
        const next: IntakeDraft = {
          ...current,
          revision: current.revision + 1,
          status: "summary",
          challenge: { ...structuredClone(fixtureChallenge), goal: current.goal },
        };
        drafts.set(id, next);
        return route.fulfill({ json: next });
      }
      if (id === secondId && action === "analyze" && method === "POST") {
        const next = questionDraft(secondId, secondQuestion);
        drafts.set(secondId, next);
        return route.fulfill({ json: next });
      }
      if (
        (discussionFlow || id === firstId) &&
        action === "submit" &&
        method === "POST" &&
        drafts.has(id)
      ) {
        const current = drafts.get(id)!;
        const submitted = discussionFlow
          ? completedSnapshot(id === firstId ? firstArenaId : secondArenaId)
          : snapshot;
        if (discussionFlow) submitted.versions[0].challenge.goal = current.goal;
        arenas.set(submitted.id, submitted);
        drafts.set(id, { ...current, status: "submitted", arenaId: submitted.id });
        return route.fulfill({ status: 201, json: submitted });
      }
      if (method === "GET" && !action && drafts.has(id))
        return route.fulfill({ json: drafts.get(id) });
    }
    const arenaMatch = path.match(/^\/api\/arenas\/([^/]+)(?:\/(events))?$/);
    if (arenaMatch && arenas.has(arenaMatch[1]) && !arenaMatch[2] && method === "GET")
      return route.fulfill({ json: arenas.get(arenaMatch[1]) });
    if (arenaMatch && arenas.has(arenaMatch[1]) && arenaMatch[2] === "events" && method === "GET")
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": synthetic tab fixture\n\n",
      });
    unexpected.push(`${method} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic tab fixture request" },
    });
  });
  return {
    requests,
    unexpected,
    snapshot,
    requestsFrom: (page: Page) =>
      pageRequests.filter((entry) => entry.page === page).map((entry) => entry.request),
    denyFirst: (status: number, code: string) => {
      denied = { status, code };
    },
  };
}
async function seedPointer(
  page: Page,
  draftId: string,
  { tabOwned = false, sharedId = draftId, journal = null as string | null } = {},
) {
  // This explicit picker URL reads health only, allowing setup without a restore racing the test.
  await page.goto("/?examples=open");
  await page.evaluate(
    ({ tabKey, sharedKey, answerKey, draftId, tabOwned, sharedId, journal }) => {
      sessionStorage.setItem("arena-intro", "1");
      if (tabOwned) sessionStorage.setItem(tabKey, draftId);
      else sessionStorage.removeItem(tabKey);
      localStorage.setItem(sharedKey, sharedId);
      if (journal) sessionStorage.setItem(answerKey, journal);
      else sessionStorage.removeItem(answerKey);
    },
    {
      tabKey: INTAKE_TAB_STORAGE_KEY,
      sharedKey: INTAKE_DRAFT_STORAGE_KEY,
      answerKey: ANSWER_JOURNAL_KEY,
      draftId,
      tabOwned,
      sharedId,
      journal,
    },
  );
}
async function pointers(page: Page) {
  return page.evaluate(
    ({ tabKey, sharedKey }) => ({
      tab: sessionStorage.getItem(tabKey),
      shared: localStorage.getItem(sharedKey),
    }),
    { tabKey: INTAKE_TAB_STORAGE_KEY, sharedKey: INTAKE_DRAFT_STORAGE_KEY },
  );
}
async function createSecondDraft(context: BrowserContext) {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByLabel("你想解决什么问题？", { exact: true })).not.toHaveValue("");
  await page.getByRole("button", { name: "准备新问题", exact: true }).click();
  await page
    .getByLabel("你想解决什么问题？", { exact: true })
    .fill(questionDraft(secondId, secondQuestion).goal);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("textbox", { name: secondQuestion, exact: true })).toBeVisible();
  expect(await pointers(page)).toEqual({ tab: secondId, shared: secondId });
  return page;
}

test("explicit UI fixture: a tab keeps its unsent answers after another tab creates a newer draft", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await installTabFixture(context);
  await seedPointer(page, firstId);
  await page.goto("/");
  const answer = page.getByRole("textbox", { name: firstQuestion, exact: true });
  await answer.fill(unsentAnswer);
  expect((await pointers(page)).tab).toBe(firstId); // Legacy localStorage pointer is migrated.
  const other = await createSecondDraft(context);
  const analyses = fixture.requests.filter((entry) => entry.includes("/analyze")).length;
  await page.reload();
  await expect(answer).toHaveValue(unsentAnswer);
  expect(await pointers(page)).toEqual({ tab: firstId, shared: secondId });
  expect(fixture.requests.filter((entry) => entry.includes("/analyze"))).toHaveLength(analyses);
  await other.reload();
  await expect(other.getByRole("textbox", { name: secondQuestion, exact: true })).toBeVisible();
  expect((await pointers(other)).tab).toBe(secondId);
  expect(fixture.unexpected).toEqual([]);
});

test("explicit UI fixture: starting over clears only the current tab's draft, preserving another tab's newer pointer", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await installTabFixture(context);
  await seedPointer(page, firstId);
  await page.goto("/");
  await page.getByRole("textbox", { name: firstQuestion, exact: true }).fill(unsentAnswer);
  const other = await createSecondDraft(context);
  await page.getByRole("button", { name: "准备新问题", exact: true }).click();
  await expect(page.getByLabel("你想解决什么问题？", { exact: true })).toHaveValue("");
  // Empty owned pointer suppresses the legacy fallback on this tab's next refresh.
  expect(await pointers(page)).toEqual({ tab: "", shared: secondId });
  expect(await page.evaluate((key) => sessionStorage.getItem(key), ANSWER_JOURNAL_KEY)).toBeNull();
  await page.reload();
  await expect(page.getByLabel("你想解决什么问题？", { exact: true })).toHaveValue("");
  expect(await pointers(page)).toEqual({ tab: "", shared: secondId });
  await other.reload();
  await expect(other.getByRole("textbox", { name: secondQuestion, exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("explicit UI fixture: submitting one tab cannot clear or resume another tab's draft", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const first = fixtureIntake({
    id: firstId,
    status: "summary",
    challenge: structuredClone(fixtureChallenge),
  });
  const fixture = await installTabFixture(context, first);
  await seedPointer(page, firstId);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始推演", exact: true })).toBeVisible();
  const other = await createSecondDraft(context);
  await page.getByRole("button", { name: "开始推演", exact: true }).click();
  await expect.poll(async () => (await pointers(page)).tab).toBe("");
  expect((await pointers(page)).shared).toBe(secondId);
  await other.reload();
  await expect(other.getByRole("textbox", { name: secondQuestion, exact: true })).toBeVisible();
  expect(
    fixture.requests.filter((entry) => entry === `POST /api/intakes/${firstId}/submit`),
  ).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

for (const [status, code] of [
  [404, "NOT_FOUND"],
  [403, "FORBIDDEN"],
] as const) {
  test(`explicit UI fixture: ${status} draft reads cannot resurrect a tab's old answer journal or delete another pointer`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await installTabFixture(context);
    await seedPointer(page, firstId);
    await page.goto("/");
    await page.getByRole("textbox", { name: firstQuestion, exact: true }).fill(unsentAnswer);
    const other = await createSecondDraft(context);
    fixture.denyFirst(status, code);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("textbox", { name: firstQuestion, exact: true })).toHaveCount(0);
    expect((await pointers(page)).shared).toBe(secondId);
    expect(fixture.requests.some((entry) => entry === `POST /api/intakes/${firstId}/analyze`)).toBe(
      false,
    );
    await other.reload();
    await expect(other.getByRole("textbox", { name: secondQuestion, exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const destination of ["/?examples=open", "/?arena=synthetic-tab-submitted-arena"]) {
  test(`explicit UI fixture: ${destination} never restores an old tab answer journal`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await installTabFixture(context);
    const draft = questionDraft(firstId, firstQuestion);
    const journal = JSON.stringify({
      scope: answerJournalScope(draft),
      answers: [{ questionId: "limits", state: "answered", value: unsentAnswer }],
    });
    await seedPointer(page, firstId, { tabOwned: true, journal });
    fixture.requests.length = 0;
    await page.goto(destination);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("textbox", { name: firstQuestion, exact: true })).toHaveCount(0);
    expect(fixture.requests.some((entry) => entry.startsWith("GET /api/intakes/"))).toBe(false);
    expect(fixture.requests.some((entry) => entry.startsWith("POST "))).toBe(false);
    expect(await pointers(page)).toEqual({ tab: firstId, shared: firstId });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), ANSWER_JOURNAL_KEY)).toBe(
      journal,
    );
    expect(fixture.unexpected).toEqual([]);
  });
}

async function arenaPointers(page: Page) {
  return page.evaluate(
    ({ tabKey, sharedKey }) => ({
      tab: sessionStorage.getItem(tabKey),
      shared: localStorage.getItem(sharedKey),
    }),
    { tabKey: ARENA_TAB_STORAGE_KEY, sharedKey: ARENA_STORAGE_KEY },
  );
}
async function submitNewDiscussion(page: Page, goal: string, arenaId: string) {
  await page.getByLabel("你想解决什么问题？", { exact: true }).fill(goal);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始推演", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始推演", exact: true }).click();
  await expect(page.getByRole("heading", { name: goal, exact: true })).toBeVisible();
  await expect.poll(async () => (await pointers(page)).tab).toBe("");
  expect(await arenaPointers(page)).toEqual({ tab: arenaId, shared: arenaId });
}
async function submitTwoDiscussions(page: Page, context: BrowserContext) {
  const fixture = await installTabFixture(context, undefined, true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
  await page.goto("/");
  await submitNewDiscussion(page, firstArenaGoal, firstArenaId);
  const other = await context.newPage();
  await other.emulateMedia({ reducedMotion: "reduce" });
  await other.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
  await other.goto("/");
  await expect(other.getByRole("heading", { name: firstArenaGoal, exact: true })).toBeVisible();
  await other.getByRole("button", { name: "新问题", exact: true }).click();
  await submitNewDiscussion(other, secondArenaGoal, secondArenaId);
  return { fixture, other };
}

test("explicit UI fixture: after two tabs submit their own discussions, a plain refresh restores only the owning arena", async ({
  page,
  context,
}) => {
  const { fixture, other } = await submitTwoDiscussions(page, context);
  await expect(page).toHaveURL(/\/$/); // An explicit ?arena URL must not mask pointer restoration.
  const before = fixture.requestsFrom(page).length;
  await page.reload();
  await expect(page.getByRole("heading", { name: firstArenaGoal, exact: true })).toBeVisible();
  expect(await arenaPointers(page)).toEqual({ tab: firstArenaId, shared: secondArenaId });
  const restored = fixture.requestsFrom(page).slice(before);
  expect(restored).toContain(`GET /api/arenas/${firstArenaId}`);
  expect(restored.some((entry) => entry.startsWith(`GET /api/arenas/${secondArenaId}`))).toBe(
    false,
  );
  expect(restored).not.toContain(`POST /api/arenas/${secondArenaId}/advance`);
  await other.reload();
  await expect(other.getByRole("heading", { name: secondArenaGoal, exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("explicit UI fixture: clearing one submitted discussion cannot clear another arena or reclaim it after refresh", async ({
  page,
  context,
}) => {
  const { fixture, other } = await submitTwoDiscussions(page, context);
  const before = fixture.requestsFrom(page).length;
  await page.getByRole("button", { name: "新问题", exact: true }).click();
  await expect(page.getByLabel("你想解决什么问题？", { exact: true })).toHaveValue("");
  expect(await arenaPointers(page)).toEqual({ tab: "", shared: secondArenaId });
  await page.reload();
  await expect(page.getByLabel("你想解决什么问题？", { exact: true })).toHaveValue("");
  expect(await arenaPointers(page)).toEqual({ tab: "", shared: secondArenaId });
  const restored = fixture.requestsFrom(page).slice(before);
  expect(restored.some((entry) => entry.startsWith(`GET /api/arenas/${secondArenaId}`))).toBe(
    false,
  );
  expect(restored).not.toContain(`POST /api/arenas/${secondArenaId}/advance`);
  await other.reload();
  await expect(other.getByRole("heading", { name: secondArenaGoal, exact: true })).toBeVisible();
  expect(await arenaPointers(other)).toEqual({ tab: secondArenaId, shared: secondArenaId });
  expect(fixture.unexpected).toEqual([]);
});

test("explicit UI fixture: unsynced summaries survive another tab's edits and starting over clears only its own tail", async ({
  page,
  context,
}) => {
  const snapshot = completedSnapshot();
  const drafts = new Map(
    [firstId, secondId].map((id) => [
      id,
      fixtureIntake({
        id,
        status: "summary",
        goal: id === firstId ? firstArenaGoal : secondArenaGoal,
        challenge: {
          ...structuredClone(fixtureChallenge),
          goal: id === firstId ? firstArenaGoal : secondArenaGoal,
        },
      }),
    ]),
  );
  const saves: string[] = [];
  const unexpected: string[] = [];
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-summary-tab-fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    const id = path.match(/^\/api\/intakes\/([^/]+)$/)?.[1];
    if (id && drafts.has(id)) {
      if (method === "GET") return route.fulfill({ json: drafts.get(id) });
      if (method === "PATCH") {
        expect(route.request().postDataJSON().summary).toBeTruthy();
        saves.push(id);
        return route.fulfill({ status: 503, json: { error: "合成测试：摘要尚未同步" } });
      }
    }
    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected synthetic summary request" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedPointer(page, firstId, { tabOwned: true });
  await page.goto("/");
  const firstField = page.getByRole("textbox", { name: "必须满足的限制", exact: true });
  const firstTail = "合成摘要A未同步：不能离职，保留现有收入。";
  await firstField.fill(firstTail);
  await expect(page.getByRole("status").filter({ hasText: "摘要尚未保存" })).toBeVisible();
  const other = await context.newPage();
  await other.emulateMedia({ reducedMotion: "reduce" });
  await seedPointer(other, secondId, { tabOwned: true });
  await other.goto("/");
  const secondField = other.getByRole("textbox", { name: "必须满足的限制", exact: true });
  const secondTail = "合成摘要B未同步：只使用现有设备。";
  await secondField.fill(secondTail);
  await expect(other.getByRole("status").filter({ hasText: "摘要尚未保存" })).toBeVisible();
  const secondJournal = await other.evaluate(
    ({ tab, legacy }) => {
      const raw = sessionStorage.getItem(tab);
      // Also retain an older client's B journal to exercise matching legacy cleanup in the real hook.
      if (raw) localStorage.setItem(legacy, raw);
      return raw;
    },
    { tab: SUMMARY_TAB_JOURNAL_KEY, legacy: SUMMARY_JOURNAL_KEY },
  );
  expect(secondJournal).not.toBeNull();
  await page.reload();
  await expect(firstField).toHaveValue(firstTail);
  await expect(page.getByRole("status").filter({ hasText: "摘要尚未保存" })).toBeVisible();
  expect(await other.evaluate((key) => sessionStorage.getItem(key), SUMMARY_TAB_JOURNAL_KEY)).toBe(
    secondJournal,
  );
  await page.getByRole("button", { name: "准备新问题", exact: true }).click();
  await expect(page.getByLabel("你想解决什么问题？", { exact: true })).toHaveValue("");
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), SUMMARY_TAB_JOURNAL_KEY),
  ).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), SUMMARY_JOURNAL_KEY)).toBe(
    secondJournal,
  );
  expect(await other.evaluate((key) => sessionStorage.getItem(key), SUMMARY_TAB_JOURNAL_KEY)).toBe(
    secondJournal,
  );
  await other.reload();
  await expect(secondField).toHaveValue(secondTail);
  expect(saves).toContain(firstId);
  expect(saves).toContain(secondId);
  expect(unexpected).toEqual([]);
});
