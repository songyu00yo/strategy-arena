// Explicit synthetic API fixtures. These checks never contact a model provider.
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route, type Locator } from "@playwright/test";
import type { ArenaSnapshot, Challenge, ModelMode } from "../../src/lib/contracts";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { stepContext } from "../../src/lib/step-context";
import { advanceFixture, fixtureSnapshot, fixtureVersion } from "./ui.fixture";
import { configureFixtureModels } from "./intake.fixture";

type VersionBody = {
  challenge: Challenge;
  changeReason: string;
  modelMode: ModelMode;
  baseVersionId: string;
  followUp?: { stepId: string; quote: string; text: string };
};
function completedSnapshot() {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  snapshot.versions[0].modelSelection = {
    requestedMode: "gpt-6.1-terra",
    provider: "openai",
    modelId: "gpt-6.1-terra",
    currency: "USD",
    policyVersion: "explicit-test-fixture",
    reason: "Explicit synthetic model selection.",
  };
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  return snapshot;
}
async function interceptAllApis(
  page: Page,
  snapshot: ArenaSnapshot,
  onPost: (route: Route) => Promise<void>,
) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-test-fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (route.request().method() === "POST") return onPost(route);
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 500, json: { error: "Unexpected explicit fixture request" } });
  });
}
function appendCompletedVersion(snapshot: ArenaSnapshot, body: VersionBody) {
  const parent = snapshot.versions.find((version) => version.id === snapshot.activeVersionId)!;
  const next = fixtureVersion(snapshot.versions.length + 1, body.challenge);
  Object.assign(next, {
    status: "completed",
    stage: "judge",
    strategies: structuredClone(parent.strategies),
    attacks: structuredClone(parent.attacks),
    evidence: structuredClone(parent.evidence),
    revisions: structuredClone(parent.revisions),
    verdict: structuredClone(parent.verdict),
    modelSelection: parent.modelSelection,
    parentVersionId: parent.id,
    changeReason: body.changeReason,
    ...(body.followUp ? { followUp: { ...body.followUp, sourceVersionId: parent.id } } : {}),
  });
  snapshot.versions.push(next);
  snapshot.activeVersionId = next.id;
}
async function openSource(page: Page, number: number) {
  await page.keyboard.press("End");
  // Narrow screens expose the current deck card; select it through the visible progress control.
  if ((page.viewportSize()?.width ?? 1440) < 650)
    await page.getByRole("button", { name: `第 ${number} 步`, exact: true }).click();
  await page.getByRole("button", { name: `查看第 ${number} 步`, exact: true }).focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("dialog", { name: new RegExp(`^第 ${number} 步 ·`) });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "补充或质疑", exact: true }).click();
  await expect(card).toBeHidden();
  const supplement = page.getByRole("dialog", { name: "补充这一步", exact: true });
  await expect(supplement).toBeVisible();
  return supplement;
}

