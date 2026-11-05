"use client";
import { useEffect, useRef } from "react";

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
type Mote = { x: number; y: number; z: number; phase: number };

/** A light layer: comet trails, charges, impacts, embers and drifting dust. It only decorates recorded steps. */
export class Sparks {
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  private motes: Mote[] = [];
  private sprites = new Map<string, HTMLCanvasElement>();
  private context: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private time = 0;
  dark = false;
  dust = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.context = canvas.getContext("2d");
    for (let i = 0; i < 160; i++)
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
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (this.canvas.width === Math.round(width * ratio)) return;
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
  }

  comet(x: number, y: number, color: string) {
    for (let i = 0; i < 9; i++)
      this.add(
        x + (Math.random() - 0.5) * 7,
        y + (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 46,
        (Math.random() - 0.5) * 46,
        0.45 + Math.random() * 0.7,
        5 + Math.random() * 15,
        color,
      );
    this.add(x, y, 0, 0, 0.32, 58, color);
  }

  /** Light gathers to a point before something launches. */
  charge(x: number, y: number, color: string) {
    for (let i = 0; i < 6; i++) {
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
    for (let i = 0; i < 4; i++)
      this.rings.push({ x, y, life: -i * 0.08, max: 0.85, reach: (90 + i * 70) * power, color });
    this.add(x, y, 0, 0, 0.32, 240 * power, color);
    for (let i = 0; i < 130 * power; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (60 + Math.random() * 560) * power;
      this.add(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.45 + Math.random() * 0.95,
        3 + Math.random() * 12,
        color,
        0.93,
        40,
      );
    }
  }

  /** A band of light rising from a line, as when old text burns away. */
  burn(x: number, y: number, width: number, color: string) {
    for (let i = 0; i < 80; i++)
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

  tick(dt: number) {
    const c = this.context;
    if (!c) return;
    this.time += dt;
    c.clearRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = this.dark ? "lighter" : "source-over";
    if (this.dust > 0.01) {
      const sprite = this.sprite(this.dark ? "190,205,235" : "60,70,90");
      for (const m of this.motes) {
        m.y -= dt * 0.012 * m.z;
        if (m.y < -0.02) m.y = 1.02;
        const x = (m.x + Math.sin(this.time * 0.22 + m.phase) * 0.018) * this.width;
        const twinkle = 0.45 + 0.55 * Math.sin(this.time * 1.5 + m.phase * 3);
        c.globalAlpha = this.dust * twinkle * m.z * (this.dark ? 0.5 : 0.16);
        const size = 2.5 + m.z * 9;
        c.drawImage(sprite, x - size / 2, m.y * this.height - size / 2, size, size);
      }
    }
    this.rings = this.rings.filter((r) => (r.life += dt) < r.max);
    for (const r of this.rings) {
      if (r.life < 0) continue;
      const k = r.life / r.max;
      c.globalAlpha = 1;
      c.beginPath();
      c.arc(r.x, r.y, r.reach * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
      c.strokeStyle = `rgba(${r.color},${(1 - k) * 0.9})`;
      c.lineWidth = 5 * (1 - k) + 0.5;
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
    const began = performance.now() + delay;
    let frame = 0;
    const tick = (now: number) => {
      const k = (now - began) / duration;
      if (k >= 1) {
        el.textContent = text;
        return;
      }
      const solved = Math.floor(Math.max(0, k) * glyphs.length);
      el.textContent =
        k < 0
          ? ""
          : glyphs
              .slice(0, solved + 7)
              .map((g, i) =>
                i < solved || g === " " ? g : pool[Math.floor(Math.random() * pool.length)],
              )
              .join("");
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.textContent = text;
    };
  }, [text, active, delay]);
  return <span ref={ref}>{text}</span>;
}

/** A number that rolls to its new value and jumps as it lands. */
export function Roll({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    shown.current = value;
    if (from === value || reducedMotion()) {
      el.textContent = value.toLocaleString();
      return;
    }
    el.animate(
      [
        { transform: "scale(1.9) translateY(-3px)", textShadow: "0 0 18px currentColor" },
        { transform: "none", textShadow: "0 0 0 transparent" },
      ],
      { duration: 700, easing: "cubic-bezier(.2,1.4,.3,1)" },
    );
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - began) / 700);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (value - from) * eased).toLocaleString();
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.textContent = value.toLocaleString();
    };
  }, [value]);
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
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      sparks.fit(canvas.clientWidth, canvas.clientHeight);
      if (embers?.length)
        for (let i = 0; i < 3; i++) sparks.ember(embers[Math.floor(Math.random() * embers.length)]);
      sparks.tick(dt);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dark, embers]);
  return <canvas ref={ref} className="c-dust" aria-hidden="true" />;
}
