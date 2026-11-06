"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createMotionLoop, createMotionScope, motionNow } from "./motion-runtime";

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const STATE_COLOR = {
  attack: "255,255,255",
  pending: "120,190,255",
  supported: "255,70,45",
  refuted: "50,225,140",
  unresolved: "255,190,50",
};
/** Each route's light. Used only as light, never to carry a meaning of its own. */
export const ROUTE_COLOR: Record<string, string> = {
  A: "70,130,255",
  B: "255,60,150",
  C: "255,175,40",
};

type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  drag: number;
  rise: number;
};
type Ring = { x: number; y: number; life: number; max: number; reach: number; color: string };
type Stream = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bow: number;
  color: string;
  age: number;
  dur: number;
};
type Mote = { x: number; y: number; z: number; phase: number };

/** A light layer: comet trails, charges, impacts, embers and drifting dust. It only decorates recorded steps. */
export class Sparks {
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  private motes: Mote[] = [];
  private streams: Stream[] = [];
  private sprites = new Map<string, HTMLCanvasElement>();
  private context: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private time = 0;
  dark = false;
  private blank = false;
  dust = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private wake: () => void = () => {},
  ) {
    this.context = canvas.getContext("2d");
    for (let i = 0; i < 60; i++)
      this.motes.push({
        x: Math.random(),
        y: Math.random(),
        z: 0.25 + Math.random() * 0.75,
        phase: Math.random() * 6.28,
      });
  }

  private sprite(color: string) {
    let sprite = this.sprites.get(color);
    if (sprite) return sprite;
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = 48;
    const c = sprite.getContext("2d")!;
    const g = c.createRadialGradient(24, 24, 0, 24, 24, 24);
    g.addColorStop(0, `rgba(${color},1)`);
    g.addColorStop(0.22, `rgba(${color},.55)`);
    g.addColorStop(1, `rgba(${color},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, 48, 48);
    this.sprites.set(color, sprite);
    return sprite;
  }

  fit(width: number, height: number) {
    this.width = width;
    this.height = height;
    // Soft light needs no retina pixels, and a full-screen layer at 2x is what costs frames.
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

  private add(
    x: number,
    y: number,
    vx: number,
    vy: number,
    max: number,
    size: number,
    color: string,
    drag = 0.95,
    rise = 0,
  ) {
    if (this.sparks.length > 1400) return;
    this.sparks.push({ x, y, vx, vy, life: 0, max, size, color, drag, rise });
    this.wake();
  }

  /** Energy travelling from one part of the screen to another, ending in a small ring. */
  stream(x0: number, y0: number, x1: number, y1: number, color: string, ms: number) {
    const bow = (Math.random() < 0.5 ? -1 : 1) * Math.min(150, Math.hypot(x1 - x0, y1 - y0) * 0.25);
    this.streams.push({ x0, y0, x1, y1, bow, color, age: 0, dur: ms / 1000 });
    this.wake();
  }

  comet(x: number, y: number, color: string) {
    for (let i = 0; i < 4; i++)
      this.add(
        x + (Math.random() - 0.5) * 7,
        y + (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 46,
        (Math.random() - 0.5) * 46,
        0.45 + Math.random() * 0.7,
        3 + Math.random() * 8,
        color,
      );
    this.add(x, y, 0, 0, 0.26, 26, color);
  }

  /** Light gathers to a point before something launches. */
  charge(x: number, y: number, color: string) {
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 70 + Math.random() * 110;
      this.add(
        x + Math.cos(a) * r,
        y + Math.sin(a) * r,
        -Math.cos(a) * r * 2.5,
        -Math.sin(a) * r * 2.5,
        0.38,
        4 + Math.random() * 9,
        color,
        1,
      );
    }
  }

  impact(x: number, y: number, color: string, power = 1) {
    for (let i = 0; i < 2; i++)
      this.rings.push({ x, y, life: -i * 0.08, max: 0.85, reach: (60 + i * 42) * power, color });
    this.add(x, y, 0, 0, 0.26, 90 * power, color);
    for (let i = 0; i < 46 * power; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (40 + Math.random() * 240) * power;
      this.add(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.45 + Math.random() * 0.95,
        2 + Math.random() * 6,
        color,
        0.93,
        40,
      );
    }
  }

  /** A band of light rising from a line, as when old text burns away. */
  burn(x: number, y: number, width: number, color: string) {
    for (let i = 0; i < 30; i++)
      this.add(
        x + Math.random() * width,
        y + Math.random() * 14,
        (Math.random() - 0.5) * 60,
        -30 - Math.random() * 170,
        0.5 + Math.random() * 0.9,
        3 + Math.random() * 9,
        color,
        0.97,
      );
  }

  ember(color: string) {
    this.add(
      Math.random() * this.width,
      this.height + 10,
      (Math.random() - 0.5) * 34,
      -60 - Math.random() * 200,
      2 + Math.random() * 2.4,
      3 + Math.random() * 14,
      color,
      0.998,
    );
  }

  get active() {
    return (
      this.sparks.length > 0 || this.rings.length > 0 || this.streams.length > 0 || this.dust > 0.01
    );
  }

  clear() {
    this.sparks = [];
    this.rings = [];
    this.streams = [];
    this.context?.clearRect(0, 0, this.width, this.height);
    this.blank = true;
  }

  tick(dt: number) {
    const c = this.context;
    if (!c) return;
    this.time += dt;
    // Nothing on screen: leave the layer alone so the compositor has no work.
    const idle =
      !this.sparks.length && !this.rings.length && !this.streams.length && this.dust <= 0.01;
    if (idle && this.blank) return;
    this.blank = idle;
    c.clearRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = this.dark ? "lighter" : "source-over";
    if (this.dust > 0.01) {
      const sprite = this.sprite(this.dark ? "190,205,235" : "60,70,90");
      for (const m of this.motes) {
        m.y -= dt * 0.012 * m.z;
        if (m.y < -0.02) m.y = 1.02;
        const x = (m.x + Math.sin(this.time * 0.22 + m.phase) * 0.018) * this.width;
        const twinkle = 0.45 + 0.55 * Math.sin(this.time * 1.5 + m.phase * 3);
        c.globalAlpha = this.dust * twinkle * m.z * (this.dark ? 0.5 : 0.09);
        const size = 2.5 + m.z * 9;
        c.drawImage(sprite, x - size / 2, m.y * this.height - size / 2, size, size);
      }
    }
    this.streams = this.streams.filter((f) => {
      f.age += dt;
      const k = Math.min(1, f.age / f.dur);
      const e = 1 - Math.pow(1 - k, 2.4);
      const nx = -(f.y1 - f.y0);
      const ny = f.x1 - f.x0;
      const len = Math.hypot(nx, ny) || 1;
      const arc = Math.sin(e * Math.PI) * f.bow;
      const x = f.x0 + (f.x1 - f.x0) * e + (nx / len) * arc;
      const y = f.y0 + (f.y1 - f.y0) * e + (ny / len) * arc;
      this.comet(x, y, f.color);
      if (k >= 1) this.rings.push({ x, y, life: 0, max: 0.55, reach: 22, color: f.color });
      return k < 1;
    });
    this.rings = this.rings.filter((r) => (r.life += dt) < r.max);
    for (const r of this.rings) {
      if (r.life < 0) continue;
      const k = r.life / r.max;
      c.globalAlpha = 1;
      c.beginPath();
      c.arc(r.x, r.y, r.reach * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
      c.strokeStyle = `rgba(${r.color},${(1 - k) * 0.55})`;
      c.lineWidth = 2.4 * (1 - k) + 0.4;
      c.stroke();
    }
    this.sparks = this.sparks.filter((s) => (s.life += dt) < s.max);
    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= s.drag;
      s.vy = s.vy * s.drag + s.rise * dt;
      const fade = 1 - s.life / s.max;
      c.globalAlpha = fade * fade;
      const size = s.size * (0.5 + fade * 0.5);
      c.drawImage(this.sprite(s.color), s.x - size / 2, s.y - size / 2, size, size);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
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

/** Text that resolves out of its own characters. It always settles on the exact recorded text. */
export function Decode({
  text,
  active,
  delay = 0,
}: {
  text: string;
  active: boolean;
  delay?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    if (!active || reducedMotion() || !text) return;
    const pool = Array.from(text.replace(/\s/g, ""));
    const glyphs = Array.from(text);
    const duration = Math.min(1000, 300 + glyphs.length * 16);
    const scope = createMotionScope();
    let loop: ReturnType<typeof createMotionLoop> | undefined;
    scope.later(delay, () => {
      const began = motionNow();
      let painted = 0;
      loop = createMotionLoop((now) => {
        const k = (now - began) / duration;
        if (k >= 1) {
          el.textContent = text;
          return false;
        }
        if (now - painted < 33) return true;
        painted = now;
        const solved = Math.floor(Math.max(0, k) * glyphs.length);
        el.textContent = glyphs
          .slice(0, solved + 7)
          .map((g, i) =>
            i < solved || g === " " ? g : pool[Math.floor(Math.random() * pool.length)],
          )
          .join("");
        return true;
      });
    });
    return () => {
      scope.dispose();
      loop?.dispose();
      el.textContent = text;
    };
  }, [text, active, delay]);
  return <span ref={ref}>{text}</span>;
}

/** A number that rolls to its new value and jumps as it lands. */
export function Roll({
  value,
  delay = 0,
  animate = true,
}: {
  value: number;
  delay?: number;
  animate?: boolean;
}) {
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
    const scope = createMotionScope();
    let loop: ReturnType<typeof createMotionLoop> | undefined;
    scope.later(delay, () => {
      scope.animate(el, [{ transform: "scale(1.08)" }, { transform: "none" }], {
        duration: 420,
        easing: "cubic-bezier(.2,.7,.2,1)",
      });
      const began = motionNow();
      loop = createMotionLoop((now) => {
        const k = Math.max(0, Math.min(1, (now - began) / 420));
        shown.current = Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3)));
        el.textContent = shown.current.toLocaleString();
        return k < 1;
      });
    });
    return () => {
      scope.dispose();
      loop?.dispose();
    };
    // A step's delay is fixed when its recorded value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, animate]);
  return (
    <span ref={ref} className="c-roll">
      {value.toLocaleString()}
    </span>
  );
}

/** Drifting dust for a surface outside the stage, such as the home page. */
export function Dust({ dark = false, embers }: { dark?: boolean; embers?: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reducedMotion()) return;
    const sparks = new Sparks(canvas);
    sparks.dark = dark;
    sparks.dust = 1;
    const size = new ResizeObserver(() => sparks.fit(canvas.clientWidth, canvas.clientHeight));
    size.observe(canvas);
    let last = motionNow();
    const loop = createMotionLoop((now) => {
      if (now - last < 30) return true;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (embers?.length) sparks.ember(embers[Math.floor(Math.random() * embers.length)]);
      sparks.tick(dt);
      return true;
    });
    return () => {
      loop.dispose();
      size.disconnect();
      sparks.clear();
    };
  }, [dark, embers]);
  return <canvas ref={ref} className="c-dust" aria-hidden="true" />;
}

const CLICKABLE = "button, a[href], select, summary, label, [role='button']";

/** Every press answers the same way: a sprung push, a ring and a few sparks from the exact point touched. */
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
    if (reducedMotion()) return;
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
      const color = route ? route.replaceAll(" ", ",") : "11,13,16";
      const box = target.getBoundingClientRect();
      const scale = style.scale === "none" ? "1" : style.scale;
      const compact = !!target.closest(".c-time, .c-transport, .c-pull .actions");
      presses.get(target)?.cancel();
      const press = target.animate([{ scale }, { scale: "0.97", offset: 0.3 }, { scale: "1" }], {
        duration: compact ? 140 : 220,
        easing: "cubic-bezier(.2,.7,.2,1)",
      });
      presses.set(target, press);
      press.onfinish = () => {
        if (presses.get(target) === press) presses.delete(target);
      };
      if (!compact) {
        const ring = document.createElement("div");
        ring.className = "c-press-ring";
        ring.style.cssText = `left:${x}px;top:${y}px;color:rgb(${color})`;
        add(
          ring,
          [
            { transform: "translate(-50%,-50%) scale(.2)", opacity: 0.55 },
            { transform: "translate(-50%,-50%) scale(1)", opacity: 0 },
          ],
          300,
        );
      }
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
    return () => {
      removeEventListener("pointerdown", onPointer, true);
      removeEventListener("click", onClick, true);
      presses.forEach((animation) => animation.cancel());
      decorations.forEach((node) => {
        node.getAnimations().forEach((a) => a.cancel());
        node.remove();
      });
    };
  }, []);
  return null;
}
