import { expect, test, type Page } from "@playwright/test";
import { fixtureModels } from "./intake.fixture";

// Explicit health fixtures only. Every mutation is blocked, with no model or external request.
async function installHealthFixture(page: Page, healthDelayMs = 0) {
  const domReady = healthDelayMs
    ? new Promise<void>((resolve) => page.once("domcontentloaded", () => resolve()))
    : Promise.resolve();
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/health") {
      await domReady;
      if (healthDelayMs) await new Promise((resolve) => setTimeout(resolve, healthDelayMs));
      return route.fulfill({
        json: {
          status: "ok",
          version: "mobile-first-paint-ui-fixture",
          model: {
            id: fixtureModels[0].id,
            configured: true,
            promptVersion: "fixture",
            schemaVersion: "fixture",
            models: fixtureModels,
            providers: fixtureModels,
          },
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    }
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected mutation blocked by first-paint fixture" },
    });
  });
}

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
]) {
  test.describe(`mobile first paint ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });
    test("model-ready UI fixture keeps input and primary action in the first viewport through 2000ms after becoming editable", async ({
      page,
    }) => {
      await installHealthFixture(page);
      await page.addInitScript(() => {
        const state = window as typeof window & {
          mobilePaintSamples?: {
            elapsed: number;
            opacity: number;
            hit: boolean;
            inputBottom: number;
            buttonBottom: number;
            scrollY: number;
            width: number;
          }[];
        };
        const seek = () => {
          const input = document.querySelector<HTMLTextAreaElement>(".gi-goal");
          const button = document.querySelector<HTMLButtonElement>(".gi-analyze");
          if (!input || input.disabled || !button) return requestAnimationFrame(seek);
          state.mobilePaintSamples = [];
          const start = performance.now();
          const sample = () => {
            const box = input.getBoundingClientRect();
            const action = button.getBoundingClientRect();
            let opacity = 1;
            for (let parent: Element | null = input; parent; parent = parent.parentElement)
              opacity *= Number(getComputedStyle(parent).opacity);
            state.mobilePaintSamples!.push({
              elapsed: performance.now() - start,
              opacity,
              hit:
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input,
              inputBottom: box.bottom,
              buttonBottom: action.bottom,
              scrollY,
              width: document.documentElement.scrollWidth,
            });
          };
          sample();
          setTimeout(sample, 500);
          setTimeout(sample, 2000);
        };
        requestAnimationFrame(seek);
      });
      await page.goto("/");
      const input = page.getByLabel("你想解决什么问题？", { exact: true });
      await expect(input).toBeEditable();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { mobilePaintSamples?: unknown[] }).mobilePaintSamples
                ?.length,
          ),
        )
        .toBe(3);
      const samples = await page.evaluate(
        () =>
          (
            window as typeof window & {
              mobilePaintSamples: {
                elapsed: number;
                opacity: number;
                hit: boolean;
                inputBottom: number;
                buttonBottom: number;
                scrollY: number;
                width: number;
              }[];
            }
          ).mobilePaintSamples,
      );
      expect(samples[0].elapsed).toBeLessThan(100);
      expect(samples[1].elapsed).toBeGreaterThanOrEqual(450);
      expect(samples[2].elapsed).toBeGreaterThanOrEqual(1900);
      for (const sample of samples) {
        expect(sample.opacity).toBeGreaterThanOrEqual(0.99);
        expect(sample.hit).toBe(true);
        expect(sample.inputBottom).toBeLessThanOrEqual(viewport.height);
        expect(sample.buttonBottom).toBeLessThanOrEqual(viewport.height);
        expect(sample.scrollY).toBe(0);
        expect(sample.width).toBeLessThanOrEqual(viewport.width);
      }
      await input.fill("比较两门课程并决定先学哪门");
      await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "开始分析", exact: true }).click({ trial: true });
      await expect(input).toHaveValue("比较两门课程并决定先学哪门");
    });
    test("slow-health UI fixture displays the disabled core form at DOMContentLoaded, 500ms and 2000ms", async ({
      page,
    }) => {
      await installHealthFixture(page, 3000);
      await page.addInitScript(() => {
        type Sample = {
          elapsed: number;
          inputVisible: boolean;
          buttonVisible: boolean;
          inputDisabled: boolean;
          buttonDisabled: boolean;
          inputTop: number | null;
          inputBottom: number | null;
          buttonBottom: number | null;
          scrollY: number;
        };
        const state = window as typeof window & { slowHealthPaintSamples?: Sample[] };
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            const start = performance.now();
            state.slowHealthPaintSamples = [];
            const visible = (element: HTMLElement | null) => {
              if (!element || !element.getClientRects().length) return false;
              for (
                let ancestor: HTMLElement | null = element;
                ancestor;
                ancestor = ancestor.parentElement
              ) {
                const style = getComputedStyle(ancestor);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity) <= 0
                )
                  return false;
              }
              return true;
            };
            const sample = () => {
              const input = document.querySelector<HTMLTextAreaElement>(".gi-goal");
              const button = document.querySelector<HTMLButtonElement>(".gi-analyze");
              state.slowHealthPaintSamples!.push({
                elapsed: performance.now() - start,
                inputVisible: visible(input),
                buttonVisible: visible(button),
                inputDisabled: input?.disabled ?? false,
                buttonDisabled: button?.disabled ?? false,
                inputTop: input?.getBoundingClientRect().top ?? null,
                inputBottom: input?.getBoundingClientRect().bottom ?? null,
                buttonBottom: button?.getBoundingClientRect().bottom ?? null,
                scrollY,
              });
            };
            // Navigation timing starts here. Missing or disabled controls do not postpone this sample.
            sample();
            setTimeout(sample, 500);
            setTimeout(sample, 2000);
          },
          { once: true },
        );
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { slowHealthPaintSamples?: unknown[] })
                .slowHealthPaintSamples?.length,
          ),
        )
        .toBe(3);
      const samples = await page.evaluate(
        () =>
          (
            window as typeof window & {
              slowHealthPaintSamples: {
                elapsed: number;
                inputVisible: boolean;
                buttonVisible: boolean;
                inputDisabled: boolean;
                buttonDisabled: boolean;
                inputTop: number | null;
                inputBottom: number | null;
                buttonBottom: number | null;
                scrollY: number;
              }[];
            }
          ).slowHealthPaintSamples,
      );
      expect(samples[0].elapsed).toBeLessThan(100);
      expect(samples[1].elapsed).toBeGreaterThanOrEqual(450);
      expect(samples[2].elapsed).toBeGreaterThanOrEqual(1900);
      for (const sample of samples) {
        expect(sample.inputVisible).toBe(true);
        // The primary action waits for text on the home page.
        expect(sample.buttonVisible).toBe(false);
        expect(sample.inputDisabled).toBe(true);
        expect(sample.buttonDisabled).toBe(true);
        expect(sample.inputTop).toBeGreaterThanOrEqual(0);
        expect(sample.inputBottom).toBeLessThanOrEqual(viewport.height);
        expect(sample.buttonBottom).toBeLessThanOrEqual(viewport.height);
        expect(sample.scrollY).toBe(0);
      }
      const input = page.getByLabel("你想解决什么问题？", { exact: true });
      await expect(input).toBeEditable();
      await input.fill("服务连接恢复后选择一门入门课程");
      const button = page.getByRole("button", { name: "开始分析", exact: true });
      await expect(button).toBeEnabled();
      await button.click({ trial: true });
      await expect(input).toHaveValue("服务连接恢复后选择一门入门课程");
    });
    test("explicit UI fixture remains visible after focus restoration and reduced-motion changes", async ({
      page,
    }) => {
      await installHealthFixture(page);
      await page.goto("/");
      const input = page.getByLabel("你想解决什么问题？", { exact: true });
      await expect(input).toBeEditable();
      await page.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.locator(".g-focus-stage")).toHaveAttribute("data-motion", "reduced");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect(page.locator(".g-focus-stage")).toHaveAttribute("data-motion", "full");
      const state = await page.locator(".g-focus-input-wrapper").evaluate((element) => ({
        opacity: getComputedStyle(element).opacity,
        transform: getComputedStyle(element).transform,
        animations: element.getAnimations().filter((animation) => animation.playState === "running")
          .length,
      }));
      expect(state).toEqual({ opacity: "1", transform: "none", animations: 0 });
      await input.fill("窗口切回后继续输入目标");
      await expect(input).toHaveValue("窗口切回后继续输入目标");
    });
  });
}
