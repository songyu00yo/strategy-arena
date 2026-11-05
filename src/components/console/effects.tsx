"use client";
import { useEffect, useRef } from "react";

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const STATE_COLOR = {
  attack: "11,13,16",
  pending: "11,13,16",
  supported: "196,43,24",
  refuted: "19,112,66",
  unresolved: "143,95,0",
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
};
type Ring = { x: number; y: number; life: number; max: number; reach: number; color: string };

/** A small particle layer: comet trails and impacts. It only ever decorates a recorded step. */
export class Sparks {
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  private context: CanvasRenderingContext2D | null;
  private dirty = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.context = canvas.getContext("2d");
  }

  fit(width: number, height: number) {
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (this.canvas.width === Math.round(width * ratio)) return;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  comet(x: number, y: number, color: string) {
    for (let i = 0; i < 3; i++)
      this.sparks.push({
        x: x + (Math.random() - 0.5) * 3,
        y: y + (Math.random() - 0.5) * 3,
        vx: (Math.random() - 0.5) * 14,
        vy: (Math.random() - 0.5) * 14,
        life: 0,
        max: 0.32 + Math.random() * 0.34,
        size: 0.8 + Math.random() * 1.6,
        color,
      });
  }

  impact(x: number, y: number, color: string, power = 1) {
    for (let i = 0; i < 3; i++)
      this.rings.push({ x, y, life: -i * 0.09, max: 0.7, reach: (70 + i * 46) * power, color });
    for (let i = 0; i < 70 * power; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (70 + Math.random() * 300) * power;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        max: 0.4 + Math.random() * 0.6,
        size: 0.8 + Math.random() * 2.2,
        color,
      });
    }
  }

  tick(dt: number) {
    const c = this.context;
    if (!c) return;
    if (!this.sparks.length && !this.rings.length) {
      if (this.dirty) {
        c.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.dirty = false;
      }
      return;
    }
    this.dirty = true;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.rings = this.rings.filter((r) => (r.life += dt) < r.max);
    for (const r of this.rings) {
      if (r.life < 0) continue;
      const k = r.life / r.max;
      c.beginPath();
      c.arc(r.x, r.y, r.reach * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
      c.strokeStyle = `rgba(${r.color},${(1 - k) * 0.75})`;
      c.lineWidth = 2.4 * (1 - k) + 0.4;
      c.stroke();
    }
    this.sparks = this.sparks.filter((s) => (s.life += dt) < s.max);
    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.94;
      s.vy *= 0.94;
      c.fillStyle = `rgba(${s.color},${1 - s.life / s.max})`;
      c.fillRect(s.x, s.y, s.size, s.size);
    }
  }
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
    const duration = Math.min(900, 260 + glyphs.length * 14);
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
              .slice(0, solved + 6)
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

/** A number that rolls to its new value. */
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
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - began) / 650);
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
  return <span ref={ref}>{value.toLocaleString()}</span>;
}
