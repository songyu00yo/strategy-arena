import { reducedMotion } from "../console/effects";

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];
const flights = new WeakMap<HTMLElement, () => void>();

/** Read projected corners once, including the Agent board's parent perspective. */
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
  return `matrix3d(${(b.x - a.x + g * b.x) / width},${(b.y - a.y + g * b.y) / width},0,${g / width},${(d.x - a.x + h * d.x) / height},${(d.y - a.y + h * d.y) / height},0,${h / height},0,0,1,0,${a.x},${a.y},0,1)`;
}

export function settlePaper(panel: HTMLElement) {
  flights.get(panel)?.();
  panel.style.transform = "none";
  panel.style.opacity = "1";
  panel.style.willChange = "";
}

/** Seven spatial samples describe a curl; native easing supplies a continuous time curve.
 * Only transform and opacity animate. No per-frame layout, shadow paint or global hold. */
export function animatePaper(
  panel: HTMLElement,
  anchor: HTMLElement | null,
  opening: boolean,
  done?: () => void,
  start?: Quad,
  options: { continuation?: boolean } = {},
) {
  const previous = flights.get(panel);
  const currentPose = start ?? (!opening || previous ? paperCorners(panel) : undefined);
  const currentOpacity = previous ? Number(getComputedStyle(panel).opacity) : 1;
  previous?.();
  panel.style.transform = "none";
  panel.style.opacity = "1";
  panel.style.transformOrigin = "0 0";
  if (reducedMotion()) {
    done?.();
    return () => {};
  }
  const box = panel.getBoundingClientRect();
  if (!box.width || !box.height) {
    done?.();
    return () => {};
  }
  const own: Quad = [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
  const anchorBox = anchor?.getBoundingClientRect();
  const visibleAnchor =
    anchor &&
    anchorBox &&
    anchorBox.width > 0 &&
    anchorBox.height > 0 &&
    anchorBox.bottom > 0 &&
    anchorBox.top < innerHeight &&
    anchorBox.right > 0 &&
    anchorBox.left < innerWidth;
  const destination = visibleAnchor
    ? paperCorners(anchor)
    : (own.map((point) => ({ x: point.x + 28, y: point.y + 18 })) as Quad);
  const incoming = options.continuation
    ? (own.map((point, index) => ({
        x: point.x + (index === 1 || index === 2 ? 30 : 14),
        y: point.y + (index < 2 ? 18 : 8),
      })) as Quad)
    : destination;
  const from = currentPose ?? (opening ? incoming : own);
  const to = opening ? own : destination;
  const distance = Math.hypot(to[0].x - from[0].x, to[0].y - from[0].y);
  const lift = Math.min(options.continuation ? 16 : 38, distance * 0.06);
  const frames = [0, 0.16, 0.36, 0.58, 0.78, 0.92, 1].map((progress): Keyframe => {
    const arc = Math.sin(Math.PI * progress);
    const quad = from.map((point, index) => ({
      x: point.x + (to[index].x - point.x) * progress - box.left,
      y:
        point.y +
        (to[index].y - point.y) * progress -
        box.top -
        lift * arc +
        (index === 1 || index === 2 ? arc * 7 : 0),
    })) as Quad;
    return {
      offset: progress,
      transform: progress === 1 && opening ? "none" : projection(box.width, box.height, quad),
      opacity: opening
        ? currentPose
          ? currentOpacity + (1 - currentOpacity) * progress
          : Math.min(1, 0.12 + progress * 4)
        : currentOpacity * (progress < 0.78 ? 1 : (1 - progress) / 0.22),
    };
  });
  panel.style.willChange = "transform, opacity";
  const flight = panel.animate(frames, {
    duration: options.continuation ? (opening ? 180 : 220) : opening ? 460 : 320,
    easing: "cubic-bezier(.18,.74,.24,1)",
    fill: "both",
  });
  let disposed = false;
  const cancel = () => {
    if (disposed) return;
    disposed = true;
    // Keep the current pose before cancelling fill; replacement flights never flash home.
    const style = getComputedStyle(panel);
    panel.style.transform = style.transform;
    panel.style.opacity = style.opacity;
    flight.onfinish = null;
    flight.cancel();
    panel.style.willChange = "";
    if (flights.get(panel) === cancel) flights.delete(panel);
  };
  flights.set(panel, cancel);
  flight.onfinish = () => {
    if (disposed) return;
    disposed = true;
    panel.style.transform = opening ? "none" : String(frames.at(-1)!.transform);
    panel.style.opacity = opening ? "1" : "0";
    flight.cancel();
    panel.style.willChange = "";
    flights.delete(panel);
    done?.();
  };
  return cancel;
}

export const agentPaperAnchor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-paper-origin="${id}"]`) ??
  document.querySelector<HTMLElement>(`[data-planning-agent="${id}"]`);
