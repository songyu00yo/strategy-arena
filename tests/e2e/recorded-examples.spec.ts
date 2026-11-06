import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../../src/lib/recorded-examples";

// These are the published historical records, not synthetic UI fixtures or model stubs.
function recording(slug: string): RecordedExamplePayload {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "public", "recorded-examples", `${slug}.json`), "utf8"),
  ) as RecordedExamplePayload;
}

async function watchReadOnlyRequests(page: Page, origin: string, homepage = false) {
  const forbidden: string[] = [];
  const apiReads: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isApi = url.pathname.startsWith("/api/");
    // The homepage reads real configuration once. Record viewers need no API, even without access.
    const allowedHealth = homepage && url.pathname === "/api/health" && request.method() === "GET";
    if (isApi) apiReads.push(`${request.method()} ${url.pathname}`);
    if (url.origin !== origin || request.method() !== "GET" || (isApi && !allowedHealth)) {
      forbidden.push(`${request.method()} ${url.href}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  return { forbidden, apiReads };
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

for (const example of RECORDED_EXAMPLES) {
  test(`real recorded example: ${example.slug} is readable and interactive without API or external requests`, async ({
    page,
    baseURL,
  }) => {
    const payload = recording(example.slug);
    const version = payload.arena.versions.at(-1)!;
    const requests = await watchReadOnlyRequests(page, new URL(baseURL!).origin, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/examples/${example.slug}`);
    await expect(page.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "你想解决什么问题？", exact: true }),
    ).toHaveValue(version.challenge.goal);
    await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
    await page.getByRole("button", { name: "开始分析", exact: true }).click();
    await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(
      page.getByRole("heading", { name: version.verdict!.headline, exact: true }),
    ).toBeHidden();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("heading", { name: version.verdict!.headline, exact: true }),
    ).toBeVisible();
    // The compact mobile header omits the secondary badge; the full replay notice stays visible.
    await expect(page.getByText("真实生成记录 · 回看不调用模型", { exact: true })).toBeVisible();
    await noHorizontalOverflow(page);

    const sourceButton = page.getByRole("button", { name: "原题与记录", exact: true });
    await sourceButton.focus();
    await page.keyboard.press("Enter");
    const source = page.getByRole("dialog", { name: "原题与生成记录", exact: true });
    await expect(source).toBeVisible();
    await expect(source.getByText(example.modelId, { exact: true })).toBeVisible();
    await expect(source.getByText(example.sourceCommit, { exact: true })).toBeVisible();
    await expect(source).toContainText(example.qualityNote);
    await expect(source).toContainText(version.challenge.goal);
    await expect(source).toContainText("回看不会产生新的模型费用");
    await noHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();
    await expect(sourceButton).toBeFocused();

    // Select only versions actually present in the historical record; do not manufacture a rematch.
    const versions = page.getByRole("combobox", { name: "已存版本", exact: true });
    if (payload.arena.versions.length > 1) {
      await expect(versions.locator("option")).toHaveCount(payload.arena.versions.length);
      for (const stored of payload.arena.versions) {
        await versions.selectOption(stored.id);
        await expect(versions).toHaveValue(stored.id);
        await expect(
          page.getByRole("heading", { name: stored.verdict!.headline, exact: true }),
        ).toBeVisible();
      }
      await versions.selectOption(version.id);
    } else {
      await expect(versions).toHaveCount(0);
      await expect(page.getByText(`原记录 V${version.number}`, { exact: true })).toBeVisible();
    }

    // Narrow screens show the current card; choose its step before opening its details.
    await page.getByRole("button", { name: "第 1 步", exact: true }).click();
    await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
      "aria-current",
      "step",
    );
    const cardButton = page.getByRole("button", { name: "查看第 1 步", exact: true });
    await cardButton.focus();
    await page.keyboard.press("Space");
    const card = page.getByRole("dialog", { name: "第 1 步 · 独立提案", exact: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText(version.strategies[0].title);
    await noHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await expect(cardButton).toBeFocused();
    await page.keyboard.press("End");

    const evidenceButton = page
      .getByRole("region", { name: "全部质疑", exact: true })
      .getByRole("button")
      .first();
    await evidenceButton.focus();
    await page.keyboard.press("Enter");
    const evidence = page.getByRole("dialog", { name: "这一条，站得住吗？", exact: true });
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText(version.attacks[0].claimQuote);
    await noHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(evidence).toBeHidden();
    await expect(evidenceButton).toBeFocused();

    await page.getByRole("button", { name: "逐步看", exact: true }).click();
    await expect(page.getByRole("button", { name: "逐步看", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "从头放映", exact: true }).click();
    await page.getByRole("button", { name: "第 1 步", exact: true }).click();
    await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByRole("button", { name: "第 2 步", exact: true })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await page.keyboard.press("End");
    await expect(
      page.getByRole("heading", { name: version.verdict!.headline, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".c-chapter")).toBeHidden();
    await noHorizontalOverflow(page);
    await page.waitForLoadState("networkidle");
    expect(requests.apiReads).toEqual([]);
    expect(requests.forbidden).toEqual([]);
    await page.getByRole("link", { name: "返回示例", exact: true }).click();
    await expect(page).toHaveURL(/\/\?examples=open$/);
    await expect(page.getByRole("dialog", { name: "先看一场真实推演", exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: `播放${example.direction}案例：${example.title}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests.apiReads.every((item) => item === "GET /api/health")).toBe(true);
    expect(requests.forbidden).toEqual([]);
  });
}

test("homepage keeps examples hidden until requested, then opens an input-first real replay", async ({
  page,
  baseURL,
}) => {
  const example = RECORDED_EXAMPLES[0];
  const payload = recording(example.slug);
  const requests = await watchReadOnlyRequests(page, new URL(baseURL!).origin, true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "选择真实案例" })).toHaveCount(0);
  const entry = page.getByRole("button", { name: "先看真实案例", exact: true });
  await entry.focus();
  await page.keyboard.press("Enter");
  const chooser = page.getByRole("dialog", { name: "先看一场真实推演", exact: true });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("link")).toHaveCount(RECORDED_EXAMPLES.length);
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();
  await expect(entry).toBeFocused();
  await entry.click();
  await chooser
    .getByRole("link", { name: `播放${example.direction}案例：${example.title}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/examples/${example.slug}$`));
  await expect(page.getByRole("textbox", { name: "你想解决什么问题？", exact: true })).toHaveValue(
    payload.arena.versions[0].challenge.goal,
  );
  await expect(page.locator(".c-root")).toHaveCount(0);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(
    page.getByRole("heading", { name: payload.arena.versions[0].verdict!.headline, exact: true }),
  ).toBeHidden();
  await page.waitForLoadState("networkidle");
  expect(requests.apiReads.every((item) => item === "GET /api/health")).toBe(true);
  expect(requests.forbidden).toEqual([]);
});

test("real recorded example automatically starts from empty progress and plays every stage to its result", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const payload = recording("learning");
  const requests = await watchReadOnlyRequests(page, new URL(baseURL!).origin);
  await page.goto("/examples/learning");
  await expect(page.getByRole("textbox", { name: "你想解决什么问题？", exact: true })).toHaveValue(
    payload.arena.versions[0].challenge.goal,
  );
  await expect(page.locator(".c-root")).toHaveCount(0);
  await expect(page.locator(".c-root")).toBeVisible({ timeout: 12_000 });
  await expect(
    page.getByRole("heading", { name: payload.arena.versions[0].verdict!.headline, exact: true }),
  ).toBeHidden();
  await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.locator(".c-intro")).toBeHidden();
  for (const step of [2, 4, 7, 10, 13]) {
    await expect(page.getByRole("button", { name: `第 ${step} 步`, exact: true })).toHaveAttribute(
      "aria-current",
      "step",
      { timeout: 20_000 },
    );
  }
  await expect(
    page.getByRole("heading", { name: payload.arena.versions[0].verdict!.headline, exact: true }),
  ).toBeVisible();
  expect(requests.apiReads).toEqual([]);
  expect(requests.forbidden).toEqual([]);
});

test("real recorded example: mobile card return stays over its source without moving the page", async ({
  page,
  baseURL,
}) => {
  const requests = await watchReadOnlyRequests(page, new URL(baseURL!).origin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/examples/learning");
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await page.getByRole("button", { name: "第 1 步", exact: true }).click();
  const trigger = page.getByRole("button", { name: "查看第 1 步", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await trigger.click();
  const card = page.getByRole("dialog", { name: "第 1 步 · 独立提案", exact: true });
  await expect(card).toBeVisible();
  await expect.poll(() => card.locator(".c-pull-face").count()).toBe(0);
  const deckHeight = await page
    .locator(".c-deck")
    .evaluate((node) => node.getBoundingClientRect().height);
  await card.getByRole("button", { name: "收起这张卡片", exact: true }).click();
  const landing = await page.locator(".c-return-proxy").evaluate((node) => {
    // Sample the actual flight near its end so CSS cannot silently override its transform.
    const dialog = document.querySelector<HTMLDialogElement>(".c-pull")!;
    for (const animation of [
      ...dialog.getAnimations({ subtree: true }),
      ...node.getAnimations({ subtree: true }),
    ]) {
      animation.pause();
      animation.currentTime = 459;
    }
    const source = document.querySelector<HTMLElement>('[data-step-source="0"]')!;
    const bounds = node.getBoundingClientRect();
    const sourceBounds = source.getBoundingClientRect();
    return {
      position: getComputedStyle(node).position,
      transform: getComputedStyle(node).transform,
      maxCornerError: Math.max(
        Math.abs(bounds.left - sourceBounds.left),
        Math.abs(bounds.top - sourceBounds.top),
        Math.abs(bounds.right - sourceBounds.right),
        Math.abs(bounds.bottom - sourceBounds.bottom),
      ),
      deckHeight: document.querySelector(".c-deck")!.getBoundingClientRect().height,
    };
  });
  expect(landing.position).toBe("absolute");
  expect(landing.transform).not.toBe("none");
  expect(landing.maxCornerError).toBeLessThan(2);
  expect(Math.abs(landing.deckHeight - deckHeight)).toBeLessThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(card).toBeHidden();
  await expect(page.locator(".c-return-proxy")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await noHorizontalOverflow(page);
  expect(requests.apiReads).toEqual([]);
  expect(requests.forbidden).toEqual([]);
});
