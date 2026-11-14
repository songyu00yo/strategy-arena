import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

type SystemDisplay = {
  _name?: string;
  _spdisplays_displayID?: string;
  _spdisplays_resolution?: string;
  spdisplays_refreshRate?: string;
  spdisplays_main?: string;
  spdisplays_online?: string;
  spdisplays_asleep?: string;
};

export type CurrentDisplayMode = {
  displayId: string | null;
  name: string | null;
  main: boolean;
  online: boolean;
  asleep: boolean;
  currentResolution: string | null;
  refreshRate: number | null;
  refreshRateSource: string | null;
};

export function currentDisplayModes(report: {
  SPDisplaysDataType?: Array<{ spdisplays_ndrvs?: SystemDisplay[] }>;
}): CurrentDisplayMode[] {
  return (report.SPDisplaysDataType ?? []).flatMap((adapter) =>
    (adapter.spdisplays_ndrvs ?? []).map((display) => {
      const resolution = display._spdisplays_resolution ?? "";
      const resolutionRate = resolution.match(/@\s*(\d+(?:\.\d+)?)\s*Hz\b/i);
      const explicitRate = display.spdisplays_refreshRate?.match(/^(\d+(?:\.\d+)?)\s*Hz$/i);
      const rate = resolutionRate?.[1] ?? explicitRate?.[1];
      return {
        displayId: display._spdisplays_displayID ?? null,
        name: display._name ?? null,
        main: display.spdisplays_main === "spdisplays_yes",
        online: display.spdisplays_online === "spdisplays_yes",
        asleep: display.spdisplays_asleep === "spdisplays_yes",
        currentResolution: resolution || null,
        refreshRate: rate === undefined ? null : Number(rate),
        refreshRateSource: resolutionRate
          ? "_spdisplays_resolution"
          : explicitRate
            ? "spdisplays_refreshRate"
            : null,
      };
    }),
  );
}

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
  const qualified = new WeakSet<Page>();
  test.beforeEach(async ({ page }, info) => {
    await page.bringToFront();
    expect(process.platform, "OS refresh-mode capture currently supports macOS.").toBe("darwin");
    const raw = execFileSync("system_profiler", ["SPDisplaysDataType", "-json"], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const modes = currentDisplayModes(JSON.parse(raw));
    await info.attach("display-system-profiler", { body: raw, contentType: "application/json" });
    await info.attach("display-current-modes", {
      body: JSON.stringify({ capturedAt: new Date().toISOString(), modes }),
      contentType: "application/json",
    });
    const current = modes.find((mode) => mode.main && mode.online && !mode.asleep);
    expect(
      current,
      "An awake online main display must report its current refresh mode.",
    ).toBeDefined();
    expect(
      current!.refreshRate,
      "The current OS mode must explicitly report a refresh rate.",
    ).not.toBeNull();
    expect(current!.refreshRate!).toBeGreaterThanOrEqual(120);

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
