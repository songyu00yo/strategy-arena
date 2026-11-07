/** Synthetic HTTP and Web Locks boundaries only. No cookies or provider calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identity = { identityTag: "a".repeat(64), hasRecoveryCode: false };
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("identity initialization barrier", () => {
  it("deduplicates concurrent subscribers in one window without Web Locks", async () => {
    vi.stubGlobal("navigator", {});
    let finish!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { bootstrapIdentity } = await import("../src/components/identity-bootstrap");
    const first = bootstrapIdentity();
    const second = bootstrapIdentity();
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(Response.json(identity));
    expect(await first).toEqual(identity);
    expect(fetch).toHaveBeenCalledWith("/api/identity", {
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    });
  });
  it("uses the shared named Web Lock for initialization", async () => {
    const request = vi.fn(async (_name, operation) => operation());
    vi.stubGlobal("navigator", { locks: { request } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(identity)),
    );
    const { bootstrapIdentity, IDENTITY_BOOTSTRAP_LOCK } =
      await import("../src/components/identity-bootstrap");
    await bootstrapIdentity();
    expect(request).toHaveBeenCalledWith(IDENTITY_BOOTSTRAP_LOCK, expect.any(Function));
  });
  it("allows a fresh attempt after failure and does not cache a successful identity across recovery", async () => {
    vi.stubGlobal("navigator", {});
    const switched = { ...identity, identityTag: "b".repeat(64) };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic network failure"))
      .mockResolvedValueOnce(Response.json(identity))
      .mockResolvedValueOnce(Response.json(switched));
    vi.stubGlobal("fetch", fetch);
    const { bootstrapIdentity } = await import("../src/components/identity-bootstrap");
    await expect(bootstrapIdentity()).rejects.toThrow();
    expect(await bootstrapIdentity()).toEqual(identity);
    expect(await bootstrapIdentity()).toEqual(switched);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("rejects failed or malformed identity responses instead of opening the readiness barrier", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: "fixture" }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ identityTag: "not-a-tag", hasRecoveryCode: false })),
    );
    const { bootstrapIdentity } = await import("../src/components/identity-bootstrap");
    await expect(bootstrapIdentity()).rejects.toThrow("初始化未完成");
    await expect(bootstrapIdentity()).rejects.toThrow("初始化未完成");
  });
});
