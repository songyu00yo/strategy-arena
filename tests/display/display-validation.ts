import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as baseTest, type Page } from "@playwright/test";
import { checkDisplayPower } from "../../scripts/check-display-power.mjs";
export { currentDisplayModes } from "../../scripts/check-display-power.mjs";
export type { CurrentDisplayMode } from "../../scripts/check-display-power.mjs";

// A persistent, freshly allocated profile is required for Chrome Settings.
// The base page fixture still creates the application page in this context.
export const displayTest = baseTest.extend({
  context: async (
    {
      playwright,
      browserName,
      launchOptions,
      contextOptions,
      baseURL,
      viewport,
      reducedMotion,
      hasTouch,
      isMobile,
      deviceScaleFactor,
      locale,
      colorScheme,
      screen,
      timezoneId,
      acceptDownloads,
      bypassCSP,
      extraHTTPHeaders,
      forcedColors,
      geolocation,
      httpCredentials,
      ignoreHTTPSErrors,
      javaScriptEnabled,
      offline,
      permissions,
      serviceWorkers,
      userAgent,
      contrast,
      actionTimeout,
      navigationTimeout,
    },
    provideContext,
    info,
  ) => {
    expect(browserName).toBe("chromium");
    expect(launchOptions.args ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /--(?:disable-frame-rate-limit|disable-gpu-vsync|enable-begin-frame-control|user-data-dir)(?:=|$)/,
        ),
      ]),
    );
    expect(contextOptions.recordVideo).toBeUndefined();
    const profile = await mkdtemp(join(tmpdir(), "strategy-arena-display-"));
    let context;
    try {
      context = await playwright.chromium.launchPersistentContext(profile, {
        ...launchOptions,
        ...contextOptions,
        channel: "chrome",
        headless: false,
        baseURL,
        viewport,
        reducedMotion,
        hasTouch,
        isMobile,
        deviceScaleFactor,
        locale,
        colorScheme,
        screen,
        timezoneId,
        acceptDownloads,
        bypassCSP,
        extraHTTPHeaders,
        forcedColors,
        geolocation,
        httpCredentials,
        ignoreHTTPSErrors,
        javaScriptEnabled,
        offline,
        permissions,
        serviceWorkers,
        userAgent,
        contrast,
      });
      context.setDefaultTimeout(actionTimeout);
      context.setDefaultNavigationTimeout(navigationTimeout);
      const setup = context.pages()[0] ?? (await context.newPage());
      await setup.bringToFront();
      await setup.goto("chrome://settings/performance");
      const energy = setup.getByRole("switch", { name: /^(?:节能模式|Energy Saver)$/i });
      await info.attach("display-owned-settings-before-toggle", {
        body: JSON.stringify({
          profile,
          switchCount: await energy.count(),
          settingsText: await setup.locator("body").innerText(),
        }),
        contentType: "application/json",
      });
      await expect(energy).toHaveCount(1);
      const before = await energy.getAttribute("aria-checked");
      if (before === "true") await energy.click();
      await expect(energy).toHaveAttribute("aria-checked", "false");
      const after = await energy.getAttribute("aria-checked");
      await info.attach("display-owned-energy-settings", {
        body: JSON.stringify({
          profile,
          profileAllocation: "mkdtemp-owned-for-this-test",
          userProfileChanged: false,
          frameRateFlagsAdded: false,
          before,
          after,
          url: setup.url(),
          settingsText: await setup.locator("body").innerText(),
        }),
        contentType: "application/json",
      });
      await setup.goto("about:blank");
      await provideContext(context);
    } finally {
      let contextClosed = false;
      try {
        await context?.close();
        contextClosed = true;
      } finally {
        await rm(profile, { recursive: true, force: true });
        await info.attach("display-owned-profile-cleanup", {
          body: JSON.stringify({
            profile,
            contextClosed,
            profileRemoved: true,
            userProfileChanged: false,
          }),
          contentType: "application/json",
        });
      }
    }
  },
});

