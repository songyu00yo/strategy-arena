import { expect, type Page } from "@playwright/test";

export type NativeMotionSample = {
  at: number;
  reason: string;
  time: number | null;
  rate: number;
  state: string;
  progress: number | null;
};
export type NativeMotionEntry = {
  id: number;
  nodeId: number;
  target: string;
  text: string;
  step: number | null;
  ancestors: string[];
  duration: number | string;
  easing: string;
  keys: Record<string, unknown>[];
  samples: NativeMotionSample[];
  slots: string[];
};
type NativeMotionWindow = Window & {
  __nativeMotionProbe?: { read: () => NativeMotionEntry[]; stop: () => NativeMotionEntry[] };
};

// Observe actual application-created WAAPI handles and native lifecycle clocks.
// No application timelines or currentTime getters are replaced.
export async function installNativeMotionProbe(page: Page, selectors: Record<string, string> = {}) {
  await page.evaluate((selectors) => {
    const target = window as NativeMotionWindow;
    target.__nativeMotionProbe?.stop();
    const original = Element.prototype.animate;
    const originalCancel = Animation.prototype.cancel;
    const originalPlay = Animation.prototype.play;
    const originalPause = Animation.prototype.pause;
    const nodes = new WeakMap<Element, number>();
    const entries = new Map<Animation, NativeMotionEntry>();
    let nodeId = 0;
    let id = 0;
    let stopped = false;
    const capture = (animation: Animation, entry: NativeMotionEntry, reason: string) => {
      if (stopped) return;
      const time = animation.currentTime;
      entry.samples.push({
        at: performance.now(),
        reason,
        time: typeof time === "number" ? time : null,
        rate: animation.playbackRate,
        state: animation.playState,
        progress: animation.effect?.getComputedTiming().progress ?? null,
      });
      if (
        [
          "created",
          "first-native-handle",
          "before-cancel",
          "finish",
          "cancel",
          "play",
          "pause",
        ].includes(reason)
      )
        dispatchEvent(new Event("test-native-motion-observation"));
    };
    const observe = (animation: Animation, reason: string) => {
      if (entries.has(animation)) return entries.get(animation)!;
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element)) return null;
      const node = effect.target;
      if (!nodes.has(node)) nodes.set(node, ++nodeId);
      const timing = effect.getTiming();
      const ancestors: string[] = [];
      ancestors.push(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`);
      for (let parent = node.parentElement; parent; parent = parent.parentElement)
        ancestors.push(`${parent.tagName.toLowerCase()}.${[...parent.classList].join(".")}`);
      const entry: NativeMotionEntry = {
        id: ++id,
        nodeId: nodes.get(node)!,
        target: `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`,
        text: node.textContent ?? "",
        step:
          Number(
            document
              .querySelector('.c-time [aria-current="step"]')
              ?.getAttribute("aria-label")
              ?.match(/\d+/)?.[0],
          ) || null,
        ancestors,
        duration:
          typeof timing.duration === "number" ? timing.duration : String(timing.duration ?? "auto"),
        easing: timing.easing ?? "linear",
        keys: effect.getKeyframes(),
        samples: [],
        slots: Object.entries(selectors)
          .filter(([, selector]) => {
            const owner = document.querySelector(selector);
            return owner && (owner === node || owner.contains(node) || node.contains(owner));
          })
          .map(([name]) => name),
      };
      entries.set(animation, entry);
      capture(animation, entry, reason);
      animation.addEventListener("finish", () => capture(animation, entry, "finish"));
      animation.addEventListener("cancel", () => capture(animation, entry, "cancel"));
      return entry;
    };
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args);
      observe(animation, "created");
      return animation;
    };
    Animation.prototype.play = function () {
      const entry = observe(this, "first-native-handle");
      const result = originalPlay.call(this);
      if (entry) capture(this, entry, "play");
      return result;
    };
    Animation.prototype.pause = function () {
      const entry = observe(this, "first-native-handle");
      const result = originalPause.call(this);
      if (entry) capture(this, entry, "pause");
      return result;
    };
    Animation.prototype.cancel = function () {
      const entry = entries.get(this);
      if (entry) capture(this, entry, "before-cancel");
      return originalCancel.call(this);
    };
    const read = () => {
      for (const [animation, entry] of entries) capture(animation, entry, "read");
      return [...entries.values()];
    };
    const tick = () => {
      if (stopped) return;
      for (const [animation, entry] of entries)
        if (animation.playState !== "idle") capture(animation, entry, "raf-native-clock");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    target.__nativeMotionProbe = {
      read,
      stop: () => {
        try {
          return read();
        } finally {
          stopped = true;
          Element.prototype.animate = original;
          Animation.prototype.cancel = originalCancel;
          Animation.prototype.play = originalPlay;
          Animation.prototype.pause = originalPause;
        }
      },
    };
  }, selectors);
}

export async function readNativeMotionProbe(page: Page, stop = false) {
  return page.evaluate((stop) => {
    const probe = (window as NativeMotionWindow).__nativeMotionProbe;
    if (!probe) throw new Error("The actual native motion probe was not installed.");
    return stop ? probe.stop() : probe.read();
  }, stop);
}

export async function cleanupNativeMotionProbe(page: Page) {
  if (page.isClosed()) return;
  await page.evaluate(() => (window as NativeMotionWindow).__nativeMotionProbe?.stop());
}

export function assertNativeMotion(entries: NativeMotionEntry[]) {
  expect(entries.length, "Actual native animation handles were captured.").toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry.nodeId).toBeGreaterThan(0);
    expect(entry.keys.length).toBeGreaterThanOrEqual(2);
    expect(Number(entry.duration)).toBeGreaterThan(0);
    expect(entry.samples.some((sample) => sample.time !== null)).toBe(true);
    expect(entry.samples.every((sample) => Number.isFinite(sample.rate) && sample.rate > 0)).toBe(
      true,
    );
    for (const sample of entry.samples.filter((sample) => sample.time !== null)) {
      expect(sample.time!).toBeGreaterThanOrEqual(0);
      expect(sample.progress === null || (sample.progress >= 0 && sample.progress <= 1)).toBe(true);
    }
  }
}
