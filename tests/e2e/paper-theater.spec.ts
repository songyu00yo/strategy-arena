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

async function openReplay(page: Page) {
  const blocked: string[] = [];
  await page.route("**/api/**", (route) => {
    blocked.push(route.request().method() + " " + new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/examples/personal-website");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);
  return blocked;
}

async function playQuestion(page: Page) {
  const blocked = await openReplay(page);
  await page.getByRole("button", { name: `第 ${questionIndex} 步`, exact: true }).click();
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
    "aria-label",
    `第 ${questionIndex + 1} 步`,
  );
  return blocked;
}

for (const width of [1440, 390]) {
  for (const kind of ["round_confirm", "handoff"] as const) {
    test(`paper theater: ${kind} returns in one continuous motion at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const blocked = await openReplay(page);
      const index = steps.findIndex(
        (step, at) =>
          step.replayAction?.kind === kind &&
          (kind === "handoff" || !!steps[at + 1]?.clarificationRun),
      );
      expect(index).toBeGreaterThan(0);
      await page.getByRole("button", { name: `第 ${index} 步`, exact: true }).click();
      const sampling = page.evaluate(
        (targetStep) =>
          new Promise<{
            frames: Array<{
              at: number;
              fold: number;
              x: number;
              y: number;
              sx: number;
              sy: number;
              owner: string;
              opacity: number;
              portalX: number | null;
              portalY: number | null;
            }>;
            portalCreatedAt: number[];
          }>((resolve) => {
            const frames: Array<{
              at: number;
              fold: number;
              x: number;
              y: number;
              sx: number;
              sy: number;
              owner: string;
              opacity: number;
              portalX: number | null;
              portalY: number | null;
            }> = [];
            const portalCreatedAt: number[] = [];
            let seen = false;
            const began = performance.now();
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                for (const node of record.addedNodes) {
                  if (
                    node instanceof HTMLElement &&
                    (node.matches(".replay-handoff-strip") ||
                      node.querySelector(".replay-handoff-strip"))
                  ) {
                    const paper = document.querySelector<HTMLElement>(".replay-question-scene");
                    portalCreatedAt.push(Number(paper?.dataset.replayFold ?? 0));
                  }
                }
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            const tick = (time: number) => {
              const selected = document
                .querySelector('.c-time [aria-current="step"]')
                ?.getAttribute("aria-label");
              const active = selected === `第 ${targetStep} 步`;
              const paper = document.querySelector<HTMLElement>(".replay-question-scene");
              if (active && paper) {
                seen = true;
                const pose = new DOMMatrixReadOnly(getComputedStyle(paper).transform);
                const portal = document.querySelector<HTMLElement>(".replay-handoff-strip");
                const portalPose = portal
                  ? new DOMMatrixReadOnly(getComputedStyle(portal).transform)
                  : null;
                frames.push({
                  at: time,
                  fold: Number(paper.dataset.replayFold),
                  x: pose.m41,
                  y: pose.m42,
                  sx: pose.m11,
                  sy: pose.m22,
                  owner: paper.dataset.stripOwner ?? "local",
                  opacity: Number(getComputedStyle(paper).opacity),
                  portalX: portalPose?.m41 ?? null,
                  portalY: portalPose?.m42 ?? null,
                });
              }
              if ((!seen || (active && paper)) && time - began < 10000) requestAnimationFrame(tick);
              else {
                observer.disconnect();
                resolve({ frames, portalCreatedAt });
              }
            };
            requestAnimationFrame(tick);
          }),
        index + 1,
      );
      await page.getByRole("button", { name: "继续放映", exact: true }).click();
      const sample = await sampling;
      await testInfo.attach(`continuous-${kind}-frames-${width}`, {
        body: JSON.stringify(sample),
        contentType: "application/json",
      });
      const returning = sample.frames.filter((frame) => frame.fold > 0 && frame.fold < 1);
      expect(returning.length).toBeGreaterThanOrEqual(8);
      expect(returning[0].fold).toBeLessThan(0.2);
      expect(returning.at(-1)!.fold).toBeGreaterThan(0.85);
      const reference = returning.find((frame) => frame.fold >= 0.45 && frame.fold <= 0.65)!;
      expect(reference).toBeDefined();
      const smooth = (value: number) => value * value * (3 - 2 * value);
      const referenceAmount = smooth(reference.fold);
      const distance = Math.hypot(reference.x, reference.y) / referenceAmount;
      expect(distance).toBeGreaterThan(20);
      const early = returning.find((frame) => frame.fold >= 0.15 && frame.fold < 0.35);
      expect(early).toBeDefined();
      expect(Math.hypot(early!.x, early!.y)).toBeGreaterThan(distance * 0.05);
      const gaps: number[] = [];
      for (let at = 0; at < returning.length; at++) {
        const frame = returning[at];
        const amount = smooth(frame.fold);
        // data-replay-fold is rounded to .001, while transforms retain full precision.
        expect(Math.abs(frame.x - (reference.x * amount) / referenceAmount)).toBeLessThan(
          distance * 0.004,
        );
        expect(Math.abs(frame.y - (reference.y * amount) / referenceAmount)).toBeLessThan(
          distance * 0.004,
        );
        expect(Math.abs(frame.sx - frame.sy)).toBeLessThan(0.001);
        if (frame.owner === "body") {
          expect(frame.portalX).not.toBeNull();
          expect(frame.portalY).not.toBeNull();
          expect(Math.abs(frame.portalX! - frame.x)).toBeLessThan(0.01);
          expect(Math.abs(frame.portalY! - frame.y)).toBeLessThan(0.01);
        }
        if (at > 0) {
          const previous = returning[at - 1];
          expect(frame.fold).toBeGreaterThanOrEqual(previous.fold);
          expect(frame.sx).toBeLessThanOrEqual(previous.sx + 0.001);
          expect(Math.hypot(frame.x, frame.y)).toBeGreaterThanOrEqual(
            Math.hypot(previous.x, previous.y) - 0.01,
          );
          if (frame.fold > previous.fold) gaps.push(frame.at - previous.at);
        }
      }
      const firstReturn = sample.frames.findIndex((frame) => frame.fold > 0);
      expect(sample.frames.slice(firstReturn).every((frame) => frame.fold > 0)).toBe(true);
      const sorted = gaps.sort((a, b) => a - b);
      // Preserve the previous two-frame budget, including WebKit's 1ms timestamp rounding.
      expect(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThanOrEqual(34.4);
      expect(sample.portalCreatedAt.every((fold) => fold === 0)).toBe(true);
      if (kind === "handoff") {
        expect(sample.portalCreatedAt).toHaveLength(1);
        expect(returning.some((frame) => frame.owner === "body")).toBe(true);
        await expect(page.locator(".replay-handoff-strip")).toHaveCount(0);
        await expect(page.locator(".c-root")).toHaveClass(/at-result/);
      }
      await page.screenshot({ path: `work/compact-motion/${kind}-${width}.png` });
      expect(blocked).toEqual([]);
    });
  }
}

test("paper theater: summary submission and acknowledgment stay open until their single final handoff", async ({
  page,
}, testInfo) => {
  const blocked = await openReplay(page);
  const summary = steps.findIndex((step) => step.replayAction?.kind === "summary_submit");
  await page.getByRole("button", { name: `第 ${summary} 步`, exact: true }).click();
  const sampling = page.evaluate(
    () =>
      new Promise<Array<{ kind: string; fold: number }>>((resolve) => {
        const frames: Array<{ kind: string; fold: number }> = [];
        const began = performance.now();
        const tick = () => {
          const root = document.querySelector<HTMLElement>(".c-root");
          const paper = root?.querySelector<HTMLElement>(".replay-question-scene");
          if (paper)
            frames.push({
              kind: root?.dataset.replayKind ?? "",
              fold: Number(paper.dataset.replayFold),
            });
          if (!root?.classList.contains("at-result") && performance.now() - began < 12000)
            requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  const frames = await sampling;
  await testInfo.attach("summary-through-handoff", {
    body: JSON.stringify(frames),
    contentType: "application/json",
  });
  for (const kind of ["summary_submit", "summary_confirm"]) {
    const actionFrames = frames.filter((frame) => frame.kind === kind);
    expect(actionFrames.length).toBeGreaterThan(0);
    expect(actionFrames.every((frame) => frame.fold === 0)).toBe(true);
  }
  expect(frames.some((frame) => frame.kind === "handoff" && frame.fold > 0)).toBe(true);
  await expect(page.locator(".c-root")).toHaveClass(/at-result/);
  expect(blocked).toEqual([]);
});

test("paper theater: foreground playback leaves background settled and pause keeps its exact pose", async ({
  page,
}) => {
  const blocked = await playQuestion(page);
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLElement>(".c-root")?.dataset.replayProgress) >= 0.2,
  );
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
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLElement>(".c-root")?.dataset.replayProgress) >= 0.45,
  );
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
  expect(activeTime).toBeGreaterThanOrEqual((sample.after.at - sample.before.at) * 0.8);
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
