"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { recordMotionOrigin } from "../motion-origin";
import {
  createMotionLoop,
  createMotionScope,
  useReducedMotion,
  type MotionOrigin,
} from "./motion-runtime";

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const STATE_COLOR = {
  attack: "21,19,15",
  pending: "92,86,74",
  supported: "200,51,31",
  refuted: "47,101,73",
  unresolved: "154,106,28",
};
/** Each route's ink: printed indigo, vermilion and ochre. Never carries a meaning of its own. */
export const ROUTE_COLOR: Record<string, string> = {
  A: "38,69,122",
  B: "200,51,31",
  C: "154,106,28",
};

type Blot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  grow: number;
};
type Ring = { x: number; y: number; life: number; max: number; reach: number; color: string };
type Stroke = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bow: number;
  color: string;
  age: number;
  dur: number;
  width: number;
};

const inkEase = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 4);

/**
 * An ink layer: brush strokes that are drawn between parts of the page, blots where they land,
 * and a strike when old text is replaced. Solid ink only, no glow. It only decorates recorded steps.
 */
export class Sparks {
  private blots: Blot[] = [];
  private rings: Ring[] = [];
  private strokes: Stroke[] = [];
  private context: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private blank = false;
  dark = false;
  dust = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private wake: () => void = () => {},
  ) {
    this.context = canvas.getContext("2d");
  }

  fit(width: number, height: number) {
    this.width = width;
    this.height = height;
    // Ink at 1x is soft enough; a full-screen 2x layer is what costs frames.
    const ratio = 1;
    if (
      this.canvas.width === Math.round(width * ratio) &&
      this.canvas.height === Math.round(height * ratio)
    )
      return;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private blot(
    x: number,
    y: number,
    vx: number,
    vy: number,
    max: number,
    size: number,
    color: string,
    grow = 1,
  ) {
    if (this.blots.length > 260) return;
    this.blots.push({ x, y, vx, vy, life: 0, max, size, color, grow });
    this.wake();
  }

  /** A brush stroke from one part of the page to another, drawn like a pen moving across paper. */
  stream(x0: number, y0: number, x1: number, y1: number, color: string, ms: number) {
    const bow = (Math.random() < 0.5 ? -1 : 1) * Math.min(90, Math.hypot(x1 - x0, y1 - y0) * 0.16);
    this.strokes.push({ x0, y0, x1, y1, bow, color, age: 0, dur: ms / 1000, width: 2.4 });
    this.wake();
  }

  /** A moving point leaves a fine ink trail behind it. */
  comet(x: number, y: number, color: string) {
    this.blot(x, y, 0, 0, 0.42, 2.2 + Math.random() * 1.2, color, 0);
  }

  /** Nothing gathers before a launch: ink does not glow. */
  charge(x: number, y: number, color: string) {
    void x;
    void y;
    void color;
  }

  /** Ink lands: a blot spreads, a fine ring opens once, a few drops fall short. */
  impact(x: number, y: number, color: string, power = 1) {
    this.rings.push({ x, y, life: 0, max: 0.9, reach: 34 * power + 12, color });
    this.blot(x, y, 0, 0, 0.9, 9 * power + 4, color, 1);
    const drops = Math.round(5 + 4 * power);
    for (let i = 0; i < drops; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (40 + Math.random() * 90) * power;
      this.blot(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.7 + Math.random() * 0.5,
        1.2 + Math.random() * 2.6,
        color,
        0.3,
      );
    }
  }

  /** Old text is struck through with one firm stroke. */
  burn(x: number, y: number, width: number, color: string) {
    this.strokes.push({
      x0: x,
      y0: y + 9,
      x1: x + width,
      y1: y + 9 + (Math.random() - 0.5) * 3,
      bow: 1.5,
      color,
      age: 0,
      dur: 0.42,
      width: 2,
    });
    this.wake();
  }

  ember(color: string) {
    void color;
  }

  get active() {
    return this.blots.length > 0 || this.rings.length > 0 || this.strokes.length > 0;
  }

  clear() {
    this.blots = [];
    this.rings = [];
    this.strokes = [];
    this.context?.clearRect(0, 0, this.width, this.height);
    this.blank = true;
  }

  private point(f: Stroke, t: number) {
    const nx = -(f.y1 - f.y0);
    const ny = f.x1 - f.x0;
    const len = Math.hypot(nx, ny) || 1;
    const arc = Math.sin(t * Math.PI) * f.bow;
    return [
      f.x0 + (f.x1 - f.x0) * t + (nx / len) * arc,
      f.y0 + (f.y1 - f.y0) * t + (ny / len) * arc,
    ];
  }

  tick(dt: number) {
    const c = this.context;
    if (!c) return;
    const idle = !this.active;
    if (idle && this.blank) return;
    this.blank = idle;
    c.clearRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = "source-over";
    c.lineCap = "round";
    c.lineJoin = "round";
    // Strokes: drawn with the pen, held a moment, then the ink dries away.
    const HOLD = 0.35;
    const FADE = 0.55;
    this.strokes = this.strokes.filter((f) => {
      f.age += dt;
      const drawn = inkEase(f.age / f.dur);
      const after = f.age - f.dur - HOLD;
      const alpha = after > 0 ? Math.max(0, 1 - after / FADE) : 1;
      const segments = 28;
      const upto = Math.max(1, Math.round(segments * drawn));
      let [px, py] = this.point(f, 0);
      for (let i = 1; i <= upto; i++) {
        const t = (i / segments) * (drawn * segments >= i ? 1 : drawn);
        const [x, y] = this.point(f, Math.min(t, drawn));
        // A brush swells in the middle of a stroke and lifts at both ends.
        const pressure = Math.pow(Math.sin((i / segments) * Math.PI), 0.7);
        c.globalAlpha = alpha * 0.82;
        c.strokeStyle = `rgb(${f.color})`;
        c.lineWidth = 0.6 + f.width * pressure;
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(x, y);
        c.stroke();
        px = x;
        py = y;
      }
      if (f.age >= f.dur && !(f as Stroke & { landed?: boolean }).landed) {
        (f as Stroke & { landed?: boolean }).landed = true;
        this.blot(f.x1, f.y1, 0, 0, 0.6, 3.4, f.color, 1);
      }
      return after < FADE;
    });
    this.rings = this.rings.filter((r) => (r.life += dt) < r.max);
    for (const r of this.rings) {
      const k = r.life / r.max;
      c.globalAlpha = (1 - k) * 0.55;
      c.beginPath();
      c.arc(r.x, r.y, r.reach * inkEase(k), 0, Math.PI * 2);
      c.strokeStyle = `rgb(${r.color})`;
      c.lineWidth = 1.2;
      c.stroke();
    }
    this.blots = this.blots.filter((b) => (b.life += dt) < b.max);
    for (const b of this.blots) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= 0.86;
      b.vy *= 0.86;
      const k = b.life / b.max;
      const spread = b.grow ? 0.55 + 0.45 * inkEase(k * 3) : 1;
      c.globalAlpha = Math.pow(1 - k, 1.6) * 0.85;
      c.fillStyle = `rgb(${b.color})`;
      c.beginPath();
      c.arc(b.x, b.y, b.size * spread, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }
}

/** Letters that turn into place one by one. The text stays exactly as recorded. */
export function Chars({
  text,
  active,
  delay = 0,
}: {
  text: string;
  active: boolean;
  delay?: number;
}) {
  if (!active) return <>{text}</>;
  const glyphs = Array.from(text);
  const step = Math.min(34, 900 / Math.max(glyphs.length, 1));
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {glyphs.map((glyph, i) =>
          glyph === " " ? (
            " "
          ) : (
            <span key={i} className="c-char" style={{ animationDelay: `${delay + i * step}ms` }}>
              {glyph}
            </span>
          ),
        )}
      </span>
    </>
  );
}

