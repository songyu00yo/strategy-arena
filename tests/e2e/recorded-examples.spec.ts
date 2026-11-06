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
    const requests = await watchReadOnlyRequests(page, new URL(baseURL!).origin);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/examples/${example.slug}`);
    await expect(page.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: version.verdict!.headline, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("只读回看", { exact: true })).toBeVisible();
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

    const cardButton = page.getByRole("button", { name: "查看第 1 步", exact: true });
    await cardButton.focus();
    await page.keyboard.press("Space");
    const card = page.getByRole("dialog", { name: "第 1 步 · 独立提案", exact: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText(version.strategies[0].title);
    await noHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();

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
    await expect(page).toHaveURL(/\/examples$/);
    await expect(
      page.getByRole("button", {
        name: `预览${example.direction}示例：${example.title}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests.apiReads).toEqual([]);
    expect(requests.forbidden).toEqual([]);
  });
}

test("homepage opens a real recorded preview and its full local replay", async ({
  page,
  baseURL,
}) => {
  const example = RECORDED_EXAMPLES[0];
  const payload = recording(example.slug);
  const requests = await watchReadOnlyRequests(page, new URL(baseURL!).origin, true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const entry = page.getByRole("button", {
    name: `预览${example.direction}示例：${example.title}`,
    exact: true,
  });
  await entry.focus();
  await page.keyboard.press("Enter");
  const preview = page.getByRole("dialog", { name: example.title, exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(payload.arena.versions.at(-1)!.verdict!.headline);
  await preview.getByRole("button", { name: "来源与适用范围", exact: true }).click();
  await expect(
    preview.getByText("示例问题为预设，方案来自真实模型。", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(entry).toBeFocused();
  await entry.click();
  await preview.getByRole("link", { name: "回看完整推演", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/examples/${example.slug}$`));
  await expect(page.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(requests.apiReads.every((item) => item === "GET /api/health")).toBe(true);
  expect(requests.forbidden).toEqual([]);
});
