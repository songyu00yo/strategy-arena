// Actual browser wheel/touch input with an explicit health fixture. No model requests are made.
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function position(page: Page) {
  return page.evaluate(() => ({
    y: scrollY,
    max: document.documentElement.scrollHeight - innerHeight,
    overflow: document.body.style.overflow,
    dialogs: document.querySelectorAll("dialog[open]").length,
    phase:
      document.querySelector<HTMLElement>("dialog[open].overlay-motion")?.dataset
        .overlayMotionPhase ?? null,
  }));
}

async function wheel(page: Page) {
  const before = await position(page);
  const direction = before.y > before.max / 2 ? -1 : 1;
  await page.mouse.move(2, 2);
  await page.mouse.wheel(0, direction * 180);
  await page.waitForTimeout(180);
  return { before, after: await position(page), direction };
}

async function touch(page: Page) {
  const before = await position(page);
  const direction = before.y > before.max / 2 ? -1 : 1;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 2, y: 420, radiusX: 2, radiusY: 2, force: 1 }],
  });
  for (let step = 1; step <= 6; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 2, y: 420 - direction * step * 20, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(180);
  return { before, after: await position(page), direction };
}

test("real wheel and touch keep the mobile page still through detail-to-supplement and restore scrolling on close", async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== "chromium", "Native touch gestures use the Chromium input channel.");
  const unexpected: string[] = [];
  page.on("pageerror", (error) => unexpected.push(error.message));
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          model: { configured: false, models: [], providers: [], tools: {} },
          accessGranted: true,
        },
      });
    unexpected.push(route.request().method() + " " + new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const inputs: unknown[] = [];
    Object.assign(window, { __stepScrollInputs: inputs });
    for (const type of ["wheel", "touchstart", "touchmove", "touchend"])
      document.addEventListener(
        type,
        (event) =>
          inputs.push({
            type,
            trusted: event.isTrusted,
            y: scrollY,
            target: event.target instanceof Element ? event.target.tagName : null,
          }),
        { capture: true, passive: true },
      );
  });
  await page.goto("/examples/personal-website");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.getByRole("button", { name: "第 1 步", exact: true }).click();
  await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);
  await page.getByRole("button", { name: "查看第 1 步", exact: true }).click();
  const detail = page.locator(".c-pull");
  await expect(detail).toBeVisible();
  await page.waitForTimeout(400);
  const initial = await position(page);
  const detailWheel = await wheel(page);
  const detailTouch = await touch(page);
  await detail.getByRole("button", { name: "补充或质疑", exact: true }).click();
  const supplement = page.getByRole("dialog", { name: "补充这一步", exact: true });
  await expect(supplement).toBeVisible();
  await page.evaluate(() => {
    const state = {
      frames: [] as Array<{ y: number; overflow: string; dialogs: number; phase: string | null }>,
      id: 0,
    };
    Object.assign(window, { __stepScrollFrames: state });
    const tick = () => {
      state.frames.push({
        y: scrollY,
        overflow: document.body.style.overflow,
        dialogs: document.querySelectorAll("dialog[open]").length,
        phase:
          document.querySelector<HTMLElement>("dialog[open].overlay-motion")?.dataset
            .overlayMotionPhase ?? null,
      });
      state.id = requestAnimationFrame(tick);
    };
    state.id = requestAnimationFrame(tick);
  });
  const handoffWheel = await wheel(page);
  const handoffTouch = await touch(page);
  await expect(supplement).not.toHaveAttribute("data-overlay-motion-active", "true");
  const frames = await page.evaluate(() => {
    const state = (window as unknown as { __stepScrollFrames: { frames: unknown[]; id: number } })
      .__stepScrollFrames;
    cancelAnimationFrame(state.id);
    return state.frames;
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const afterClose = await position(page);
  const restoredWheel = await wheel(page);
  const restoredTouch = await touch(page);
  const inputs = await page.evaluate(
    () =>
      (window as unknown as { __stepScrollInputs: Array<{ type: string; trusted: boolean }> })
        .__stepScrollInputs,
  );
  await info.attach("native-mobile-scroll-lock", {
    body: JSON.stringify({
      initial,
      detailWheel,
      detailTouch,
      handoffWheel,
      handoffTouch,
      frames,
      afterClose,
      restoredWheel,
      restoredTouch,
      inputs,
      unexpected,
    }),
    contentType: "application/json",
  });
  expect(initial.max).toBeGreaterThan(100);
  for (const sample of [detailWheel, detailTouch, handoffWheel, handoffTouch]) {
    expect(sample.before.dialogs).toBe(1);
    expect(sample.after.dialogs).toBe(1);
    expect(Math.abs(sample.after.y - sample.before.y)).toBeLessThanOrEqual(1);
  }
  expect(
    (frames as Array<{ overflow: string }>).every((frame) => frame.overflow === "hidden"),
  ).toBe(true);
  expect(afterClose.overflow).toBe("");
  expect(Math.abs(restoredWheel.after.y - restoredWheel.before.y)).toBeGreaterThan(1);
  expect(Math.abs(restoredTouch.after.y - restoredTouch.before.y)).toBeGreaterThan(1);
  expect(inputs.filter((input) => input.type === "wheel").length).toBeGreaterThanOrEqual(3);
  expect(inputs.filter((input) => input.type === "touchstart").length).toBeGreaterThanOrEqual(3);
  expect(inputs.every((input) => input.trusted)).toBe(true);
  expect(unexpected).toEqual([]);
});
