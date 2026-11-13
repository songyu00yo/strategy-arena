// Saved real-model simulation record with explicit health fixtures. No model providers are contacted.
import { expect, test, type Page } from "@playwright/test";

async function openDetail(page: Page, keyboard = false) {
  const unexpected: string[] = [];
  page.on("pageerror", (error) => unexpected.push("page error: " + error.message));
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
  const opener = page.getByRole("button", { name: "查看第 1 步", exact: true });
  if (keyboard) {
    await opener.focus();
    await page.keyboard.press("Enter");
  } else await opener.click();
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

// These are normal running animations. The only supplied data is the health fixture
// above and the explicitly labelled text entered into the form.
async function waitForMovingPaper(page: Page, name: string, start = 0.15, end = 0.65) {
  await page.waitForFunction(
    ({ name, start, end }) => {
      const dialog = [...document.querySelectorAll<HTMLElement>("dialog[open]")].find(
        (node) => node.querySelector(".modal-heading h2")?.textContent?.trim() === name,
      );
      const animation = dialog
        ?.getAnimations()
        .find(
          (entry) =>
            entry.effect instanceof KeyframeEffect &&
            entry.effect.getKeyframes().some((frame) => typeof frame.transform === "string"),
        );
      const time = animation?.currentTime;
      const duration = Number(animation?.effect?.getTiming().duration);
      if (
        !dialog ||
        !animation ||
        dialog.dataset.overlayMotionPhase !== "handoff" ||
        animation.pending ||
        typeof time !== "number" ||
        time < duration * start ||
        time > duration * end
      )
        return false;
      Object.assign(window, {
        __movingPaper: {
          dialog,
          animation,
          parts: dialog.getAnimations({ subtree: true }),
          time,
          duration,
        },
      });
      return true;
    },
    { name, start, end },
  );
}

async function closedPaperState(page: Page) {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __movingPaper?: { time: number; duration: number; parts: Animation[] };
      }
    ).__movingPaper;
    const nativeTransitions =
      probe?.parts.filter((part): part is CSSTransition => part instanceof CSSTransition) ?? [];
    return {
      interruptedAt: probe?.time,
      duration: probe?.duration,
      oldEffectsCancelled: probe?.parts
        .filter((part) => !(part instanceof CSSTransition))
        .every(
          (part) =>
            part.playState === "idle" &&
            part.currentTime === null &&
            part.onfinish === null &&
            part.oncancel === null,
        ),
      oldTransitionsSettled: nativeTransitions.every(
        (part) =>
          part.onfinish === null &&
          part.oncancel === null &&
          ["background-size", "box-shadow", "border-color", "background-color", "color"].includes(
            part.transitionProperty,
          ) &&
          ((part.playState === "idle" && part.currentTime === null) ||
            (part.playState === "finished" &&
              typeof part.currentTime === "number" &&
              part.currentTime >= Number(part.effect?.getComputedTiming().endTime))),
      ),
      nativeTransitions: nativeTransitions.map((part) => ({
        property: part.transitionProperty,
        target:
          part.effect instanceof KeyframeEffect && part.effect.target instanceof Element
            ? { tag: part.effect.target.tagName, className: part.effect.target.className }
            : null,
        state: part.playState,
        currentTime: part.currentTime,
        endTime: part.effect?.getComputedTiming().endTime,
        hasFinishCallback: part.onfinish !== null,
        hasCancelCallback: part.oncancel !== null,
      })),
      held: document.querySelector(".c-root")?.classList.contains("held"),
      overflow: document.body.style.overflow,
      snapshots: document.querySelectorAll(".overlay-handoff-snapshot").length,
      pulled: document.querySelectorAll("[data-step-source].pulled, [data-step-source].past-gap")
        .length,
    };
  });
}

async function expectPaperReleased(page: Page) {
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator(".overlay-handoff-snapshot")).toHaveCount(0);
  await expect(page.locator(".c-root")).not.toHaveClass(/held/);
  await expect(page.locator("[data-step-source].pulled, [data-step-source].past-gap")).toHaveCount(
    0,
  );
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
}