for (const recorded of [false, true]) {
  test(`explicit UI fixture: ${recorded ? "recorded" : "live"} supplement survives a conditions handoff and stays scoped to its source`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const snapshot = completedSnapshot();
    let posts = 0;
    await interceptAllApis(page, snapshot, async (route) => {
      posts++;
      await route.fulfill({
        status: 500,
        json: { error: "This recovery fixture must not submit." },
      });
    });
    await page.goto(recorded ? "/examples/career" : `/?arena=${snapshot.id}`);
    if (recorded) await page.getByRole("button", { name: "开始分析", exact: true }).click();
    const text = "测试：保留我已写下、尚未确认的补充，先去调整条件。";
    let supplement = await openSource(page, 1);
    await supplement.getByRole("textbox").fill(text);
    if (recorded) {
      await supplement.getByRole("button", { name: /^选择模型，当前/ }).click();
      await page.getByRole("option", { name: "GPT 6.1 Sol", exact: true }).click();
    }
    await supplement.getByRole("button", { name: "调整条件", exact: true }).click();
    const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
    await expect(conditions).toBeVisible();
    await conditions.getByLabel("预算上限", { exact: false }).fill("150");
    await conditions.getByRole("button", { name: "取消", exact: true }).click();
    await expect(conditions).toBeHidden();
    supplement = await openSource(page, 1);
    await expect(supplement.getByRole("textbox")).toHaveValue(text);
    if (recorded)
      await expect(
        supplement.getByRole("button", { name: "选择模型，当前GPT 6.1 Sol", exact: true }),
      ).toBeVisible();
    await supplement.getByRole("button", { name: "取消", exact: true }).click();
    await expect(supplement).toBeHidden();
    supplement = await openSource(page, 2);
    await expect(supplement.getByRole("textbox")).toHaveValue("");
    await supplement.getByRole("button", { name: "取消", exact: true }).click();
    await expect(supplement).toBeHidden();
    supplement = await openSource(page, 1);
    await expect(supplement.getByRole("textbox")).toHaveValue(text);
    expect(posts).toBe(0);
  });
}

for (const [label, field, value, key] of [
  ["budget", "预算上限", "150", "budget"],
  ["time", "可投入时间", "3", "timeHours"],
  ["preference", "更看重什么", "测试：更看重稳定性和可维护性。", "preferences"],
] as const) {
  test(`explicit UI fixture: ${label} edit preserves all other inputs and model without requiring a note`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const snapshot = completedSnapshot();
    const original = structuredClone(snapshot.versions[0].challenge);
    const requests: VersionBody[] = [];
    await interceptAllApis(page, snapshot, async (route) => {
      expect(new URL(route.request().url()).pathname).toBe(`/api/arenas/${snapshot.id}/versions`);
      const body = route.request().postDataJSON() as VersionBody;
      requests.push(body);
      appendCompletedVersion(snapshot, body);
      await route.fulfill({ json: snapshot });
    });
    await page.goto(`/?arena=${snapshot.id}`);
    if (key === "budget") await page.getByRole("button", { name: /^预算上限\s*¥300$/ }).click();
    else if (key === "timeHours")
      await page.getByRole("button", { name: /^可用时间\s*7 小时$/ }).click();
    else await page.getByRole("button", { name: "调整条件", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "调整条件", exact: true });
    if (key === "budget" || key === "timeHours")
      await expect(dialog.getByLabel(field, { exact: false })).toBeFocused();
    const submit = dialog.getByRole("button", { name: "按新条件重新推演", exact: true });
    await expect(submit).toBeDisabled();
    await submit.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    expect(requests).toEqual([]);
    if (key !== "budget")
      await dialog
        .getByRole("button", { name: key === "timeHours" ? "时间" : "偏好", exact: true })
        .click();
    await dialog.getByLabel(field, { exact: false }).fill(value);
    await expect(dialog.getByLabel("补充说明", { exact: false })).toBeHidden();
    await expect(dialog.getByRole("button", { name: /^补充说明/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(dialog.getByRole("region", { name: "本次修改", exact: true })).toContainText(
      value,
    );
    await dialog.getByRole("button", { name: "展开改动", exact: true }).click();
    await expect(dialog.locator(".condition-editor-diff")).toContainText(value);
    await dialog.getByRole("button", { name: "收起改动", exact: true }).click();
    await submit.click();
    await expect(dialog).toBeHidden();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      challenge: { ...original, [key]: key === "preferences" ? value : Number(value) },
      baseVersionId: "fixture-version-1",
      modelMode: "gpt-6.1-terra",
    });
    expect(requests[0].challenge).toEqual({
      ...original,
      [key]: key === "preferences" ? value : Number(value),
    });
    expect(requests[0].changeReason).toContain(field);
    expect(snapshot.versions[0].challenge).toEqual(original);
    if (key === "budget") {
      await expect(page.getByRole("heading", { name: "输入变化", exact: true })).toBeHidden();
      const compare = page.getByRole("button", { name: "对比上一版 V1 → V2", exact: true });
      await compare.click();
      const comparison = page.getByRole("dialog", { name: "版本变化 · V1 → V2", exact: true });
      await expect(
        comparison.getByRole("heading", { name: "预算上限", exact: true }),
      ).toBeVisible();
      await expect(comparison.getByText("上一版300 元", { exact: true })).toBeVisible();
      await expect(comparison.getByText("本版150 元", { exact: true })).toBeVisible();
      await expect(comparison).toContainText("两版记录的建议路线均为 A");
      await page.keyboard.press("Escape");
      await expect(comparison).toBeHidden();
      await expect(compare).toBeFocused();
      expect(requests).toHaveLength(1);
    }
    await page.getByRole("button", { name: "调整条件", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "调整条件", exact: true })
        .getByRole("button", { name: "按新条件重新推演", exact: true }),
    ).toBeDisabled();
    expect(requests).toHaveLength(1);
  });
}

