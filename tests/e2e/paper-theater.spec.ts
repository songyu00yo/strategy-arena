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
  for (const kind of ["round_confirm", "summary_submit", "handoff"] as const) {
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
      // These rAF observations verify main-thread-visible poses and frame gaps during normal playback.
      // They do not sample the compositor's intermediate frames while JavaScript is blocked.
      const sampling = page.evaluate(
        (targetStep) =>
          new Promise<{
            frames: Array<{
              at: number;
              fold: number;
              semanticFold: number;
              nativeState: string | null;
              nativeTime: number | null;
              nativeDuration: number | null;
              nativeRate: number | null;
              x: number;
              y: number;
              sx: number;
              sy: number;
              owner: string;
              opacity: number;
              width: number;
              height: number;
              bodyDisplay: string;
              footerDisplay: string;
              portalX: number | null;
              portalY: number | null;
            }>;
            portalCreatedAt: number[];
            destination: { x: number; y: number } | null;
          }>((resolve) => {
            const frames: Array<{
              at: number;
              fold: number;
              semanticFold: number;
              nativeState: string | null;
              nativeTime: number | null;
              nativeDuration: number | null;
              nativeRate: number | null;
              x: number;
              y: number;
              sx: number;
              sy: number;
              owner: string;
              opacity: number;
              width: number;
              height: number;
              bodyDisplay: string;
              footerDisplay: string;
              portalX: number | null;
              portalY: number | null;
            }> = [];
            const portalCreatedAt: number[] = [];
            let destination: { x: number; y: number } | null = null;
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
                const movingNode =
                  document.querySelector<HTMLElement>(".replay-handoff-strip") ?? paper;
                const native = movingNode
                  .getAnimations()
                  .find(
                    (animation) =>
                      animation.effect instanceof KeyframeEffect &&
                      animation.effect
                        .getKeyframes()
                        .some((frame) => typeof frame.transform === "string"),
                  );
                const nativeTime =
                  typeof native?.currentTime === "number" ? native.currentTime : null;
                const nativeDuration = native ? Number(native.effect?.getTiming().duration) : null;
                const fold =
                  nativeTime !== null && nativeDuration
                    ? Math.max(0, Math.min(1, nativeTime / nativeDuration))
                    : Number(paper.dataset.replayFold);
                const pose = new DOMMatrixReadOnly(getComputedStyle(paper).transform);
                if (!destination && fold > 0) {
                  const target = paper.dataset.foldTarget;
                  const receiver =
                    target === "original-result"
                      ? document.querySelector<HTMLElement>("#verdict")
                      : document.querySelector<HTMLElement>(
                          `[data-board="${target?.replace("board-", "").toUpperCase()}"]`,
                        );
                  if (receiver) {
                    let left = 0;
                    let top = 0;
                    for (
                      let node: HTMLElement | null = paper;
                      node;
                      node = node.offsetParent as HTMLElement | null
                    ) {
                      left += node.offsetLeft;
                      top += node.offsetTop;
                    }
                    const box = receiver.getBoundingClientRect();
                    destination = {
                      x: box.left + box.width / 2 - (left - scrollX + paper.offsetWidth / 2),
                      y: box.top + box.height / 2 - (top - scrollY + paper.offsetHeight / 2),
                    };
                  }
                }
                const portal = document.querySelector<HTMLElement>(".replay-handoff-strip");
                const portalPose = portal
                  ? new DOMMatrixReadOnly(getComputedStyle(portal).transform)
                  : null;
                frames.push({
                  at: time,
                  fold,
                  semanticFold: Number(paper.dataset.replayFold),
                  nativeState: native?.playState ?? null,
                  nativeTime,
                  nativeDuration,
                  nativeRate: native?.playbackRate ?? null,
                  x: pose.m41,
                  y: pose.m42,
                  sx: pose.m11,
                  sy: pose.m22,
                  owner: paper.dataset.stripOwner ?? "local",
                  opacity: Number(getComputedStyle(paper).opacity),
                  width: paper.offsetWidth,
                  height: paper.offsetHeight,
                  bodyDisplay: getComputedStyle(paper.querySelector(".replay-question-body")!)
                    .display,
                  footerDisplay: getComputedStyle(paper.querySelector(".replay-question-footer")!)
                    .display,
                  portalX: portalPose?.m41 ?? null,
                  portalY: portalPose?.m42 ?? null,
                });
              }
              if ((!seen || (active && paper)) && time - began < 10000) requestAnimationFrame(tick);
              else {
                observer.disconnect();
                resolve({ frames, portalCreatedAt, destination });
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
      expect(returning.every((frame) => frame.nativeState === "running")).toBe(true);
      expect(returning.every((frame) => frame.nativeTime !== null && frame.nativeTime > 0)).toBe(
        true,
      );
      expect(returning.every((frame) => frame.nativeRate === 1)).toBe(true);
      expect(returning[0].fold).toBeLessThan(0.2);
      expect(returning.at(-1)!.fold).toBeGreaterThan(0.85);
      const reference = returning.find((frame) => frame.fold >= 0.45 && frame.fold <= 0.65)!;
      expect(reference).toBeDefined();
      const smooth = (value: number) => value * value * (3 - 2 * value);
      const first = returning[0];
      const referenceAmount = smooth(reference.fold);
      const firstAmount = smooth(first.fold);
      const dx = (reference.x - first.x) / (referenceAmount - firstAmount);
      const dy = (reference.y - first.y) / (referenceAmount - firstAmount);
      const origin = { x: first.x - dx * firstAmount, y: first.y - dy * firstAmount };
      const distance = Math.hypot(dx, dy);
      expect(sample.destination).not.toBeNull();
      expect(distance).toBeGreaterThan(0);
      // Receiving cards can nearly share the paper's center on narrow screens.
      // Verify the measured destination instead of imposing an invented minimum travel distance.
      expect(Math.abs(origin.x + dx - sample.destination!.x)).toBeLessThan(distance * 0.004 + 0.01);
      expect(Math.abs(origin.y + dy - sample.destination!.y)).toBeLessThan(distance * 0.004 + 0.01);
      const early = returning.find((frame) => frame.fold >= 0.15 && frame.fold < 0.35);
      expect(early).toBeDefined();
      expect(Math.hypot(early!.x - origin.x, early!.y - origin.y)).toBeGreaterThan(distance * 0.05);
      const gaps: number[] = [];
      for (let at = 0; at < returning.length; at++) {
        const frame = returning[at];
        const amount = smooth(frame.fold);
        // data-replay-fold is rounded to .001, while transforms retain full precision.
        expect(Math.abs(frame.x - (origin.x + dx * amount))).toBeLessThan(distance * 0.004);
        expect(Math.abs(frame.y - (origin.y + dy * amount))).toBeLessThan(distance * 0.004);
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
          expect(Math.hypot(frame.x - origin.x, frame.y - origin.y)).toBeGreaterThanOrEqual(
            Math.hypot(previous.x - origin.x, previous.y - origin.y) - 0.01,
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
        expect(sample.frames.every((frame) => frame.width <= 320 && frame.height <= 100)).toBe(
          true,
        );
        expect(
          sample.frames.every(
            (frame) => frame.bodyDisplay === "none" && frame.footerDisplay === "none",
          ),
        ).toBe(true);
        expect(returning.every((frame) => frame.owner === "body")).toBe(true);
        await expect(page.locator(".replay-handoff-strip")).toHaveCount(0);
        await expect(page.locator(".c-root")).toHaveClass(/at-result/);
      }
      await page.screenshot({ path: `work/compact-motion/${kind}-${width}.png` });
      expect(blocked).toEqual([]);
    });
  }
}

type NativeReturnProbe = {
  animation: Animation;
  parts: Animation[];
  node: HTMLElement;
};

async function captureNativeReturn(page: Page, step: number, pause: boolean) {
  await page.waitForFunction(
    ({ step, pause }) => {
      const root = document.querySelector<HTMLElement>(".c-root");
      if (
        root?.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") !==
        `第 ${step} 步`
      )
        return false;
      const paper = root.querySelector<HTMLElement>(".replay-question-scene");
      const portal = document.querySelector<HTMLElement>(".replay-handoff-strip");
      const node = portal ?? paper;
      const animation = node
        ?.getAnimations()
        .find(
          (entry) =>
            entry.effect instanceof KeyframeEffect &&
            entry.effect.getKeyframes().some((frame) => typeof frame.transform === "string"),
        );
      const time = animation?.currentTime;
      const duration = Number(animation?.effect?.getTiming().duration);
      if (
        !node ||
        !animation ||
        animation.playState !== "running" ||
        animation.pending ||
        typeof time !== "number" ||
        time <= 0 ||
        time >= duration * 0.2
      )
        return false;
      const parts = [
        ...new Set([
          ...(paper?.getAnimations({ subtree: true }) ?? []),
          ...(portal?.getAnimations({ subtree: true }) ?? []),
        ]),
      ].filter((entry) => entry.constructor.name === "Animation");
      Object.assign(window, { __nativeReturnProbe: { animation, parts, node } });
      if (pause)
        [...root.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "暂停放映")
          ?.click();
      return true;
    },
    { step, pause },
  );
}

async function nativeReturnSnapshot(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __nativeReturnProbe: NativeReturnProbe })
      .__nativeReturnProbe;
    return {
      at: performance.now(),
      time: Number(probe.animation.currentTime),
      duration: Number(probe.animation.effect?.getTiming().duration),
      rate: probe.animation.playbackRate,
      state: probe.animation.playState,
      pending: probe.animation.pending,
      transform: getComputedStyle(probe.node).transform,
      sameAnimation: probe.node.getAnimations().includes(probe.animation),
      partCount: probe.parts.length,
    };
  });
}

