// Saved real-model simulation data. All API requests are blocked, with no provider calls.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { beatsOf } from "../../src/components/console/beats";
import { playbackDuration } from "../../src/components/console/use-playback-progress";

const payload = JSON.parse(
  readFileSync("public/recorded-examples/personal-website.json", "utf8"),
) as RecordedExamplePayload;
const version = payload.arena.versions.find((entry) => entry.id === payload.arena.activeVersionId)!;
const steps = beatsOf(version, payload.replayActions);
const questionIndex = steps.findIndex(
  (step) => step.replayAction?.kind === "questions" && step.replayAction.round === 2,
);

async function playQuestion(page: Page) {
  const blocked: string[] = [];
  await page.route("**/api/**", (route) => {
    blocked.push(route.request().method() + " " + new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/examples/personal-website");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.getByRole("button", { name: `第 ${questionIndex} 步`, exact: true }).click();
  await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);
  const speed = page.getByRole("button", { name: "放映速度", exact: true });
  await speed.click();
  await speed.click();
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
    "aria-label",
    `第 ${questionIndex + 1} 步`,
  );
  return blocked;
}

for (const width of [1440, 390]) {
  test(`paper theater: scrolling uses continuous frames at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const blocked = await playQuestion(page);
    const sample = await page.evaluate(
      (targetStep) =>
        new Promise<{
          gaps: number[];
          frameGaps: number[];
          phases: string[];
          maxPositionError: number;
        }>((resolve) => {
          const start = performance.now();
          let previousFrame = start;
          let previousScroll = start;
          let previousTop: number | undefined;
          let previousTravel = false;
          let maxPositionError = 0;
          const phases = new Set<string>();
          const gaps: number[] = [];
          const frameGaps: number[] = [];
          const tick = (time: number) => {
            frameGaps.push(time - previousFrame);
            previousFrame = time;
            const body = document.querySelector<HTMLElement>(".replay-question-body");
            const top = body?.scrollTop;
            const selected = document
              .querySelector('.c-time [aria-current="step"]')
              ?.getAttribute("aria-label");
            const active = selected === `第 ${targetStep} 步`;
            const phase = active ? (body?.dataset.scrollPhase ?? "unmarked") : "outside";
            phases.add(phase);
            const travel = phase === "travel";
            if (travel && body) {
              maxPositionError = Math.max(
                maxPositionError,
                Math.abs(body.scrollTop - Number(body.dataset.scrollTarget)),
              );
            }
            if (
              travel &&
              previousTravel &&
              top !== undefined &&
              previousTop !== undefined &&
              Math.abs(top - previousTop) >= 0.1
            ) {
              gaps.push(time - previousScroll);
              previousScroll = time;
            }
            if (!travel || !previousTravel) previousScroll = time;
            previousTravel = travel;
            previousTop = top;
            if (time - start < 4600) requestAnimationFrame(tick);
            else resolve({ gaps, frameGaps, phases: [...phases], maxPositionError });
          };
          requestAnimationFrame(tick);
        }),
      questionIndex + 1,
    );
    const sorted = sample.gaps.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    await testInfo.attach("continuous-scroll-frames", {
      body: JSON.stringify({ width, p95, ...sample }),
      contentType: "application/json",
    });
    expect(sample.phases).toContain("reading");
    expect(sample.phases).toContain("travel");
    expect(sample.gaps.length).toBeGreaterThanOrEqual(24);
    // WebKit timestamps are integer milliseconds. Allow 1ms measurement rounding.
    expect(p95).toBeLessThanOrEqual(34.4);
    expect(sample.maxPositionError).toBeLessThanOrEqual(1);
    expect(blocked).toEqual([]);
  });
}

test("paper theater: foreground playback leaves background settled and pause keeps its exact pose", async ({
  page,
}) => {
  const blocked = await playQuestion(page);
  await page.waitForTimeout(700);
  const stage = page.locator(".c-stage3");
  await expect(stage).toHaveAttribute("data-background-motion", "held");
  const pose = () =>
    page.locator(".c-rig, .c-world, .c-board").evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return [style.transform, style.translate, style.rotate];
      }),
    );
  const first = await pose();
  await page.waitForTimeout(700);
  expect(await pose()).toEqual(first);
  await page.getByRole("button", { name: "暂停放映", exact: true }).evaluate((node) => {
    if (node instanceof HTMLButtonElement) node.click();
  });
  const progress = await page.locator(".c-root").getAttribute("data-replay-progress");
  const scroll = await page.locator(".replay-question-body").evaluate((node) => node.scrollTop);
  await page.waitForTimeout(400);
  await expect(page.locator(".c-root")).toHaveAttribute("data-replay-progress", progress!);
  expect(await page.locator(".replay-question-body").evaluate((node) => node.scrollTop)).toBe(
    scroll,
  );
  expect(blocked).toEqual([]);
});

test("paper theater: an explicitly injected frame delay keeps active playback time accurate", async ({
  page,
}) => {
  const blocked = await playQuestion(page);
  const sample = await page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>(".c-root")!;
    const before = { at: performance.now(), progress: Number(root.dataset.replayProgress) };
    // This synthetic 180ms task tests the playback clock, not normal rendering performance.
    const until = performance.now() + 180;
    while (performance.now() < until) {
      /* Deliberate browser-test load. */
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return {
      before,
      after: { at: performance.now(), progress: Number(root.dataset.replayProgress) },
    };
  });
  const activeTime =
    (sample.after.progress - sample.before.progress) * playbackDuration(steps[questionIndex]);
  expect(activeTime).toBeGreaterThanOrEqual((sample.after.at - sample.before.at) * 1.8 * 0.8);
  expect(blocked).toEqual([]);
});

test("paper theater: the mobile conclusion seal stays inside the viewport throughout its visible press", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const blocked: string[] = [];
  await page.route("**/api/**", (route) => {
    blocked.push(route.request().method() + " " + new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.goto("/examples/personal-website");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.getByRole("button", { name: `第 ${steps.length - 1} 步`, exact: true }).click();
  await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);
  const sampling = page.evaluate(
    () =>
      new Promise<{
        frames: Array<{
          at: number;
          opacity: number;
          left: number;
          top: number;
          right: number;
          bottom: number;
        }>;
        width: number;
        height: number;
      }>((resolve) => {
        const frames: Array<{
          at: number;
          opacity: number;
          left: number;
          top: number;
          right: number;
          bottom: number;
        }> = [];
        const began = performance.now();
        let seen = false;
        const tick = () => {
          const seal = document.querySelector<HTMLElement>(".c-seal");
          if (seal) {
            seen = true;
            const rect = seal.getBoundingClientRect();
            frames.push({
              at: performance.now() - began,
              opacity: Number(getComputedStyle(seal).opacity),
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            });
          }
          if ((!seen || seal) && performance.now() - began < 14000) requestAnimationFrame(tick);
          else resolve({ frames, width: innerWidth, height: innerHeight });
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  const sample = await sampling;
  await testInfo.attach("mobile-conclusion-seal-frames", {
    body: JSON.stringify(sample),
    contentType: "application/json",
  });
  const visible = sample.frames.filter((frame) => frame.opacity > 0.6);
  expect(visible.length).toBeGreaterThanOrEqual(3);
  for (const frame of visible) {
    expect(frame.left).toBeGreaterThanOrEqual(0);
    expect(frame.top).toBeGreaterThanOrEqual(0);
    expect(frame.right).toBeLessThanOrEqual(sample.width);
    expect(frame.bottom).toBeLessThanOrEqual(sample.height);
  }
  await expect(page.locator(".c-root")).toHaveClass(/at-result/);
  expect(blocked).toEqual([]);
});
