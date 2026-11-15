import { createMotionScope } from "./console/motion-runtime";

export const LIVE_PAPER_TIMING = {
  cue: 180,
  shape: 300,
  transfer: 420,
  receive: 300,
  reveal: 350,
  answer: 600,
  agent: 500,
  seal: 2600,
} as const;

export function liveAnchor(name: string): HTMLElement | null {
  const node = document.querySelector<HTMLElement>(`[data-motion-anchor="${CSS.escape(name)}"]`);
  if (node && visible(node)) return node;
  const fallback = document.querySelector<HTMLElement>('[data-motion-anchor="decision-stage"]');
  return fallback && visible(fallback) ? fallback : null;
}

function visible(node: HTMLElement) {
  if (!node.isConnected) return false;
  {
    const box = node.getBoundingClientRect();
    if (
      box.width > 0 &&
      box.height > 0 &&
      box.bottom > 0 &&
      box.top < innerHeight &&
      box.right > 0 &&
      box.left < innerWidth
    )
      return true;
  }
  return false;
}

function naturalBox(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const transform = getComputedStyle(element).transform;
  const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
  return {
    left: rect.left - matrix.e - (element.offsetWidth - rect.width) / 2,
    top: rect.top - matrix.f - (element.offsetHeight - rect.height) / 2,
    width: element.offsetWidth,
    height: element.offsetHeight,
  };
}

/** A presentation clock drives the real paused WAAPI effect. Hidden time is
 * excluded and each presented frame advances at most 32ms. */