for (const kind of ["round_confirm", "handoff"] as const) {
  test(`paper theater: native ${kind} preserves pause and speed changes and cancels on seek`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const blocked = await openReplay(page);
    const index = steps.findIndex((step) => step.replayAction?.kind === kind);
    await page.getByRole("button", { name: `第 ${index} 步`, exact: true }).click();
    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await captureNativeReturn(page, index + 1, true);
    await page.waitForFunction(() => {
      const probe = (window as unknown as { __nativeReturnProbe: NativeReturnProbe })
        .__nativeReturnProbe;
      return probe.animation.playState === "paused" && !probe.animation.pending;
    });
    const paused = await nativeReturnSnapshot(page);
    expect(paused.sameAnimation).toBe(true);
    expect(paused.partCount).toBeGreaterThanOrEqual(4);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          const tick = () => (++frames >= 18 ? resolve() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );
    const held = await nativeReturnSnapshot(page);
    expect(held.time).toBe(paused.time);
    expect(held.transform).toBe(paused.transform);
    await page.getByRole("button", { name: "放映速度", exact: true }).click();
    await expect(page.getByRole("button", { name: "放映速度", exact: true })).toHaveText("慢速");
    await page.waitForFunction(() => {
      const probe = (window as unknown as { __nativeReturnProbe: NativeReturnProbe })
        .__nativeReturnProbe;
      return probe.animation.playbackRate === 0.6 && !probe.animation.pending;
    });
    const changed = await nativeReturnSnapshot(page);
    expect(changed.sameAnimation).toBe(true);
    expect(changed.time).toBe(paused.time);
    expect(changed.transform).toBe(paused.transform);
    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await page.waitForFunction((heldTime) => {
      const probe = (window as unknown as { __nativeReturnProbe: NativeReturnProbe })
        .__nativeReturnProbe;
      return (
        probe.animation.playState === "running" &&
        !probe.animation.pending &&
        Number(probe.animation.currentTime) >= heldTime + 25
      );
    }, paused.time);
    const resumed = await nativeReturnSnapshot(page);
    expect(resumed.sameAnimation).toBe(true);
    expect(resumed.rate).toBe(0.6);
    expect(resumed.time).toBeGreaterThan(paused.time);
    await page.getByRole("button", { name: `第 ${questionIndex + 1} 步`, exact: true }).click();
    await page.waitForFunction(() => {
      const probe = (window as unknown as { __nativeReturnProbe: NativeReturnProbe })
        .__nativeReturnProbe;
      return (
        probe.parts.length > 0 &&
        probe.parts.every((entry) => entry.playState === "idle" && entry.currentTime === null)
      );
    });
    await expect(page.locator(".replay-handoff-strip")).toHaveCount(0);
    await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
      "aria-label",
      `第 ${questionIndex + 1} 步`,
    );
    await testInfo.attach(`native-${kind}-control-states`, {
      body: JSON.stringify({ paused, held, changed, resumed }),
      contentType: "application/json",
    });
    expect(blocked).toEqual([]);
  });
}

