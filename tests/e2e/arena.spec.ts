import { expect, test } from "@playwright/test";
import { advanceFixture, fixtureChallenge, fixtureSnapshot, fixtureVersion } from "./ui.fixture";
import type { Challenge } from "../../src/lib/contracts";
import { e2eAddress } from "../../scripts/test-address.mjs";

const { origin } = e2eAddress();

test("real API without model key reports configuration state and enforces owner isolation", async ({
  request,
  playwright,
}) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect((await health.json()).model.configured).toBe(false);
  expect(
    (
      await request.post("/api/arenas", {
        headers: { Origin: origin },
        data: fixtureChallenge,
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/access", {
        headers: { Origin: origin },
        data: { code: "wrong-fixture-code" },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/access", {
        headers: { Origin: origin },
        data: { code: "e2e-only-access-code" },
      })
    ).status(),
  ).toBe(200);
  const create = await request.post("/api/arenas", {
    headers: { Origin: origin },
    data: fixtureChallenge,
  });
  expect(create.status()).toBe(201);
  const snapshot = await create.json();
  expect((await request.get(`/api/arenas/${snapshot.id}`)).status()).toBe(200);
  const foreign = await playwright.request.newContext({ baseURL: origin });
  try {
    expect((await foreign.get(`/api/arenas/${snapshot.id}`)).status()).toBe(401);
    expect(
      (
        await foreign.post("/api/access", {
          headers: { Origin: origin },
          data: { code: "e2e-only-access-code" },
        })
      ).status(),
    ).toBe(200);
    expect((await foreign.get(`/api/arenas/${snapshot.id}`)).status()).toBe(404);
  } finally {
    await foreign.dispose();
  }
  const advance = await request.post(`/api/arenas/${snapshot.id}/advance`, {
    headers: { Origin: origin },
    data: { versionId: snapshot.activeVersionId },
  });
  expect(advance.status()).toBe(503);
  expect((await advance.json()).code).toBe("MODEL_NOT_CONFIGURED");
  const after = await (await request.get(`/api/arenas/${snapshot.id}`)).json();
  expect(after.versions[0].strategies).toHaveLength(0);
  expect(after.versions[0].costCny).toBe(0);
});

test("real unconfigured homepage explains missing key and prevents starting a paid run", async ({
  page,
}) => {
  await page.request.post("/api/access", {
    headers: { Origin: origin },
    data: { code: "e2e-only-access-code" },
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "模型待配置" })).toBeVisible();
  await expect(page.getByRole("button", { name: "让方案上场" })).toBeDisabled();
  await expect(
    page.getByText("当前不会生成模拟结果或发起计费请求。", { exact: false }),
  ).toBeVisible();
});

