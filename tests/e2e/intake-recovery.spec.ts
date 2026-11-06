import { expect, test, type Page } from "@playwright/test";
import type { ArenaSnapshot, Challenge } from "../../src/lib/contracts";
import type { IntakeDraft } from "../../src/lib/intake-contracts";
import { SUMMARY_JOURNAL_KEY } from "../../src/components/use-intake-summary";
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
    await expect(page.getByRole("status").filter({ hasText: "摘要已保存" })).toBeVisible();
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
    await expect(page.getByRole("status").filter({ hasText: "摘要已保存" })).toBeVisible();
    expect(draft.challenge?.budget).toBe(123);
    expect(draft.assumptions).toEqual(["测试：保留的假设"]);
    expect(await page.evaluate((key) => localStorage.getItem(key), SUMMARY_JOURNAL_KEY)).toBeNull();
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
    await expect(page.getByRole("status").filter({ hasText: "摘要已保存" })).toBeVisible();
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
  await page.getByRole("button", { name: "开始推演", exact: true }).click();
  await expect.poll(() => submissions).toBe(1);
  expect(order).toEqual(["save-summary", "submit"]);
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBe(draft.id);
  await page.reload();
  await expect(page.locator(".c-root")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("strategy-arena:last-id"))).toBe(
    snapshot.id,
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBeNull();
  expect(submissions).toBe(1);
  expect(analyses).toBe(0);
  expect(oldArenaReads).toBe(0);
});