test("explicit artificial 180ms main-thread load: native handoff clock and post-load pose continue", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const blocked = await openReplay(page);
  const index = steps.findIndex((step) => step.replayAction?.kind === "handoff");
  await page.getByRole("button", { name: `第 ${index} 步`, exact: true }).click();
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await captureNativeReturn(page, index + 1, false);
  const sample = await page.evaluate(async () => {
    const probe = (window as unknown as { __nativeReturnProbe: NativeReturnProbe })
      .__nativeReturnProbe;
    const before = {
      at: performance.now(),
      time: Number(probe.animation.currentTime),
      transform: getComputedStyle(probe.node).transform,
    };
    let callbacks = 0;
    requestAnimationFrame(() => callbacks++);
    // Explicit synthetic load. JavaScript cannot observe compositor frames during this task.
    const began = performance.now();
    while (performance.now() - began < 180) {
      /* Deliberate browser-test load. */
    }
    const blockedFor = performance.now() - began;
    const callbacksDuringBlock = callbacks;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const after = {
      at: performance.now(),
      time: Number(probe.animation.currentTime),
      transform: getComputedStyle(probe.node).transform,
      state: probe.animation.playState,
    };
    return {
      before,
      after,
      blockedFor,
      callbacksDuringBlock,
      duration: Number(probe.animation.effect?.getTiming().duration),
      rate: probe.animation.playbackRate,
      sameAnimation: probe.node.getAnimations().includes(probe.animation),
    };
  });
  await testInfo.attach("explicit-artificial-load-native-clock", {
    body: JSON.stringify(sample),
    contentType: "application/json",
  });
  expect(sample.blockedFor).toBeGreaterThanOrEqual(180);
  expect(sample.callbacksDuringBlock).toBe(0);
  expect(sample.sameAnimation).toBe(true);
  expect(sample.after.state).toBe("running");
  expect(sample.after.time - sample.before.time).toBeGreaterThanOrEqual(
    (sample.after.at - sample.before.at) * 0.8,
  );
  expect(sample.after.time - sample.before.time).toBeLessThanOrEqual(
    (sample.after.at - sample.before.at) * 1.2 + 17,
  );
  expect(sample.after.transform).not.toBe(sample.before.transform);
  await expect(page.locator(".c-root")).toHaveClass(/at-result/);
  await expect(page.locator(".replay-handoff-strip")).toHaveCount(0);
  expect(blocked).toEqual([]);
});

