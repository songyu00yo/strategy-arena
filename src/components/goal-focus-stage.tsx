"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  createMotionLoop,
  createMotionScope,
  motionPaused,
  subscribeMotionPause,
} from "./console/motion-runtime";
import "./goal-focus-stage.css";

type Point = { x: number; y: number };
type Pulse = { at: number; point: Point; action: boolean; color: number };
type Field = {
  width: number;
  height: number;
  docLeft: number;
  docTop: number;
  panel: { x: number; y: number; width: number; height: number };
};

const COLORS = ["64,119,245", "235,53,138", "209,139,13"];
const UNIT = Array.from({ length: 161 }, (_, i) => {
  const t = (i / 160) * Math.PI * 2;
  const x = Math.cos(t);
  const y = Math.sin(t);
  return { x: Math.sign(x) * Math.abs(x) ** 0.58, y: Math.sign(y) * Math.abs(y) ** 0.72 };
});
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** A decorative field around the real form, with no duplicate inputs or text. */
export function GoalFocusStage({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef({ focused: false, energy: 0, pulses: [] as Pulse[], sequence: 0 });

  useLayoutEffect(() => {
    const host = root.current;
    const content = panel.current;
    const surface = canvas.current;
    const ctx = surface?.getContext("2d", { alpha: true });
    if (!host || !content || !surface || !ctx) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const scope = createMotionScope();
    let field: Field | null = null;
    let visible = true;
    let windowActive = document.hasFocus();
    let expanded = false;
    let disposed = false;
    let introStarted = false;
    let age = 0;
    let focused = 0;
    let lastPaint = -100;
    let measureFrame = 0;
    let intro: Animation | null = null;

    const point = (fraction: number, rail: number, tight = focused): Point => {
      const f = field!;
      const p = f.panel;
      const turn = (((fraction % 1) + 1) % 1) * 160;
      const a = UNIT[Math.floor(turn)];
      const b = UNIT[Math.floor(turn) + 1];
      const mix = turn % 1;
      const x = a.x + (b.x - a.x) * mix;
      const y = a.y + (b.y - a.y) * mix;
      const gap = 16 + rail * 15 - tight * 8;
      const sideRoom = Math.max(0, Math.min(p.x, f.width - p.x - p.width) - 3);
      // Keep the innermost rail beyond the mask, then compress the remaining rail spacing equally.
      const gutter = Math.min(4.5, sideRoom);
      const horizontalScale = Math.min(1, (sideRoom - gutter) / (46 - tight * 8 - gutter));
      const horizontalGap = gutter + (gap - gutter) * horizontalScale;
      return {
        x: p.x + p.width / 2 + x * (p.width / 2 + horizontalGap),
        y: p.y + p.height / 2 + y * (p.height / 2 + gap * 0.65) + x * (rail - 1) * 8,
      };
    };
    const color = (index: number, alpha: number) => `rgba(${COLORS[index % 3]},${alpha})`;
    const path = (rail: number, start: number, length: number) => {
      const steps = Math.max(2, Math.ceil(length * 160));
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const p = point(start + (length * i) / steps, rail);
        if (!i) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
    };
    const draw = (still = false) => {
      const f = field;
      if (!f) return;
      const { width, height, panel: p } = f;
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      // All drawing stays outside the actual input surface, even while its height changes.
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.roundRect(p.x - 4, p.y - 4, p.width + 8, p.height + 8, 14);
      ctx.clip("evenodd");
      const reveal = still ? 1 : clamp((age - 0.12) / 1.65);
      const strength = expanded ? 0.46 : 1;
      for (let rail = 0; rail < 3; rail++) {
        const start = rail / 3 + 0.08;
        path(rail, start, reveal);
        ctx.strokeStyle = color(rail, strength * (still ? 0.13 : 0.22 + focused * 0.15));
        ctx.lineWidth = 0.7;
        ctx.stroke();
        if (still) continue;
        // A bright narrow core rides a longer, dimmer trail. No per-particle blurs or filters.
        const head = start + age * (0.027 + rail * 0.004) + input.current.energy * 0.018;
        for (let segment = 0; segment < 12; segment++) {
          path(rail, head - segment * 0.006, 0.006);
          ctx.lineWidth = segment < 2 ? 1.65 : 0.9;
          ctx.strokeStyle = color(
            rail,
            strength * reveal * (1 - segment / 12) * (0.7 + focused * 0.22),
          );
          ctx.stroke();
        }
        for (let dot = 0; dot < 14; dot++) {
          const phase = dot / 14 + rail * 0.17 + age * (0.012 + (dot % 3) * 0.003);
          const a = point(phase, rail);
          const b = point(phase - 0.0025 - input.current.energy * 0.002, rail);
          const alpha = (0.16 + (dot % 5) * 0.08 + input.current.energy * 0.2) * reveal * strength;
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(a.x, a.y);
          ctx.lineWidth = dot % 4 === 0 ? 1.5 : 0.85;
          ctx.strokeStyle = color(rail, alpha);
          ctx.stroke();
        }
        const glint = point(head, rail);
        ctx.strokeStyle = color(rail, strength * reveal * 0.85);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(glint.x - 4, glint.y);
        ctx.lineTo(glint.x + 4, glint.y);
        ctx.moveTo(glint.x, glint.y - 4);
        ctx.lineTo(glint.x, glint.y + 4);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,.95)";
        ctx.fillRect(glint.x - 0.8, glint.y - 0.8, 1.6, 1.6);
        if (age < 2.2) {
          const arrival = clamp((age - rail * 0.16) / 1.4);
          const destination = point(start + 0.1, rail);
          const origin = { x: rail === 1 ? width + 70 : -70, y: rail === 2 ? height + 40 : -40 };
          const head = {
            x: origin.x + (destination.x - origin.x) * (1 - (1 - arrival) ** 3),
            y: origin.y + (destination.y - origin.y) * (1 - (1 - arrival) ** 3),
          };
          const tail = {
            x: head.x + (origin.x - head.x) * 0.55,
            y: head.y + (origin.y - head.y) * 0.55,
          };
          const light = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
          light.addColorStop(0, color(rail, 0));
          light.addColorStop(1, color(rail, Math.sin(arrival * Math.PI) * 0.85));
          ctx.beginPath();
          ctx.moveTo(tail.x, tail.y);
          ctx.lineTo(head.x, head.y);
          ctx.strokeStyle = light;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
      }
      if (!still)
        for (const pulse of input.current.pulses) {
          const elapsed = age - pulse.at;
          const life = pulse.action ? 1.15 : 0.8;
          const progress = clamp(elapsed / life);
          ctx.strokeStyle = color(pulse.color, (1 - progress) ** 2 * (pulse.action ? 0.65 : 0.45));
          ctx.lineWidth = pulse.action ? 1.4 : 1;
          if (pulse.action) {
            ctx.beginPath();
            ctx.ellipse(
              pulse.point.x,
              pulse.point.y,
              16 + progress * width * 0.55,
              8 + progress * height * 0.42,
              -0.1,
              0,
              Math.PI * 2,
            );
          } else path(pulse.color, pulse.point.x + progress * 0.25, 0.05 + progress * 0.13);
          ctx.stroke();
        }
      ctx.restore();
    };

    const enter = () => {
      if (introStarted || preference.matches || !visible || !windowActive || motionPaused()) return;
      introStarted = true;
      intro = scope.animate(
        content,
        [
          {
            opacity: 0.2,
            transform: "perspective(1400px) translateY(25px) rotateX(5deg) scale(.97)",
          },
          {
            opacity: 1,
            transform: "perspective(1400px) translateY(-3px) rotateX(-.35deg) scale(1.003)",
            offset: 0.72,
          },
          { opacity: 1, transform: "none" },
        ],
        { duration: 1120, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" },
      );
      intro.onfinish = () => {
        intro?.cancel();
        intro = null;
      };
    };
    const loop = createMotionLoop((_, dt) => {
      if (!field || !visible || !windowActive || preference.matches) return false;
      age += dt;
      focused += ((input.current.focused ? 1 : 0) - focused) * Math.min(1, dt * 6);
      input.current.energy = Math.max(0, input.current.energy - dt * 0.65);
      input.current.pulses = input.current.pulses.filter((pulse) => age - pulse.at < 1.3);
      if (
        age - lastPaint + 0.001 <
        1 / (input.current.focused || input.current.energy > 0.05 || age < 3 ? 60 : 30)
      )
        return true;
      lastPaint = age;
      draw();
      return true;
    });
    const measure = () => {
      measureFrame = 0;
      if (disposed) return;
      const bounds = host.getBoundingClientRect();
      const box = content.getBoundingClientRect();
      // Canvas coordinates use the untransformed layout box, not the entering form's visual pose.
      const width = host.clientWidth;
      const height = host.clientHeight;
      field = {
        width,
        height,
        docLeft: bounds.left + scrollX,
        docTop: bounds.top + scrollY,
        panel: {
          x: content.offsetLeft,
          y: content.offsetTop,
          width: content.offsetWidth,
          height: content.offsetHeight,
        },
      };
      const dpr = Math.min(
        devicePixelRatio || 1,
        1.75,
        Math.sqrt(2_000_000 / Math.max(1, width * height)),
      );
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (surface.width !== pixelWidth) surface.width = pixelWidth;
      if (surface.height !== pixelHeight) surface.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      visible = bounds.bottom > 0 && bounds.top < innerHeight && box.width > 0;
      draw(preference.matches);
      if (!preference.matches) {
        enter();
        loop.wake();
      }
    };
    const scheduleMeasure = () => {
      if (!measureFrame) measureFrame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(scheduleMeasure);
    resize.observe(host);
    resize.observe(content);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) {
        enter();
        loop.wake();
      } else if (intro?.playState === "running") intro.pause();
      if (visible && windowActive && intro?.playState === "paused" && !motionPaused()) intro.play();
    });
    intersection.observe(host);
    const preferenceChanged = () => {
      host.dataset.motion = preference.matches ? "reduced" : "full";
      if (preference.matches) {
        intro?.cancel();
        intro = null;
        input.current.pulses = [];
        input.current.energy = 0;
        draw(true);
      } else {
        introStarted = true;
        loop.wake();
      }
    };
    const unsubscribe = subscribeMotionPause(() => {
      host.dataset.paused = String(motionPaused());
      if (!motionPaused()) {
        if (visible && windowActive) {
          enter();
          if (intro?.playState === "paused") intro.play();
          loop.wake();
        } else if (intro?.playState === "running") intro.pause();
      }
    });
    const updateExpanded = () => {
      expanded = !!content.querySelector(
        '[data-expanded="true"], [data-phase="questions"], [data-phase="summary"], [data-phase="analyzing"]',
      );
      host.dataset.expanded = String(expanded);
      loop.wake();
    };
    const mutations = new MutationObserver(updateExpanded);
    updateExpanded();
    mutations.observe(content, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-expanded", "data-phase"],
    });
    const energize = (action: boolean, event?: MouseEvent) => {
      if (!field || preference.matches || motionPaused()) return;
      input.current.energy = Math.min(1.3, input.current.energy + (action ? 0.7 : 0.28));
      const sequence = input.current.sequence++;
      let origin = { x: (sequence * 0.137) % 1, y: 0 };
      if (action && event) {
        if (event.detail)
          origin = {
            x: event.clientX - field.docLeft + scrollX,
            y: event.clientY - field.docTop + scrollY,
          };
        else if (event.target instanceof Element) {
          const box = event.target.closest("button")?.getBoundingClientRect();
          if (box)
            origin = {
              x: box.left + box.width / 2 - field.docLeft + scrollX,
              y: box.top + box.height / 2 - field.docTop + scrollY,
            };
        }
      }
      input.current.pulses.push({ at: age, point: origin, action, color: sequence % 3 });
      if (input.current.pulses.length > 10) input.current.pulses.shift();
      loop.wake();
    };
    const focusedIn = () => {
      input.current.focused = true;
      loop.wake();
    };
    const focusedOut = (event: FocusEvent) => {
      if (!host.contains(event.relatedTarget as Node | null)) input.current.focused = false;
    };
    const typed = () => energize(false);
    const clicked = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("button")) energize(true, event);
    };
    input.current.focused = host.contains(document.activeElement);
    host.addEventListener("focusin", focusedIn);
    host.addEventListener("focusout", focusedOut);
    host.addEventListener("input", typed);
    host.addEventListener("click", clicked, true);
    const windowBlur = () => {
      windowActive = false;
      if (intro?.playState === "running") intro.pause();
    };
    const windowFocus = () => {
      windowActive = true;
      input.current.focused = host.contains(document.activeElement);
      if (visible && !preference.matches && !motionPaused()) {
        enter();
        if (intro?.playState === "paused") intro.play();
        loop.wake();
      }
    };
    window.addEventListener("blur", windowBlur);
    window.addEventListener("focus", windowFocus);
    window.addEventListener("resize", scheduleMeasure);
    preference.addEventListener("change", preferenceChanged);
    host.dataset.motion = preference.matches ? "reduced" : "full";
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(measureFrame);
      resize.disconnect();
      intersection.disconnect();
      mutations.disconnect();
      unsubscribe();
      loop.dispose();
      scope.dispose();
      preference.removeEventListener("change", preferenceChanged);
      window.removeEventListener("blur", windowBlur);
      window.removeEventListener("focus", windowFocus);
      window.removeEventListener("resize", scheduleMeasure);
      host.removeEventListener("focusin", focusedIn);
      host.removeEventListener("focusout", focusedOut);
      host.removeEventListener("input", typed);
      host.removeEventListener("click", clicked, true);
      ctx.clearRect(0, 0, surface.width, surface.height);
    };
  }, []);

  return (
    <div className="g-focus-stage" ref={root}>
      <canvas className="g-focus-field" ref={canvas} aria-hidden="true" />
      <div className="g-focus-input-wrapper" ref={panel}>
        {children}
      </div>
    </div>
  );
}
