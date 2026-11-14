import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PAPER_NAVIGATION_SCRIPT } from "../src/lib/paper-navigation";

type NavigationEvent = { viewTransition?: { finished: Promise<void> } };

/** Explicit browser lifecycle doubles expose no business, network or storage APIs. */
function boot() {
  const style = { viewTransitionName: "none" };
  const handlers: Record<string, (event: NavigationEvent) => void> = {};
  runInNewContext(PAPER_NAVIGATION_SCRIPT, {
    document: { documentElement: { style } },
    addEventListener: (type: string, handler: (event: NavigationEvent) => void) => {
      handlers[type] = handler;
    },
  });
  return { style, handlers };
}

describe("parser-time paper navigation", () => {
  it("registers the two lifecycle handlers synchronously and keeps the initial document live", () => {
    const { style, handlers } = boot();
    expect(Object.keys(handlers)).toEqual(["pageswap", "pagereveal"]);
    expect(style.viewTransitionName).toBe("none");
  });

  it("captures the outgoing root and restores it when its native transition finishes", async () => {
    const { style, handlers } = boot();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    handlers.pageswap({ viewTransition: { finished } });
    expect(style.viewTransitionName).toBe("root");
    finish();
    await finished;
    expect(style.viewTransitionName).toBe("none");
  });

  it("restores the outgoing root after a rejected native transition", async () => {
    const { style, handlers } = boot();
    const finished = Promise.reject(new Error("Explicit skipped-transition double"));
    handlers.pageswap({ viewTransition: { finished } });
    await finished.catch(() => {});
    expect(style.viewTransitionName).toBe("none");
  });

  it("keeps navigation without native support live", () => {
    const { style, handlers } = boot();
    handlers.pageswap({});
    expect(style.viewTransitionName).toBe("none");
  });

  it("removes the incoming root name before capture, including a restored document", () => {
    const { style, handlers } = boot();
    style.viewTransitionName = "root";
    handlers.pagereveal({});
    expect(style.viewTransitionName).toBe("none");
  });

  it("ignores a late cleanup after another navigation takes ownership", async () => {
    const { style, handlers } = boot();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    handlers.pageswap({ viewTransition: { finished: first } });
    handlers.pagereveal({});
    handlers.pageswap({ viewTransition: { finished: second } });
    finishFirst();
    await first;
    expect(style.viewTransitionName).toBe("root");
    finishSecond();
    await second;
    expect(style.viewTransitionName).toBe("none");
  });
});
