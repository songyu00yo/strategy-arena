// Saved real-model simulation data. All API requests are blocked, with no provider calls.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { beatsOf } from "../../src/components/console/beats";
import { playbackDuration } from "../../src/components/console/use-playback-progress";

export function registerPaperTheaterTests(mode: "functional" | "display") {
  const check = expect.configure({ soft: true });
  const requestsByPage = new WeakMap<Page, string[]>();
  test.afterEach(async ({ page }) => {
    if (!requestsByPage.has(page)) return;
    try {
      const firstStep = page.getByRole("button", { name: "第 1 步", exact: true });
      if (await firstStep.count()) {
        await firstStep.focus();
        await page.keyboard.press("Enter");
      }
    } finally {
      try {
        await check(page.locator(".replay-handoff-strip")).toHaveCount(0);
        await check(page.locator(".c-root")).not.toHaveClass(/held/);
        await check
          .poll(() =>
            page.evaluate(() => {
              const probe = window as unknown as {
                __paperReturnDrivers?: Animation[];
                __nativeReturnProbe?: { parts: Animation[] };
              };
              return [
                ...(probe.__paperReturnDrivers ?? []),
                ...(probe.__nativeReturnProbe?.parts ?? []),
              ].every(
                (animation) => animation.playState === "idle" && animation.currentTime === null,
              );
            }),
          )
          .toBe(true);
      } finally {
        check(requestsByPage.get(page) ?? []).toEqual([]);
      }
    }
  });

  const payload = JSON.parse(
    readFileSync("public/recorded-examples/personal-website.json", "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.find(
    (entry) => entry.id === payload.arena.activeVersionId,
  )!;
  const steps = beatsOf(version, payload.replayActions);
  const questionIndex = steps.findIndex(
    (step) => step.replayAction?.kind === "questions" && step.replayAction.round === 2,
  );

  async function openReplay(page: Page) {
    const blocked: string[] = [];
    requestsByPage.set(page, blocked);
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

  type ReturnPose = { x: number; y: number; sx: number; sy: number };
  type ReturnKeyframes = { from: ReturnPose; to: ReturnPose };
  type NativePoseWindow = ReturnPose & {
    timeBefore: number | null;
    timeAfter: number | null;
    progressBefore: number | null;
    progressAfter: number | null;
  };
  type NativeReturnFrame = NativePoseWindow & {
    at: number;
    fold: number;
    semanticFold: number;
    nativeState: string | null;
    nativeTime: number | null;
    nativeDuration: number | null;
    nativeRate: number | null;
    nativeTransformCount: number;
    portalTransformCount: number;
    owner: string;
    opacity: number;
    width: number;
    height: number;
    bodyDisplay: string;
    footerDisplay: string;
    flipOrigin: string;
    scrollX: number;
    scrollY: number;
    portalPose: NativePoseWindow | null;
  };

  function expectNativePoseAtAmount(
    pose: ReturnPose,
    keyframes: ReturnKeyframes,
    amount: number,
    tolerance: number,
  ) {
    const x = keyframes.from.x + (keyframes.to.x - keyframes.from.x) * amount;
    const y = keyframes.from.y + (keyframes.to.y - keyframes.from.y) * amount;
    check(Math.abs(pose.x - x)).toBeLessThan(tolerance);
    check(Math.abs(pose.y - y)).toBeLessThan(tolerance);
  }

  for (const width of [1440, 390]) {
    for (const kind of ["round_confirm", "summary_submit", "handoff"] as const) {
      test(`paper theater: ${kind} returns in one continuous motion at ${width}px`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const blocked = await openReplay(page);
        try {
          const index = steps.findIndex(
            (step, at) =>
              step.replayAction?.kind === kind &&
              (kind === "handoff" || !!steps[at + 1]?.clarificationRun),
          );
          expect(index).toBeGreaterThan(0);
          await page.getByRole("button", { name: `第 ${index} 步`, exact: true }).click();
          // These rAF observations cover normal main-thread-visible poses and callbacks.
          // Compositor intermediate frames during a JavaScript block are not observed here.
          const sampling = page.evaluate(
            (targetStep) =>
              new Promise<{
                frames: NativeReturnFrame[];
                portalCreatedAt: number[];
                destination: { x: number; y: number } | null;
                keyframes: ReturnKeyframes | null;
                portalKeyframes: ReturnKeyframes | null;
              }>((resolve) => {
                const frames: NativeReturnFrame[] = [];
                const portalCreatedAt: number[] = [];
                let destination: { x: number; y: number } | null = null;
                let keyframes: ReturnKeyframes | null = null;
                let portalKeyframes: ReturnKeyframes | null = null;
                let seen = false;
                const drivers = new Set<Animation>();
                Object.assign(window, { __paperReturnDrivers: [] as Animation[] });
                const began = performance.now();
                const transformAnimations = (node: HTMLElement | null) =>
                  node
                    ?.getAnimations()
                    .filter(
                      (animation) =>
                        animation.effect instanceof KeyframeEffect &&
                        animation.effect
                          .getKeyframes()
                          .some((frame) => typeof frame.transform === "string"),
                    ) ?? [];
                const readPose = (
                  node: HTMLElement,
                  animation: Animation | undefined,
                ): NativePoseWindow => {
                  const effect = animation?.effect;
                  const timeBefore =
                    typeof animation?.currentTime === "number" ? animation.currentTime : null;
                  const progressBefore = effect?.getComputedTiming().progress ?? null;
                  const transform = getComputedStyle(node).transform;
                  const timeAfter =
                    typeof animation?.currentTime === "number" ? animation.currentTime : null;
                  const progressAfter = effect?.getComputedTiming().progress ?? null;
                  const pose = new DOMMatrixReadOnly(transform);
                  return {
                    x: pose.m41,
                    y: pose.m42,
                    sx: pose.m11,
                    sy: pose.m22,
                    timeBefore,
                    timeAfter,
                    progressBefore,
                    progressAfter,
                  };
                };
                const readKeyframes = (
                  animation: Animation | undefined,
                ): ReturnKeyframes | null => {
                  if (!(animation?.effect instanceof KeyframeEffect)) return null;
                  const keys = animation.effect.getKeyframes();
                  if (!keys.length) return null;
                  const poses = [keys[0], keys[keys.length - 1]].map((key) => {
                    const pose = new DOMMatrixReadOnly(String(key.transform));
                    return { x: pose.m41, y: pose.m42, sx: pose.m11, sy: pose.m22 };
                  });
                  return { from: poses[0], to: poses[1] };
                };
                const observer = new MutationObserver((records) => {
                  for (const record of records)
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
                    const portal = document.querySelector<HTMLElement>(".replay-handoff-strip");
                    const nativeAnimations = transformAnimations(paper);
                    const portalAnimations = transformAnimations(portal);
                    const native = nativeAnimations[0];
                    const portalNative = portalAnimations[0];
                    if (native) drivers.add(native);
                    if (portalNative) drivers.add(portalNative);
                    Object.assign(window, { __paperReturnDrivers: [...drivers] });
                    keyframes ??= readKeyframes(native);
                    portalKeyframes ??= readKeyframes(portalNative);
                    const pose = readPose(paper, native);
                    const portalPose = portal ? readPose(portal, portalNative) : null;
                    const nativeDuration = native
                      ? Number(native.effect?.getTiming().duration)
                      : null;
                    const fold =
                      pose.timeAfter !== null && nativeDuration
                        ? Math.max(0, Math.min(1, pose.timeAfter / nativeDuration))
                        : Number(paper.dataset.replayFold);
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
                    frames.push({
                      ...pose,
                      at: time,
                      fold,
                      semanticFold: Number(paper.dataset.replayFold),
                      nativeState: native?.playState ?? null,
                      nativeTime: pose.timeAfter,
                      nativeDuration,
                      nativeRate: native?.playbackRate ?? null,
                      nativeTransformCount: nativeAnimations.length,
                      portalTransformCount: portalAnimations.length,
                      owner: paper.dataset.stripOwner ?? "local",
                      opacity: Number(getComputedStyle(paper).opacity),
                      width: paper.offsetWidth,
                      height: paper.offsetHeight,
                      bodyDisplay: getComputedStyle(paper.querySelector(".replay-question-body")!)
                        .display,
                      footerDisplay: getComputedStyle(
                        paper.querySelector(".replay-question-footer")!,
                      ).display,
                      flipOrigin: paper.dataset.flipOrigin ?? "",
                      scrollX,
                      scrollY,
                      portalPose,
                    });
                  }
                  if ((!seen || (active && paper)) && time - began < 10000)
                    requestAnimationFrame(tick);
                  else {
                    observer.disconnect();
                    resolve({ frames, portalCreatedAt, destination, keyframes, portalKeyframes });
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
          check(returning.length).toBeGreaterThanOrEqual(8);
          check(returning.every((frame) => frame.nativeState === "running")).toBe(true);
          check(returning.every((frame) => frame.nativeTime !== null && frame.nativeTime > 0)).toBe(
            true,
          );
          check(returning.every((frame) => frame.nativeRate === 1)).toBe(true);
          check(returning.every((frame) => frame.nativeTransformCount === 1)).toBe(true);
          check(returning[0].fold).toBeLessThan(0.2);
          check(returning.at(-1)!.fold).toBeGreaterThan(0.85);
          check(returning.some((frame) => frame.fold >= 0.45 && frame.fold <= 0.65)).toBe(true);
          check(sample.keyframes).not.toBeNull();
          check(sample.destination).not.toBeNull();
          const keys = sample.keyframes!;
          const dx = keys.to.x - keys.from.x;
          const dy = keys.to.y - keys.from.y;
          const distance = Math.hypot(dx, dy);
          check(distance).toBeGreaterThan(0);
          // Compare native endpoints with independent receiver geometry, including near-coincident centers.
          check(Math.abs(keys.to.x - sample.destination!.x)).toBeLessThan(distance * 0.004 + 0.01);
          check(Math.abs(keys.to.y - sample.destination!.y)).toBeLessThan(distance * 0.004 + 0.01);
          const early = returning.find((frame) => frame.fold >= 0.15 && frame.fold < 0.35);
          check(early).toBeDefined();
          check(Math.hypot(early!.x - keys.from.x, early!.y - keys.from.y)).toBeGreaterThan(
            distance * 0.05,
          );
          const gaps: number[] = [];
          for (let at = 0; at < returning.length; at++) {
            const frame = returning[at];
            // Running WebKit style and Animation clocks are sampled on separate engine phases.
            // All coordinates from one computed matrix must share the same measured scale phase.
            const scalePhase = (frame.sx - keys.from.sx) / (keys.to.sx - keys.from.sx);
            check(scalePhase).toBeGreaterThanOrEqual(0);
            check(scalePhase).toBeLessThanOrEqual(1);
            expectNativePoseAtAmount(frame, keys, scalePhase, distance * 0.004);
            check(Math.abs(frame.sx - frame.sy)).toBeLessThan(0.001);
            if (frame.owner === "body") {
              check(frame.portalTransformCount).toBe(1);
              check(frame.portalPose).not.toBeNull();
              check(sample.portalKeyframes).not.toBeNull();
              const portalKeys = sample.portalKeyframes!;
              const portalPhase =
                (frame.portalPose!.sx - portalKeys.from.sx) /
                (portalKeys.to.sx - portalKeys.from.sx);
              expectNativePoseAtAmount(
                frame.portalPose!,
                portalKeys,
                portalPhase,
                distance * 0.004,
              );
            }
            if (at > 0) {
              const previous = returning[at - 1];
              check(frame.fold).toBeGreaterThanOrEqual(previous.fold);
              check(frame.sx).toBeLessThanOrEqual(previous.sx + 0.001);
              check(
                Math.hypot(frame.x - keys.from.x, frame.y - keys.from.y),
              ).toBeGreaterThanOrEqual(
                Math.hypot(previous.x - keys.from.x, previous.y - keys.from.y) - 0.01,
              );
              if (frame.fold > previous.fold) gaps.push(frame.at - previous.at);
            }
          }
          const firstReturn = sample.frames.findIndex((frame) => frame.fold > 0);
          check(sample.frames.slice(firstReturn).every((frame) => frame.fold > 0)).toBe(true);
          const sorted = gaps.sort((a, b) => a - b);
          // Preserve the previous two-frame budget, including WebKit's 1ms timestamp rounding.
          if (mode === "display")
            check(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThanOrEqual(34.4);
          check(sample.portalCreatedAt.every((fold) => fold === 0)).toBe(true);
          if (kind === "handoff") {
            check(sample.portalCreatedAt).toHaveLength(1);
            check(sample.frames.every((frame) => frame.flipOrigin === "continuing-paper")).toBe(
              true,
            );
            check(
              Math.max(...sample.frames.map((frame) => frame.scrollY)) -
                Math.min(...sample.frames.map((frame) => frame.scrollY)),
            ).toBeLessThanOrEqual(1);
            check(
              Math.max(...sample.frames.map((frame) => frame.scrollX)) -
                Math.min(...sample.frames.map((frame) => frame.scrollX)),
            ).toBeLessThanOrEqual(1);
            check(sample.frames.every((frame) => frame.width <= 320 && frame.height <= 100)).toBe(
              true,
            );
            check(
              sample.frames.every(
                (frame) => frame.bodyDisplay === "none" && frame.footerDisplay === "none",
              ),
            ).toBe(true);
            check(returning.every((frame) => frame.owner === "body")).toBe(true);
            check(sample.portalKeyframes).not.toBeNull();
            for (const end of ["from", "to"] as const) {
              check(Math.abs(sample.portalKeyframes![end].x - keys[end].x)).toBeLessThan(0.01);
              check(Math.abs(sample.portalKeyframes![end].y - keys[end].y)).toBeLessThan(0.01);
              check(Math.abs(sample.portalKeyframes![end].sx - keys[end].sx)).toBeLessThan(0.001);
            }
            await check(page.locator(".replay-handoff-strip")).toHaveCount(0);
            await check(page.locator(".c-root")).toHaveClass(/at-result/);
          }
          await page.screenshot({ path: testInfo.outputPath(`${kind}-${width}.png`) });
        } finally {
          check(blocked).toEqual([]);
        }
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
      const transform = getComputedStyle(probe.node).transform;
      const pose = new DOMMatrixReadOnly(transform);
      return {
        at: performance.now(),
        time: Number(probe.animation.currentTime),
        duration: Number(probe.animation.effect?.getTiming().duration),
        rate: probe.animation.playbackRate,
        state: probe.animation.playState,
        pending: probe.animation.pending,
        transform,
        pose: { x: pose.m41, y: pose.m42, sx: pose.m11, sy: pose.m22 },
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
      // Explicit static currentTime fixture verifies easing while every native part is held.
      const curve = await page.evaluate(async () => {
        const probe = (window as unknown as { __nativeReturnProbe: NativeReturnProbe })
          .__nativeReturnProbe;
        const originalTimes = probe.parts.map((part) => part.currentTime);
        const duration = Number(probe.animation.effect?.getTiming().duration);
        const raw = (probe.animation.effect as KeyframeEffect).getKeyframes();
        const ends = [raw[0], raw[raw.length - 1]].map((key) => {
          const matrix = new DOMMatrixReadOnly(String(key.transform));
          return { x: matrix.m41, y: matrix.m42, sx: matrix.m11, sy: matrix.m22 };
        });
        const frames: Array<{ fraction: number; time: number; pose: ReturnPose }> = [];
        const settle = () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        for (const fraction of [0, 0.15, 0.3, 0.5, 0.7, 0.9, 1]) {
          for (const part of probe.parts) part.currentTime = Math.round(duration * fraction);
          await settle();
          const matrix = new DOMMatrixReadOnly(getComputedStyle(probe.node).transform);
          frames.push({
            fraction,
            time: Number(probe.animation.currentTime),
            pose: { x: matrix.m41, y: matrix.m42, sx: matrix.m11, sy: matrix.m22 },
          });
        }
        for (let index = 0; index < probe.parts.length; index++) {
          probe.parts[index].pause();
          probe.parts[index].currentTime = originalTimes[index];
        }
        await settle();
        return {
          coverage: "explicit static paused-currentTime fixture",
          dynamicFrameQualityMeasured: false,
          keyframes: { from: ends[0], to: ends[1] },
          frames,
        };
      });
      const curveDistance = Math.hypot(
        curve.keyframes.to.x - curve.keyframes.from.x,
        curve.keyframes.to.y - curve.keyframes.from.y,
      );
      for (const frame of curve.frames) {
        expect(frame.time).toBe(Math.round(frame.fraction * paused.duration));
        const amount = frame.fraction * frame.fraction * (3 - 2 * frame.fraction);
        expectNativePoseAtAmount(frame.pose, curve.keyframes, amount, curveDistance * 0.004);
        expect(
          Math.abs(
            frame.pose.sx -
              (curve.keyframes.from.sx +
                (curve.keyframes.to.sx - curve.keyframes.from.sx) * amount),
          ),
        ).toBeLessThan(0.001);
        expect(Math.abs(frame.pose.sx - frame.pose.sy)).toBeLessThan(0.001);
      }
      await testInfo.attach(`explicit-static-native-curve-${kind}`, {
        body: JSON.stringify(curve),
        contentType: "application/json",
      });
      const restored = await nativeReturnSnapshot(page);
      expect(restored.time).toBe(paused.time);
      expect(Math.abs(restored.pose.x - paused.pose.x)).toBeLessThan(curveDistance * 0.004);
      expect(Math.abs(restored.pose.y - paused.pose.y)).toBeLessThan(curveDistance * 0.004);
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
      expect(changed.transform).toBe(restored.transform);
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
        body: JSON.stringify({ paused, held, restored, changed, resumed }),
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

  test("paper theater: final summary receipt stays visible and hands its existing paper onward", async ({
    page,
  }, testInfo) => {
    const blocked = await openReplay(page);
    const summary = steps.findLastIndex((step) => step.replayAction?.kind === "summary_submit");
    await page.getByRole("button", { name: `第 ${summary} 步`, exact: true }).click();
    const sampling = page.evaluate(
      () =>
        new Promise<
          Array<{
            kind: string;
            step: number;
            paper: boolean;
            paperId: number | null;
            fold: number;
            acknowledgement: string;
            acknowledgementOpacity: number;
            confirmationButtons: number;
            pointerOpacity: number;
          }>
        >((resolve) => {
          const frames: Array<{
            kind: string;
            step: number;
            paper: boolean;
            paperId: number | null;
            fold: number;
            acknowledgement: string;
            acknowledgementOpacity: number;
            confirmationButtons: number;
            pointerOpacity: number;
          }> = [];
          const identities = new WeakMap<HTMLElement, number>();
          let identity = 0;
          const began = performance.now();
          const tick = () => {
            const root = document.querySelector<HTMLElement>(".c-root");
            const paper = root?.querySelector<HTMLElement>(".replay-question-scene");
            if (paper && !identities.has(paper)) identities.set(paper, ++identity);
            const footer = paper?.querySelector<HTMLElement>(":scope > .replay-question-footer");
            const heading = paper?.querySelector<HTMLElement>(
              ":scope > .replay-question-heading h3",
            );
            const pointer = paper?.querySelector<HTMLElement>(":scope > .replay-question-pointer");
            const opacity = (node: HTMLElement | null | undefined) => {
              let value = node ? 1 : 0;
              for (let element = node; element; element = element.parentElement) {
                const style = getComputedStyle(element);
                if (style.display === "none" || style.visibility === "hidden") return 0;
                value *= Number(style.opacity);
              }
              return value;
            };
            frames.push({
              kind: root?.dataset.replayKind ?? "",
              step: Number(
                document
                  .querySelector('.c-time [aria-current="step"]')
                  ?.getAttribute("aria-label")
                  ?.match(/\d+/)?.[0] ?? 0,
              ),
              paper: !!paper,
              paperId: paper ? identities.get(paper)! : null,
              fold: Number(paper?.dataset.replayFold ?? 0),
              acknowledgement: heading?.textContent?.trim() ?? "",
              acknowledgementOpacity: opacity(heading),
              confirmationButtons: footer?.querySelectorAll("[data-replay-confirm]").length ?? 0,
              pointerOpacity: opacity(pointer),
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
    expect(acknowledged.every((frame) => frame.paper && frame.confirmationButtons === 0)).toBe(
      true,
    );
    expect(
      acknowledged.some(
        (frame) =>
          frame.acknowledgement.includes("摘要确认已接受") && frame.acknowledgementOpacity > 0.9,
      ),
    ).toBe(true);
    expect(acknowledged.every((frame) => frame.pointerOpacity <= 0.02)).toBe(true);
    const acceptedIndex = steps.findIndex((step) => step.replayAction?.kind === "summary_confirm");
    const intervening = steps
      .slice(summary + 1, acceptedIndex)
      .flatMap((step, offset) =>
        step.clarificationRun
          ? [{ role: step.clarificationRun.role, step: summary + offset + 2 }]
          : [],
      );
    expect(intervening.map((step) => step.role)).toEqual(["A", "B", "C"]);
    expect(
      intervening.every((step) =>
        frames.some((frame) => frame.step === step.step && frame.kind === "model"),
      ),
    ).toBe(true);
    const handoff = frames.find((frame) => frame.kind === "handoff" && frame.paper);
    expect(handoff?.paperId).toBe(acknowledged.at(-1)?.paperId);
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
    requestsByPage.set(page, blocked);
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
}
