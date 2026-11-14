export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];
export type Matrix = [number, number, number, number, number, number, number, number, number];

/** Read border corners in screen coordinates, including ancestor perspective. */
export function corners(element: HTMLElement): Quad {
  const markers = [
    [0, 0],
    [element.offsetWidth, 0],
    [element.offsetWidth, element.offsetHeight],
    [0, element.offsetHeight],
  ].map(([x, y]) => {
    const marker = document.createElement("i");
    marker.style.cssText = `position:absolute;left:${x - element.clientLeft}px;top:${y - element.clientTop}px;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden`;
    marker.setAttribute("aria-hidden", "true");
    marker.dataset.overlayCorner = "true";
    element.append(marker);
    return marker;
  });
  const quad = markers.map((marker) => {
    const box = marker.getBoundingClientRect();
    return { x: box.left, y: box.top };
  }) as Quad;
  markers.forEach((marker) => marker.remove());
  return quad;
}

/** Map a natural paper rectangle onto its measured projected quadrilateral. */
export function project(width: number, height: number, quad: Quad): Matrix {
  const [a, b, c, d] = quad;
  const dx1 = b.x - c.x;
  const dx2 = d.x - c.x;
  const dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y;
  const dy2 = d.y - c.y;
  const dy3 = a.y - b.y + c.y - d.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(determinant) > 0.0001 ? (dx3 * dy2 - dx2 * dy3) / determinant : 0;
  const h = Math.abs(determinant) > 0.0001 ? (dx1 * dy3 - dx3 * dy1) / determinant : 0;
  return [
    (b.x - a.x + g * b.x) / width,
    (d.x - a.x + h * d.x) / height,
    a.x,
    (b.y - a.y + g * b.y) / width,
    (d.y - a.y + h * d.y) / height,
    a.y,
    g / width,
    h / height,
    1,
  ];
}

export function inverse(matrix: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((value) => value / determinant) as Matrix;
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3) * 3;
    const column = index % 3;
    return a[row] * b[column] + a[row + 1] * b[column + 3] + a[row + 2] * b[column + 6];
  }) as Matrix;
}

export function translate(x: number, y: number): Matrix {
  return [1, 0, x, 0, 1, y, 0, 0, 1];
}

export function cssMatrix(matrix: Matrix) {
  return `matrix3d(${matrix[0]},${matrix[3]},0,${matrix[6]},${matrix[1]},${matrix[4]},0,${matrix[7]},0,0,1,0,${matrix[2]},${matrix[5]},0,${matrix[8]})`;
}

/** The inherited tangent decays smoothly while the destination lands at rest. */
export function overlayPath(from: Quad, to: Quad, duration: number, velocity?: Quad) {
  return (progress: number): Quad => {
    const t = Math.max(0, Math.min(1, progress));
    const amount = t * t * t * (10 + t * (-15 + 6 * t));
    const momentum = t * (1 - t) ** 3 * duration;
    return from.map((point, index) => ({
      x: point.x + (to[index].x - point.x) * amount + (velocity?.[index].x ?? 0) * momentum,
      y: point.y + (to[index].y - point.y) * amount + (velocity?.[index].y ?? 0) * momentum,
    })) as Quad;
  };
}
