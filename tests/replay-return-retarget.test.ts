/** Pure synthetic geometry checks. No browser, task writes or model calls. */
import { describe, expect, it } from "vitest";
import {
  replayReturnPose,
  replayReturnQuad,
  replayReturnRebase,
  replayReturnTransform,
} from "../src/components/console/ReplayQuestionScene";
import { overlayPath, type Quad } from "../src/components/overlay-geometry";

const box = { left: 120, top: 340, width: 660, height: 280 };
const resized = { left: 36, top: 410, width: 354, height: 410 };
const destination = { x: 400, y: 230, scaleX: 0.8, scaleY: 0.6 };

function sameQuad(actual: Quad, expected: Quad) {
  actual.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index].x, 8);
    expect(point.y).toBeCloseTo(expected[index].y, 8);
  });
}

describe("native replay return retarget geometry", () => {
  it("maps a visible paper through a different natural width and height without moving its corners", () => {
    const pose = replayReturnPose(0.37, destination);
    const quad = replayReturnQuad(box, { ...pose, scaleX: pose.scale, scaleY: pose.scale });
    const transform = replayReturnTransform(quad, resized);
    sameQuad(replayReturnQuad(resized, transform), quad);
    expect(transform.scaleX).not.toBe(transform.scaleY);
  });

  it("uses the actual sampled compositor pose while removing only natural layout reflow", () => {
    const actualPose = { x: 93.251, y: 61.724, scaleX: 0.7042, scaleY: 0.7042 };
    const afterReflow = replayReturnQuad(resized, actualPose);
    const retained = replayReturnRebase(afterReflow, resized, box, actualPose);
    sameQuad(retained, replayReturnQuad(box, actualPose));
    // CurrentTime may be one compositor phase ahead of the currently painted style.
    // The retained start must follow the sampled style, never an inferred clock pose.
    const inferred = replayReturnPose(0.39, destination);
    expect(
      Math.abs(
        retained[0].x -
          replayReturnQuad(box, {
            ...inferred,
            scaleX: inferred.scale,
            scaleY: inferred.scale,
          })[0].x,
      ),
    ).toBeGreaterThan(1);
  });

  it("preserves document-space geometry through a common scroll shift", () => {
    const pose = { x: 140, y: -55, scaleX: 0.52, scaleY: 0.52 };
    const documentQuad = replayReturnQuad(box, pose);
    const scrolledFixedBox = { ...box, left: box.left + 23, top: box.top + 185 };
    const sampledFixedQuad = replayReturnQuad(scrolledFixedBox, pose);
    sameQuad(replayReturnRebase(sampledFixedQuad, scrolledFixedBox, box, pose), documentQuad);
  });

  it("inherits the current tangent and lands at rest on the new recipient in the remaining time", () => {
    const total = 360;
    const elapsed = 137;
    const previous = (time: number) => {
      const pose = replayReturnPose(time / total, destination);
      return replayReturnQuad(box, { ...pose, scaleX: pose.scale, scaleY: pose.scale });
    };
    const from = previous(elapsed);
    const before = previous(elapsed - 8);
    const velocity = from.map((point, index) => ({
      x: (point.x - before[index].x) / 8,
      y: (point.y - before[index].y) / 8,
    })) as Quad;
    const target = replayReturnQuad(resized, { x: -58, y: 378, scaleX: 0.3, scaleY: 0.3 });
    const remaining = total - elapsed;
    const path = overlayPath(from, target, remaining, velocity);
    sameQuad(path(0), from);
    sameQuad(path(1), target);
    const after = path(0.001 / remaining);
    after.forEach((point, index) => {
      expect((point.x - from[index].x) / 0.001).toBeCloseTo(velocity[index].x, 4);
      expect((point.y - from[index].y) / 0.001).toBeCloseTo(velocity[index].y, 4);
    });
    const nearEnd = path(1 - 0.001 / remaining);
    nearEnd.forEach((point, index) => {
      expect((target[index].x - point.x) / 0.001).toBeCloseTo(0, 6);
      expect((target[index].y - point.y) / 0.001).toBeCloseTo(0, 6);
    });
  });
});