for (const [stepId, number] of [
  ["p:A", 1],
  ["a:attack-fixture", 4],
  ["v:attack-fixture", 5],
  ["r:A", 6],
  ["judge", 9],
] as const) {
  test(`explicit UI fixture: ${stepId} supplement sends its frozen source and repeated submit creates one version`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const snapshot = completedSnapshot();
    const source = stepContext(snapshot.versions[0], stepId)!;
    const beforeAction = snapshot.versions[0].revisions[0].strategy.firstAction;
    const afterAction = "测试后续行动：先核算交通和等待时间，再写最小样片大纲。";
    const posts: VersionBody[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await interceptAllApis(page, snapshot, async (route) => {
      expect(new URL(route.request().url()).pathname).toBe(`/api/arenas/${snapshot.id}/versions`);
      const body = route.request().postDataJSON() as VersionBody;
      posts.push(body);
      await gate;
      appendCompletedVersion(snapshot, body);
      // Explicit response fixture changes one recorded action while retaining the same recommendation.
      if (stepId === "p:A") snapshot.versions[1].revisions[0].strategy.firstAction = afterAction;
      await route.fulfill({ json: snapshot });
    });
    try {
      await page.goto(`/?arena=${snapshot.id}`);
      const dialog = await openSource(page, number);
      await expect(dialog.locator("blockquote")).toBeHidden();
      await dialog.getByRole("button", { name: "查看原文", exact: true }).click();
      await expect(dialog.locator("blockquote")).toBeVisible();
      await expect(dialog.locator("blockquote")).toHaveText(source.quote);
      await dialog.getByRole("button", { name: "收起原文", exact: true }).click();
      await expect(dialog.locator("blockquote")).toBeHidden();
      const text = "测试：这里还需考虑交通和等待时间。";
      await dialog.getByRole("textbox").fill(text);
      const submit = dialog.getByRole("button", { name: "补充后重新推演", exact: true });
      await submit.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect.poll(() => posts.length).toBe(1);
      await expect(
        dialog.getByRole("button", { name: "正在创建新版本…", exact: true }),
      ).toBeDisabled();
      expect(posts[0]).toMatchObject({
        baseVersionId: "fixture-version-1",
        followUp: { stepId, quote: source.quote, text },
      });
      release();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("combobox", { name: "选择推演版本" })).toHaveValue(
        "fixture-version-2",
      );
      expect(posts).toHaveLength(1);
      if (stepId === "p:A") {
        const original = page.getByRole("button", {
          name: "本次补充 · 查看原文与意见",
          exact: true,
        });
        await original.click();
        const sourceDialog = page.getByRole("dialog", { name: "本次补充", exact: true });
        await expect(sourceDialog.locator("blockquote")).toHaveText(source.quote);
        await expect(sourceDialog.getByText(text, { exact: true })).toBeVisible();
        await expect(sourceDialog).toContainText("来源：V1 · 步骤 p:A");
        await page.keyboard.press("Escape");
        await expect(sourceDialog).toBeHidden();
        await expect(original).toBeFocused();
        await expect(page.getByRole("heading", { name: "输入变化", exact: true })).toBeHidden();
        const compare = page.getByRole("button", { name: "对比上一版 V1 → V2", exact: true });
        await compare.click();
        const comparison = page.getByRole("dialog", { name: "版本变化 · V1 → V2", exact: true });
        await expect(comparison).toContainText("任务条件未改动，本次新增了补充意见或调整了模型。");
        const routeA = comparison.locator("section").filter({
          has: page.getByRole("heading", { name: "路线 A", exact: true }),
        });
        await expect(routeA).toContainText("第一步行动");
        await expect(routeA.getByText(`上一版${beforeAction}`, { exact: true })).toBeVisible();
        await expect(routeA.getByText(`本版${afterAction}`, { exact: true })).toBeVisible();
        await expect(comparison).toContainText(
          "两版记录的建议路线均为 A，具体内容以各版原文为准。",
        );
        await expect(
          comparison.getByText("已记录的路线内容没有变化。", { exact: true }),
        ).toHaveCount(2);
        await page.keyboard.press("Escape");
        await expect(comparison).toBeHidden();
        await expect(compare).toBeFocused();
        expect(posts).toHaveLength(1);
      }
    } finally {
      release();
    }
  });
}

