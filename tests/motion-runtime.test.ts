import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Explicit WAAPI doubles. These exercise ownership without a browser compositor. */
class SyntheticKeyframeEffect {
  constructor(
    readonly target: Element,
    readonly frames: Keyframe[],
    readonly options: KeyframeAnimationOptions,
  ) {}
}

class SyntheticAnimation extends EventTarget {
  playState: AnimationPlayState = "idle";
  currentTime: number | null = null;
  onfinish: (() => void) | null = null;

  constructor(
    readonly effect: SyntheticKeyframeEffect,
    readonly timeline: object,
  ) {
    super();
  }

  play = vi.fn(() => {
    this.playState = "running";
    this.currentTime ??= 0;
  });

  pause = vi.fn(() => {
    this.playState = "paused";
    this.currentTime ??= 0;
  });

  cancel = vi.fn(() => {
    this.playState = "idle";
    this.currentTime = null;
    this.dispatchEvent(new Event("cancel"));
  });
}

describe("console motion ownership and interruption", () => {
  let page: EventTarget & {
    hidden: boolean;
    timeline: object;
    querySelectorAll: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    page = Object.assign(new EventTarget(), {
      hidden: false,
      timeline: {},
      querySelectorAll: vi.fn(() => []),
    });
    vi.stubGlobal("document", page);
    vi.stubGlobal("KeyframeEffect", SyntheticKeyframeEffect);
    vi.stubGlobal("Animation", SyntheticAnimation);
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) =>
      setTimeout(() => run(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("prepares an idle native effect without starting it or assigning a visual time", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    const scope = motion.createMotionScope();
    const animate = vi.fn();
    const node = { animate } as unknown as Element;
    const frames = [
      { transform: "none", opacity: 1 },
      { transform: "translateX(200px)", opacity: 0 },
    ];
    const options = { duration: 300, fill: "both" } as const;
    const animation = scope.prepare(node, frames, options) as unknown as SyntheticAnimation;
    expect(animation.effect).toBeInstanceOf(SyntheticKeyframeEffect);
    expect(animation.effect.target).toBe(node);
    expect(animation.effect.frames).toBe(frames);
    expect(animation.effect.options).toBe(options);
    expect(animation.timeline).toBe(page.timeline);
    expect(animation.playState).toBe("idle");
    expect(animation.currentTime).toBeNull();
    expect(animation.play).not.toHaveBeenCalled();
    expect(animation.pause).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
    scope.dispose();
    expect(animation.cancel).toHaveBeenCalledOnce();
  });

  it("keeps prepared idle effects untouched across held creation, hold release and timer arming", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    const release = motion.acquireMotionHold();
    const scope = motion.createMotionScope();
    const animation = scope.prepare({} as Element, [], {
      duration: 300,
    }) as unknown as SyntheticAnimation;
    scope.later(100, vi.fn());
    release();
    const releaseAgain = motion.acquireMotionHold();
    releaseAgain();
    vi.advanceTimersByTime(200);
    expect(animation.playState).toBe("idle");
    expect(animation.currentTime).toBeNull();
    expect(animation.play).not.toHaveBeenCalled();
    expect(animation.pause).not.toHaveBeenCalled();
    scope.dispose();
  });

  it("pauses and resumes a prepared effect after its owner explicitly starts it", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    const scope = motion.createMotionScope();
    const animation = scope.prepare({} as Element, [], {
      duration: 300,
    }) as unknown as SyntheticAnimation;
    animation.play();
    animation.currentTime = 125;
    const release = motion.acquireMotionHold();
    expect(animation.playState).toBe("paused");
    expect(animation.pause).toHaveBeenCalledOnce();
    expect(animation.currentTime).toBe(125);
    release();
    expect(animation.playState).toBe("running");
    expect(animation.play).toHaveBeenCalledTimes(2);
    expect(animation.currentTime).toBe(125);
    scope.dispose();
  });

  it("cancels both prepared and started effects on disposal and never revives them on release", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    const scope = motion.createMotionScope();
    const idle = scope.prepare({} as Element, [], { duration: 300 });
    const running = scope.prepare({} as Element, [], { duration: 300 });
    running.play();
    const release = motion.acquireMotionHold();
    scope.dispose();
    scope.dispose();
    release();
    expect(idle.cancel).toHaveBeenCalledOnce();
    expect(running.cancel).toHaveBeenCalledOnce();
    expect(idle.playState).toBe("idle");
    expect(running.playState).toBe("idle");
    expect(idle.currentTime).toBeNull();
    expect(running.currentTime).toBeNull();
    expect(idle.play).not.toHaveBeenCalled();
    expect(running.play).toHaveBeenCalledOnce();
    expect(idle.onfinish).toBeNull();
    expect(running.onfinish).toBeNull();
  });

  it("shares finish and cancel cleanup with immediately started animations", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    const scope = motion.createMotionScope();
    const finished = scope.prepare({} as Element, [], { duration: 300 });
    const filled = scope.prepare({} as Element, [], { duration: 300, fill: "both" });
    const cancelled = scope.prepare({} as Element, [], { duration: 300 });
    finished.dispatchEvent(new Event("finish"));
    filled.dispatchEvent(new Event("finish"));
    cancelled.cancel();
    scope.dispose();
    expect(finished.cancel).not.toHaveBeenCalled();
    expect(filled.cancel).toHaveBeenCalledOnce();
    expect(cancelled.cancel).toHaveBeenCalledOnce();
    const late = scope.prepare({} as Element, [], { duration: 300 });
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(late.playState).toBe("idle");
  });

  it("keeps independent overlay holds and excludes hidden-tab time", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    vi.advanceTimersByTime(100);
    const before = motion.motionNow();
    const first = motion.acquireMotionHold();
    const second = motion.acquireMotionHold();
    vi.advanceTimersByTime(8000);
    first();
    first();
    expect(motion.motionPaused()).toBe(true);
    expect(motion.motionNow()).toBe(before);
    page.hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    second();
    expect(motion.motionPaused()).toBe(true);
    vi.advanceTimersByTime(3000);
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(motion.motionNow()).toBe(before);
    vi.advanceTimersByTime(75);
    expect(motion.motionNow()).toBe(before + 75);
  });

  it("resumes the remaining delay and disposes already-started animations and nodes", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    const scope = motion.createMotionScope();
    const callback = vi.fn();
    const removed = vi.fn();
    const animation = Object.assign(new EventTarget(), {
      playState: "running",
      onfinish: vi.fn(),
      pause: vi.fn(function (this: { playState: string }) {
        this.playState = "paused";
      }),
      play: vi.fn(function (this: { playState: string }) {
        this.playState = "running";
      }),
      cancel: vi.fn(),
    });
    const node = { remove: removed, animate: () => animation } as unknown as Element;
    scope.own(node);
    scope.animate(node, [], { duration: 500 });
    scope.later(500, callback);
    vi.advanceTimersByTime(200);
    const release = motion.acquireMotionHold();
    expect(animation.pause).toHaveBeenCalled();
    vi.advanceTimersByTime(8000);
    expect(callback).not.toHaveBeenCalled();
    release();
    expect(animation.play).toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    scope.later(100, callback);
    scope.dispose();
    scope.dispose();
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(animation.cancel).toHaveBeenCalledTimes(1);
    expect(animation.onfinish).toBeNull();
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit interaction motion running while an overlay holds the story", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    const release = motion.acquireMotionHold();
    const story = motion.createMotionScope();
    const interaction = motion.createMotionScope("interaction");
    const storyDone = vi.fn();
    const interactionDone = vi.fn();
    const animation = Object.assign(new EventTarget(), {
      playState: "running",
      pause: vi.fn(),
      play: vi.fn(),
      cancel: vi.fn(),
      onfinish: null,
    });
    interaction.animate({ animate: () => animation } as unknown as Element, [], { duration: 560 });
    story.later(420, storyDone);
    interaction.later(420, interactionDone);
    let frames = 0;
    const loop = motion.createMotionLoop(() => ++frames < 2, "interaction");
    vi.advanceTimersByTime(560);
    expect(animation.pause).not.toHaveBeenCalled();
    expect(interactionDone).toHaveBeenCalledOnce();
    expect(storyDone).not.toHaveBeenCalled();
    expect(frames).toBe(2);
    expect(interaction.now()).toBe(560);
    expect(story.now()).toBe(0);
    release();
    vi.advanceTimersByTime(420);
    expect(storyDone).toHaveBeenCalledOnce();
    loop.dispose();
    interaction.dispose();
    story.dispose();
  });

  it("sleeps when idle or held and never duplicates RAF when particles wake inside a tick", async () => {
    const motion = await import("../src/components/console/motion-runtime");
    let frames = 0;
    const loop = motion.createMotionLoop(() => {
      frames += 1;
      loop.wake();
      return frames < 3;
    });
    vi.advanceTimersByTime(16);
    expect(frames).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    const release = motion.acquireMotionHold();
    vi.advanceTimersByTime(5000);
    expect(frames).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    release();
    vi.advanceTimersByTime(32);
    expect(frames).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    loop.wake();
    expect(vi.getTimerCount()).toBe(1);
    loop.dispose();
    vi.advanceTimersByTime(100);
    expect(frames).toBe(3);
  });
});
