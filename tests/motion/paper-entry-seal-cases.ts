// Explicit visibility-delay fixture over saved real-model simulation records.
import { expect, test as baseTest } from "@playwright/test";
import { readFileSync } from "node:fs";
import { beatsOf } from "../../src/components/console/beats";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";

import { displayTest } from "../display/display-validation";
import {
  expectNativeSealLifecycle,
  installNativeSealProbe,
  readNativeSealProbe,
} from "./native-seal-probe";

export function registerPaperEntrySealTests(mode: "functional" | "display") {
  const test = mode === "display" ? displayTest : baseTest;
  const check = expect.configure({ soft: true });
  const payload = JSON.parse(
    readFileSync("public/recorded-examples/personal-website.json", "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.find(
    (entry) => entry.id === payload.arena.activeVersionId,
  )!;
  const steps = beatsOf(version, payload.replayActions);

  for (const width of [1440, 390]) {
    test(`explicit visibility-delay fixture over saved simulation: input waits for visible A and seal holds at ${width}px`, async ({
      page,
      baseURL,
    }, testInfo) => {
      test.setTimeout(30000);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const forbidden: string[] = [];
      try {
        await page.route("**/*", (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (
            url.origin !== new URL(baseURL!).origin ||
            url.pathname.startsWith("/api/") ||
            request.method() !== "GET"
          ) {
            forbidden.push(`${request.method()} ${url.pathname}`);
            return route.abort();
          }
          return route.continue();
        });
        await page.goto("/examples/personal-website");
        await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
        // Explicit QA visibility delay exercises the waiting branch even when A renders immediately.
        const visibilityDelay = await page.addStyleTag({
          content: '[data-board="A"] .c-board-body { opacity: .5 !important; }',
        });
        await visibilityDelay.evaluate((node) => {
          if (node instanceof Element)
            node.setAttribute("data-entry-seal-visibility-fixture", "true");
        });
        const source = await page.locator(".recorded-entry-form").boundingBox();
        expect(source).not.toBeNull();
        await page.evaluate(() => {
          type Frame = {
            at: number;
            height: number;
            opacity: number;
            transform: string;
            animation: boolean;
            duration: number | string | undefined;
            ready: boolean;
          };
          const state = { frames: [] as Frame[], done: false };
          Object.assign(window, { __entryProbe: state });
          const began = performance.now();
          const tick = () => {
            const paper = document.querySelector<HTMLElement>(".initial-paper-transfer");
            const body = document.querySelector<HTMLElement>('[data-board="A"] .c-board-body');
            const active = document
              .querySelector('.c-time [aria-current="step"]')
              ?.getAttribute("aria-label");
            let visible =
              !!body?.querySelector("h3") && !!body?.querySelector(".est")?.textContent?.trim();
            for (let node = body; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              visible &&=
                style.display !== "none" &&
                style.visibility === "visible" &&
                Number(style.opacity) >= 0.98;
            }
            if (paper) {
              const animation = paper.getAnimations()[0];
              const style = getComputedStyle(paper);
              state.frames.push({
                at: performance.now() - began,
                height: paper.getBoundingClientRect().height,
                opacity: Number(style.opacity),
                transform: style.transform,
                animation: !!animation,
                duration: Number(animation?.effect?.getTiming().duration),
                ready: visible && active === "第 1 步",
              });
            }
            if ((paper || !state.frames.length) && performance.now() - began < 5000)
              requestAnimationFrame(tick);
            else state.done = true;
          };
          requestAnimationFrame(tick);
        });
        await page.getByRole("button", { name: "开始回看", exact: true }).click();
        await page.waitForFunction(() => {
          const probe = (
            window as unknown as {
              __entryProbe: { frames: { ready: boolean; animation: boolean }[] };
            }
          ).__entryProbe;
          return probe.frames.filter((frame) => !frame.ready && !frame.animation).length >= 3;
        });
        await visibilityDelay.evaluate((node) => node.parentNode?.removeChild(node));
        await page.waitForFunction(
          () => (window as unknown as { __entryProbe: { done: boolean } }).__entryProbe.done,
        );
        const entry = await page.evaluate(
          () =>
            (
              window as unknown as {
                __entryProbe: {
                  frames: {
                    at: number;
                    height: number;
                    opacity: number;
                    transform: string;
                    animation: boolean;
                    duration: number;
                    ready: boolean;
                  }[];
                };
              }
            ).__entryProbe.frames,
        );
        await testInfo.attach("initial-input-paper-frames", {
          body: JSON.stringify({ source, entry }),
          contentType: "application/json",
        });
        const held = entry.filter((frame) => !frame.animation);
        const firstFlight = entry.find((frame) => frame.animation);
        check(held.length).toBeGreaterThan(0);
        check(
          held.every(
            (frame) =>
              frame.opacity === 1 &&
              frame.transform === "none" &&
              Math.abs(frame.height - source!.height) < 1,
          ),
        ).toBe(true);
        check(firstFlight?.ready).toBe(true);
        check(firstFlight?.duration).toBe(420);
        await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);

        // This fixture isolates entry visibility and the final seal. Hold the live rail before seeking.
        await page.getByRole("button", { name: "暂停放映", exact: true }).evaluate((button) => {
          if (button instanceof HTMLButtonElement) button.click();
        });
        await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
        await page.getByRole("button", { name: `第 ${steps.length - 1} 步`, exact: true }).click();
        await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
          "aria-label",
          `第 ${steps.length - 1} 步`,
        );
        await installNativeSealProbe(page);
        await page.evaluate(() => {
          const state = {
            frames: [] as {
              at: number;
              opacity: number;
              duration: number | string | undefined;
              currentTime: number | null;
            }[],
            done: false,
          };
          Object.assign(window, { __sealProbe: state });
          const began = performance.now();
          let seen = false;
          const tick = () => {
            const seal = document.querySelector<HTMLElement>(".c-seal");
            if (seal) {
              seen = true;
              const animation = seal.getAnimations()[0];
              state.frames.push({
                at: performance.now() - began,
                opacity: Number(getComputedStyle(seal).opacity),
                duration: Number(animation?.effect?.getTiming().duration),
                currentTime:
                  typeof animation?.currentTime === "number" ? animation.currentTime : null,
              });
            }
            if ((!seen || seal) && performance.now() - began < 14000) requestAnimationFrame(tick);
            else state.done = true;
          };
          requestAnimationFrame(tick);
        });
        await page.getByRole("button", { name: "继续放映", exact: true }).click();
        await expect(page.locator(".c-root")).toHaveClass(/at-result/, { timeout: 15000 });
        await page.waitForFunction(
          () => (window as unknown as { __sealProbe: { done: boolean } }).__sealProbe.done,
        );
        const seal = await page.evaluate(
          () =>
            (
              window as unknown as {
                __sealProbe: {
                  frames: {
                    at: number;
                    opacity: number;
                    duration: number;
                    currentTime: number | null;
                  }[];
                };
              }
            ).__sealProbe.frames,
        );
        await testInfo.attach("clarification-seal-frames", {
          body: JSON.stringify(seal),
          contentType: "application/json",
        });
        if (mode === "display") {
          check(seal.length).toBeGreaterThanOrEqual(8);
          check(seal.filter((frame) => frame.opacity >= 0.98).length).toBeGreaterThanOrEqual(5);
          check(seal.slice(-3).every((frame) => frame.opacity >= 0.98)).toBe(true);
          check(seal.some((frame) => frame.duration === 220)).toBe(true);
        }
        const nativeSeal = await readNativeSealProbe(page);
        await testInfo.attach("clarification-seal-native-lifecycle", {
          body: JSON.stringify(nativeSeal),
          contentType: "application/json",
        });
        expectNativeSealLifecycle(nativeSeal);
        const tag = page.locator('.c-result[data-confirmation="confirmed"] .tag b');
        await check(tag).toHaveText("已确认");
        await check(tag).toHaveCSS("border-top-style", "double");
        await check(tag).toHaveCSS("color", "rgb(200, 51, 31)");
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              let frames = 0;
              const tick = () => (++frames >= 12 ? resolve() : requestAnimationFrame(tick));
              requestAnimationFrame(tick);
            }),
        );
        await check(tag).toHaveCSS("opacity", "1");
      } finally {
        try {
          await page
            .locator("[data-entry-seal-visibility-fixture]")
            .evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
          await readNativeSealProbe(page);
          await check(page.locator(".initial-paper-transfer")).toHaveCount(0);
          await check(page.locator(".c-seal")).toHaveCount(0);
        } finally {
          check(forbidden).toEqual([]);
        }
      }
    });
  }
}
