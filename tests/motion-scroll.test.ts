import { describe, expect, it } from "vitest";
import { scrollPositionAt } from "../src/components/motion-scroll";

describe("continuous scroll geometry", () => {
  it("has exact endpoints and zero settled velocity", () => {
    expect(scrollPositionAt(30, 900, 0, 360, 0)).toBe(30);
    expect(scrollPositionAt(30, 900, 0, 360, 1)).toBe(900);
    const endVelocity = (900 - scrollPositionAt(30, 900, 0, 360, 0.99999)) / 0.0036;
    expect(Math.abs(endVelocity)).toBeLessThan(0.001);
  });
  it("carries the current velocity into an interrupted reverse move", () => {
    const dt = 0.00001;
    const velocity = (scrollPositionAt(300, 0, 1.2, 360, dt) - 300) / (360 * dt);
    expect(velocity).toBeCloseTo(1.2, 3);
    expect(scrollPositionAt(300, 0, 1.2, 360, 1)).toBe(0);
  });
  it("keeps a stationary-start move monotone in either direction", () => {
    for (const [start, end] of [
      [0, 100],
      [100, 0],
    ]) {
      const values = Array.from({ length: 61 }, (_, i) =>
        scrollPositionAt(start, end, 0, 360, i / 60),
      );
      values
        .slice(1)
        .forEach((value, i) =>
          expect((value - values[i]) * Math.sign(end - start)).toBeGreaterThanOrEqual(0),
        );
    }
  });
});
