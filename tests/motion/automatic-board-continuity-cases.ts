import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { beatsOf } from "../../src/components/console/beats";
import { advanceFixture, fixtureSnapshot } from "../e2e/ui.fixture";
import { configureFixtureModels } from "../e2e/intake.fixture";

// Saved real-model simulation with simulated answers. APIs are blocked. rAF
// geometry is regression telemetry, separate from original CDP frame evidence.
const payload = JSON.parse(
  readFileSync("public/recorded-examples/user-guide.json", "utf8"),
) as RecordedExamplePayload;
const version = payload.arena.versions.find((entry) => entry.id === payload.arena.activeVersionId)!;
const beats = beatsOf(version, payload.replayActions);
const targetIndex = beats.findIndex(
  (beat) => beat.clarificationRun?.role === "A" && beat.clarificationRun.round === 3,
);
const targetStep = targetIndex + 1;
const previousRun = beats
  .slice(0, targetIndex)
  .findLast((beat) => beat.clarificationRun?.role === "A")!.clarificationRun!;
const nextRun = beats[targetIndex].clarificationRun!;

async function prepare(page: Page, speed: "常速" | "慢速" | "快速") {
  const requests: string[] = [];
  await page.addInitScript(() => {
    const inputs: unknown[] = [];
    Object.assign(window, { __bodyInputs: inputs });
    for (const type of ["pointerdown", "pointerup", "click", "keydown", "keyup"])
      addEventListener(
        type,
        (event) => {
          const target = event.target instanceof Element ? event.target.closest("button") : null;
          const board = document.querySelector<HTMLElement>(".c-board-A");
          const animation = board
            ?.getAnimations()
            .find(
              (motion) =>
                motion.effect instanceof KeyframeEffect &&
                motion.effect.getKeyframes().some((frame) => typeof frame.height === "string"),
            );
          inputs.push({
            type,
            at: performance.now(),
            trusted: event.isTrusted,
            control: target?.getAttribute("aria-label") || target?.textContent?.trim(),
            step: document
              .querySelector('.c-time [aria-current="step"]')
              ?.getAttribute("aria-label"),
            key: event instanceof KeyboardEvent ? event.key : undefined,
            nativeTime: animation?.currentTime,
            pending: animation?.pending,
            nativeState: animation?.playState,
            nativeRate: animation?.playbackRate,
          });
        },
        true,
      );
  });
  await page.route("**/api/**", (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/examples/user-guide");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
    "aria-label",
    "第 1 步",
  );
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  const speedButton = page.getByRole("button", { name: "放映速度", exact: true });
  if (speed !== "常速") await speedButton.click();
  if (speed === "快速") await speedButton.click();
  await expect(speedButton).toHaveText(speed);
  expect(beats[targetIndex - 1].replayAction?.kind).toBe("round_confirm");
  // Start one answer before confirmation. Both following advances are automatic.
  await page.getByRole("button", { name: `第 ${targetStep - 2} 步`, exact: true }).click();
  await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
    "aria-label",
    `第 ${targetStep - 2} 步`,
  );
  await expect(page.locator("[data-stage-retiring=true]")).toHaveCount(0);
  await page.mouse.move(0, 0);
  return requests;
}

type BoardFrame = {
  at: number;
  step: number;
  height: number;
  visibleHeight: number;
  bFlowOffset: number;
  opacity: number;
  currentText: string;
  fromHeight: number | null;
  toHeight: number | null;
  nativeTime: number | null;
  nativeRate: number | null;
  nativePending: boolean;
  nativeState: string | null;
  aDepth: number;
  bDepth: number;
  aDepthFrom: number | null;
  bDepthFrom: number | null;
  aDepthTo: number | null;
  bDepthTo: number | null;
  depthRate: number | null;
  aDepthNative: NativeDepth | null;
  bDepthNative: NativeDepth | null;
  copy: {
    text: string;
    opacity: number;
    inert: boolean;
    hidden: string | null;
    enabled: number;
  } | null;
};

type NativeDepth = {
  id: number;
  timeBefore: number | null;
  time: number | null;
  duration: number;
  rate: number;
  state: string;
  easing: string;
};

