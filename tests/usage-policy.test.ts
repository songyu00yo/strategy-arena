import { afterEach, describe, expect, it, vi } from "vitest";
import { usageLimitsEnabled } from "../src/lib/server/usage-policy";

afterEach(() => vi.unstubAllEnvs());

describe("explicit usage-limit policy", () => {
  it.each([undefined, "", "true", "FALSE", "0", " false ", "invalid"])(
    "keeps quotas enabled for %s",
    (value) => {
      vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", value);
      expect(usageLimitsEnabled()).toBe(true);
    },
  );

  it("disables quotas only for the explicit false setting", () => {
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "false");
    expect(usageLimitsEnabled()).toBe(false);
    vi.stubEnv("ARENA_USAGE_LIMITS_ENABLED", "true");
    expect(usageLimitsEnabled()).toBe(true);
  });
});
