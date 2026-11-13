import { expect, test, type Page } from "@playwright/test";

// Playback uses saved examples. All API access is intercepted and forbidden.
async function entry(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/examples/personal-website");
  return requests;
}

for (const width of [1440, 390]) {
  test(`holding pause stops auto start before mouse release at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const requests = await entry(page);
    const pause = page.getByRole("button", { name: "暂停自动开始", exact: true });
    await pause.hover();
    const box = await pause.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    const resume = page.getByRole("button", { name: "继续自动开始", exact: true });
    try {
      await expect(resume).toBeVisible();
      await page.waitForTimeout(1800);
      await expect(resume).toBeVisible();
      await expect(page.getByRole("button", { name: "开始回看", exact: true })).toBeVisible();
    } finally {
      await page.mouse.up();
    }
    await expect(resume).toBeVisible();
    await page.waitForTimeout(200);
    await expect(resume).toBeVisible();
    expect(requests).toEqual([]);
  });

  test(`pause toggles once for keyboard and synthetic activation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const requests = await entry(page);
    const pause = page.getByRole("button", { name: "暂停自动开始", exact: true });
    const resume = page.getByRole("button", { name: "继续自动开始", exact: true });
    await pause.click();
    await expect(resume).toBeVisible();
    await resume.focus();
    await page.keyboard.press("Enter");
    await expect(pause).toBeVisible();
    await page.keyboard.press("Space");
    await expect(resume).toBeVisible();
    await resume.evaluate((button: HTMLButtonElement) => button.click());
    await expect(pause).toBeVisible();
    await pause.evaluate((button: HTMLButtonElement) => button.click());
    await expect(resume).toBeVisible();
    await page.waitForTimeout(1800);
    await expect(resume).toBeVisible();
    expect(requests).toEqual([]);
  });
}