async function openSupplement(page: Page) {
  await page.waitForTimeout(380);
  await page.locator(".c-pull").getByRole("button", { name: "补充或质疑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "补充这一步", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

type HeightClick = { at: number; height: number; expanded: boolean; trusted: boolean };

function measuredHeightTransition(
  frames: Awaited<ReturnType<typeof endProbe>>,
  click: HeightClick,
  target: number,
  until: number,
) {
  const samples = frames.flatMap((frame) => {
    const paper = frame.dialogs.find((dialog) => dialog.name === "调整条件");
    return paper && frame.at >= click.at && frame.at < until
      ? [{ at: frame.at, height: paper.height }]
      : [];
  });
  const moving = samples.filter(
    (sample, index) => index > 0 && Math.abs(sample.height - samples[index - 1].height) > 0.1,
  );
  const reached = samples.find((sample) => Math.abs(sample.height - target) <= 1);
  expect(moving.length).toBeGreaterThan(0);
  const motionSpanMs = moving.at(-1)!.at - moving[0].at;
  const intermediate = samples.filter(
    (sample) =>
      sample.height > Math.min(click.height, target) + 2 &&
      sample.height < Math.max(click.height, target) - 2,
  );
  expect(click.trusted).toBe(true);
  expect(Math.abs(target - click.height)).toBeGreaterThan(100);
  expect(intermediate.length).toBeGreaterThan(0);
  expect(reached).toBeDefined();
  expect(reached!.at - click.at).toBeGreaterThanOrEqual(80);
  expect(motionSpanMs).toBeGreaterThanOrEqual(140);
  expect(
    samples.some((sample) => sample.at - click.at < 80 && Math.abs(sample.height - target) <= 1),
  ).toBe(false);
  return { samples, motionSpanMs, firstAtTargetMs: reached!.at - click.at };
}

for (const width of [1440, 390]) {
  test(`normal settled height: long complete editing expands, reverses and preserves scroll at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const unexpected = await openDetail(page);
    const supplement = await openSupplement(page);
    await expect(supplement).not.toHaveAttribute("data-overlay-motion-active", "true");
    await supplement.getByRole("button", { name: "调整条件", exact: true }).click();
    const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
    await expect(conditions).not.toHaveAttribute("data-overlay-motion-active", "true");
    // The regression concerns an idle paper, after its handoff and initial field animation finish.
    await page.waitForTimeout(250);
    const toggle = conditions.getByRole("button", { name: /^完整编辑/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const collapsed = (await conditions.boundingBox())!.height;
    const originalPageScroll = await page.evaluate(() => scrollY);
    await page.evaluate(() => {
      const clicks: HeightClick[] = [];
      const record = (event: MouseEvent) => {
        const button = (event.target as Element | null)?.closest("button");
        if (!button?.textContent?.trim().startsWith("完整编辑")) return;
        clicks.push({
          at: performance.now(),
          height: button.closest("dialog")!.getBoundingClientRect().height,
          expanded: button.getAttribute("aria-expanded") === "true",
          trusted: event.isTrusted,
        });
      };
      document.addEventListener("click", record, true);
      Object.assign(window, { __conditionHeightProbe: { clicks, record } });
    });
    await beginProbe(page);
    await toggle.click();
    await page.waitForTimeout(300);
    const expanded = (await conditions.boundingBox())!.height;
    const complete = conditions.locator('[data-disclosure-region][id$="-complete"]');
    await expect
      .poll(() => complete.evaluate((node) => (node as HTMLElement).style.height))
      .toBe("auto");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    expect(Math.abs((await conditions.boundingBox())!.height - collapsed)).toBeLessThanOrEqual(1);

    await toggle.click();
    await page.waitForFunction(
      ({ collapsed, expanded }) => {
        const paper = document.querySelector<HTMLElement>("dialog[open].modal-side");
        const height = paper?.getBoundingClientRect().height ?? 0;
        return height > collapsed + (expanded - collapsed) * 0.25 && height < expanded - 16;
      },
      { collapsed, expanded },
    );
    // Native keyboard activation interrupts the moving control without waiting for stable geometry.
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const region = document.querySelector<HTMLElement>(
        '[data-disclosure-region][id$="-complete"]',
      );
      return region?.getAnimations().some((animation) => {
        const time = animation.currentTime;
        const duration = Number(animation.effect?.getTiming().duration);
        return typeof time === "number" && time > 16 && time < duration * 0.5;
      });
    });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(Math.abs((await conditions.boundingBox())!.height - expanded)).toBeLessThanOrEqual(1);
    const frames = await endProbe(page);
    const clicks = await page.evaluate(() => {
      const state = (
        window as unknown as {
          __conditionHeightProbe: { clicks: HeightClick[]; record: (event: MouseEvent) => void };
        }
      ).__conditionHeightProbe;
      document.removeEventListener("click", state.record, true);
      return state.clicks;
    });
    await info.attach("settled-height-original-geometry", {
      body: JSON.stringify({ collapsed, expanded, clicks, originalPageScroll, frames }),
      contentType: "application/json",
    });
    expect(clicks).toHaveLength(5);
    expect(clicks.map((click) => click.expanded)).toEqual([false, true, false, true, false]);
    const opening = measuredHeightTransition(frames, clicks[0], expanded, clicks[1].at);
    const closing = measuredHeightTransition(frames, clicks[1], collapsed, clicks[2].at);
    for (const click of clicks.slice(3)) {
      expect(click.height).toBeGreaterThan(collapsed + 2);
      expect(click.height).toBeLessThan(expanded - 2);
    }
    expect(
      frames.every((frame) =>
        frame.dialogs.every(
          (paper) => paper.height >= collapsed - 1 && paper.height <= expanded + 1,
        ),
      ),
    ).toBe(true);
    expect(frames.every((frame) => frame.scrollY === originalPageScroll)).toBe(true);
    await expect
      .poll(() => complete.evaluate((node) => (node as HTMLElement).style.height))
      .toBe("auto");
    const body = conditions.locator(".condition-editor-body");
    const scrollRange = await body.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(scrollRange).toBeGreaterThan(100);
    const bodyBox = (await body.boundingBox())!;
    await page.mouse.move(bodyBox.x + bodyBox.width - 2, bodyBox.y + bodyBox.height / 2);
    await page.mouse.wheel(0, 5000);
    await expect
      .poll(async () => Math.abs(scrollRange - (await body.evaluate((node) => node.scrollTop))))
      .toBeLessThanOrEqual(1);
    const previousScroll = await body.evaluate((node) => node.scrollTop);
    await info.attach("native-scroll-range-and-offset", {
      body: JSON.stringify({ scrollRange, scrollTop: previousScroll }),
      contentType: "application/json",
    });
    await conditions.getByRole("button", { name: /^补充说明/ }).click();
    await page.waitForTimeout(260);
    expect(
      Math.abs((await body.evaluate((node) => node.scrollTop)) - previousScroll),
    ).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => scrollY)).toBe(originalPageScroll);
    await info.attach("settled-visible-height-and-reversal", {
      body: JSON.stringify({
        collapsed,
        expanded,
        clicks,
        opening,
        closing,
        previousScroll,
      }),
      contentType: "application/json",
    });
    await conditions.getByRole("button", { name: "取消", exact: true }).click();
    await expectPaperReleased(page);
    expect(await page.evaluate(() => scrollY)).toBe(originalPageScroll);
    expect(unexpected).toEqual([]);
  });

  test(`normal interruption: Escape closes a moving handoff and releases its source at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const unexpected = await openDetail(page);
    const supplement = await openSupplement(page);
    await beginProbe(page);
    await waitForMovingPaper(page, "补充这一步", 0.4, 0.64);
    const snapshotBefore = await supplement
      .locator(".overlay-handoff-snapshot")
      .evaluate((node) => Number(getComputedStyle(node).opacity));
    expect(snapshotBefore).toBeLessThanOrEqual(0.01);
    await page.keyboard.press("Escape");
    const snapshotClosing = await supplement
      .locator(".overlay-handoff-snapshot")
      .evaluate((node) => Number(getComputedStyle(node).opacity));
    expect(snapshotClosing).toBeLessThanOrEqual(0.01);
    await expectPaperReleased(page);
    const frames = await endProbe(page);
    const state = await closedPaperState(page);
    await info.attach("escape-interrupted-handoff", {
      body: JSON.stringify({ state, snapshotBefore, snapshotClosing, frames }),
      contentType: "application/json",
    });
    expect(state.interruptedAt).toBeGreaterThan(0);
    expect(state.interruptedAt!).toBeLessThan(state.duration!);
    expect(state.oldEffectsCancelled).toBe(true);
    expect(state.oldTransitionsSettled).toBe(true);
    expect(frames.some((frame) => frame.dialogs.some((dialog) => dialog.phase === "closing"))).toBe(
      true,
    );
    const lastPaper = frames.findLastIndex((frame) =>
      frame.dialogs.some((dialog) => dialog.opacity > 0.02),
    );
    expect(
      frames
        .slice(0, lastPaper + 1)
        .every((frame) => frame.held && frame.dialogs.some((dialog) => dialog.opacity > 0)),
    ).toBe(true);
    expect(unexpected).toEqual([]);
  });

  test(`normal interruption: a real click retargets an unfinished handoff at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const unexpected = await openDetail(page);
    const supplement = await openSupplement(page);
    await beginProbe(page);
    await waitForMovingPaper(page, "补充这一步", 0.42, 0.68);
    await page.evaluate(() => {
      const probe = (
        window as unknown as {
          __movingPaper: { dialog: HTMLElement; animation: Animation; duration: number };
        }
      ).__movingPaper;
      const button = [...probe.dialog.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "调整条件",
      )!;
      const record = (event: MouseEvent) => {
        if ((event.target as Element | null)?.closest("button") !== button) return;
        Object.assign(window, {
          __retargetClick: {
            trusted: event.isTrusted,
            time: Number(probe.animation.currentTime),
            duration: probe.duration,
            phase: probe.dialog.dataset.overlayMotionPhase,
          },
        });
        document.removeEventListener("click", record, true);
      };
      document.addEventListener("click", record, true);
    });
    // Direct mouse coordinates avoid Playwright waiting for a deliberately moving button to settle.
    const box = await supplement
      .getByRole("button", { name: "调整条件", exact: true })
      .boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
    await expect(conditions).toBeVisible();
    const click = await page.evaluate(
      () =>
        (
          window as unknown as {
            __retargetClick: { trusted: boolean; time: number; duration: number; phase: string };
          }
        ).__retargetClick,
    );
    expect(click.trusted).toBe(true);
    expect(click.phase).toBe("handoff");
    expect(click.time).toBeGreaterThan(0);
    expect(click.time).toBeLessThan(click.duration);
    await expect(conditions).not.toHaveAttribute("data-overlay-motion-active", "true");
    const frames = await endProbe(page);
    expect(
      frames.every((frame) => frame.held && frame.dialogs.some((dialog) => dialog.opacity > 0)),
    ).toBe(true);
    const state = await closedPaperState(page);
    await info.attach("real-click-retarget", {
      body: JSON.stringify({ click, state, frames }),
      contentType: "application/json",
    });
    expect(state.oldEffectsCancelled).toBe(true);
    expect(state.oldTransitionsSettled).toBe(true);
    await conditions.getByRole("button", { name: "取消", exact: true }).click();
    await expectPaperReleased(page);
    expect(unexpected).toEqual([]);
  });

  test(`normal layout: viewport and expanded content resize one moving paper at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const unexpected = await openDetail(page);
    const supplement = await openSupplement(page);
    await waitForMovingPaper(page, "补充这一步", 0.4, 0.6);
    const snapshotBeforeResize = await supplement
      .locator(".overlay-handoff-snapshot")
      .evaluate((node) => Number(getComputedStyle(node).opacity));
    expect(snapshotBeforeResize).toBeLessThanOrEqual(0.01);
    // Passive instrumentation records the interrupted native transform before cancel.
    // It leaves the browser clock and animation behavior intact.
    await page.evaluate(() => {
      const probe = (
        window as unknown as {
          __movingPaper: { dialog: HTMLElement; animation: Animation; duration: number };
        }
      ).__movingPaper;
      const element = probe.dialog;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      const box = element.getBoundingClientRect();
      const old = {
        left: box.left - matrix.m41,
        top: box.top - matrix.m42,
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
      const originalCancel = probe.animation.cancel;
      probe.animation.cancel = function () {
        const pose = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        Object.assign(window, {
          __resizeStart: {
            time: Number(this.currentTime),
            duration: probe.duration,
            expected: {
              x: old.left + pose.m41,
              y: old.top + pose.m42,
              width: old.width * pose.m11,
              height: old.height * pose.m22,
            },
          },
        });
        originalCancel.call(this);
      };
      window.addEventListener(
        "resize",
        () => {
          const box = element.getBoundingClientRect();
          Object.assign(window, {
            __synchronousResize: {
              phase: element.dataset.overlayMotionPhase,
              originalState: probe.animation.playState,
              snapshotOpacity: element.querySelector(".overlay-handoff-snapshot")
                ? Number(
                    getComputedStyle(element.querySelector(".overlay-handoff-snapshot")!).opacity,
                  )
                : 0,
              box: { x: box.x, y: box.y, width: box.width, height: box.height },
            },
          });
        },
        { once: true },
      );
    });
    await beginProbe(page);
    await page.setViewportSize({
      width: width === 390 ? 430 : 1280,
      height: width === 390 ? 780 : 760,
    });
    await page.waitForFunction(() => {
      const dialog = document.querySelector<HTMLElement>("dialog[open].overlay-motion");
      if (dialog?.dataset.overlayMotionPhase !== "resizing") return false;
      const animation = dialog
        .getAnimations()
        .find(
          (entry) =>
            entry.effect instanceof KeyframeEffect &&
            entry.effect.getKeyframes().some((frame) => typeof frame.transform === "string"),
        );
      if (!animation || !(animation.effect instanceof KeyframeEffect)) return false;
      const first = new DOMMatrixReadOnly(String(animation.effect.getKeyframes()[0].transform));
      const current = new DOMMatrixReadOnly(getComputedStyle(dialog).transform);
      const box = dialog.getBoundingClientRect();
      Object.assign(window, {
        __resizeDestination: {
          from: {
            x: box.left - current.m41 + first.m41,
            y: box.top - current.m42 + first.m42,
            width: dialog.offsetWidth * first.m11,
            height: dialog.offsetHeight * first.m22,
          },
        },
      });
      return true;
    });
    const redirect = await page.evaluate(() => ({
      old: (
        window as unknown as {
          __resizeStart: {
            time: number;
            duration: number;
            expected: { x: number; y: number; width: number; height: number };
          };
        }
      ).__resizeStart,
      next: (
        window as unknown as {
          __resizeDestination: { from: { x: number; y: number; width: number; height: number } };
        }
      ).__resizeDestination,
    }));
    const synchronous = await page.evaluate(
      () =>
        (
          window as unknown as {
            __synchronousResize: {
              phase: string;
              originalState: string;
              snapshotOpacity: number;
              box: { x: number; y: number; width: number; height: number };
            };
          }
        ).__synchronousResize,
    );
    expect(synchronous.phase).toBe("resizing");
    expect(synchronous.originalState).toBe("idle");
    expect(synchronous.snapshotOpacity).toBeLessThanOrEqual(0.01);
    expect(redirect.old.time).toBeGreaterThan(0);
    expect(redirect.old.time).toBeLessThan(redirect.old.duration);
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(redirect.old.expected[key] - redirect.next.from[key])).toBeLessThanOrEqual(1);
      expect(Math.abs(redirect.old.expected[key] - synchronous.box[key])).toBeLessThanOrEqual(1);
    }
    await expect(supplement).not.toHaveAttribute("data-overlay-motion-active", "true");
    await supplement.getByRole("button", { name: "调整条件", exact: true }).click();
    const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
    await expect(conditions).not.toHaveAttribute("data-overlay-motion-active", "true");
    await conditions.getByRole("button", { name: /完整编辑/ }).click();
    await expect(conditions.getByRole("textbox", { name: "目标", exact: true })).toBeVisible();
    await page.waitForTimeout(280);
    const frames = await endProbe(page);
    expect(
      frames.every((frame) => frame.held && frame.dialogs.some((dialog) => dialog.opacity > 0)),
    ).toBe(true);
    const fit = await conditions.boundingBox();
    expect(fit).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(fit!.x).toBeGreaterThanOrEqual(0);
    expect(fit!.y).toBeGreaterThanOrEqual(0);
    expect(fit!.x + fit!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(fit!.y + fit!.height).toBeLessThanOrEqual(viewport.height + 1);
    await info.attach("native-viewport-and-content-redirect", {
      body: JSON.stringify({ redirect, synchronous, snapshotBeforeResize, fit, frames }),
      contentType: "application/json",
    });
    await page.keyboard.press("Escape");
    await expectPaperReleased(page);
    expect(unexpected).toEqual([]);
  });

  test(`normal keyboard: handoff focus returns to the original usable opener at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const unexpected = await openDetail(page, true);
    await page.waitForTimeout(380);
    const action = page.locator(".c-pull").getByRole("button", { name: "补充或质疑", exact: true });
    await action.focus();
    await page.keyboard.press("Enter");
    const supplement = page.getByRole("dialog", { name: "补充这一步", exact: true });
    await expect(
      supplement.getByRole("textbox", { name: "你想补充或询问什么？", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expectPaperReleased(page);
    const opener = page.getByRole("button", { name: "查看第 1 步", exact: true });
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".c-pull")).toBeVisible();
    const focus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute("aria-label"),
    }));
    await info.attach("keyboard-focus-after-reopen", {
      body: JSON.stringify(focus),
      contentType: "application/json",
    });
    await page.keyboard.press("Escape");
    await expectPaperReleased(page);
    expect(unexpected).toEqual([]);
  });

  test(`normal cleanup: an old handoff cannot retire a newly reopened source at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const unexpected = await openDetail(page);
    const source = page.locator('[data-step-source="0"]');
    await openSupplement(page);
    await expect(source).toHaveClass(/pulled/);
    await page.keyboard.press("Escape");
    await expectPaperReleased(page);
    await page.getByRole("button", { name: "查看第 1 步", exact: true }).click();
    await expect(page.locator(".c-pull")).toBeVisible();
    await expect(source).toHaveClass(/pulled/);
    await page.waitForTimeout(1700);
    await expect(source).toHaveClass(/pulled/);
    await expect(page.locator(".c-root")).toHaveClass(/held/);
    const state = await page.evaluate(() => ({
      open: document.querySelectorAll("dialog[open]").length,
      snapshots: document.querySelectorAll(".overlay-handoff-snapshot").length,
      sourceClass: document.querySelector('[data-step-source="0"]')?.className,
    }));
    expect(state.open).toBe(1);
    expect(state.snapshots).toBe(0);
    await info.attach("old-source-lease-retirement", {
      body: JSON.stringify(state),
      contentType: "application/json",
    });
    await page.keyboard.press("Escape");
    await expectPaperReleased(page);
    expect(unexpected).toEqual([]);
  });
}
