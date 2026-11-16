import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { e2eAddress } from "../../scripts/test-address.mjs";
import { fixtureModels } from "./intake.fixture";

const { origin } = e2eAddress();
async function unlock(request: APIRequestContext) {
  const response = await request.post("/api/access", {
    headers: { Origin: origin },
    data: { code: "e2e-only-access-code" },
  });
  expect(response.status()).toBe(200);
}
/** Only model availability is a UI fixture. Identity and draft endpoints use the real server. */
async function installModelHealthFixture(page: Page, observed?: () => void) {
  await page.route("**/api/health", async (route) => {
    observed?.();
    const response = await route.fetch();
    const health = await response.json();
    expect(health.identityBootstrap).toBe(true);
    await route.fulfill({
      response,
      json: {
        ...health,
        model: {
          ...health.model,
          configured: true,
          models: fixtureModels,
          providers: fixtureModels,
        },
      },
    });
  });
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("real identity bootstrap blocks draft creation and history, then one blur and history click share their owner", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page.request);
  await installModelHealthFixture(page);
  const initialization = barrier();
  let identities = 0;
  let firstTag = "";
  let drafts = 0;
  let draftId = "";
  let draftFulfilled = false;
  let lists = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.pathname === "/api/intakes" || url.pathname === "/api/arenas") &&
      request.method() === "GET"
    )
      lists++;
  });
  await page.route("**/api/identity", async (route) => {
    identities++;
    await initialization.promise;
    const response = await route.fetch();
    const value = await response.json();
    if (!firstTag) firstTag = value.identityTag;
    else {
      expect(value.identityTag).toBe(firstTag);
      expect(response.headers()["set-cookie"]).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await route.fulfill({ response });
  });
  await page.route(/\/api\/intakes(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    drafts++;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    draftId = (await response.json()).id;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ response });
    draftFulfilled = true;
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => identities).toBe(1);
    const input = page.getByLabel("你想解决什么问题？", { exact: true });
    const history = page.getByRole("banner").getByRole("button", { name: "我的历史", exact: true });
    await expect(input).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(history).toBeDisabled();
    await page.waitForTimeout(300);
    expect(drafts).toBe(0);
    expect(lists).toBe(0);
    expect((await context.cookies()).some((cookie) => cookie.name === "arena_owner")).toBe(false);
    initialization.release();
    await expect(input).toBeEditable();
    await expect(history).toBeEnabled();
    const goal = "首次身份引导后，同一次失焦保存与历史查询保持归属";
    await input.fill(goal);
    await history.click();
    await expect.poll(() => draftId).not.toBe("");
    await expect.poll(() => draftFulfilled).toBe(true);
    await expect(page.getByRole("dialog", { name: "我的历史与恢复码" })).toBeVisible();
    await expect(
      page
        .getByRole("dialog", { name: "我的历史与恢复码" })
        .getByRole("button", { name: "刷新", exact: true }),
    ).toBeEnabled();
    expect(drafts).toBe(1);
    expect(identities).toBe(2);
    const identity = await (await page.request.get("/api/identity")).json();
    expect(identity.identityTag).toBe(firstTag);
    expect((await page.request.get(`/api/intakes/${draftId}`)).status()).toBe(200);
    const historyPage = await (
      await page.request.get(`/api/intakes?identityTag=${firstTag}`)
    ).json();
    expect(historyPage.items.some((item: { id: string }) => item.id === draftId)).toBe(true);
  } finally {
    initialization.release();
  }
});

test("real Web Locks serialize first identity creation across two browser tabs", async ({
  page,
  context,
}) => {
  await unlock(page.request);
  const other = await context.newPage();
  const initialization = barrier();
  let healthReads = 0;
  let identities = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const tags: string[] = [];
  await installModelHealthFixture(page, () => healthReads++);
  await installModelHealthFixture(other, () => healthReads++);
  await context.route("**/api/identity", async (route) => {
    identities++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await initialization.promise;
      if (identities > 1) expect(route.request().headers().cookie).toContain("arena_owner=");
      const response = await route.fetch();
      tags.push((await response.json()).identityTag);
      if (identities > 1) expect(response.headers()["set-cookie"]).toBeUndefined();
      await route.fulfill({ response });
    } finally {
      inFlight--;
    }
  });
  try {
    await Promise.all([
      page.goto("/", { waitUntil: "domcontentloaded" }),
      other.goto("/", { waitUntil: "domcontentloaded" }),
    ]);
    expect(await page.evaluate(() => Boolean(navigator.locks))).toBe(true);
    await expect.poll(() => healthReads).toBe(2);
    await expect.poll(() => identities).toBe(1);
    await page.waitForTimeout(200);
    expect(identities).toBe(1);
    await expect(page.getByLabel("你想解决什么问题？", { exact: true })).toBeDisabled();
    await expect(other.getByLabel("你想解决什么问题？", { exact: true })).toBeDisabled();
    initialization.release();
    await expect(page.getByLabel("你想解决什么问题？", { exact: true })).toBeEditable();
    await expect(other.getByLabel("你想解决什么问题？", { exact: true })).toBeEditable();
    expect(identities).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toBe(tags[1]);
    expect(
      (await context.cookies()).filter((cookie) => cookie.name === "arena_owner"),
    ).toHaveLength(1);
  } finally {
    initialization.release();
    await other.close();
  }
});

test("real access unlock waits for identity bootstrap before allowing history or draft input", async ({
  page,
}) => {
  await installModelHealthFixture(page);
  const initialization = barrier();
  let identities = 0;
  await page.route("**/api/identity", async (route) => {
    identities++;
    await initialization.promise;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "验证访问码", exact: true })).toBeEnabled();
    expect(identities).toBe(0);
    await page.getByLabel("访问码", { exact: true }).fill("e2e-only-access-code");
    await page.getByRole("button", { name: "验证访问码", exact: true }).click();
    await expect.poll(() => identities).toBe(1);
    const input = page.getByLabel("你想解决什么问题？", { exact: true });
    await expect(input).toBeDisabled();
    await expect(
      page.getByRole("banner").getByRole("button", { name: "我的历史", exact: true }),
    ).toBeDisabled();
    initialization.release();
    await expect(input).toBeEditable();
    await expect(
      page.getByRole("banner").getByRole("button", { name: "我的历史", exact: true }),
    ).toBeEnabled();
  } finally {
    initialization.release();
  }
});