export type DisplaySessionFrame = {
  at: number;
  visible: boolean;
  focused: boolean;
  reducedMotion: boolean;
};

declare global {
  interface Window {
    __physicalDisplaySession?: {
      url: string;
      frames: DisplaySessionFrame[];
      id: number;
    };
  }
}

function installSessionMonitor() {
  const state = { url: location.href, frames: [] as DisplaySessionFrame[], id: 0 };
  window.__physicalDisplaySession = state;
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const tick = (at: number) => {
    state.frames.push({
      at,
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
      reducedMotion: preference.matches,
    });
    state.id = requestAnimationFrame(tick);
  };
  state.id = requestAnimationFrame(tick);
}

export function assertDisplaySession(frames: readonly DisplaySessionFrame[]) {
  expect(
    frames.length,
    "The visible display session must contain actual rAF observations.",
  ).toBeGreaterThan(0);
  expect(
    frames.every((frame) => frame.visible),
    "The display session stays visible.",
  ).toBe(true);
  expect(
    frames.every((frame) => frame.focused),
    "The display session stays focused.",
  ).toBe(true);
  expect(
    frames.every((frame) => !frame.reducedMotion),
    "The display session keeps normal motion enabled.",
  ).toBe(true);
}

export function enableDisplayValidation() {
  const test = displayTest;
  const qualified = new WeakSet<Page>();
  test.beforeEach(async ({ page }, info) => {
    await page.bringToFront();
    const power = checkDisplayPower();
    await info.attach("display-power-qualification", {
      body: JSON.stringify(power),
      contentType: "application/json",
    });
    expect(power.status).toBe("eligible");
    expect(power.powerConnected).toBe(true);
    expect(power.lowPowerMode).toBe(false);
    const current = power.currentMode;
    expect(current?.refreshRate).toBeGreaterThanOrEqual(120);

    const calibration = await page.evaluate(
      () =>
        new Promise<{ frames: DisplaySessionFrame[]; intervals: number[] }>((resolve) => {
          const frames: DisplaySessionFrame[] = [];
          const intervals: number[] = [];
          const began = performance.now();
          const preference = matchMedia("(prefers-reduced-motion: reduce)");
          let previous: number | null = null;
          const tick = (at: number) => {
            if (previous !== null) intervals.push(at - previous);
            previous = at;
            frames.push({
              at,
              visible: document.visibilityState === "visible",
              focused: document.hasFocus(),
              reducedMotion: preference.matches,
            });
            if (at - began < 2500) requestAnimationFrame(tick);
            else resolve({ frames, intervals });
          };
          requestAnimationFrame(tick);
        }),
    );
    const sorted = [...calibration.intervals].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    await info.attach("display-session-calibration", {
      body: JSON.stringify({
        ...calibration,
        median,
        p95,
        currentMode: current,
        measurement:
          "OS-current-mode and visible focused browser rAF calibration. Physical scanout requires separate measurement.",
      }),
      contentType: "application/json",
    });
    assertDisplaySession(calibration.frames);
    expect(sorted.length).toBeGreaterThanOrEqual(240);
    expect(median).toBeLessThanOrEqual(10);
    expect(p95).toBeLessThanOrEqual(12.5);
    // Each navigation installs the same lightweight qualification monitor.
    await page.addInitScript(installSessionMonitor);
    await page.evaluate(installSessionMonitor);
    qualified.add(page);
  });

  test.afterEach(async ({ page }, info) => {
    if (!qualified.has(page)) return;
    expect(
      page.isClosed(),
      "A qualified display session remains available for evidence collection.",
    ).toBe(false);
    const session = await page.evaluate(() => {
      const state = window.__physicalDisplaySession;
      if (state) cancelAnimationFrame(state.id);
      return state ?? null;
    });
    expect(
      session,
      "The qualified document retains its continuous display observations.",
    ).not.toBeNull();
    await info.attach("display-session-observations", {
      body: JSON.stringify(session),
      contentType: "application/json",
    });
    assertDisplaySession(session!.frames);
  });
}