test("explicit UI fixture: stale source preserves the user's draft and never automatically retries", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const snapshot = completedSnapshot();
  let posts = 0;
  await interceptAllApis(page, snapshot, async (route) => {
    posts++;
    await route.fulfill({
      status: 409,
      json: {
        code: "STALE_SOURCE",
        error: "这一步的内容已更新，你填写的内容已保留。请重新查看原文后确认。",
      },
    });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  const dialog = await openSource(page, 1);
  const text = "测试：请保留这段尚未提交成功的补充内容。";
  await dialog.getByRole("textbox").fill(text);
  await dialog.getByRole("button", { name: "补充后重新推演", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("内容已更新");
  await expect(dialog.getByRole("textbox")).toHaveValue(text);
  await expect(dialog.getByRole("button", { name: "补充后重新推演", exact: true })).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(dialog).toBeVisible();
  expect(posts).toBe(1);
  expect(snapshot.versions).toHaveLength(1);
});

for (const entry of ["stale condition submission", "step supplement to conditions"] as const) {
  test(`explicit UI fixture: ${entry} keeps its V1 source pinned until closing returns to background V2`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Explicit browser transport fixture: an arena event triggers the application's real GET refresh.
    await page.addInitScript(() => {
      const fixtureWindow = window as typeof window & { __fixtureArenaStream?: EventTarget };
      class FixtureEventSource extends EventTarget {
        constructor() {
          super();
          fixtureWindow.__fixtureArenaStream = this;
        }
        close() {}
      }
      Object.defineProperty(window, "EventSource", {
        configurable: true,
        value: FixtureEventSource,
      });
    });
    const snapshot = completedSnapshot();
    const posts: VersionBody[] = [];
    await interceptAllApis(page, snapshot, async (route) => {
      expect(new URL(route.request().url()).pathname).toBe(`/api/arenas/${snapshot.id}/versions`);
      posts.push(route.request().postDataJSON() as VersionBody);
      await route.fulfill({
        status: 409,
        json: {
          code: "STALE_VERSION",
          error: "当前版本已更新，你填写的内容已保留。请回到当前版本确认后再提交。",
        },
      });
    });
    await page.goto(`/?arena=${snapshot.id}`);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (window as typeof window & { __fixtureArenaStream?: EventTarget }).__fixtureArenaStream,
          ),
        ),
      )
      .toBe(true);
    const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
    const draftNote = "测试：保留我尚未提交成功的预算调整。";
    if (entry === "stale condition submission") {
      await page.getByRole("button", { name: "调整条件", exact: true }).click();
      await conditions.getByLabel("预算上限", { exact: false }).fill("150");
      await conditions.getByRole("button", { name: /^补充说明/ }).click();
      await conditions.getByLabel("补充说明", { exact: false }).fill(draftNote);
    } else {
      const supplement = await openSource(page, 1);
      await supplement.getByRole("textbox").fill("测试：补充前先调整预算条件。");
    }
    // Synthetic persisted V2 arrives from another client while this form still cites V1.
    appendCompletedVersion(snapshot, {
      challenge: { ...snapshot.versions[0].challenge, budget: 200 },
      baseVersionId: "fixture-version-1",
      changeReason: "测试：另一个客户端已调整预算为 200 元。",
      modelMode: "gpt-6.1-terra",
    });
    const refreshed = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/arenas/${snapshot.id}`,
    );
    await page.evaluate(() => {
      (
        window as typeof window & { __fixtureArenaStream?: EventTarget }
      ).__fixtureArenaStream!.dispatchEvent(new Event("arena"));
    });
    await refreshed;
    // Read the pinned background value while the native modal intentionally makes it inert.
    const versions = page.locator('select[aria-label="选择推演版本"]');
    await expect(versions.locator('option[value="fixture-version-2"]')).toHaveText("V02 当前版本");
    await expect(versions).toHaveValue("fixture-version-1");
    if (entry === "stale condition submission") {
      await expect(conditions.getByLabel("预算上限", { exact: false })).toHaveValue("150");
      await conditions.getByRole("button", { name: "按新条件重新推演", exact: true }).click();
      await expect(conditions.getByRole("alert")).toContainText("当前版本已更新");
      await expect(conditions.getByLabel("预算上限", { exact: false })).toHaveValue("150");
      await expect(conditions.getByLabel("补充说明", { exact: false })).toHaveValue(draftNote);
      await expect(versions).toHaveValue("fixture-version-1");
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        baseVersionId: "fixture-version-1",
        challenge: { budget: 150 },
      });
    } else {
      const supplement = page.getByRole("dialog", { name: "补充这一步", exact: true });
      await supplement.getByRole("button", { name: "调整条件", exact: true }).click();
      await expect(supplement).toBeHidden();
      await expect(conditions).toBeVisible();
      await expect(conditions.getByLabel("预算上限", { exact: false })).toHaveValue("300");
      expect(posts).toEqual([]);
    }
    await conditions.getByRole("button", { name: "取消", exact: true }).click();
    await expect(conditions).toBeHidden();
    await expect(versions).toHaveValue("fixture-version-2");
    await expect(page.getByRole("button", { name: /^预算上限\s*¥200$/ })).toBeEnabled();
    expect(snapshot.versions).toHaveLength(2);
    expect(posts).toHaveLength(entry === "stale condition submission" ? 1 : 0);
  });
}

test("explicit UI fixture: compact input drawers preserve desktop context and fit a 390px screen", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 900 });
  const snapshot = completedSnapshot();
  const posts: string[] = [];
  await interceptAllApis(page, snapshot, async (route) => {
    posts.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 500,
      json: { error: "This input layout fixture must not submit." },
    });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  await page.getByRole("button", { name: "调整条件", exact: true }).click();
  const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
  await expect(conditions).toBeVisible();
  const desktop = await conditions.boundingBox();
  expect(desktop).not.toBeNull();
  expect(desktop!.width).toBeLessThanOrEqual(440);
  expect(desktop!.x).toBeGreaterThanOrEqual(1280 / 2);
  expect(desktop!.x + desktop!.width).toBeLessThanOrEqual(1280);
  const reference = page.locator(".condition-trigger").filter({ hasText: "硬性限制" });
  await expect(reference).toBeVisible();
  const referenceBox = await reference.boundingBox();
  expect(referenceBox).not.toBeNull();
  expect(referenceBox!.x + referenceBox!.width).toBeLessThan(desktop!.x);
  expect(referenceBox!.y).toBeGreaterThanOrEqual(0);
  expect(referenceBox!.y + referenceBox!.height).toBeLessThanOrEqual(900);
  await conditions.getByRole("button", { name: "取消", exact: true }).click();
  await expect(conditions).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  const compact = async (dialog: Locator) => {
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(370);
    expect(box!.height).toBeLessThanOrEqual(560);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  };
  await page.getByRole("button", { name: "调整条件", exact: true }).click();
  await compact(conditions);
  await expect(conditions.getByLabel("预算上限", { exact: false })).toBeFocused();
  await expect(conditions.getByLabel("可投入时间", { exact: false })).toBeHidden();
  await expect(conditions.getByLabel("更看重什么", { exact: false })).toBeHidden();
  for (const name of ["时间", "限制", "偏好", "预算"]) {
    const switcher = conditions.getByRole("button", { name, exact: true });
    await expect(switcher).toBeInViewport();
    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-pressed", "true");
  }
  await conditions.getByLabel("预算上限", { exact: false }).fill("150");
  const confirm = conditions.getByRole("button", { name: "按新条件重新推演", exact: true });
  await expect(confirm).toBeEnabled();
  await expect(confirm).toBeInViewport();
  await conditions.getByRole("button", { name: "取消", exact: true }).click();
  await expect(conditions).toBeHidden();
  const supplement = await openSource(page, 1);
  await compact(supplement);
  await expect(supplement.locator("blockquote")).toBeHidden();
  await supplement.getByRole("textbox").fill("测试：在小屏幕上也能直接填写补充意见。");
  const submit = supplement.getByRole("button", { name: "补充后重新推演", exact: true });
  await expect(submit).toBeEnabled();
  await expect(submit).toBeInViewport();
  await supplement.getByRole("button", { name: "取消", exact: true }).click();
  await expect(supplement).toBeHidden();
  expect(posts).toEqual([]);
});

test("explicit UI fixture: recorded conditions stay free until explicit confirmation creates a sourced real task", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot();
  snapshot.id = "fixture-recorded-conditions";
  const payload = JSON.parse(
    readFileSync("public/recorded-examples/career.json", "utf8"),
  ) as RecordedExamplePayload;
  const original = payload.arena.versions[0].challenge;
  const posts: { path: string; body: Challenge & { modelMode: ModelMode } }[] = [];
  await interceptAllApis(page, snapshot, async (route) => {
    const body = route.request().postDataJSON() as Challenge & { modelMode: ModelMode };
    posts.push({ path: new URL(route.request().url()).pathname, body });
    snapshot.versions[0].challenge = body;
    await route.fulfill({ json: snapshot });
  });
  await page.goto("/examples/career");
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await page.getByRole("button", { name: "调整条件", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "调整条件", exact: true });
  await expect(
    dialog.getByRole("button", { name: "按新条件重新推演", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("预算上限", { exact: false }).fill("150");
  await expect(dialog.getByRole("button", { name: "按新条件重新推演", exact: true })).toBeEnabled();
  expect(posts).toEqual([]);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(posts).toEqual([]);
  await page.getByRole("button", { name: "调整条件", exact: true }).click();
  await dialog.getByLabel("预算上限", { exact: false }).fill("150");
  await dialog.getByRole("button", { name: "按新条件重新推演", exact: true }).click();
  await expect(page).toHaveURL(/\/\?arena=fixture-recorded-conditions$/);
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe("/api/arenas");
  const { materials, ...fields } = original;
  expect(posts[0].body).toMatchObject({ ...fields, budget: 150 });
  expect(posts[0].body.materials).toContain(materials);
  expect(posts[0].body.materials).toContain(payload.metadata.sourceCommit);
  expect(posts[0].body.materials).toContain("待复核");
});