/** Text that comes into focus like ink settling. It is always the exact recorded text. */
export function Decode({
  text,
  active,
  delay = 0,
  origin = "story",
}: {
  text: string;
  active: boolean;
  delay?: number;
  origin?: MotionOrigin;
}) {
  const reducePreference = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || reducedMotion() || !text) return;
    // Ink settles into the paper: out of focus, then sharp. The text itself never changes.
    const scope = createMotionScope(origin);
    scope.animate(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 760,
      delay,
      easing: "cubic-bezier(.19,1,.22,1)",
      fill: "backwards",
    });
    return () => scope.dispose();
  }, [text, active, delay, origin, reducePreference]);
  return <span ref={ref}>{text}</span>;
}

/** A number that rolls to its new value and jumps as it lands. */
export function Roll({
  value,
  delay = 0,
  animate = true,
  origin = "story",
}: {
  value: number;
  delay?: number;
  animate?: boolean;
  origin?: MotionOrigin;
}) {
  const reducePreference = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    if (from === value || !animate || reducedMotion()) {
      shown.current = value;
      el.textContent = value.toLocaleString();
      return;
    }
    const scope = createMotionScope(origin);
    let loop: ReturnType<typeof createMotionLoop> | undefined;
    scope.later(delay, () => {
      scope.animate(el, [{ transform: "scale(1.3)" }, { transform: "none" }], {
        duration: 700,
        easing: "cubic-bezier(0.19, 1, 0.22, 1)",
      });
      const began = scope.now();
      loop = createMotionLoop((now) => {
        const k = Math.max(0, Math.min(1, (now - began) / 700));
        shown.current = Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3)));
        el.textContent = shown.current.toLocaleString();
        return k < 1;
      }, origin);
    });
    return () => {
      scope.dispose();
      loop?.dispose();
    };
    // A step's delay is fixed when its recorded value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, animate, origin, reducePreference]);
  return (
    <span ref={ref} className="c-roll">
      {value.toLocaleString()}
    </span>
  );
}

