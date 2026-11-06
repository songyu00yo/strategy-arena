/** Synthetic authentication round-trip only; no model requests or real owner data. */
import { afterEach, expect, it, vi } from "vitest";
import { acceptanceBrowserState } from "../scripts/export-acceptance-browser-state";
import { ownerFromRequest } from "../src/lib/server/auth";

afterEach(() => vi.unstubAllEnvs());
it("exports an owner accepted by the real auth verifier and preserves production secure cookies", () => {
  const secret = "synthetic-browser-export-test-secret-only";
  const owner = "af6f4c86-3a4b-470a-ad79-756fba3ae5c9";
  const arena = "bf6f4c86-3a4b-470a-ad79-756fba3ae5c9";
  vi.stubEnv("ARENA_SESSION_SECRET", secret);
  const state = acceptanceBrowserState(owner, arena, "http://127.0.0.1:3340", secret, true);
  const cookie = state.cookies[0];
  expect(
    ownerFromRequest(
      new Request("http://127.0.0.1:3340/api/arenas", {
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      }),
    ),
  ).toBe(owner);
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
  expect(state.origins[0].localStorage).toEqual([{ name: "strategy-arena:last-id", value: arena }]);
  expect(JSON.stringify(state)).not.toContain(secret);
});
it("refuses non-loopback origins, malformed owners and short session secrets", () => {
  const owner = "af6f4c86-3a4b-470a-ad79-756fba3ae5c9";
  expect(() =>
    acceptanceBrowserState(owner, owner, "https://example.com", "x".repeat(32), true),
  ).toThrow();
  expect(() =>
    acceptanceBrowserState(
      `live-acceptance-${owner}`,
      owner,
      "http://127.0.0.1:3340",
      "x".repeat(32),
      true,
    ),
  ).toThrow();
  expect(() =>
    acceptanceBrowserState(owner, owner, "http://127.0.0.1:3340", "short", true),
  ).toThrow();
});
