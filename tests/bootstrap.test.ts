import { describe, expect, it } from "vitest";
import packageJson from "../package.json";

describe("runtime contract", () => {
  it("pins the supported Node major and package manager", () => {
    expect(packageJson.engines.node).toBe(">=24 <25");
    expect(packageJson.packageManager).toBe("pnpm@11.19.0");
  });
});