export function animateLivePaper(
  element: HTMLElement,
  source: HTMLElement | null,
  duration: number,
  onFinish: () => void = () => {},
  returning = false,
) {
  const scope = createMotionScope("interaction");
  let disposed = false;
  let frame = 0;
  let elapsed = 0;
  let previous = performance.now();
  let completed = false;
  const original = {
    transform: element.style.transform,
    opacity: element.style.opacity,
    transformOrigin: element.style.transformOrigin,
    willChange: element.style.willChange,
  };
  const box = naturalBox(element);
  let previousNatural = box;
  const readOrigin = () => {
    const target = source && visible(source) ? source.getBoundingClientRect() : box;
    return {
      x: target.left + target.width / 2 - (box.left + box.width / 2),
      y: target.top + target.height / 2 - (box.top + box.height / 2),
      scale: Math.max(0.12, Math.min(0.55, target.width / Math.max(1, box.width))),
    };
  };
  const origin = readOrigin();
  const pose = (point: typeof origin) =>
    `translate3d(${point.x}px,${point.y}px,0) scale(${point.scale})`;
  const total =
    LIVE_PAPER_TIMING.cue +
    LIVE_PAPER_TIMING.shape +
    LIVE_PAPER_TIMING.transfer +
    LIVE_PAPER_TIMING.receive +
    LIVE_PAPER_TIMING.reveal;
  const keys: Keyframe[] = returning
    ? [
        {
          transform: getComputedStyle(element).transform,
          opacity: getComputedStyle(element).opacity,
        },
        { transform: pose(origin), opacity: 0.15 },
      ]
    : [
        { transform: pose(origin), opacity: 0.35, offset: 0 },
        { transform: pose(origin), opacity: 0.65, offset: LIVE_PAPER_TIMING.cue / total },
        {
          transform: `translate3d(${origin.x * 0.85}px,${origin.y * 0.85}px,0) scale(.68)`,
          opacity: 1,
          offset: (LIVE_PAPER_TIMING.cue + LIVE_PAPER_TIMING.shape) / total,
        },
        {
          transform: "translate3d(0,0,0) scale(.96)",
          opacity: 1,
          offset:
            (LIVE_PAPER_TIMING.cue + LIVE_PAPER_TIMING.shape + LIVE_PAPER_TIMING.transfer) / total,
        },
        { transform: "none", opacity: 1, offset: 1 },
      ];
  element.style.transformOrigin = "center";
  element.style.willChange = "transform, opacity";
  const animation = scope.prepare(element, keys, {
    duration,
    easing: "cubic-bezier(.19,1,.22,1)",
    fill: "both",
  });
  animation.pause();
  animation.currentTime = 0;
  const restore = () => {
    scope.dispose();
    Object.assign(element.style, original);
    delete element.dataset.liveMotion;
  };
  const release = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    removeEventListener("resize", scheduleMeasure);
    removeEventListener("scroll", scheduleMeasure, true);
    document.removeEventListener("visibilitychange", visibility);
  };
  const finish = () => {
    if (disposed || completed || elapsed < duration) return;
    completed = true;
    animation.finish();
    release();
    restore();
    onFinish();
  };
  const tick = (at: number) => {
    frame = 0;
    if (disposed || completed || document.hidden) return;
    elapsed = Math.min(duration, elapsed + Math.min(32, Math.max(0, at - previous)));
    animation.currentTime = elapsed;
    previous = at;
    finish();
    if (!completed) frame = requestAnimationFrame(tick);
  };
  const visibility = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!document.hidden) {
      previous = performance.now();
      if (!completed) frame = requestAnimationFrame(tick);
    }
  };
  const measure = () => {
    if (disposed || completed || !(animation.effect instanceof KeyframeEffect)) return;
    const time = typeof animation.currentTime === "number" ? animation.currentTime : 0;
    const progress = Math.max(
      0,
      Math.min(1, animation.effect.getComputedTiming().progress ?? time / duration),
    );
    if (progress >= 1) return;
    const style = getComputedStyle(element);
    const natural = naturalBox(element);
    const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
    // Layout moves independently of the effect when the viewport or paper changes.
    // Rebase the displayed pose before continuing toward the new natural destination.
    const current = new DOMMatrix([
      (matrix.a * previousNatural.width) / Math.max(1, natural.width),
      matrix.b,
      matrix.c,
      (matrix.d * previousNatural.height) / Math.max(1, natural.height),
      matrix.e +
        previousNatural.left +
        previousNatural.width / 2 -
        natural.left -
        natural.width / 2,
      matrix.f +
        previousNatural.top +
        previousNatural.height / 2 -
        natural.top -
        natural.height / 2,
    ]).toString();
    const target = source && visible(source) ? source.getBoundingClientRect() : natural;
    const effect = animation.effect;
    const end = returning
      ? `translate3d(${target.left + target.width / 2 - natural.left - natural.width / 2}px,${target.top + target.height / 2 - natural.top - natural.height / 2}px,0) scale(.25)`
      : "none";
    previousNatural = natural;
    effect.setKeyframes([
      { transform: keys[0].transform, opacity: keys[0].opacity, offset: 0 },
      { transform: current, opacity: style.opacity, offset: progress },
      { transform: end, opacity: returning ? 0.15 : 1, offset: 1 },
    ]);
  };
  // Resize/scroll events run before the next paint. Deferring this correction to
  // another rAF would expose one frame at the newly shifted layout coordinates.
  const scheduleMeasure = () => measure();
  let observed = false;
  const observer = new ResizeObserver(() => {
    if (!observed) {
      observed = true;
      return;
    }
    scheduleMeasure();
  });
  observer.observe(element);
  if (source) observer.observe(source);
  addEventListener("resize", scheduleMeasure, { passive: true });
  addEventListener("scroll", scheduleMeasure, { passive: true, capture: true });
  document.addEventListener("visibilitychange", visibility);
  element.dataset.liveMotion = returning ? "returning" : "receiving";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    elapsed = duration;
    queueMicrotask(finish);
  } else if (!document.hidden) frame = requestAnimationFrame(tick);
  return (preservePose = false) => {
    if (disposed || completed) return;
    const pose = preservePose ? getComputedStyle(element) : null;
    const transform = pose?.transform;
    const opacity = pose?.opacity;
    disposed = true;
    release();
    restore();
    if (transform !== undefined && opacity !== undefined) {
      element.style.transform = transform;
      element.style.opacity = opacity;
    }
  };
}
