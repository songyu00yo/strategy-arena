import { expect, test, type Page } from "@playwright/test";
import {
  configureFixtureModels,
  confirmFixtureIntake,
  installQuickIntakeFixture,
} from "./intake.fixture";
import { advanceFixture, fixtureSnapshot } from "./ui.fixture";

type RouteWindow = Window & {
  __routeInputs: Array<{ type: string; trusted: boolean; name?: string }>;
  __routeReveals: Array<{ t: number; transition: boolean }>;
};

type TrustedTimelineWindow = Window & {
  __trustedTimelineEvents: Array<Record<string, unknown>>;
  __trustedTimelineIntent: number | null;
};

async function observeTrustedTimelineTargets(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as TrustedTimelineWindow;
    state.__trustedTimelineEvents = [];
    state.__trustedTimelineIntent = null;
    const ids = new WeakMap<Element, number>();
    let identity = 0;
    const id = (node: Element | null) => {
      if (!node) return null;
      if (!ids.has(node)) ids.set(node, ++identity);
      return ids.get(node)!;
    };
    const currentStep = () =>
      document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ?? null;
    const record = (event: Event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      const pointer = event instanceof MouseEvent ? event : null;
      const touch = event instanceof TouchEvent ? event.changedTouches[0] : null;
      const x = pointer?.clientX ?? touch?.clientX ?? null;
      const y = pointer?.clientY ?? touch?.clientY ?? null;
      const hit = x === null || y === null ? null : document.elementFromPoint(x, y);
      const button =
        target?.closest<HTMLButtonElement>('.c-time button[aria-label^="第 "]') ?? null;
      const entry: Record<string, unknown> = {
        type: event.type,
        at: performance.now(),
        eventTimeStamp: event.timeStamp,
        trusted: event.isTrusted,
        intendedStep: state.__trustedTimelineIntent,
        pointerType: event instanceof PointerEvent ? event.pointerType : touch ? "touch" : null,
        pointerId: event instanceof PointerEvent ? event.pointerId : null,
        x,
        y,
        targetTag: target?.tagName ?? null,
        targetClass: target?.getAttribute("class") ?? null,
        targetLabel: target?.closest("button")?.getAttribute("aria-label") ?? null,
        targetId: id(target),
        targetConnected: target?.isConnected ?? false,
        timelineTarget: button?.getAttribute("aria-label") ?? null,
        timelineTargetId: id(button),
        hitTag: hit?.tagName ?? null,
        hitLabel: hit?.closest("button")?.getAttribute("aria-label") ?? null,
        hitId: id(hit),
        currentStep: currentStep(),
        scrollX,
        scrollY,
        railBox: document.querySelector(".c-time")?.getBoundingClientRect().toJSON() ?? null,
        pointerCaptured:
          event instanceof PointerEvent && !!target?.hasPointerCapture(event.pointerId),
        defaultPrevented: event.defaultPrevented,
      };
      state.__trustedTimelineEvents.push(entry);
      if (event.type === "click")
        requestAnimationFrame(() => {
          entry.nextFrameAt = performance.now();
          entry.nextFrameStep = currentStep();
          entry.nextFrameScrollY = scrollY;
        });
    };
    for (const type of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "touchstart",
      "touchend",
      "touchcancel",
      "click",
    ])
      document.addEventListener(type, record, true);
  });
}