test("paper theater: final summary acknowledgment does not reopen the question paper before handoff", async ({
  page,
}, testInfo) => {
  const blocked = await openReplay(page);
  const summary = steps.findLastIndex((step) => step.replayAction?.kind === "summary_submit");
  await page.getByRole("button", { name: `第 ${summary} 步`, exact: true }).click();
  const sampling = page.evaluate(
    () =>
      new Promise<Array<{ kind: string; paper: boolean; fold: number }>>((resolve) => {
        const frames: Array<{ kind: string; paper: boolean; fold: number }> = [];
        const began = performance.now();
        const tick = () => {
          const root = document.querySelector<HTMLElement>(".c-root");
          const paper = root?.querySelector<HTMLElement>(".replay-question-scene");
          frames.push({
            kind: root?.dataset.replayKind ?? "",
            paper: !!paper,
            fold: Number(paper?.dataset.replayFold ?? 0),
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
  const submitFrames = frames.filter((frame) => frame.kind === "summary_submit");
  expect(submitFrames.some((frame) => frame.fold > 0)).toBe(true);
  const firstReturn = submitFrames.findIndex((frame) => frame.fold > 0);
  expect(submitFrames.slice(firstReturn).every((frame) => frame.fold > 0)).toBe(true);
  const acknowledged = frames.filter((frame) => frame.kind === "summary_confirm");
  expect(acknowledged.length).toBeGreaterThan(0);
  expect(acknowledged.every((frame) => !frame.paper)).toBe(true);
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
