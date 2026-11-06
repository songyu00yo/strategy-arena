import { expect, test, type Page } from "@playwright/test";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";
import { advanceFixture, fixtureSnapshot } from "./ui.fixture";

// Explicit UI fixtures: every API is intercepted. No real model, provider or billing call occurs.
const previousArenaKey = "strategy-arena:last-id";
const oldDraft = fixtureIntake({
  id: "fixture-old-submitted-draft",
  status: "submitted",
  arenaId: "fixture-old-running-arena",
});
function completedTarget() {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  snapshot.id = "fixture-new";
  snapshot.versions[0].challenge = {
    ...snapshot.versions[0].challenge,
    goal: "测试指定新任务：只打开链接中的推演，不恢复之前的草稿",
  };
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  return snapshot;
}
async function previousPointers(page: Page) {
  await page.addInitScript(
    ({ draftKey, arenaKey, draftId, arenaId }) => {
      localStorage.setItem(draftKey, draftId);
      localStorage.setItem(arenaKey, arenaId);
    },
    {
      draftKey: intakeStorageKey,
      arenaKey: previousArenaKey,
      draftId: oldDraft.id,
      arenaId: oldDraft.arenaId!,
    },
  );
}
async function pointerValues(page: Page) {
  return page.evaluate(
    ({ draftKey, arenaKey }) => ({
      draft: localStorage.getItem(draftKey),
      arena: localStorage.getItem(arenaKey),
    }),
    { draftKey: intakeStorageKey, arenaKey: previousArenaKey },
  );
}

test("explicit UI fixture: opening the free example picker preserves old pointers and reads only health", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await previousPointers(page);
  const target = completedTarget();
  const oldArena = structuredClone(target);
  oldArena.id = oldDraft.arenaId!;
  oldArena.versions[0].status = "running";
  oldArena.versions[0].verdict = null;
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    calls.push(`${method} ${pathname}`);
    if (pathname === "/api/health" && method === "GET")
      return route.fulfill({
        json: {
          status: "ok",
          model: target.model,
          accessGranted: true,
          requiresAccessCode: false,
        },
      });
    if (pathname === `/api/intakes/${oldDraft.id}` && method === "GET")
      return route.fulfill({ json: oldDraft });
    if (pathname === `/api/arenas/${oldArena.id}` && method === "GET")
      return route.fulfill({ json: oldArena });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto("/examples");
  await expect(page).toHaveURL(/\/\?examples=open$/);
  await expect(page.getByRole("dialog", { name: "先看一场真实推演", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => call === "GET /api/health")).toBe(true);
  expect(await pointerValues(page)).toEqual({ draft: oldDraft.id, arena: oldDraft.arenaId });
});

test("explicit UI fixture: explicit arena takes priority and forbidden or missing IDs never fall back", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await previousPointers(page);
  const target = completedTarget();
  let calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    calls.push(`${method} ${pathname}`);
    if (pathname === "/api/health" && method === "GET")
      return route.fulfill({
        json: {
          status: "ok",
          model: target.model,
          accessGranted: true,
          requiresAccessCode: false,
        },
      });
    if (pathname === "/api/arenas/fixture-new" && method === "GET")
      return route.fulfill({ json: target });
    if (pathname === "/api/arenas/fixture-new/events" && method === "GET")
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (pathname === "/api/arenas/fixture-forbidden" && method === "GET")
      return route.fulfill({ status: 403, json: { code: "FORBIDDEN", error: "Fixture denied" } });
    if (pathname === "/api/arenas/fixture-missing" && method === "GET")
      return route.fulfill({ status: 404, json: { code: "NOT_FOUND", error: "Fixture missing" } });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto("/?arena=fixture-new");
  await expect(
    page.getByRole("heading", { name: target.versions[0].challenge.goal, exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(calls).toContain("GET /api/arenas/fixture-new");
  expect(
    calls.every((call) =>
      [
        "GET /api/health",
        "GET /api/arenas/fixture-new",
        "GET /api/arenas/fixture-new/events",
      ].includes(call),
    ),
  ).toBe(true);
  expect(await pointerValues(page)).toEqual({ draft: oldDraft.id, arena: target.id });

  for (const id of ["fixture-forbidden", "fixture-missing"]) {
    calls = [];
    await page.goto(`/?arena=${id}`);
    await expect(page.getByRole("alert")).toContainText("未恢复之前的任务");
    await expect(
      page.getByRole("heading", { name: target.versions[0].challenge.goal, exact: true }),
    ).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(calls).toContain(`GET /api/arenas/${id}`);
    expect(calls.every((call) => ["GET /api/health", `GET /api/arenas/${id}`].includes(call))).toBe(
      true,
    );
    expect(await pointerValues(page)).toEqual({ draft: oldDraft.id, arena: oldDraft.arenaId });
  }
});

test("explicit UI fixture: explicit arena restores normally when optional storage writes fail", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(
    ({ draftKey, arenaKey, draftId, arenaId }) => {
      localStorage.setItem(draftKey, draftId);
      localStorage.setItem(arenaKey, arenaId);
      Storage.prototype.setItem = () => {
        throw new DOMException("Synthetic blocked storage", "QuotaExceededError");
      };
    },
    {
      draftKey: intakeStorageKey,
      arenaKey: previousArenaKey,
      draftId: oldDraft.id,
      arenaId: oldDraft.arenaId!,
    },
  );
  const target = completedTarget();
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    calls.push(`${method} ${pathname}`);
    if (pathname === "/api/health" && method === "GET")
      return route.fulfill({
        json: { status: "ok", model: target.model, accessGranted: true, requiresAccessCode: false },
      });
    if (pathname === `/api/arenas/${target.id}` && method === "GET")
      return route.fulfill({ json: target });
    if (pathname === `/api/arenas/${target.id}/events` && method === "GET")
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto(`/?arena=${target.id}`);
  await expect(
    page.getByRole("heading", { name: target.versions[0].challenge.goal, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(calls).toContain(`GET /api/arenas/${target.id}`);
  expect(
    calls.every((call) =>
      [
        "GET /api/health",
        `GET /api/arenas/${target.id}`,
        `GET /api/arenas/${target.id}/events`,
      ].includes(call),
    ),
  ).toBe(true);
  expect(await pointerValues(page)).toEqual({ draft: oldDraft.id, arena: oldDraft.arenaId });
});