test("explicit UI fixture: five stages, evidence, condition rematch and preserved history", async ({
  page,
}, testInfo) => {
  // This suite checks data flow; the console also supports immediate reduced-motion viewing.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = fixtureSnapshot();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "fixture",
          commit: "fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": explicit test fixture\n\n",
      });
    if (path.endsWith("/advance")) advanceFixture(snapshot);
    if (path.endsWith("/versions")) {
      const body = route.request().postDataJSON() as { challenge: Challenge; changeReason: string };
      const previous = snapshot.versions.find((item) => item.id === snapshot.activeVersionId)!;
      previous.status = "superseded";
      const next = fixtureVersion(snapshot.versions.length + 1, body.challenge);
      next.changeReason = body.changeReason;
      snapshot.versions.push(next);
      snapshot.activeVersionId = next.id;
    }
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "试填一个视频任务" }).click();
  await page.getByRole("button", { name: "让方案上场" }).click();
  await expect(page.getByRole("heading", { name: "测试裁决：先做最小样片" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("explicit-ui-fixture-arena.png"),
    fullPage: true,
  });
  // A child's Space activation opens its card without triggering the global playback shortcut.
  await page.getByRole("button", { name: "查看第 1 步", exact: true }).focus();
  await page.keyboard.press("Space");
  const step = page.getByRole("dialog", { name: "第 1 步 · 独立提案" });
  await expect(step).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(step).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "测试裁决：先做最小样片" })).toBeVisible();
  // Early replay opens the visible proposal, not a future revision of that route.
  await page.getByRole("button", { name: "第 1 步", exact: true }).click();
  await page.getByRole("button", { name: "查看路线 A 的详情" }).click();
  await expect(step).toBeVisible();
  await expect(step).toContainText("写一份测试大纲。");
  await page.keyboard.press("Escape");
  await expect(step).not.toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("heading", { name: "测试裁决：先做最小样片" })).toBeVisible();
  await page.getByRole("button", { name: /测试质疑：尚未核算总投入/ }).click();
  const evidence = page.getByRole("dialog", { name: "这一条，站得住吗？" });
  await expect(evidence.getByRole("heading", { name: "测试计算证据" })).toBeVisible();
  await expect(evidence.getByText("依据测试计算补充准备时间。", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("explicit-ui-fixture-evidence.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(evidence).not.toBeVisible();
  await page.getByRole("button", { name: "修改条件再开局" }).click();
  const edit = page.getByRole("dialog", { name: "修改条件，重新开局" });
  await edit.getByLabel("预算上限", { exact: false }).fill("150");
  await edit.getByLabel("这次为什么修改？", { exact: false }).fill("测试：预算减少到 150 元。");
  await edit.getByRole("button", { name: "按新条件重新推演" }).click();
  await expect(page.getByRole("heading", { name: "测试裁决：先做最小样片" })).toBeVisible();
  await expect(page.getByText("测试：预算减少到 150 元。", { exact: false })).toBeVisible();
  await page.getByRole("combobox", { name: "选择推演版本" }).selectOption("fixture-version-1");
  await expect(page.getByText("你正在查看历史版本。", { exact: false })).toBeVisible();
  expect(snapshot.versions[0].challenge.budget).toBe(300);
  expect(snapshot.versions[1].challenge.budget).toBe(150);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("explicit-ui-fixture-mobile-history.png"),
    fullPage: true,
  });
});

test("explicit UI fixture: a delayed old advance cannot replace a new condition version", async ({
  page,
}) => {
  // This suite checks data flow; the console also supports immediate reduced-motion viewing.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = fixtureSnapshot();
  let releaseOld!: () => void;
  let oldStarted!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldSeen = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  let held = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "fixture",
          commit: "fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit fixture\n\n" });
    if (path.endsWith("/advance")) {
      if (!held) {
        held = true;
        const stale = structuredClone(snapshot);
        oldStarted();
        await oldGate;
        await route.fulfill({ json: stale }).catch(() => {});
        return;
      }
      advanceFixture(snapshot);
    }
    if (path.endsWith("/versions")) {
      const body = route.request().postDataJSON() as { challenge: Challenge; changeReason: string };
      snapshot.versions[0].status = "superseded";
      const next = fixtureVersion(2, body.challenge);
      next.changeReason = body.changeReason;
      snapshot.versions.push(next);
      snapshot.activeVersionId = next.id;
    }
    return route.fulfill({ json: snapshot });
  });
  try {
    await page.goto("/");
    await page.getByLabel("你的目标、备选方案或想法").fill(fixtureChallenge.goal);
    await page.getByRole("button", { name: "让方案上场" }).click();
    await oldSeen;
    await page.getByRole("button", { name: "修改条件再开局" }).click();
    const edit = page.getByRole("dialog", { name: "修改条件，重新开局" });
    const newGoal = "测试任务：条件改变以后只制作一支更短的知识视频。";
    await edit.getByLabel("你的目标、备选方案或想法").fill(newGoal);
    await edit.getByLabel("这次为什么修改？", { exact: false }).fill("测试旧请求延迟到达。");
    await edit.getByRole("button", { name: "按新条件重新推演" }).click();
    await expect(page.getByRole("heading", { name: newGoal })).toBeVisible();
    releaseOld();
    await expect(page.getByRole("heading", { name: "测试裁决：先做最小样片" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "选择推演版本" })).toHaveValue(
      "fixture-version-2",
    );
    await expect(page.getByRole("heading", { name: newGoal })).toBeVisible();
  } finally {
    releaseOld();
  }
});