function depthProgress(time: number, duration: number) {
  const progress = Math.max(0, Math.min(1, time / duration));
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const parameter = (low + high) / 2;
    const inverse = 1 - parameter;
    const x =
      3 * inverse * inverse * parameter * 0.22 +
      3 * inverse * parameter * parameter * 0.3 +
      parameter ** 3;
    if (x < progress) low = parameter;
    else high = parameter;
  }
  return 1 - (1 - (low + high) / 2) ** 3;
}

export function registerAutomaticBoardContinuityTests(mode: "functional" | "display") {
  test.beforeEach(async ({ browserName }, info) => {
    info.annotations.push({
      type: "motion-validation",
      description: JSON.stringify({
        mode,
        browserName,
        reducedMotionSwitchCases: mode === "functional" ? 2 : 0,
      }),
    });
  });
  for (const width of [1440, 390]) {
    for (const speed of ["常速", "慢速", "快速"] as const) {
      test(`automatic A body preserves paper and following board at ${width}px ${speed}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const requests = await prepare(page, speed);
        if (width === 390) {
          // Explicit test-only geometry makes the incoming paper measurably taller.
          // Immutable public recordings retain their original contents and styles.
          await page.addStyleTag({
            content:
              '.c-stage3 [data-board="A"].enter > .c-board-body { min-height: 560px !important; }',
          });
        }
        const sampling = page.evaluate(
          (target) =>
            new Promise<BoardFrame[]>((resolve) => {
              const frames: BoardFrame[] = [];
              const animationIds = new WeakMap<Animation, number>();
              let nextAnimationId = 1;
              const began = performance.now();
              let entered = false;
              const tick = (at: number) => {
                const selected = document.querySelector('.c-time [aria-current="step"]');
                const step = Number(selected?.getAttribute("aria-label")?.match(/\d+/)?.[0] ?? 0);
                const a = document.querySelector<HTMLElement>('.c-stage3 [data-board="A"]');
                const b = document.querySelector<HTMLElement>('.c-stage3 [data-board="B"]');
                if (a && b && step >= target - 1 && step <= target) {
                  const heightMotion = a
                    .getAnimations()
                    .find(
                      (animation) =>
                        animation.effect instanceof KeyframeEffect &&
                        animation.effect
                          .getKeyframes()
                          .some((frame) => typeof frame.height === "string"),
                    );
                  const keys = (heightMotion?.effect as KeyframeEffect | null)?.getKeyframes();
                  const depth = (board: HTMLElement) => {
                    const motion = board
                      .getAnimations()
                      .find(
                        (animation) =>
                          animation.effect instanceof KeyframeEffect &&
                          animation.effect
                            .getKeyframes()
                            .some((frame) => typeof frame.transform === "string"),
                      );
                    const frames = (motion?.effect as KeyframeEffect | null)?.getKeyframes();
                    const timeBefore =
                      typeof motion?.currentTime === "number" ? motion.currentTime : null;
                    const current = new DOMMatrixReadOnly(getComputedStyle(board).transform).m43;
                    const time =
                      typeof motion?.currentTime === "number" ? motion.currentTime : null;
                    let id = motion ? animationIds.get(motion) : undefined;
                    if (motion && id === undefined) {
                      id = nextAnimationId++;
                      animationIds.set(motion, id);
                    }
                    return {
                      current,
                      from: frames?.length
                        ? new DOMMatrixReadOnly(String(frames[0].transform)).m43
                        : null,
                      to: frames?.length
                        ? new DOMMatrixReadOnly(String(frames[frames.length - 1].transform)).m43
                        : null,
                      rate: motion?.playbackRate ?? null,
                      native: motion
                        ? {
                            id: id!,
                            timeBefore,
                            time,
                            duration: Number(motion.effect?.getTiming().duration),
                            rate: motion.playbackRate,
                            state: motion.playState,
                            easing: motion.effect?.getTiming().easing ?? "",
                          }
                        : null,
                    };
                  };
                  const aDepth = depth(a);
                  const bDepth = depth(b);
                  const copy = a.querySelector<HTMLElement>(":scope > [data-stage-retiring=true]");
                  const body = a.querySelector<HTMLElement>(":scope > .c-board-body")!;
                  frames.push({
                    at,
                    step,
                    height: parseFloat(getComputedStyle(a).height),
                    visibleHeight: a.getBoundingClientRect().height,
                    bFlowOffset: b.offsetTop - a.offsetTop,
                    opacity: Number(getComputedStyle(body).opacity),
                    currentText: body.textContent ?? "",
                    fromHeight: keys?.length ? parseFloat(String(keys[0].height)) : null,
                    toHeight: keys?.length
                      ? parseFloat(String(keys[keys.length - 1].height))
                      : null,
                    nativeTime:
                      typeof heightMotion?.currentTime === "number"
                        ? heightMotion.currentTime
                        : null,
                    nativeRate: heightMotion?.playbackRate ?? null,
                    nativePending: heightMotion?.pending ?? false,
                    nativeState: heightMotion?.playState ?? null,
                    aDepth: aDepth.current,
                    bDepth: bDepth.current,
                    aDepthFrom: aDepth.from,
                    bDepthFrom: bDepth.from,
                    aDepthTo: aDepth.to,
                    bDepthTo: bDepth.to,
                    depthRate: aDepth.rate,
                    aDepthNative: aDepth.native,
                    bDepthNative: bDepth.native,
                    copy: copy
                      ? {
                          text: copy.textContent ?? "",
                          opacity: Number(getComputedStyle(copy).opacity),
                          inert: copy.inert,
                          hidden: copy.getAttribute("aria-hidden"),
                          enabled: copy.querySelectorAll(
                            "input:enabled,button:enabled,select:enabled",
                          ).length,
                        }
                      : null,
                  });
                }
                if (step === target) entered = true;
                if ((entered && step > target) || at - began > 15_000) return resolve(frames);
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
          targetStep,
        );
        await page.getByRole("button", { name: "继续放映", exact: true }).click();
        const frames = await sampling;
        await info.attach("automatic-body-geometry-before-assertions", {
          body: JSON.stringify({ width, speed, targetStep, frames, requests }),
          contentType: "application/json",
        });
        const previous = frames.filter((frame) => frame.step === targetStep - 1).at(-1);
        const active = frames.filter((frame) => frame.step === targetStep);
        const animated = active.filter((frame) => frame.copy && frame.fromHeight !== null);
        expect(previous).toBeDefined();
        expect(animated.length).toBeGreaterThanOrEqual(3);
        expect(Math.abs(animated[0].fromHeight! - previous!.height)).toBeLessThanOrEqual(1);
        expect(
          animated.every(
            (frame) =>
              frame.copy!.inert && frame.copy!.hidden === "true" && frame.copy!.enabled === 0,
          ),
        ).toBe(true);
        expect(animated.every((frame) => frame.currentText.includes(nextRun.summary))).toBe(true);
        expect(animated.some((frame) => frame.copy!.text.includes(previousRun.summary))).toBe(true);
        expect(animated.every((frame) => frame.opacity + frame.copy!.opacity >= 0.98)).toBe(true);
        const rate = { 常速: 1, 慢速: 0.6, 快速: 1.8 }[speed];
        expect(animated.every((frame) => frame.nativeRate === rate)).toBe(true);
        expect(animated.every((frame) => frame.depthRate === rate)).toBe(true);
        if (width === 1440) {
          expect(animated[0].aDepthFrom).not.toBeNull();
          expect(animated[0].bDepthFrom).not.toBeNull();
          expect(Math.abs(animated[0].aDepthFrom! - previous!.aDepth)).toBeLessThanOrEqual(1);
          expect(Math.abs(animated[0].bDepthFrom! - previous!.bDepth)).toBeLessThanOrEqual(1);
          expect(animated[0].aDepthTo! - animated[0].aDepthFrom!).toBeGreaterThan(50);
          expect(animated[0].bDepthFrom! - animated[0].bDepthTo!).toBeGreaterThan(50);
          for (const axis of ["aDepth", "bDepth"] as const) {
            const nativeKey = axis === "aDepth" ? "aDepthNative" : "bDepthNative";
            const fromKey = axis === "aDepth" ? "aDepthFrom" : "bDepthFrom";
            const toKey = axis === "aDepth" ? "aDepthTo" : "bDepthTo";
            const tracks = new Map<number, number[]>();
            for (const frame of animated) {
              const native = frame[nativeKey];
              expect(native).not.toBeNull();
              expect(native!.duration).toBe(220);
              expect(native!.rate).toBe(rate);
              expect(native!.state).toMatch(/^(?:running|finished)$/);
              expect(native!.timeBefore).not.toBeNull();
              expect(native!.time).not.toBeNull();
              expect(native!.time!).toBeGreaterThanOrEqual(native!.timeBefore!);
              const times = tracks.get(native!.id) ?? [];
              times.push(native!.time!);
              tracks.set(native!.id, times);
              const from = frame[fromKey]!;
              const to = frame[toKey]!;
              const before =
                from + (to - from) * depthProgress(native!.timeBefore!, native!.duration);
              const after = from + (to - from) * depthProgress(native!.time!, native!.duration);
              expect(frame[axis]).toBeGreaterThanOrEqual(Math.min(before, after) - 1);
              expect(frame[axis]).toBeLessThanOrEqual(Math.max(before, after) + 1);
            }
            for (const times of tracks.values()) {
              expect(times.at(-1)!).toBeGreaterThan(times[0]);
              for (let index = 1; index < times.length; index++)
                expect(times[index]).toBeGreaterThanOrEqual(times[index - 1]);
            }
            const values = animated.map((frame) => frame[axis]);
            const low = Math.min(...values);
            const high = Math.max(...values);
            if (mode === "display")
              expect(
                new Set(
                  values
                    .filter((value) => value > low + 1 && value < high - 1)
                    .map((value) => value.toFixed(2)),
                ).size,
              ).toBeGreaterThanOrEqual(3);
          }
        }
        const from = animated[0].fromHeight!;
        const to = animated[0].toHeight!;
        if (width === 390) expect(Math.abs(from - to)).toBeGreaterThan(1);
        const between = animated.filter(
          (frame) =>
            frame.height > Math.min(from, to) + 0.5 && frame.height < Math.max(from, to) - 0.5,
        );
        if (Math.abs(from - to) > 1)
          expect(
            new Set(between.map((frame) => frame.height.toFixed(2))).size,
          ).toBeGreaterThanOrEqual(3);
        expect(animated.some((frame) => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
        const settled = active.at(-1)!;
        expect(Math.abs(settled.height - to)).toBeLessThanOrEqual(1);
        if (width === 390) {
          const offsets = animated.map((frame) => frame.bFlowOffset - frame.height);
          expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1);
          expect(new Set(between.map((frame) => frame.bFlowOffset)).size).toBeGreaterThanOrEqual(3);
        }
        expect(requests).toEqual([]);
        await info.attach("automatic-body-geometry", {
          body: JSON.stringify({ width, speed, targetStep, frames, requests }),
          contentType: "application/json",
        });
      });
    }
  }

  test("automatic mobile body pauses across speed and width changes, then yields to manual seek", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const requests = await prepare(page, "慢速");
    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await page.waitForFunction((target) => {
      const step = document
        .querySelector('.c-time [aria-current="step"]')
        ?.getAttribute("aria-label");
      return (
        step === `第 ${target} 步` &&
        !!document.querySelector('.c-board-A > [data-stage-retiring="true"]')
      );
    }, targetStep);
    // Native Space on the focused playback button keeps the pause within this
    // 367ms slow body transition and avoids any programmatic click shortcut.
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
    const read = () =>
      page.locator('.c-stage3 [data-board="A"]').evaluate((board) => {
        const animation = board
          .getAnimations()
          .find(
            (entry) =>
              entry.effect instanceof KeyframeEffect &&
              entry.effect.getKeyframes().some((key) => typeof key.height === "string"),
          );
        return {
          height: board.getBoundingClientRect().height,
          time: animation?.currentTime,
          state: animation?.playState,
          rate: animation?.playbackRate,
        };
      });
    const paused = await read();
    await info.attach("pause-before-assertions", {
      body: JSON.stringify({
        paused,
        inputs: await page.evaluate(
          () => (window as unknown as { __bodyInputs: unknown[] }).__bodyInputs,
        ),
      }),
      contentType: "application/json",
    });
    expect(paused.state).toBe("paused");
    await page.getByRole("button", { name: "放映速度", exact: true }).click();
    await expect(page.getByRole("button", { name: "放映速度", exact: true })).toHaveText("快速");
    const changedSpeed = await read();
    expect(changedSpeed.state).toBe("paused");
    expect(changedSpeed.rate).toBe(1.8);
    expect(Math.abs(Number(changedSpeed.time) - Number(paused.time))).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 420, height: 844 });
    // Viewport emulation can return before resize retargets the held native effect.
    await page.waitForFunction(() =>
      document
        .querySelector('.c-stage3 [data-board="A"]')
        ?.getAnimations()
        .some(
          (animation) =>
            animation.effect instanceof KeyframeEffect &&
            animation.effect.getKeyframes().some((frame) => typeof frame.height === "string") &&
            animation.effect.getTiming().duration === 160 &&
            animation.playState === "paused" &&
            animation.currentTime === 0,
        ),
    );
    const resized = await read();
    expect(resized.state).toBe("paused");
    expect(Math.abs(resized.height - paused.height)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(160);
    const held = await read();
    expect(Math.abs(held.height - resized.height)).toBeLessThanOrEqual(1);
    expect(held.time).toBe(resized.time);
    // A trusted keyboard seek interrupts the held story and owns the final paper.
    await page.keyboard.press("Home");
    await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
      "aria-label",
      "第 1 步",
    );
    await expect(page.locator("[data-stage-retiring=true]")).toHaveCount(0);
    const firstRun = beats.find((beat) => beat.clarificationRun?.role === "A")!.clarificationRun!;
    await expect(page.locator('.c-stage3 [data-board="A"] > .c-board-body')).toContainText(
      firstRun.summary,
    );
    await expect(page.locator(".c-stage3 [data-board]")).toHaveCount(3);
    expect(requests).toEqual([]);
    await info.attach("paused-body-interruption", {
      body: JSON.stringify({ paused, changedSpeed, resized, held, requests }),
      contentType: "application/json",
    });
  });

  // Preference-switch behavior remains a functional requirement. The physical
  // session separately requires normal motion throughout every measured case.
  if (mode === "functional")
    for (const paused of [false, true]) {
      test(`reduced motion settles automatic body and cannot replay its old copy (${paused ? "paused" : "playing"})`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const requests = await prepare(page, "慢速");
        await page.getByRole("button", { name: "继续放映", exact: true }).click();
        await page.waitForFunction(
          (target) =>
            document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ===
              `第 ${target} 步` &&
            !!document.querySelector('.c-board-A > [data-stage-retiring="true"]'),
          targetStep,
        );
        if (paused) await page.keyboard.press("Space");
        const before = await page.locator('.c-stage3 [data-board="A"]').evaluate((node) => ({
          copies: node.querySelectorAll('[data-stage-retiring="true"]').length,
          height: getComputedStyle(node).height,
        }));
        await info.attach("before-reduced-motion", {
          body: JSON.stringify({ paused, before }),
          contentType: "application/json",
        });
        expect(before.copies).toBeGreaterThan(0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        if (!paused) await page.keyboard.press("Space");
        await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
        await expect(page.locator("[data-stage-retiring=true]")).toHaveCount(0);
        const settled = await page.locator('.c-stage3 [data-board="A"]').evaluate((node) => ({
          height: (node as HTMLElement).style.height,
          opacity: getComputedStyle(node.querySelector(":scope > .c-board-body")!).opacity,
          text: node.querySelector(":scope > .c-board-body")!.textContent,
          nativeHeights: node
            .getAnimations()
            .filter(
              (motion) =>
                motion.effect instanceof KeyframeEffect &&
                motion.effect.getKeyframes().some((frame) => typeof frame.height === "string"),
            ).length,
        }));
        await info.attach("reduced-motion-settled", {
          body: JSON.stringify({ paused, settled }),
          contentType: "application/json",
        });
        expect(settled.height).toBe("");
        expect(Number(settled.opacity)).toBeGreaterThan(0);
        expect(settled.text).toContain(nextRun.summary);
        expect(settled.nativeHeights).toBe(0);
        const current = await page
          .locator('.c-time [aria-current="step"]')
          .getAttribute("aria-label");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.waitForTimeout(250);
        await expect(page.locator("[data-stage-retiring=true]")).toHaveCount(0);
        await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
          "aria-label",
          current!,
        );
        expect(requests).toEqual([]);
      });
    }

  test("primary down pauses a moving playback button and release cannot resume it", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const requests = await prepare(page, "慢速");
    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await page.waitForFunction(
      (target) =>
        document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ===
          `第 ${target} 步` &&
        !!document.querySelector('.c-board-A > [data-stage-retiring="true"]'),
      targetStep,
    );
    const pause = page.getByRole("button", { name: "暂停放映", exact: true });
    const box = await pause.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
    const selected = await page.locator('.c-time [aria-current="step"]').getAttribute("aria-label");
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(180);
    const inputs = await page.evaluate(
      () => (window as unknown as { __bodyInputs: unknown[] }).__bodyInputs,
    );
    await info.attach("held-primary-playback-inputs", {
      body: JSON.stringify({ inputs, selected }),
      contentType: "application/json",
    });
    await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
    await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
      "aria-label",
      selected!,
    );
    const down = (
      inputs as Array<{ type: string; control?: string; trusted: boolean; nativeState?: string }>
    ).findLast((input) => input.type === "pointerdown" && input.control === "暂停放映");
    expect(down?.trusted).toBe(true);
    expect(down?.nativeState).toBe("running");
    const continueBox = await page
      .getByRole("button", { name: "继续放映", exact: true })
      .boundingBox();
    expect(continueBox).not.toBeNull();
    await page.mouse.move(
      continueBox!.x + continueBox!.width / 2,
      continueBox!.y + continueBox!.height / 2,
    );
    await page.mouse.down();
    await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.waitForTimeout(180);
    await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
    await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
      "aria-label",
      selected!,
    );
    // The focused original button still supports a single native keyboard activation.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "暂停放映", exact: true })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
    await info.attach("cancelled-idle-down-and-keyboard-inputs", {
      body: JSON.stringify(
        await page.evaluate(() => (window as unknown as { __bodyInputs: unknown[] }).__bodyInputs),
      ),
      contentType: "application/json",
    });
    expect(requests).toEqual([]);
  });

  test("explicit legacy fixture camera aims at newly mounted natural body, not outgoing quiet card", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
    const snapshot = configureFixtureModels(fixtureSnapshot());
    const requests: string[] = [];
    let releaseAdvance = () => {};
    const advanceGate = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(`${route.request().method()} ${path}`);
      if (path === "/api/health")
        return route.fulfill({
          json: { status: "ok", model: snapshot.model, accessGranted: true },
        });
      if (path.endsWith("/events"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": explicit legacy fixture\n\n",
        });
      if (path.endsWith("/advance")) {
        await advanceGate;
        advanceFixture(snapshot);
        snapshot.versions[0].status = "paused";
        return route.fulfill({ json: snapshot });
      }
      if (path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
      return route.fulfill({ status: 404, json: { error: "explicit legacy fixture boundary" } });
    });
    await page.goto(`/?arena=${snapshot.id}`);
    await expect(page.locator('.c-stage3 [data-board="A"] > .c-board-body')).toHaveClass(/quiet/);
    const quietHeight = await page
      .locator('.c-stage3 [data-board="A"]')
      .evaluate((node) => (node as HTMLElement).offsetHeight);
    await page.getByRole("button", { name: "逐步看", exact: true }).click();
    releaseAdvance();
    await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
      "aria-label",
      "第 1 步",
    );
    await expect(page.locator('.c-stage3 [data-board="A"] > .c-board-body')).not.toHaveClass(
      /quiet/,
    );
    await expect(page.locator("[data-stage-retiring=true]")).toHaveCount(0);
    const expected = await page.locator(".c-world").evaluate((element, quiet) => {
      const world = element as HTMLElement;
      const a = world.querySelector<HTMLElement>('[data-board="A"]')!;
      const W = world.clientWidth,
        H = world.clientHeight,
        margin = 48;
      const scale = Math.min(1.03, Math.max(1, (W - margin * 2) / a.offsetWidth));
      const screen = (position: number) => H / 2 + (position - H / 2) * scale;
      const y = (height: number) =>
        Math.max(margin - screen(a.offsetTop), H * 0.26 - screen(a.offsetTop + height / 2));
      return {
        y: y(a.offsetHeight),
        quietY: y(quiet),
        naturalHeight: a.offsetHeight,
        quietHeight: quiet,
      };
    }, quietHeight);
    let pose = 0;
    await expect
      .poll(async () => {
        pose = await page
          .locator(".c-world")
          .evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42);
        return Math.abs(pose - expected.y);
      })
      .toBeLessThanOrEqual(1);
    await info.attach("legacy-natural-camera-target", {
      body: JSON.stringify({ expected, pose, requests }),
      contentType: "application/json",
    });
    expect(Math.abs(expected.y - expected.quietY)).toBeGreaterThan(10);
    expect(requests.filter((request) => request.endsWith("/advance"))).toEqual([
      `POST /api/arenas/${snapshot.id}/advance`,
    ]);
  });
}
