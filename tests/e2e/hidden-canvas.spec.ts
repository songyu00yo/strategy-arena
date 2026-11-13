import { expect, test } from "@playwright/test";
import { fixtureModels } from "./intake.fixture";

// Explicit UI fixtures. This measures unused hidden work, independently of visible frame pacing.
test("hidden homepage canvas stays idle while the original input remains visible and focusable", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const unexpected: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          requiresAccessCode: false,
          accessGranted: true,
          model: { configured: true, models: fixtureModels, providers: fixtureModels },
        },
      });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "b".repeat(64), hasRecoveryCode: false } });
    unexpected.push(`${route.request().method()} ${path}`);
    return route.abort();
  });
  await page.addInitScript(() => {
    const counts = { clears: 0 };
    Object.assign(window, { __hiddenCanvasCounts: counts });
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.classList.contains("g-focus-field")) counts.clears++;
      return clear.apply(this, args);
    };
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    await page.bringToFront();
    const input = page.getByRole("textbox", { name: "你想做什么", exact: true });
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await page.waitForTimeout(5000);
    await input.click();
    await expect(input).toBeFocused();
    const observation = await page.evaluate(() => {
      const surface = document.querySelector<HTMLCanvasElement>(".g-focus-field")!;
      const paper = document.querySelector<HTMLElement>(".g-focus-input-wrapper")!;
      return {
        counts: (window as unknown as { __hiddenCanvasCounts: { clears: number } })
          .__hiddenCanvasCounts,
        display: getComputedStyle(surface).display,
        paperOpacity: Number(getComputedStyle(paper).opacity),
        viewport: [innerWidth, innerHeight],
      };
    });
    await info.attach(`hidden-canvas-${width}`, {
      body: JSON.stringify({ classification: "hidden-work-regression", observation }),
      contentType: "application/json",
    });
    expect(observation.display).toBe("none");
    expect(observation.counts).toEqual({ clears: 0 });
    expect(observation.paperOpacity).toBeGreaterThanOrEqual(0.99);
  }
  expect(unexpected).toEqual([]);
});
