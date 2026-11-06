import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";

test("real career recording: card pages crossfade without replacing visible text or jumping in height", async ({
  page,
  baseURL,
}) => {
  const recording = JSON.parse(
    readFileSync(path.join(process.cwd(), "public/recorded-examples/career.json"), "utf8"),
  ) as RecordedExamplePayload;
  const version = recording.arena.versions.at(-1)!;
  // In this real record, steps 11 and 12 are the saved B and C revisions.
  const title11 = version.revisions[1].summary;
  const title12 = version.revisions[2].summary;
  const forbidden: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin !== new URL(baseURL!).origin ||
      url.pathname.startsWith("/api/") ||
      request.method() !== "GET"
    ) {
      forbidden.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/examples/career");
  const original = page.getByRole("textbox", { name: "你想解决什么问题？", exact: true });
  await expect(original).toHaveValue(version.challenge.goal);
  await expect(original).toHaveJSProperty("readOnly", true);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("group", { name: "推演步骤", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  const trigger = page.getByRole("button", { name: "查看第 11 步", exact: true });
  await trigger.click();
  const card = page.getByRole("dialog");
  const window = card.locator(".c-step-window");
  await expect(card.getByRole("heading", { name: title11, exact: true })).toBeVisible();
  await expect(card.locator(".c-pull-face")).toHaveCount(0);

  // Sample the reading viewport before and throughout a real button click, rather than
  // accepting only the final dimensions after a potentially abrupt replacement.
  const samples = window.evaluate(async (node) => {
    const heights = [node.getBoundingClientRect().height];
    for (let frame = 0; frame < 45; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      heights.push(node.getBoundingClientRect().height);
    }
    return heights;
  });
  await card.getByRole("button", { name: "下一步", exact: true }).click();
  const retiring = card.locator(".c-step-leaving");
  await expect(retiring).toContainText(title11);
  await expect(retiring).toHaveAttribute("aria-hidden", "true");
  await expect(retiring).toHaveJSProperty("inert", true);
  await expect(card.getByRole("heading", { name: title12, exact: true })).toHaveCount(1);
  expect(
    await window.evaluate((node) =>
      node.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"),
    ),
  ).toBe(true);
  const heights = await samples;
  const span = Math.max(...heights) - Math.min(...heights);
  const largestFrameChange = Math.max(
    ...heights.slice(1).map((height, index) => Math.abs(height - heights[index])),
  );
  expect(heights.every((height) => height > 0)).toBe(true);
  // A genuine size change must be distributed over frames; allow subpixel and frame timing noise.
  expect(largestFrameChange).toBeLessThanOrEqual(Math.max(24, span * 0.65));
  await expect(retiring).toHaveCount(0);
  await expect(card.getByRole("heading", { name: title12, exact: true })).toBeVisible();
  await card.getByRole("button", { name: "上一步", exact: true }).click();
  await expect(card.getByRole("heading", { name: title11, exact: true })).toBeVisible();
  await expect(window).not.toHaveClass(/is-paging/);
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(page.locator(".c-return-proxy")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Reverse twice while the preceding page is still moving, then reduce motion mid-transition.
  await trigger.click();
  await expect(card).toBeVisible();
  await expect(card.locator(".c-pull-face")).toHaveCount(0);
  await card.getByRole("button", { name: "下一步", exact: true }).click();
  await card.getByRole("button", { name: "上一步", exact: true }).click();
  await card.getByRole("button", { name: "下一步", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(card.getByRole("heading", { name: title12, exact: true })).toBeVisible();
  await expect(card.locator(".c-step-leaving")).toHaveCount(0);
  await expect(window).not.toHaveClass(/is-paging/);
  await expect
    .poll(() =>
      window.evaluate((node) =>
        node
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
  await card.getByRole("button", { name: "上一步", exact: true }).click();
  await expect(card.getByRole("heading", { name: title11, exact: true })).toBeVisible();
  await expect(card.locator(".c-step-leaving")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.waitForLoadState("networkidle");
  expect(forbidden).toEqual([]);
});