// Explicit synthetic records, intercepted APIs and trusted browser input.
async function fixture(page: Page, longResult = false) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const inputs: unknown[] = [];
    const reveals: unknown[] = [];
    Object.assign(window, { __routeInputs: inputs, __routeReveals: reveals });
    window.addEventListener("pagereveal", (event) =>
      reveals.push({
        t: performance.now(),
        transition: !!(event as Event & { viewTransition?: unknown }).viewTransition,
      }),
    );
    for (const type of ["pointerdown", "pointerup", "click"]) {
      window.addEventListener(
        type,
        (event) => {
          const pointer = event as MouseEvent;
          const target = event.target instanceof Element ? event.target : null;
          const control = target?.closest("button,a");
          const track = document.querySelector(".c-track");
          const result = document.querySelector(".c-result-region");
          inputs.push({
            type,
            t: performance.now(),
            trusted: event.isTrusted,
            name: control?.getAttribute("aria-label") || control?.textContent?.trim(),
            tag: target?.tagName,
            x: pointer.clientX,
            y: pointer.clientY,
            scrollY,
            trackTop: track?.getBoundingClientRect().top,
            resultHeight: result?.getBoundingClientRect().height,
            shellTransitionName: document.querySelector<HTMLElement>(
              ".site-shell,.recorded-entry-shell",
            )?.style.viewTransitionName,
            pseudoAnimations: document
              .getAnimations()
              .filter((animation) =>
                ((animation.effect as KeyframeEffect)?.pseudoElement ?? "").includes(
                  "view-transition",
                ),
              ).length,
          });
        },
        true,
      );
    }
  });
  const snapshot = configureFixtureModels(fixtureSnapshot());
  for (let i = 0; i < 5; i++) advanceFixture(snapshot);
  if (longResult) {
    snapshot.versions[0].verdict!.rationale =
      "【测试替身】这段较长的说明用于核对完整结论与时间轴的可见交互。".repeat(45);
  }
  const calls: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(`${route.request().method()} ${path}`);
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-route-fixture",
          commit: "fixture",
          model: snapshot.model,
          accessGranted: true,
          requiresAccessCode: false,
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit fixture\n\n" });
    return route.fulfill({ json: snapshot });
  });
  await installQuickIntakeFixture(page, snapshot);
  return calls;
}

async function firstVisiblePage(page: Page) {
  await page.waitForFunction(() => (window as unknown as RouteWindow).__routeReveals.length > 0);
  return page.evaluate(async () => {
    const transition = (document as unknown as { activeViewTransition?: { ready: Promise<void> } })
      .activeViewTransition;
    await transition?.ready.catch(() => {});
    // One paint separates these frames so input targets the displayed page
    // while its native transition continues.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const form = document.querySelector(".recorded-entry-form");
    return {
      at: performance.now(),
      nativeTransition: !!transition,
      rootName: getComputedStyle(document.documentElement).viewTransitionName,
      formOpacity: form ? getComputedStyle(form).opacity : undefined,
      oldPageOpacity: getComputedStyle(document.documentElement, "::view-transition-old(root)")
        .opacity,
      newPageOpacity: getComputedStyle(document.documentElement, "::view-transition-new(root)")
        .opacity,
    };
  });
}

for (const width of [1440, 390]) {
  test(`first arena appearance accepts an immediate trusted timeline click at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await fixture(page);
    await page.goto("/");
    await confirmFixtureIntake(page);
    const tick = page.getByRole("button", { name: "第 4 步", exact: true });
    await tick.waitFor({ state: "attached" });
    const box = await tick.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const observations = await page.evaluate(() => ({
      inputs: (window as unknown as RouteWindow).__routeInputs,
      shellName: getComputedStyle(document.querySelector(".site-shell")!).viewTransitionName,
      root: document.querySelector(".c-root")?.className,
    }));
    await info.attach("first-visible-native-inputs", {
      body: JSON.stringify({ box, observations }),
      contentType: "application/json",
    });
    await expect(tick).toHaveAttribute("aria-current", "step");
    expect(observations.shellName).toBe("none");
    const actual = observations.inputs.filter((event) => event.type === "click").at(-1);
    expect(actual?.trusted).toBe(true);
    expect(actual?.name).toBe("第 4 步");
    await page.screenshot({ path: info.outputPath("first-click.png") });
  });

  test(`document navigation keeps immediate destination buttons live at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await fixture(page);
    await page.goto("/");
    await page.getByRole("button", { name: "先看需求梳理示例", exact: true }).click();
    const link = page.locator('a.recorded-example-card[href="/examples/personal-website"]');
    await link.click({ noWaitAfter: true });
    await page.waitForURL("**/examples/personal-website", { waitUntil: "commit" });
    const firstVisible = await firstVisiblePage(page);
    const button = page.getByRole("button", { name: "暂停自动开始", exact: true });
    await button.waitFor({ state: "attached" });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByRole("button", { name: "继续自动开始", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "继续自动开始", exact: true })).toBeFocused();
    const forward = await page.evaluate(() => ({
      reveals: (window as unknown as RouteWindow).__routeReveals,
      inputs: (window as unknown as RouteWindow).__routeInputs,
      shellName: getComputedStyle(document.querySelector(".recorded-entry-shell")!)
        .viewTransitionName,
      navigation: performance
        .getEntriesByType("navigation")
        .map((entry) => ({ name: entry.name, type: (entry as PerformanceNavigationTiming).type })),
    }));
    await page.getByRole("link", { name: "返回案例", exact: true }).click({ noWaitAfter: true });
    await page.waitForURL("**/?examples=open", { waitUntil: "commit" });
    const backVisible = await firstVisiblePage(page);
    const dialog = page.getByRole("dialog", { name: "先看需求梳理示例", exact: true });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole("button", { name: "关闭弹窗", exact: true });
    const closeBox = await close.boundingBox();
    expect(closeBox).not.toBeNull();
    await page.mouse.click(closeBox!.x + closeBox!.width / 2, closeBox!.y + closeBox!.height / 2);
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "先看需求梳理示例", exact: true })).toBeFocused();
    const back = await page.evaluate(() => ({
      reveals: (window as unknown as RouteWindow).__routeReveals,
      inputs: (window as unknown as RouteWindow).__routeInputs,
      navigation: performance
        .getEntriesByType("navigation")
        .map((entry) => ({ name: entry.name, type: (entry as PerformanceNavigationTiming).type })),
    }));
    expect(forward.navigation[0].name).toContain("/examples/personal-website");
    expect(forward.shellName).toBe("none");
    expect(firstVisible.rootName).toBe("none");
    expect(backVisible.rootName).toBe("none");
    expect(
      forward.inputs.some(
        (event) => event.type === "pointerdown" && event.trusted && event.name === "暂停自动开始",
      ),
    ).toBe(true);
    expect(
      back.inputs.some(
        (event) => event.type === "pointerdown" && event.trusted && event.name === "关闭弹窗",
      ),
    ).toBe(true);
    await info.attach("native-route-inputs", {
      body: JSON.stringify({ firstVisible, backVisible, forward, back }),
      contentType: "application/json",
    });
    await page.screenshot({ path: info.outputPath("returned-home.png") });
  });
}

