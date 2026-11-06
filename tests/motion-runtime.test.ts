import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("console motion ownership and interruption", () => {
  let page: EventTarget & { hidden: boolean; querySelectorAll: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    page = Object.assign(new EventTarget(), { hidden: false, querySelectorAll: vi.fn(() => []) });
    vi.stubGlobal("document", page);
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) =>
      setTimeout(() => run(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
