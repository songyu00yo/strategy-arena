import { expect, type Page } from "@playwright/test";

type SealNativeState = {
  at: number;
  state: string;
  time: number | null;
  duration: number;
  rate: number;
  progress: number | null;
  opacity: number;
  connected: boolean;
  size: { width: number; height: number };
  pose: { x: number; y: number; scale: number; angle: number };
  bounds: { left: number; top: number; right: number; bottom: number };
  viewport: { width: number; height: number };
  timing: EffectTiming;
  keyframes: ComputedKeyframe[];
};
export type SealNativeObservation = {
  first: SealNativeState | null;
  finished: SealNativeState | null;
  cleanup: {
    connected: boolean;
    state: string | null;
    time: number | null;
    finishHandler: boolean;
  };
};
type SealProbeWindow = Window & {
  __nativeSealProbe?: { read: () => SealNativeObservation; stop: () => void };
};

export async function installNativeSealProbe(page: Page) {
  await page.evaluate(() => {
    let node: HTMLElement | null = null;
    let animation: Animation | null = null;
    let first: SealNativeState | null = null;
    let finished: SealNativeState | null = null;
    const readState = (): SealNativeState => {
      const style = getComputedStyle(node!);
      const transform = new DOMMatrixReadOnly(style.transform);
      const rect = node!.getBoundingClientRect();
      const width =
        parseFloat(style.width) +
        (style.boxSizing === "border-box"
          ? 0
          : parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.borderRightWidth));
      const height =
        parseFloat(style.height) +
        (style.boxSizing === "border-box"
          ? 0
          : parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom) +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.borderBottomWidth));
      return {
        at: performance.now(),
        state: animation!.playState,
        time: typeof animation!.currentTime === "number" ? animation!.currentTime : null,
        duration: Number(animation!.effect!.getTiming().duration),
        rate: animation!.playbackRate,
        progress: animation!.effect!.getComputedTiming().progress ?? null,
        opacity: Number(style.opacity),
        connected: node!.isConnected,
        size: { width, height },
        pose: {
          x: transform.m41,
          y: transform.m42,
          scale: Math.hypot(transform.m11, transform.m12),
          angle: (Math.atan2(transform.m12, transform.m11) * 180) / Math.PI,
        },
        bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        timing: animation!.effect!.getTiming(),
        keyframes: (animation!.effect as KeyframeEffect).getKeyframes(),
      };
    };
    const capture = () => {
      node = document.querySelector<HTMLElement>(".c-seal");
      animation =
        node
          ?.getAnimations()
          .find(
            (candidate) =>
              candidate.effect instanceof KeyframeEffect &&
              candidate.effect.getKeyframes().some((frame) => "opacity" in frame),
          ) ?? null;
      if (!animation) return;
      first = readState();
      // Capture before the application's finish handler removes the real seal.
      animation.addEventListener(
        "finish",
        () => {
          finished = readState();
        },
        { once: true, capture: true },
      );
      observer.disconnect();
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    (window as SealProbeWindow).__nativeSealProbe = {
      read: () => ({
        first,
        finished,
        cleanup: {
          connected: node?.isConnected ?? false,
          state: animation?.playState ?? null,
          time: typeof animation?.currentTime === "number" ? animation.currentTime : null,
          finishHandler: animation?.onfinish != null,
        },
      }),
      stop: () => observer.disconnect(),
    };
    capture();
  });
}

export async function readNativeSealProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as SealProbeWindow).__nativeSealProbe;
    probe?.stop();
    return probe?.read() ?? null;
  });
}

export function expectNativeSealLifecycle(observed: SealNativeObservation | null) {
  const check = expect.configure({ soft: true });
  check(observed?.first).toBeTruthy();
  check(observed?.finished).toBeTruthy();
  if (!observed?.first || !observed.finished) return;
  const { first, finished, cleanup } = observed;
  check(first.duration).toBe(220);
  check(first.rate).toBe(1);
  check(first.timing.direction).toBe("normal");
  check(first.timing.iterations).toBe(1);
  check(first.timing.fill).toBe("both");
  check(first.timing.easing?.replace(/\s/g, "")).toBe("cubic-bezier(0.22,1,0.3,1)");
  check(first.keyframes.map((key) => key.computedOffset)).toEqual([0, 0.45, 1]);
  check(first.keyframes.map((key) => Number(key.opacity))).toEqual([0, 1, 1]);
  check(first.keyframes.every((key) => typeof key.transform === "string")).toBe(true);
  check(first.time).not.toBeNull();
  check(first.time!).toBeGreaterThanOrEqual(0);
  check(first.time!).toBeLessThan(220);
  check(first.connected).toBe(true);
  check(finished.state).toBe("finished");
  check(finished.time).toBe(220);
  check(finished.time!).toBeGreaterThan(first.time!);
  check(finished.progress).toBe(1);
  check(finished.opacity).toBeGreaterThanOrEqual(0.98);
  check(finished.connected).toBe(true);
  check(finished.pose.scale).toBeCloseTo(1, 3);
  check(finished.pose.angle).toBeCloseTo(-7, 3);
  check(finished.pose.x).toBeCloseTo(-finished.size.width / 2, 3);
  check(finished.pose.y).toBeCloseTo(-finished.size.height / 2, 3);
  const center = {
    x: (finished.bounds.left + finished.bounds.right) / 2,
    y: (finished.bounds.top + finished.bounds.bottom) / 2,
  };
  for (const key of first.keyframes) {
    const transform = String(key.transform);
    const angle = (Number(transform.match(/rotate\(([-\d.]+)deg\)/)?.[1]) * Math.PI) / 180;
    const scale = Number(transform.match(/scale\(([-\d.]+)\)/)?.[1]);
    const halfWidth =
      ((finished.size.width * Math.abs(Math.cos(angle)) +
        finished.size.height * Math.abs(Math.sin(angle))) *
        scale) /
      2;
    const halfHeight =
      ((finished.size.width * Math.abs(Math.sin(angle)) +
        finished.size.height * Math.abs(Math.cos(angle))) *
        scale) /
      2;
    check(Number.isFinite(halfWidth) && Number.isFinite(halfHeight)).toBe(true);
    check(center.x - halfWidth).toBeGreaterThanOrEqual(0);
    check(center.x + halfWidth).toBeLessThanOrEqual(finished.viewport.width);
    check(center.y - halfHeight).toBeGreaterThanOrEqual(0);
    check(center.y + halfHeight).toBeLessThanOrEqual(finished.viewport.height);
  }
  check(cleanup.connected).toBe(false);
  check(cleanup.state).toBe("idle");
  check(cleanup.time).toBeNull();
  check(cleanup.finishHandler).toBe(false);
}
