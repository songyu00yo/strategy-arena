import { createMotionScope } from "../console/motion-runtime";
import { reducedMotion } from "../console/effects";

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];

// The same projected-corner method used by the original StepCard. Keeping the four
// actual corners avoids a visible jump when paper leaves a tilted Agent board.
export function paperCorners(element: HTMLElement): Quad {
  const markers = [
    [0, 0],
    [element.offsetWidth, 0],
    [element.offsetWidth, element.offsetHeight],
    [0, element.offsetHeight],
  ].map(([x, y]) => {
    const marker = document.createElement("i");
    marker.style.cssText = `position:absolute;left:${x - element.clientLeft}px;top:${y - element.clientTop}px;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden`;
    element.appendChild(marker);
    return marker;
  });
  const points = markers.map((marker) => {
    const rect = marker.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }) as Quad;
  markers.forEach((marker) => marker.remove());
  return points;
}

function projection(width: number, height: number, q: Quad) {
  const [a, b, c, d] = q;
  const dx1 = b.x - c.x,
    dx2 = d.x - c.x,
    dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y,
    dy2 = d.y - c.y,
    dy3 = a.y - b.y + c.y - d.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(det) > 0.0001 ? (dx3 * dy2 - dx2 * dy3) / det : 0;
  const h = Math.abs(det) > 0.0001 ? (dx1 * dy3 - dx3 * dy1) / det : 0;
  const m = [
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
  return `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,1)`;
}

export function animatePaper(
  panel: HTMLElement,
  anchor: HTMLElement | null,
  opening: boolean,
  done?: () => void,
  start?: Quad,
) {
  const scope = createMotionScope("interaction");
  if (reducedMotion()) {
    done?.();
    return () => scope.dispose();
  }
  const box = panel.getBoundingClientRect();
  const own = paperCorners(panel);
  const destination =
    anchor && anchor.getBoundingClientRect().width
      ? paperCorners(anchor)
      : (own.map((point) => ({ x: point.x + 32, y: point.y + 26 })) as Quad);
  const from = start ?? (opening ? destination : own);
  const to = opening ? own : destination;
  const frames = Array.from({ length: 41 }, (_, index): Keyframe => {
    const t = index / 40;
    const ease = t === 1 ? 1 : 1 - (1 + 7.8 * t) * Math.exp(-7.8 * t);
    const rise = -62 * Math.sin(Math.PI * ease) ** 2;
    const quad = from.map((point, i) => ({
      x: point.x + (to[i].x - point.x) * ease - box.left,
      y: point.y + (to[i].y - point.y) * ease + rise - box.top,
    })) as Quad;
    return {
      transform: projection(box.width, box.height, quad),
      opacity: opening ? Math.min(1, t * 5) : t > 0.82 ? (1 - t) / 0.18 : 1,
      boxShadow: `0 ${Math.sin(Math.PI * ease) * 24 + 4}px ${Math.sin(Math.PI * ease) * 48 + 6}px rgb(21 19 15 / ${0.1 + Math.sin(Math.PI * ease) * 0.12})`,
    };
  });
  panel.style.transformOrigin = "0 0";
  const flight = scope.animate(panel, frames, {
    duration: opening ? 900 : 760,
    easing: "linear",
    fill: "both",
  });
  flight.onfinish = () => {
    flight.cancel();
    done?.();
  };
  return () => scope.dispose();
}

export const agentPaperAnchor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-paper-origin="${id}"]`) ??
  document.querySelector<HTMLElement>(`[data-planning-agent="${id}"]`);