test("original five forced timeline clicks retain actual trusted targets after adoption", async ({
  page,
}, info) => {
  await fixture(page);
  await page.goto("/");
  await confirmFixtureIntake(page);
  await expect(page.getByRole("heading", { name: "测试裁决：先做最小样片" })).toBeVisible();
  for (const step of [1, 6, 2, 8, 4])
    await page.getByRole("button", { name: `第 ${step} 步`, exact: true }).click({ force: true });
  const observations = await page.evaluate(() => ({
    inputs: (window as unknown as RouteWindow).__routeInputs,
    current: document.querySelector(".c-time [aria-current=step]")?.getAttribute("aria-label"),
  }));
  await info.attach("forced-click-native-targets", {
    body: JSON.stringify(observations),
    contentType: "application/json",
  });
  expect(
    observations.inputs
      .filter((event) => event.type === "click" && /^第 \d+ 步$/.test(event.name ?? ""))
      .map((event) => event.name),
  ).toEqual(["第 1 步", "第 6 步", "第 2 步", "第 8 步", "第 4 步"]);
  await expect(page.getByRole("button", { name: "第 4 步", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.waitForTimeout(1600);
  await expect(page.getByRole("button", { name: "第 4 步", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  const region = page.locator(".c-result-region");
  expect(
    await region.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "第 4 步", exact: true })).toBeFocused();
  // A mouse-focused tick releases its footprint when the pointer leaves.
  await page.mouse.move(1, 1);
  await expect
    .poll(() => region.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(0);
});

test("keyboard timeline focus retains long-result space through reversals and releases on blur", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto("/");
  await confirmFixtureIntake(page);
  await page.getByRole("button", { name: "看完整结论", exact: true }).click();
  const region = page.locator(".c-result-region");
  await expect
    .poll(() =>
      region.evaluate((element) => element.getAnimations().some((a) => a.playState === "running")),
    )
    .toBe(false);
  const height = await region.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(200);
  await page.getByRole("button", { name: "第 1 步", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  expect(await region.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(
    height,
    0,
  );
  await page.keyboard.press("End");
  await expect(region).toHaveAttribute("aria-hidden", "false");
  await page.keyboard.press("Home");
  await expect(region).toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "放映速度", exact: true }).focus();
  await expect
    .poll(() => region.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(0);
});

test.describe("touch timeline footprint", () => {
  test.use({ hasTouch: true });
  test("rapid touch selection releases its buffer and foreground details preserve the footprint", async ({
    page,
  }, info) => {
    await observeTrustedTimelineTargets(page);
    const calls = await fixture(page);
    const taps: Array<Record<string, unknown>> = [];
    try {
      await page.goto("/");
      await confirmFixtureIntake(page);
      const region = page.locator(".c-result-region");
      for (const step of [1, 6, 2, 8, 4]) {
        const before = await page
          .getByRole("button", { name: `第 ${step} 步`, exact: true })
          .evaluate((node, intended) => {
            (window as unknown as TrustedTimelineWindow).__trustedTimelineIntent = intended;
            return {
              at: performance.now(),
              connected: node.isConnected,
              rect: node.getBoundingClientRect().toJSON(),
              scrollX,
              scrollY,
              currentStep:
                document
                  .querySelector('.c-time [aria-current="step"]')
                  ?.getAttribute("aria-label") ?? null,
              rail: document.querySelector(".c-time")?.getBoundingClientRect().toJSON() ?? null,
              animations:
                document
                  .querySelector(".c-result-region")
                  ?.getAnimations()
                  .map((animation) => ({
                    state: animation.playState,
                    time: animation.currentTime,
                    duration: animation.effect?.getTiming().duration,
                  })) ?? [],
            };
          }, step);
        const box = await page
          .getByRole("button", { name: `第 ${step} 步`, exact: true })
          .boundingBox();
        expect(box).not.toBeNull();
        taps.push({ step, before, box });
        await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
      }
      await expect(page.getByRole("button", { name: "第 4 步", exact: true })).toHaveAttribute(
        "aria-current",
        "step",
      );
      const rapidEvents = await page.evaluate(() =>
        (window as unknown as TrustedTimelineWindow).__trustedTimelineEvents.filter(
          (event) => event.type === "click" && event.intendedStep !== null,
        ),
      );
      expect(rapidEvents.map((event) => event.timelineTarget)).toEqual(
        [1, 6, 2, 8, 4].map((step) => `第 ${step} 步`),
      );
      await page.evaluate(() => {
        (window as unknown as TrustedTimelineWindow).__trustedTimelineIntent = null;
      });
      expect(
        await region.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(0);
      // A touch reader leaves through an actual outside gesture, matching focus and hover lifetimes.
      const outside = await page.locator(".c-slate h1").boundingBox();
      expect(outside).not.toBeNull();
      await page.touchscreen.tap(outside!.x + outside!.width / 2, outside!.y + outside!.height / 2);
      await expect(page.getByRole("button", { name: "第 4 步", exact: true })).toHaveAttribute(
        "aria-current",
        "step",
      );
      await expect
        .poll(() => region.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(0);
      await page.getByRole("button", { name: /回到结果/ }).click();
      await expect
        .poll(() =>
          region.evaluate((element) =>
            element.getAnimations().some((a) => a.playState === "running"),
          ),
        )
        .toBe(false);
      const box = await page.getByRole("button", { name: "第 1 步", exact: true }).boundingBox();
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
        "aria-current",
        "step",
      );
      await page.getByRole("button", { name: "查看第 1 步", exact: true }).focus();
      await expect(page.getByRole("button", { name: "查看第 1 步", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      const details = page.getByRole("dialog", { name: "第 1 步 · 独立提案", exact: true });
      await expect(details).toBeVisible();
      await page.waitForTimeout(400);
      expect(
        await region.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await expect(details).not.toBeVisible();
      await expect
        .poll(() => region.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(0);
    } finally {
      const observed = await page.evaluate(() => ({
        events: (window as unknown as TrustedTimelineWindow).__trustedTimelineEvents,
        currentStep:
          document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ??
          null,
        scrollX,
        scrollY,
        rail: document.querySelector(".c-time")?.getBoundingClientRect().toJSON() ?? null,
      }));
      await info.attach("trusted-touch-targets", {
        body: JSON.stringify({
          classification: "explicit-fixture-real-coordinate-touch-target-observation",
          sequence: [1, 6, 2, 8, 4],
          taps,
          ...observed,
          calls,
        }),
        contentType: "application/json",
      });
    }
  });
});
