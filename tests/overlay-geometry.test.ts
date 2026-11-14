import { describe, expect, it } from "vitest";
import {
  cssMatrix,
  inverse,
  multiply,
  overlayPath,
  project,
  translate,
  type Matrix,
  type Point,
  type Quad,
} from "../src/components/overlay-geometry";

const rectangle = (left: number, top: number, width: number, height: number): Quad => [
  { x: left, y: top },
  { x: left + width, y: top },
  { x: left + width, y: top + height },
  { x: left, y: top + height },
];
const apply = (matrix: Matrix, point: Point) => {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
};
const expectPoint = (actual: Point, expected: Point) => {
  expect(actual.x).toBeCloseTo(expected.x, 7);
  expect(actual.y).toBeCloseTo(expected.y, 7);
};

describe("shared overlay geometry", () => {
  const natural = rectangle(0, 0, 660, 480);
  const from: Quad = [
    { x: 180, y: 52 },
    { x: 824, y: 68 },
    { x: 807, y: 518 },
    { x: 169, y: 527 },
  ];
  const to = rectangle(1000, 180, 404, 520);

  it("maps every source corner exactly, preserving the interrupted perspective", () => {
    const matrix = project(660, 480, from);
    natural.forEach((point, index) => expectPoint(apply(matrix, point), from[index]));
  });

  it("inverts a projected plane without replacing it with its bounding rectangle", () => {
    const matrix = project(660, 480, from);
    const back = inverse(matrix);
    natural.forEach((point) => expectPoint(apply(back, apply(matrix, point)), point));
  });

  it("maps the new paper's natural geometry onto the old visible quadrilateral", () => {
    const base = project(404, 520, to);
    const replacement = multiply(inverse(base), project(404, 520, from));
    const result = multiply(base, replacement);
    rectangle(0, 0, 404, 520).forEach((point, index) =>
      expectPoint(apply(result, point), from[index]),
    );
  });

  it("begins and finishes a transfer exactly at its specified corners", () => {
    const path = overlayPath(from, to, 420);
    expect(path(0)).toEqual(from);
    expect(path(1)).toEqual(to);
    expect(path(-1)).toEqual(from);
    expect(path(2)).toEqual(to);
  });

  it("keeps un-interrupted movement monotonic and lands at rest", () => {
    const path = overlayPath(from, to, 420);
    const epsilon = 0.00001;
    const start = path(epsilon);
    const end = path(1 - epsilon);
    from.forEach((point, index) => {
      expect(Math.hypot(start[index].x - point.x, start[index].y - point.y)).toBeLessThan(0.000001);
      expect(Math.hypot(end[index].x - to[index].x, end[index].y - to[index].y)).toBeLessThan(
        0.000001,
      );
    });
    for (let step = 1; step <= 100; step++) {
      const before = path((step - 1) / 100);
      const current = path(step / 100);
      current.forEach((point, index) => {
        expect(point.x).toBeGreaterThanOrEqual(before[index].x - 0.000001);
        const minY = Math.min(from[index].y, to[index].y);
        const maxY = Math.max(from[index].y, to[index].y);
        expect(point.y).toBeGreaterThanOrEqual(minY - 0.000001);
        expect(point.y).toBeLessThanOrEqual(maxY + 0.000001);
      });
    }
  });

  it("inherits the visible velocity when a moving paper is interrupted", () => {
    const velocity = from.map(() => ({ x: 0.8, y: -0.3 })) as Quad;
    const path = overlayPath(from, to, 420, velocity);
    const interval = 0.001;
    const at = path(interval / 420);
    at.forEach((point, index) => {
      expect((point.x - from[index].x) / interval).toBeCloseTo(velocity[index].x, 4);
      expect((point.y - from[index].y) / interval).toBeCloseTo(velocity[index].y, 4);
    });
    const end = path(1 - interval / 420);
    end.forEach((point, index) => {
      expect(Math.abs((to[index].x - point.x) / interval)).toBeLessThan(0.0001);
      expect(Math.abs((to[index].y - point.y) / interval)).toBeLessThan(0.0001);
    });
  });

  it("keeps retired text on its original plane while the outer paper changes shape", () => {
    const path = overlayPath(from, to, 420);
    const oldPlane = project(660, 480, from);
    for (const amount of [0, 0.15, 0.3, 0.5, 0.7, 1]) {
      const quad = path(amount);
      const outer = project(404, 520, quad);
      const delta = translate(quad[0].x - from[0].x, quad[0].y - from[0].y);
      const counter = multiply(inverse(outer), multiply(delta, oldPlane));
      const visible = multiply(outer, counter);
      natural.forEach((point, index) =>
        expectPoint(apply(visible, point), apply(delta, from[index])),
      );
    }
  });

  it("keeps incoming content at its natural size throughout the paper morph", () => {
    const path = overlayPath(from, to, 420);
    const local = translate(20, 72);
    for (const amount of [0, 0.2, 0.5, 0.8, 1]) {
      const quad = path(amount);
      const outer = project(404, 520, quad);
      const desired = multiply(translate(quad[0].x, quad[0].y), local);
      const counter = multiply(inverse(local), multiply(inverse(outer), desired));
      const visible = multiply(multiply(outer, local), counter);
      const first = apply(visible, { x: 0, y: 0 });
      const last = apply(visible, { x: 340, y: 120 });
      expectPoint(first, { x: quad[0].x + 20, y: quad[0].y + 72 });
      expectPoint(last, { x: first.x + 340, y: first.y + 120 });
    }
  });

  it("writes the planar coefficients in CSS matrix3d order", () => {
    expect(cssMatrix([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(
      "matrix3d(1,4,0,7,2,5,0,8,0,0,1,0,3,6,0,9)",
    );
  });
});
