import { expect, test } from "@playwright/test";
import { MODEL_CATALOG } from "../../src/lib/model-catalog";
import { advanceFixture, fixtureSnapshot } from "./ui.fixture";
import { configureFixtureModels } from "./intake.fixture";

// Synthetic UI fixtures only. No model request is allowed through this browser routing layer.
test.beforeEach(async ({ page }) => {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  for (let i = 0; i < 5; i++) advanceFixture(snapshot);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-ui-fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (path.startsWith("/api/arenas/") && route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected mutation blocked by model picker fixture" },
    });
  });
});

test("explicit UI fixture: floating picker keeps form geometry, arrows only focus, reverses smoothly and tracks a resized viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /^选择模型，当前/ });
  await expect(trigger).toBeEnabled();
  // Resize the goal as a real user can, forcing a menu above the source with limited height.
  const textarea = await page.getByLabel("你想解决什么问题？", { exact: true }).boundingBox();
  await page.mouse.move(textarea!.x + textarea!.width - 4, textarea!.y + textarea!.height - 4);
  await page.mouse.down();
  await page.mouse.move(textarea!.x + textarea!.width - 4, textarea!.y + textarea!.height + 106, {
    steps: 8,
  });
  await page.mouse.up();
  expect((await trigger.boundingBox())!.y).toBeGreaterThan(360);
  await trigger.click();
  const popup = page.locator('[popover="manual"]');
  const reasonToggle = page.getByRole("button", { name: "查看选择依据", exact: true });
  const pageScroll = await page.evaluate(() => scrollY);
  await reasonToggle.click();
  await page.waitForTimeout(650);
  const reasonId = await reasonToggle.getAttribute("aria-controls");
  const reasonText = page.locator(`[id="${reasonId}"] p`);
  const reasonBox = await reasonText.boundingBox();
  const popupBox = await popup.boundingBox();
  expect(reasonBox!.y).toBeGreaterThanOrEqual(popupBox!.y + 6);
  expect(reasonBox!.y + reasonBox!.height).toBeLessThanOrEqual(popupBox!.y + popupBox!.height - 6);
  expect(await page.evaluate(() => scrollY)).toBe(pageScroll);
  await reasonToggle.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(false);
  await expect.poll(() => popup.evaluate((node) => node.matches(":popover-open"))).toBe(false);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  const composer = page.locator(".gi-composer");
  const before = await composer.boundingBox();
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const listbox = page.getByRole("listbox", { name: "本轮使用的模型" });
  await expect(listbox).toBeVisible();
  await expect(
    page.getByRole("option", { name: MODEL_CATALOG[0].label, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: MODEL_CATALOG[1].label, exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("option", { name: MODEL_CATALOG[0].label, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(trigger).toHaveAccessibleName(`选择模型，当前${MODEL_CATALOG[0].label}`);
  const during = await composer.boundingBox();
  expect(Math.abs(during!.height - before!.height)).toBeLessThan(1);
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: MODEL_CATALOG.at(-1)!.label, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Space");
  await expect(trigger).toHaveAccessibleName(`选择模型，当前${MODEL_CATALOG.at(-1)!.label}`);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Reverse an unfinished close from its current visible pose, then resize during the new entrance.
  await trigger.click({ force: true });
  await page.waitForTimeout(80);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(listbox).toBeVisible();
  await page.waitForTimeout(650);
  const bounds = await listbox.locator("..").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(10);
  expect(bounds!.y).toBeGreaterThanOrEqual(10);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(380);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(834);
  const goal = page.getByLabel("你想解决什么问题？", { exact: true });
  // The centered mobile composer is behind the picker. Click its exposed left padding.
  await goal.click({ position: { x: 8, y: 16 } });
  await expect(listbox).toBeHidden();
  await expect(goal).toBeFocused();
  await trigger.click();
  await page.waitForTimeout(80);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      listbox
        .locator("..")
        .evaluate(
          (node) =>
            node
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === "running").length,
        ),
    )
    .toBe(0);
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect.poll(() => popup.evaluate((node) => node.matches(":popover-open"))).toBe(false);
  await expect(trigger).toBeFocused();
});

test("explicit UI fixture: picker stays in the modal focus boundary and Escape returns to its source before closing the modal", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("strategy-arena:last-id", "fixture-arena");
    sessionStorage.setItem("arena-intro", "1");
  });
  await page.goto("/");
  await expect(page.locator(".c-root")).toBeVisible();
  await page.getByRole("button", { name: "修改条件再开局", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "修改条件，重新开局" });
  const trigger = modal.getByRole("button", { name: /^选择模型，当前/ });
  await trigger.click();
  const listbox = modal.getByRole("listbox", { name: "本轮使用的模型" });
  await expect(listbox).toBeVisible();
  expect(await listbox.evaluate((node) => !!node.closest("dialog"))).toBe(true);
  await page.keyboard.press("End");
  expect(await listbox.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect
    .poll(() =>
      modal.locator('[popover="manual"]').evaluate((node) => node.matches(":popover-open")),
    )
    .toBe(false);
  await expect(modal).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page.locator(":popover-open")).toHaveCount(0);
});