/** Drifting dust for a surface outside the stage, such as the home page. */
/** Drifting dust was light, not ink; the paper page keeps still behind its titles. */
export function Dust(props: { dark?: boolean; embers?: string[] }) {
  void props;
  return null;
}

const CLICKABLE = "button, a[href], select, summary, label, [role='button']";

/** Every press answers the same way: pressed into the paper, a dab of ink and one ring from the exact point touched. */
/**
 * Closing is animated by a stand-in. The real element leaves at once, so focus and state stay correct,
 * and every way of closing (button, Esc, backdrop, submit) gets the same exit.
 */
export function leaveAs(
  el: HTMLElement | null,
  frames: Keyframe[],
  options: { duration?: number; backdrop?: string; inner?: string; innerFrames?: Keyframe[] } = {},
) {
  if (!el || reducedMotion()) return;
  const host = el.closest(".console-shell") ?? document.querySelector(".console-shell");
  const box = el.getBoundingClientRect();
  if (!host || !box.width) return;
  host.querySelectorAll<HTMLElement>(".c-ghost").forEach((previous) => {
    if (previous.dataset.exitKey === el.className) {
      previous.getAnimations().forEach((animation) => animation.cancel());
      previous.remove();
    }
  });
  const ghost = document.createElement("div");
  ghost.className = `${el.className} c-ghost`;
  ghost.dataset.exitKey = el.className;
  ghost.innerHTML = el.innerHTML;
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  ghost.querySelectorAll("[role]").forEach((node) => node.removeAttribute("role"));
  const duration = options.duration ?? 240;
  ghost.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;margin:0;max-width:none;max-height:none;z-index:200;pointer-events:none;display:block;animation:none;overflow:hidden`;
  host.appendChild(ghost);
  ghost.animate(frames, {
    duration,
    easing: "cubic-bezier(.4,0,.8,.3)",
    fill: "forwards",
  }).onfinish = () => ghost.remove();
  if (options.backdrop) {
    const veil = document.createElement("div");
    veil.style.cssText = `position:fixed;inset:0;z-index:199;pointer-events:none;background:${options.backdrop}`;
    host.appendChild(veil);
    veil.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration,
      easing: "ease-out",
      fill: "forwards",
    }).onfinish = () => veil.remove();
  }
}

/** A short stream of light between two places on screen, ending in a small ring. */
export function flyLight(from: DOMRect, to: DOMRect, color: string, ms = 420) {
  if (reducedMotion()) return () => {};
  const pieces: HTMLElement[] = [];
  const x0 = from.left + from.width / 2;
  const y0 = from.top + from.height / 2;
  const x1 = to.left + Math.min(to.width / 2, 60);
  const y1 = to.top + Math.min(to.height / 2, 14);
  const lift = Math.max(40, Math.abs(x1 - x0) * 0.16 + Math.abs(y1 - y0) * 0.12);
  const route = `path("M${x0},${y0} C${x0},${y0 - lift} ${x1},${y1 - lift} ${x1},${y1}")`;
  const count = 12;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("div");
    dot.className = "c-fill-dot";
    const size = 7 - i * 0.42;
    dot.style.cssText = `width:${size}px;height:${size}px;background:rgb(${color});offset-path:${route};opacity:${1 - i / count}`;
    pieces.push(dot);
    document.body.appendChild(dot);
    dot.animate([{ offsetDistance: "0%" }, { offsetDistance: "100%" }], {
      duration: ms,
      delay: i * 16,
      easing: "cubic-bezier(.5,0,.2,1)",
      fill: "both",
    }).onfinish = () => dot.remove();
  }
  const ring = document.createElement("div");
  ring.className = "c-press-ring";
  ring.style.cssText = `left:${x1}px;top:${y1}px;color:rgb(${color});width:56px;height:56px`;
  pieces.push(ring);
  document.body.appendChild(ring);
  ring.animate(
    [
      { transform: "translate(-50%,-50%) scale(.2)", opacity: 0.8 },
      { transform: "translate(-50%,-50%) scale(1)", opacity: 0 },
    ],
    { duration: 420, delay: ms * 0.92, easing: "cubic-bezier(.16,1,.3,1)", fill: "both" },
  ).onfinish = () => ring.remove();
  return () => {
    pieces.forEach((piece) => {
      piece.getAnimations().forEach((animation) => animation.cancel());
      piece.remove();
    });
  };
}

/** A container that animates out when it is removed. */
export function Leaving({
  frames,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { frames: Keyframe[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const exit = useRef(frames);
  useLayoutEffect(() => {
    const el = ref.current;
    const leave = exit.current;
    return () => leaveAs(el, leave, { duration: 200 });
  }, []);
  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  );
}

export function ClickFx() {
  useEffect(() => {
    const presses = new Map<HTMLElement, Animation>();
    const decorations = new Set<HTMLElement>();
    const add = (node: HTMLElement, frames: Keyframe[], duration: number) => {
      decorations.add(node);
      document.body.appendChild(node);
      const animation = node.animate(frames, { duration, easing: "cubic-bezier(.16,1,.3,1)" });
      animation.onfinish = () => {
        decorations.delete(node);
        node.remove();
      };
    };
    const answer = (target: HTMLElement, x: number, y: number) => {
      // Read before adding nodes or starting any animation.
      const style = getComputedStyle(target);
      const route = style.getPropertyValue("--route").trim();
      const color = route ? route.replaceAll(" ", ",") : "21,19,15";
      const box = target.getBoundingClientRect();
      recordMotionOrigin(target, x, y, box);
      if (reducedMotion()) return;
      const scale = style.scale === "none" ? "1" : style.scale;
      presses.get(target)?.cancel();
      // Pressed into the paper and released: no spring past rest.
      const press = target.animate([{ scale }, { scale: "0.962", offset: 0.22 }, { scale }], {
        duration: 560,
        easing: "cubic-bezier(.19,1,.22,1)",
      });
      presses.set(target, press);
      press.onfinish = () => {
        if (presses.get(target) === press) presses.delete(target);
      };
      // Ink touched to the page: a dab where the finger was and one fine ring that opens and dries.
      const dab = document.createElement("div");
      dab.className = "c-press-dab";
      dab.style.cssText = `left:${x}px;top:${y}px;background:rgb(${color})`;
      add(
        dab,
        [
          { transform: "translate(-50%,-50%) scale(1)", opacity: 0.55 },
          { transform: "translate(-50%,-50%) scale(.2)", opacity: 0 },
        ],
        520,
      );
      const ring = document.createElement("div");
      ring.className = "c-press-ring";
      ring.style.cssText = `left:${x}px;top:${y}px;color:rgb(${color})`;
      add(
        ring,
        [
          { transform: "translate(-50%,-50%) scale(.15)", opacity: 0.7 },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 0 },
        ],
        760,
      );
      target.style.setProperty("--cx", `${x - box.left}px`);
      target.style.setProperty("--cy", `${y - box.top}px`);
      document.documentElement.style.setProperty("--press-dx", `${x - innerWidth / 2}px`);
      document.documentElement.style.setProperty("--press-dy", `${y - innerHeight / 2}px`);
    };
    const onPointer = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>(CLICKABLE);
      if (target && !target.matches(":disabled")) answer(target, event.clientX, event.clientY);
    };
    const onClick = (event: MouseEvent) => {
      if (event.detail !== 0) return;
      const target = (event.target as Element | null)?.closest<HTMLElement>(CLICKABLE);
      if (!target || target.matches(":disabled")) return;
      const box = target.getBoundingClientRect();
      answer(target, box.left + box.width / 2, box.top + box.height / 2);
    };
    addEventListener("pointerdown", onPointer, true);
    addEventListener("click", onClick, true);
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const clearDecorations = () => {
      presses.forEach((animation) => animation.cancel());
      presses.clear();
      decorations.forEach((node) => {
        node.getAnimations().forEach((animation) => animation.cancel());
        node.remove();
      });
      decorations.clear();
    };
    const changedPreference = () => {
      if (preference.matches) clearDecorations();
    };
    preference.addEventListener("change", changedPreference);
    return () => {
      removeEventListener("pointerdown", onPointer, true);
      removeEventListener("click", onClick, true);
      preference.removeEventListener("change", changedPreference);
      clearDecorations();
    };
  }, []);
  return null;
}
