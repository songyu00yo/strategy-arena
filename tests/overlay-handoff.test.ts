import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const motion = vi.hoisted(() => ({ holds: 0, acquired: 0, released: 0 }));
vi.mock("../src/components/console/motion-runtime", () => ({
  acquireMotionHold: () => {
    motion.holds++;
    motion.acquired++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      motion.holds--;
      motion.released++;
    };
  },
}));
vi.mock("../src/components/overlay-geometry", () => ({
  corners: (source: SyntheticElement) => {
    const time = Number(source.animations[0]?.currentTime ?? 0);
    return [
      { x: 100 + time * 0.5, y: 80 },
      { x: 700 + time * 0.5, y: 80 },
      { x: 700 + time * 0.5, y: 520 },
      { x: 100 + time * 0.5, y: 520 },
    ];
  },
}));

class SyntheticStyle {
  overflow = "scroll";
  scrollbarGutter = "auto";
  setProperty(name: string, value: string) {
    Object.assign(this, { [name]: value });
  }
}
class SyntheticElement {
  style = new SyntheticStyle();
  offsetWidth = 600;
  offsetHeight = 440;
  isConnected = true;
  scrollTop = 0;
  scrollLeft = 0;
  animations: SyntheticAnimation[] = [];
  classList = { add: vi.fn() };
  inert = false;
  attributes = new Map<string, string>();
  querySelectorAll() {
    return [];
  }
  getAnimations() {
    return this.animations;
  }
  cloneNode() {
    return new SyntheticElement();
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  closest() {
    return null;
  }
}
class SyntheticDialog extends SyntheticElement {}
class SyntheticKeyframeEffect {
  constructor(readonly target: SyntheticElement) {}
  getKeyframes() {
    return [{ transform: "none" }, { transform: "translateX(200px)" }];
  }
}
class SyntheticAnimation {
  playState: AnimationPlayState = "running";
  currentTime: number | null = 16;
  pending = false;
  effect: SyntheticKeyframeEffect;
  constructor(source: SyntheticElement) {
    this.effect = new SyntheticKeyframeEffect(source);
  }
  pause = vi.fn(() => {
    this.playState = "paused";
  });
  play = vi.fn(() => {
    this.playState = "running";
  });
  cancel = vi.fn(() => {
    this.playState = "idle";
    this.currentTime = null;
  });
}

/** Explicit DOM/WAAPI doubles verify ownership, not composited browser frames. */
describe("overlay handoff ownership", () => {
  let handoff: typeof import("../src/components/overlay-handoff");
  let body: SyntheticElement;
  let root: SyntheticElement & { clientWidth: number };
  let source: SyntheticDialog;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    motion.holds = motion.acquired = motion.released = 0;
    body = new SyntheticElement();
    root = Object.assign(new SyntheticElement(), { clientWidth: 1264 });
    source = new SyntheticDialog();
    source.animations = [new SyntheticAnimation(source)];
    vi.stubGlobal("document", { body, documentElement: root });
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("HTMLDialogElement", SyntheticDialog);
    vi.stubGlobal("HTMLTextAreaElement", class {});
    vi.stubGlobal("HTMLInputElement", class {});
    vi.stubGlobal("HTMLSelectElement", class {});
    vi.stubGlobal("KeyframeEffect", SyntheticKeyframeEffect);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("getComputedStyle", (_source: unknown, pseudo?: string) => ({
      opacity: pseudo ? "0.75" : "0.8",
      backgroundColor: "rgba(60,48,30,.28)",
      getPropertyValue: (property: string) => (property === "opacity" ? "0.8" : ""),
    }));
    handoff = await import("../src/components/overlay-handoff");
  });
  afterEach(() => {
    handoff.takeOverlayHandoff()?.abort();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("captures the visible paper before replacing its owner", () => {
    const replace = vi.fn(() => {
      expect(source.animations[0].playState).toBe("paused");
      expect(motion.holds).toBe(1);
      expect(body.style.overflow).toBe("hidden");
    });
    handoff.handoffOverlay(source as unknown as HTMLElement, replace);
    expect(replace).toHaveBeenCalledOnce();
    const captured = handoff.takeOverlayHandoff()!;
    expect(captured.width).toBe(600);
    expect(captured.height).toBe(440);
    expect(captured.opacity).toBe(0.8);
    expect(captured.backdropOpacity).toBe("0.75");
    expect(captured.quad[0]).toEqual({ x: 108, y: 80 });
    expect(captured.velocity?.[0]).toEqual({ x: 0.5, y: 0 });
    expect(captured.snapshot.inert).toBe(true);
    expect(
      captured.snapshot.getAttribute?.("aria-hidden") ??
        (captured.snapshot as unknown as SyntheticElement).attributes.get("aria-hidden"),
    ).toBe("true");
    captured.abort();
    expect(motion.holds).toBe(0);
  });

  it("keeps the scroll and story leases until the receiver has acquired its own", () => {
    handoff.handoffOverlay(source as unknown as HTMLElement, () => {});
    const captured = handoff.takeOverlayHandoff()!;
    const releaseReceiver = handoff.acquireOverlayScrollLock();
    expect(root.style.scrollbarGutter).toBe("stable");
    captured.accept();
    captured.accept();
    expect(source.animations[0].cancel).toHaveBeenCalledOnce();
    expect(motion.released).toBe(1);
    expect(body.style.overflow).toBe("hidden");
    releaseReceiver();
    expect(body.style.overflow).toBe("scroll");
    expect(root.style.scrollbarGutter).toBe("auto");
    captured.releaseSource();
  });

  it("recovers the original paper when replacement throws", () => {
    const failure = new Error("explicit test replacement failure");
    expect(() =>
      handoff.handoffOverlay(source as unknown as HTMLElement, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(source.animations[0].play).toHaveBeenCalledOnce();
    expect(motion.holds).toBe(0);
    expect(body.style.overflow).toBe("scroll");
    expect(handoff.takeOverlayHandoff()).toBeNull();
  });

  it("releases an unclaimed handoff after the receiving component fails to mount", () => {
    handoff.handoffOverlay(source as unknown as HTMLElement, () => {});
    expect(motion.holds).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(source.animations[0].play).toHaveBeenCalledOnce();
    expect(motion.holds).toBe(0);
    expect(body.style.overflow).toBe("scroll");
    expect(handoff.takeOverlayHandoff()).toBeNull();
  });

  it("cancels detached source effects when the receiver never mounts", () => {
    handoff.handoffOverlay(source as unknown as HTMLElement, () => {});
    source.isConnected = false;
    vi.advanceTimersByTime(1500);
    expect(source.animations[0].cancel).toHaveBeenCalledOnce();
    expect(source.animations[0].play).not.toHaveBeenCalled();
    expect(motion.holds).toBe(0);
  });

  it("coalesces two immediate replacement requests from the same visible source", () => {
    const replace = vi.fn();
    handoff.handoffOverlay(source as unknown as HTMLElement, replace);
    handoff.handoffOverlay(source as unknown as HTMLElement, replace);
    expect(replace).toHaveBeenCalledTimes(2);
    expect(motion.acquired).toBe(1);
    const captured = handoff.takeOverlayHandoff()!;
    captured.accept();
    captured.releaseSource();
    expect(motion.released).toBe(1);
  });

  it("defers source deck retirement until the replacement chain releases it", () => {
    const retire = vi.fn();
    handoff.handoffOverlay(source as unknown as HTMLElement, () => {});
    expect(handoff.deferOverlayHandoffCleanup(source as unknown as HTMLElement, retire)).toBe(true);
    const captured = handoff.takeOverlayHandoff()!;
    captured.accept();
    expect(retire).not.toHaveBeenCalled();
    captured.releaseSource();
    captured.releaseSource();
    expect(retire).toHaveBeenCalledOnce();
    expect(handoff.deferOverlayHandoffCleanup(source as unknown as HTMLElement, retire)).toBe(
      false,
    );
  });

  it("runs deferred source cleanup when a receiving component never claims the transfer", () => {
    const retire = vi.fn();
    handoff.handoffOverlay(source as unknown as HTMLElement, () => {});
    handoff.deferOverlayHandoffCleanup(source as unknown as HTMLElement, retire);
    vi.advanceTimersByTime(1500);
    expect(retire).toHaveBeenCalledOnce();
  });

  it("uses ordinary mounting for missing, disconnected and reduced-motion sources", () => {
    const replace = vi.fn();
    handoff.handoffOverlay(null, replace);
    source.isConnected = false;
    handoff.handoffOverlay(source as unknown as HTMLElement, replace);
    source.isConnected = true;
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    handoff.handoffOverlay(source as unknown as HTMLElement, replace);
    expect(replace).toHaveBeenCalledTimes(3);
    expect(motion.acquired).toBe(0);
    expect(source.animations[0].pause).not.toHaveBeenCalled();
  });
});
