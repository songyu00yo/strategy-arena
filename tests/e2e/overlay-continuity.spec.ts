// Saved real-model simulation record with explicit health fixtures. No model providers are contacted.
import { expect, test, type Page } from "@playwright/test";

async function openDetail(page: Page) {
  const unexpected: string[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          model: { configured: false, models: [], providers: [], tools: {} },
          accessGranted: true,
        },
      });
    unexpected.push(request.method() + " " + path);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/examples/personal-website");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.getByRole("button", { name: "第 1 步", exact: true }).click();
  await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);
  await page.getByRole("button", { name: "查看第 1 步", exact: true }).click();
  await expect(page.locator(".c-pull")).toBeVisible();
  return unexpected;
}

async function beginProbe(page: Page) {
  await page.evaluate(() => {
    const state = {
      frames: [] as Array<{
        at: number;
        dialogs: Array<{
          name: string;
          phase: string;
          opacity: number;
          x: number;
          y: number;
          width: number;
          height: number;
          snapshot: boolean;
        }>;
        held: boolean;
        scrollY: number;
      }>,
      id: 0,
    };
    Object.assign(window, { __overlayProbe: state });
    const tick = (at: number) => {
      const dialogs = [...document.querySelectorAll<HTMLElement>("dialog[open]")].map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          name: node.getAttribute("aria-label") || node.querySelector("h2")?.textContent || "",
          phase: node.dataset.overlayMotionPhase ?? "settled",
          opacity: Number(style.opacity),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          snapshot: !!node.querySelector(".overlay-handoff-snapshot"),
        };
      });
      state.frames.push({
        at,
        dialogs,
        held: document.querySelector(".c-root")?.classList.contains("held") ?? false,
        scrollY,
      });
      state.id = requestAnimationFrame(tick);
    };
    state.id = requestAnimationFrame(tick);
  });
}
async function endProbe(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __overlayProbe: {
          frames: Array<{
            at: number;
            dialogs: Array<{
              name: string;
              phase: string;
              opacity: number;
              x: number;
              y: number;
              width: number;
              height: number;
              snapshot: boolean;
            }>;
            held: boolean;
            scrollY: number;
          }>;
          id: number;
        };
      }
    ).__overlayProbe;
    cancelAnimationFrame(state.id);
    return state.frames;
  });
}

for (const width of [1440, 390]) {
  for (let round = 1; round <= 3; round++) {
    test(`normal interaction: one paper hands detail to supplement and conditions at ${width}px, round ${round}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const unexpected = await openDetail(page);
      await page.waitForTimeout(380);
      await beginProbe(page);
      await page
        .locator(".c-pull")
        .getByRole("button", { name: "补充或质疑", exact: true })
        .click();
      const supplement = page.getByRole("dialog", { name: "补充这一步", exact: true });
      await expect(supplement).toBeVisible();
      await expect(supplement).toHaveAttribute("data-overlay-motion-phase", "handoff");
      await page.waitForTimeout(460);
      await expect(supplement.locator(".overlay-handoff-snapshot")).toHaveCount(0);
      await supplement
        .getByRole("textbox", { name: "你想补充或询问什么？", exact: true })
        .fill("【测试替身输入】检查连续交接并保留草稿。");
      await supplement.getByRole("button", { name: "调整条件", exact: true }).click();
      const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
      await expect(conditions).toHaveAttribute("data-overlay-motion-phase", "handoff");
      await page.waitForTimeout(460);
      const frames = await endProbe(page);
      await info.attach("continuous-overlay-frames", {
        body: JSON.stringify(frames),
        contentType: "application/json",
      });
      expect(frames.length).toBeGreaterThan(20);
      expect(frames.every((frame) => frame.held)).toBe(true);
      expect(frames.every((frame) => frame.dialogs.some((dialog) => dialog.opacity > 0.02))).toBe(
        true,
      );
      expect(
        frames.some((frame) =>
          frame.dialogs.some((dialog) => dialog.phase === "handoff" && dialog.snapshot),
        ),
      ).toBe(true);
      const boundaries = frames.flatMap((frame, index) => {
        if (!index) return [];
        const current = frame.dialogs.find((dialog) => dialog.phase === "handoff");
        const previous = frames[index - 1].dialogs.at(-1);
        return current && previous && previous.name !== current.name ? [{ current, previous }] : [];
      });
      expect(boundaries).toHaveLength(2);
      for (const { current, previous } of boundaries)
        for (const key of ["x", "y", "width", "height"] as const)
          expect(Math.abs(current[key] - previous[key])).toBeLessThanOrEqual(1);
      const movingIntervals = frames
        .flatMap((frame, index) =>
          index &&
          frame.dialogs.some((dialog) => dialog.phase === "handoff") &&
          frames[index - 1].dialogs.some((dialog) => dialog.phase === "handoff")
            ? [frame.at - frames[index - 1].at]
            : [],
        )
        .sort((a, b) => a - b);
      expect(movingIntervals.length).toBeGreaterThan(10);
      expect(movingIntervals[Math.floor(movingIntervals.length * 0.95)]).toBeLessThanOrEqual(20);
      expect(Math.max(...movingIntervals)).toBeLessThanOrEqual(50);
      await conditions.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page.locator(".c-root")).not.toHaveClass(/held/);
      expect(unexpected).toEqual([]);
    });
  }
}
