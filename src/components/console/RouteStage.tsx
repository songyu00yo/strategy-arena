"use client";
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { ArenaVersion, Attack, Strategy } from "@/lib/contracts";
import { attackMeta } from "@/components/status";
import { ChainDeck, LiveRecord } from "./fx";
import { Chars, reducedMotion, ROUTE_COLOR, Sparks, STATE_COLOR } from "./effects";
import type { Beat } from "./beats";
import { createMotionLoop, createMotionScope, motionNow, motionPaused } from "./motion-runtime";
import "./stage-motion.css";

const CLAIM = { user: "用户给定", estimate: "估算", unknown: "待核", supported: "有据" };
const WORD: Record<Attack["status"], string> = {
  supported: "成立",
  refuted: "已反驳",
  unresolved: "未决",
  pending: "待核验",
};
/** CSS custom colours use the space-separated form so they can take an alpha. */
const spaced = (rgb: string) => rgb.replaceAll(",", " ");
const centre = (box: DOMRect) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

type Flight = {
  attack: Attack;
  kind: "attack" | "verify";
  began: number;
  wait: number;
  duration: number;
  landed: boolean;
};
/** A value on a spring: it can be redirected at any moment without a visible seam. */
type Spring = { p: number; v: number };
const spring = (s: Spring, target: number, k: number, c: number, dt: number) => {
  s.v += (-k * (s.p - target) - c * s.v) * dt;
  s.p += s.v * dt;
};
const axis = (): Spring => ({ p: 0, v: 0 });
const bodyOf = () => ({ x: axis(), y: axis(), z: axis(), r: axis(), rest: true });

/** Three boards in real 3D space. A sprung camera and sprung boards keep every step flowing into the next. */
export function RouteStage({
  version,
  demo,
  beats,
  index,
  speed,
  directed,
  camera,
  seeking = false,
  lead,
  located,
  reviewing,
  onStep,
  onEvidence,
  entering,
  readOnly,
  onClaim,
}: {
  version: ArenaVersion;
  demo: boolean;
  beats: Beat[];
  index: number;
  speed: number;
  directed: boolean;
  camera: boolean;
  seeking?: boolean;
  /** Pause before a step acts, leaving room for its stage word. */ lead: number;
  /** A challenge the viewer asked to find on the boards. */ located?: string;
  /** Looking back over a finished game: each step can show how it turned out. */
  reviewing: boolean;
  onStep: (index: number) => void;
  onEvidence: (attack: Attack) => void;
  entering: boolean;
  readOnly: boolean;
  onClaim: (strategy: Strategy, claimId: string) => void;
}) {
  const motionSpeed = seeking ? 1.25 : speed;
  const shown = beats.slice(0, index + 1);
  const current = beats[index] ?? null;
  const seen = new Set(shown.map((b) => b.id));
  const attacks = shown.filter((b) => b.stage === "attack").map((b) => b.attack!);
  const activeAttack = current?.attack;
  const stateOf = (a: Attack) => (seen.has(`v:${a.id}`) ? a.status : "pending");
  const hot = activeAttack ? `${activeAttack.targetStrategyId}:${activeAttack.targetClaimId}` : "";

  const beatId = current?.id;
  const signature = attacks.map((a) => a.id).join();
  const stage = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const packet = useRef<HTMLDivElement>(null);
  const fx = useRef<Sparks | null>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const flows = useRef(new Map<string, SVGPathElement>());
  const dots = useRef(new Map<string, SVGCircleElement>());
  const flight = useRef<Flight | null>(null);
  const kick = useRef(2);
  const wake = useRef<() => void>(() => {});
  const stepMotion = useRef<ReturnType<typeof createMotionScope> | null>(null);
  const directedRef = useRef(directed);
  const live = useRef(attacks);
  const filming = useRef(camera);
  const shot = useRef({ x: 0, y: 0, s: 1, r: 0 });
  const cam = useRef({ x: axis(), y: axis(), s: { p: 1, v: 0 }, r: axis() });
  const bodies = useRef({ A: bodyOf(), B: bodyOf(), C: bodyOf() } as Record<
    string,
    ReturnType<typeof bodyOf>
  >);
  useEffect(() => {
    live.current = attacks;
    filming.current = camera;
    directedRef.current = directed;
    if (!camera && rig.current) rig.current.style.transform = "none";
    wake.current();
  });

  const push = (id: string, x: number, y: number, z: number, r: number) => {
    const body = bodies.current[id];
    if (!body) return;
    body.x.v += x;
    body.y.v += y;
    body.z.v += z;
    body.r.v += r;
    wake.current();
  };
  /** A blow travels through the room: every board is shoved away from the point, the nearest hardest. */
  const shockwave = (x: number, y: number, power: number) => {
    const host = stage.current;
    if (!host) return;
    for (const id of ["A", "B", "C"]) {
      const box = host.querySelector(`[data-board="${id}"]`)?.getBoundingClientRect();
      if (!box) continue;
      const at = centre(box);
      const dx = at.x - x;
      const dy = at.y - y;
      const d = Math.max(90, Math.hypot(dx, dy));
      const force = (power * 420) / (d + 200);
      push(id, (dx / d) * force, (dy / d) * force, -force * 0.8, (dx / d) * force * 0.14);
    }
    cam.current.s.v += 0.1 * power;
    cam.current.y.v += 28 * power;
    cam.current.x.v += (Math.random() - 0.5) * 56 * power;
  };

  // Every asynchronous decoration belongs to the selected step, even after it has started.
  useLayoutEffect(() => {
    const scope = createMotionScope();
    stepMotion.current = scope;
    fx.current?.clear();
    if (!directed) {
      for (const body of Object.values(bodies.current)) {
        for (const axis of [body.x, body.y, body.z, body.r]) axis.v = 0;
      }
    }
    return () => {
      scope.dispose();
      if (stepMotion.current === scope) stepMotion.current = null;
    };
  }, [beatId, directed]);

  const isDirected = () => directed && !reducedMotion();

  // Each step launches one flight along its thread.
  useEffect(() => {
    const host = stage.current;
    if (!activeAttack || !current || (current.stage !== "attack" && current.stage !== "verify")) {
      flight.current = null;
      return;
    }
    const animate = isDirected();
    flight.current = {
      attack: activeAttack,
      kind: current.stage,
      began: motionNow(),
      wait: animate ? lead + (current.stage === "attack" ? 260 : 560) / motionSpeed : 0,
      duration: animate ? 720 / motionSpeed : 0,
      landed: !animate,
    };
    if (animate && current.stage === "verify" && host) {
      // A scanning beam reads the board before the result lands.
      const scope = stepMotion.current!;
      scope.later(lead, () => {
        const box = host.querySelector(`[data-board="${current.to}"]`)?.getBoundingClientRect();
        const origin = host.getBoundingClientRect();
        if (!box) return;
        const beam = scope.own(document.createElement("div"));
        beam.className = "c-beam";
        beam.style.cssText = `left:${box.left - origin.left - 18}px;top:${box.top - origin.top}px;width:${box.width + 36}px`;
        host.appendChild(beam);
        const reach = Math.min(box.height, 340);
        scope.animate(
          beam,
          [
            { transform: "translateY(0)", opacity: 0 },
            { transform: `translateY(${reach * 0.5}px)`, opacity: 1, offset: 0.25 },
            { transform: `translateY(${reach}px)`, opacity: 1, offset: 0.7 },
            { transform: "translateY(0)", opacity: 0 },
          ],
          { duration: 620 / motionSpeed, easing: "cubic-bezier(.5,0,.5,1)" },
        ).onfinish = () => beam.remove();
      });
    }
    // Only a new step launches a flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId, directed]);

  // Energy hands the story on: timeline to board, then each step's own choreography.
  useEffect(() => {
    const host = stage.current;
    if (!host || !current || !isDirected()) return;
    const scope = stepMotion.current!;
    const later = (ms: number, run: () => void) => scope.later(lead + ms / motionSpeed, run);
    const node = host.querySelector<HTMLElement>(`[data-board="${current.agent}"]`);
    const color = ROUTE_COLOR[current.agent] ?? STATE_COLOR.pending;

    later(0, () => {
      const tick = document.querySelector(".c-time .cur")?.getBoundingClientRect();
      const box = node?.getBoundingClientRect();
      if (tick && box) {
        const from = centre(tick);
        fx.current?.stream(
          from.x,
          from.y,
          box.left + box.width / 2,
          box.top + 8,
          color,
          480 / motionSpeed,
        );
      }
    });

    if (current.stage === "propose" && node) {
      later(120, () => {
        const giant = scope.own(document.createElement("div"));
        giant.className = "c-giant";
        giant.textContent = current.agent;
        giant.style.color = `rgb(${color})`;
        host.appendChild(giant);
        const origin = host.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        const tx = box.left + 18 - (origin.left + origin.width / 2);
        const ty = box.top + 18 - (origin.top + origin.height / 2);
        scope.animate(
          giant,
          [
            {
              transform: "translate(-50%,-50%) scale(1.3)",
              opacity: 0,
              offset: 0,
            },
            {
              transform: "translate(-50%,-50%) scale(1)",
              opacity: 0.5,
              offset: 0.4,
            },
            {
              transform: "translate(-50%,-50%) scale(.98)",
              opacity: 0.5,
              offset: 0.52,
            },
            {
              transform: `translate(-50%,-50%) translate(${tx}px,${ty}px) scale(.05)`,
              opacity: 0.3,
              offset: 1,
            },
          ],
          { duration: 820 / motionSpeed, easing: "cubic-bezier(.7,0,.2,1)", fill: "forwards" },
        ).onfinish = () => giant.remove();
      });
      later(880, () => {
        const box = node.getBoundingClientRect();
        fx.current?.impact(box.left + 22, box.top + 18, color, 0.6);
        push(current.agent, 0, 40, 120, 0);
      });
      later(1050, () => {
        const box = node.getBoundingClientRect();
        const card = host.querySelector(".c-deck-now")?.getBoundingClientRect();
        if (card) {
          const to = centre(card);
          fx.current?.stream(
            box.left + box.width / 2,
            box.bottom,
            to.x,
            card.top,
            color,
            520 / motionSpeed,
          );
        }
      });
    }
    if (current.stage === "attack" && node && current.to) {
      // The challenger draws back on its spring, then throws itself forward as the light leaves.
      const away = node.dataset.board === "C" ? 1 : -1;
      push(current.agent, away * 34, 12, -230, away * 9);
      later(220, () => push(current.agent, -away * 150, -22, 540, -away * 16));
    }
    if (current.stage === "revise" && node) {
      later(0, () => {
        node.querySelectorAll(".struck").forEach((line) => {
          const box = line.getBoundingClientRect();
          fx.current?.burn(box.left, box.top, box.width, color);
        });
        push(current.agent, 0, 18, 210, 66);
        later(340, () => push(current.agent, 0, -8, 60, -42));
      });
    }
    if (current.stage === "judge") {
      // Everything converges: light runs from every board into the chosen route, the rest fall away.
      const pick = version.verdict?.preferred;
      const target = host.querySelector(`[data-board="${pick}"]`)?.getBoundingClientRect();
      later(0, () => {
        for (const id of ["A", "B", "C"]) {
          const box = host.querySelector(`[data-board="${id}"]`)?.getBoundingClientRect();
          if (!box) continue;
          if (id === pick) {
            push(id, 0, -36, 380, 0);
          } else {
            push(id, 0, 44, -480, (id === "A" ? -1 : 1) * 12);
            if (target) {
              const a = centre(box);
              const b = centre(target);
              fx.current?.stream(a.x, a.y, b.x, b.y, ROUTE_COLOR[id], 620 / motionSpeed);
            }
          }
        }
      });
    }

    // A step's choreography plays once, when that step arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId, directed]);

  // One loop runs everything, so every moving part stays in phase.
  useEffect(() => {
    const host = stage.current;
    const dot = packet.current;
    const surface = canvas.current;
    const el = world.current;
    if (!host || !dot || !surface || !el) return;
    const sparks = new Sparks(surface, () => wake.current());
    fx.current = sparks;
    const reduce = reducedMotion();
    const fitSparks = () => sparks.fit(innerWidth, innerHeight);
    fitSparks();
    addEventListener("resize", fitSparks);

    const stamp = (x: number, y: number, attack: Attack) => {
      const scope = stepMotion.current;
      if (!scope) return;
      const mark = scope.own(document.createElement("div"));
      mark.className = `c-stamp is-${attack.status}`;
      mark.textContent = attackMeta[attack.status].label;
      mark.style.left = `${x}px`;
      mark.style.top = `${y}px`;
      host.appendChild(mark);
      scope.animate(
        mark,
        [
          {
            transform: "translate(-50%,-50%) scale(1.9) rotate(-9deg)",
            opacity: 0,
            offset: 0,
          },
          {
            transform: "translate(-50%,-50%) scale(.97) rotate(-4deg)",
            opacity: 1,
            offset: 0.1,
          },
          { transform: "translate(-50%,-50%) scale(1) rotate(-5deg)", opacity: 1, offset: 0.16 },
          { transform: "translate(-50%,-50%) scale(1) rotate(-5deg)", opacity: 1, offset: 0.66 },
          { transform: "translate(-50%,-50%) scale(.3) rotate(-5deg)", opacity: 0, offset: 1 },
        ],
        { duration: 1400, easing: "cubic-bezier(.2,.9,.2,1)", fill: "forwards" },
      ).onfinish = () => mark.remove();
      const flash = scope.own(document.createElement("div"));
      flash.className = "c-flash";
      flash.style.setProperty("--flash", spaced(STATE_COLOR[attack.status]));
      flash.style.setProperty("--x", `${x}px`);
      flash.style.setProperty("--y", `${y}px`);
      host.appendChild(flash);
      scope.animate(flash, [{ opacity: 0.32 }, { opacity: 0 }], {
        duration: 800,
        easing: "ease-out",
      }).onfinish = () => flash.remove();
    };

    // The doubted sentence lifts off its board and flies into the chain.
    const tear = (attack: Attack) => {
      const claim = host.querySelector(
        `[data-claim="${attack.targetStrategyId}:${attack.targetClaimId}"]`,
      );
      const row = host.querySelector(".c-float-card");
      if (!claim || !row) return;
      const origin = host.getBoundingClientRect();
      const from = claim.getBoundingClientRect();
      const to = row.getBoundingClientRect();
      const scope = stepMotion.current;
      if (!scope) return;
      const piece = scope.own(document.createElement("div"));
      piece.className = "c-tear";
      piece.textContent = attack.claimQuote;
      piece.style.cssText = `left:${from.left - origin.left}px;top:${from.top - origin.top}px;width:${from.width}px`;
      host.appendChild(piece);
      scope.animate(
        piece,
        [
          { transform: "none", opacity: 1 },
          { transform: "translateY(-18px) scale(1.08) rotate(-2deg)", opacity: 1, offset: 0.28 },
          {
            transform: `translate(${to.left - from.left}px,${to.top + 26 - from.top}px) scale(.94)`,
            opacity: 0.15,
          },
        ],
        { duration: 560, easing: "cubic-bezier(.65,0,.2,1)", fill: "forwards" },
      ).onfinish = () => piece.remove();
    };

    const loop = createMotionLoop((now, dt) => {
      // Read all HTML geometry before writing transforms or SVG attributes.
      const measuring = kick.current > 0 || (!!flight.current && !flight.current.landed);
      const origin = measuring ? host.getBoundingClientRect() : null;
      const rects = new Map<string, DOMRect>();
      const claims = new Map<string, DOMRect>();
      if (measuring) {
        for (const id of ["A", "B", "C"]) {
          const node = host.querySelector(`[data-board="${id}"]`);
          if (node) rects.set(id, node.getBoundingClientRect());
        }
        for (const attack of live.current) {
          const id = `${attack.targetStrategyId}:${attack.targetClaimId}`;
          const node = host.querySelector(`[data-claim="${id}"]`);
          if (node && !claims.has(id)) claims.set(id, node.getBoundingClientRect());
        }
      }
      const rect = (id: string) => rects.get(id);

      // Camera: sprung, with a slow drift so a held shot never goes dead.
      const c = cam.current;
      const on = filming.current && !reduce;
      const aim = on ? shot.current : { x: 0, y: 0, s: 1, r: 0 };
      const stiffness = directedRef.current ? 30 : 180;
      const damping = directedRef.current ? 9.5 : 27;
      spring(c.x, aim.x, stiffness, damping, dt);
      spring(c.y, aim.y, stiffness, damping, dt);
      spring(c.s, aim.s, stiffness, damping, dt);
      spring(c.r, aim.r, stiffness, damping, dt);
      const moving =
        Math.abs(c.x.v) + Math.abs(c.y.v) + Math.abs(c.r.v) > 0.04 ||
        Math.abs(c.s.v) > 0.0004 ||
        Math.abs(c.x.p - aim.x) + Math.abs(c.y.p - aim.y) + Math.abs(c.r.p - aim.r) > 0.04 ||
        Math.abs(c.s.p - aim.s) > 0.0004;
      if (moving) {
        kick.current = 2;
        el.style.transform = `translate3d(${c.x.p}px,${c.y.p}px,0) scale(${c.s.p}) rotateY(${c.r.p}deg)`;
      } else if (!on && el.style.transform !== "none") {
        el.style.transform = "none";
      }

      // Boards: each on its own spring, so a blow rings through them and settles.
      let bodyMoving = false;
      for (const id of ["A", "B", "C"]) {
        const b = bodies.current[id];
        if (b.rest && !b.x.v && !b.y.v && !b.z.v && !b.r.v) continue;
        const node = el.querySelector<HTMLElement>(`[data-board="${id}"]`);
        if (!node) continue;
        const k = directedRef.current ? 70 : 220;
        const damping = directedRef.current ? 9 : 30;
        spring(b.x, 0, k, damping, dt);
        spring(b.y, 0, k, damping, dt);
        spring(b.z, 0, k, damping, dt);
        spring(b.r, 0, k, damping, dt);
        const quiet =
          Math.abs(b.x.p) + Math.abs(b.y.p) + Math.abs(b.z.p) + Math.abs(b.r.p) < 0.05 &&
          Math.abs(b.x.v) + Math.abs(b.z.v) < 0.5;
        if (quiet) {
          for (const axis of [b.x, b.y, b.z, b.r]) axis.p = axis.v = 0;
          b.rest = true;
          node.style.translate = "";
          node.style.rotate = "";
        } else {
          b.rest = false;
          bodyMoving = true;
          kick.current = 2;
          node.style.translate = `${b.x.p}px ${b.y.p}px ${b.z.p}px`;
          node.style.rotate = `y ${b.r.p}deg`;
        }
      }

      const flying = flight.current;
      const elapsed = flying ? now - flying.began - flying.wait : 0;
      const k = flying
        ? flying.duration
          ? Math.max(0, Math.min(1, elapsed / flying.duration))
          : 1
        : 0;
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

      // Threads are re-measured only while something moves: reading layout every frame is what cost time.
      if (kick.current > 0) kick.current -= 1;
      const middle = measuring ? rect("B") : undefined;
      (origin ? live.current : []).forEach((a, i) => {
        const path = paths.current.get(a.id);
        const flow = flows.current.get(a.id);
        const from = rect(a.from);
        const box = rect(a.targetStrategyId);
        if (!path || !from || !box || !origin) return;
        const claim = claims.get(`${a.targetStrategyId}:${a.targetClaimId}`);
        const rightward = from.left < box.left;
        const y = claim
          ? Math.min(box.bottom - 8, Math.max(box.top + 8, claim.top + claim.height / 2))
          : box.top + 30;
        const sx = (rightward ? from.right : from.left) - origin.left;
        const sy = from.top + 34 + (i % 6) * 15 - origin.top;
        const tx = (rightward ? box.left : box.right) - origin.left;
        const ty = y - origin.top;
        const bend = Math.max(36, Math.abs(tx - sx) * 0.42) * (rightward ? 1 : -1);
        // A and C talk around B: their thread runs below it instead of across its text.
        const across = a.from !== "B" && a.targetStrategyId !== "B" && middle;
        let d = `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`;
        if (across) {
          const lane = middle.bottom - origin.top + 10 + (i % 6) * 5;
          const near = (rightward ? middle.left - 6 : middle.right + 6) - origin.left;
          const far = (rightward ? middle.right + 6 : middle.left - 6) - origin.left;
          d = `M${sx},${sy} C${(sx + near) / 2},${sy} ${(sx + near) / 2},${lane} ${near},${lane} L${far},${lane} C${(far + tx) / 2},${lane} ${(far + tx) / 2},${ty} ${tx},${ty}`;
        }
        const drawing = flying?.kind === "attack" && flying.attack.id === a.id && eased < 1;
        const from_ = dots.current.get(`${a.id}:from`);
        const to_ = dots.current.get(`${a.id}:to`);
        from_?.setAttribute("cx", String(sx));
        from_?.setAttribute("cy", String(sy));
        to_?.setAttribute("cx", String(tx));
        to_?.setAttribute("cy", String(ty));
        to_?.setAttribute("opacity", drawing ? "0" : "1");
        path.setAttribute("d", d);
        flow?.setAttribute("d", d);
        path.style.strokeDashoffset =
          flying?.kind === "attack" && flying.attack.id === a.id ? String(1 - eased) : "0";
      });

      if (!flying || (flying.landed && flying.duration > 0)) dot.style.opacity = "0";
      const path = flying && paths.current.get(flying.attack.id);
      if (flying && origin && path?.getAttribute("d")) {
        const color =
          flying.kind === "verify"
            ? STATE_COLOR[flying.attack.status]
            : (ROUTE_COLOR[flying.attack.from] ?? STATE_COLOR.attack);
        const point = path.getPointAtLength(path.getTotalLength() * eased);
        const px = point.x + origin.left;
        const py = point.y + origin.top;
        dot.style.transform = `translate(${point.x}px,${point.y}px) translate(-50%,-50%)`;
        // Once it lands the label steps aside, so it never sits on the sentence it points at.
        dot.style.opacity = elapsed < 0 || (flying.duration > 0 && flying.landed) ? "0" : "1";
        if (elapsed < 0 && flying.kind === "attack" && elapsed > -260) sparks.charge(px, py, color);
        if (elapsed >= 0 && k < 1 && flying.duration) sparks.comet(px, py, color);
        if (k >= 1 && !flying.landed) {
          flying.landed = true;
          const strong = flying.kind === "verify" && flying.attack.status === "supported";
          sparks.impact(px, py, color, strong ? 1.25 : 0.75);
          shockwave(px, py, strong ? 1.2 : 0.7);
          if (flying.kind === "attack") {
            tear(flying.attack);
          } else {
            // Beside the sentence rather than on it, so the words stay readable.
            stamp(
              point.x + (point.x > origin.width / 2 ? -86 : 86),
              Math.max(22, point.y - 40),
              flying.attack,
            );
            host
              .querySelectorAll(
                `[data-claim="${flying.attack.targetStrategyId}:${flying.attack.targetClaimId}"] .struck`,
              )
              .forEach((line) => {
                const box = line.getBoundingClientRect();
                sparks.burn(box.left, box.top, box.width, color);
              });
            // The result flows up into the running count, which rolls as it arrives.
            const metric = document
              .querySelector(`.c-metrics [data-state="${flying.attack.status}"] dd`)
              ?.getBoundingClientRect();
            if (metric) {
              const to = centre(metric);
              sparks.stream(px, py, to.x, to.y, color, 620);
            }
          }
          const log = document.querySelector(".c-log .hot")?.getBoundingClientRect();
          if (log) sparks.stream(px, py, log.left + 30, log.top + 8, color, 720);
        }
      }
      sparks.tick(dt);
      return (
        moving || bodyMoving || kick.current > 0 || !!(flying && !flying.landed) || sparks.active
      );
    });
    wake.current = loop.wake;
    return () => {
      loop.dispose();
      wake.current = () => {};
      sparks.clear();
      fx.current = null;
      removeEventListener("resize", fitSparks);
    };
    // The loop reads current state through refs and lives as long as the stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The shot for this step. Every board stays in frame: the camera leans and pushes, it never hides.
  useLayoutEffect(() => {
    const el = world.current;
    if (!el || !current) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    const middle = (id?: string) => {
      const board = el.querySelector<HTMLElement>(`[data-board="${id}"]`);
      return board
        ? {
            x: board.offsetLeft + board.offsetWidth / 2,
            y: board.offsetTop + board.offsetHeight / 2,
          }
        : { x: W / 2, y: H / 2 };
    };
    let scale = 1.03;
    let at = middle(current.agent);
    let turn = at.x < W / 2 ? 1.6 : at.x > W / 2 + 20 ? -1.6 : 0;
    if (current.stage === "attack" && current.to) {
      const a = middle(current.agent);
      const b = middle(current.to);
      at = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) };
      scale = Math.abs(a.x - b.x) > W * 0.5 ? 0.97 : 1.025;
      turn = a.x < b.x ? -1.8 : 1.8;
    } else if (current.stage === "verify" && current.to) {
      at = middle(current.to);
      scale = 1.04;
      turn = at.x < W / 2 ? 1.2 : at.x > W / 2 + 20 ? -1.2 : 0;
    } else if (current.stage === "judge") {
      at = { x: W / 2, y: H / 2 };
      scale = 0.985;
      turn = 0;
    }
    // Every board in shot stays fully inside the frame, with room left for drift and tilt.
    const margin = 48; // Room for the focused board moving forward in depth.
    const inShot = [current.agent, current.to]
      .map((id) => el.querySelector<HTMLElement>(`[data-board="${id}"]`))
      .filter((node): node is HTMLElement => !!node);
    const left = Math.min(...inShot.map((n) => n.offsetLeft), W);
    const right = Math.max(...inShot.map((n) => n.offsetLeft + n.offsetWidth), 0);
    const top = Math.min(...inShot.map((n) => n.offsetTop), H);
    if (current.stage !== "judge" && right - left > 0)
      scale = Math.min(scale, Math.max(1, (W - margin * 2) / (right - left)));
    if (scale <= 1.01 && current.stage !== "judge") turn = Math.sign(turn) * 1.2;
    const screen = (p: number, size: number) => size / 2 + (p - size / 2) * scale;
    const wantX = W / 2 - screen(at.x, W);
    const minX = margin - screen(left, W);
    const maxX = W - margin - screen(right, W);
    // The camera leans toward the action but keeps all three routes on screen.
    const lean = Math.max(0, ((scale - 1) * W) / 2);
    const leaned = Math.max(-lean, Math.min(lean, wantX));
    const x =
      current.stage === "judge"
        ? 0
        : minX > maxX
          ? (minX + maxX) / 2
          : Math.max(minX, Math.min(maxX, leaned));
    const wantY = (current.stage === "judge" ? H / 2 : H * 0.26) - screen(at.y, H);
    const y = current.stage === "judge" ? 0 : Math.max(margin - screen(top, H), wantY);
    shot.current = { x, y, s: scale, r: turn };
  }, [current]);

  // A new step or thread can shift things, so it asks for a fresh measure. Refreshed data alone does not.
  useEffect(() => {
    kick.current = Math.max(kick.current, 2);
    wake.current();
  }, [beatId, signature, hot, camera]);
  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const measure = () => {
      kick.current = Math.max(kick.current, 2);
      wake.current();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    host.querySelectorAll("[data-board]").forEach((node) => observer.observe(node));
    host.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      host.removeEventListener("scroll", measure, true);
    };
  }, []);

  // Bring the doubted claim into view inside its board, without moving the page.
  useEffect(() => {
    if (!hot) return;
    const claim = stage.current?.querySelector<HTMLElement>(`[data-claim="${hot}"]`);
    const body = claim?.closest<HTMLElement>(".c-board-body");
    if (claim && body) body.scrollTop = Math.max(0, claim.offsetTop - 28);
  }, [hot]);

  // Only an actual opening sequence raises the boards; history and seeks stay readable.
  useEffect(() => {
    if (entering || !directed || reducedMotion()) return;
    const scope = createMotionScope();
    scope.later(80, () => {
      push("A", -25, 22, 300, 8);
      push("B", 0, 25, 340, 0);
      push("C", 25, 22, 300, -8);
    });
    stage.current?.querySelectorAll("[data-board]").forEach((node, i) => {
      scope.animate(node, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 420,
        delay: 80 + i * 60,
        easing: "ease-out",
        fill: "backwards",
      });
    });
    return () => scope.dispose();
    // Start only when the opening shutter changes, not when playback resumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entering]);

  // The room leans toward the pointer during a replay; at rest the boards hold still for clicking.
  useEffect(() => {
    if (reducedMotion()) return;
    const onMove = (e: MouseEvent) => {
      if (motionPaused()) return;
      const nx = e.clientX / innerWidth - 0.5;
      const ny = e.clientY / innerHeight - 0.5;
      if (rig.current)
        rig.current.style.transform = filming.current
          ? `rotateY(${nx * 1.2}deg) rotateX(${-ny * 0.9}deg)`
          : "none";
      const wall = document.querySelector<HTMLElement>(".c-stage");
      if (wall) wall.style.translate = `${-nx * 46}px ${-ny * 30}px`;
    };
    addEventListener("mousemove", onMove);
    return () => removeEventListener("mousemove", onMove);
  }, []);

  // Pointing at a claim or a challenge lights the threads tied to it, so the page explains itself.
  useEffect(() => {
    const light = (event: Event, on: boolean) => {
      const node = event.target as Element | null;
      const row = node?.closest?.<HTMLElement>(".c-row[data-attack]");
      const claim = node?.closest?.<HTMLElement>("[data-claim]");
      if (!row && !claim) return;
      const ids = row
        ? [row.dataset.attack]
        : live.current
            .filter((a) => `${a.targetStrategyId}:${a.targetClaimId}` === claim!.dataset.claim)
            .map((a) => a.id);
      for (const id of ids) {
        document.querySelector(`.c-thread[data-attack="${id}"]`)?.classList.toggle("lit", on);
        const a = live.current.find((x) => x.id === id);
        if (row && a)
          document
            .querySelector(`[data-claim="${a.targetStrategyId}:${a.targetClaimId}"]`)
            ?.classList.toggle("lit", on);
      }
    };
    const over = (e: Event) => light(e, true);
    const out = (e: Event) => light(e, false);
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
    };
  }, []);

  const involved = (id: string) => {
    if (!camera || !current || current.stage === "judge") return true;
    return current.agent === id || current.to === id;
  };

  const board = (id: "A" | "B" | "C") => {
    const strategy = version.strategies.find((s) => s.id === id);
    const present = !!strategy && seen.has(`p:${id}`);
    const revision = seen.has(`r:${id}`)
      ? version.revisions.find((r) => r.strategyId === id)
      : undefined;
    const view = revision?.strategy ?? strategy;
    const taken = attacks.filter((a) => a.targetStrategyId === id);
    const sent = attacks.filter((a) => a.from === id);
    const pick = seen.has("judge") && version.verdict?.preferred === id;
    const speaking = current?.agent === id;
    const target = !speaking && current?.to === id;
    const enter = directed && !seeking && current?.id === `p:${id}`;
    const rewriting = directed && !seeking && current?.id === `r:${id}`;
    return (
      <section
        key={id}
        data-board={id}
        aria-label={`路线 ${id}`}
        className={`c-board c-board-${id} ${speaking ? "speaking" : ""} ${target ? "target" : ""} ${pick ? "pick" : ""} ${involved(id) ? "" : "dim"} ${enter ? "enter" : ""}`}
        style={{ "--route": spaced(ROUTE_COLOR[id]) } as CSSProperties}
      >
        <svg className="c-outline" aria-hidden="true">
          <rect width="100%" height="100%" pathLength={1} />
        </svg>
        <header>
          <b>{id}</b>
          <span>{pick ? "当前建议" : revision ? "已修订" : present ? "已提案" : "等待提案"}</span>
          <em>
            发出 {sent.length} · 收到 {taken.length}
          </em>
        </header>
        {present && strategy && view ? (
          <div className="c-board-body">
            <h3>
              <Chars text={view.title} active={enter} delay={lead + 700} />
            </h3>
            <p>{view.thesis}</p>
            <div className="est">
              {strategy.estimatedHours === view.estimatedHours
                ? `${view.estimatedHours ?? "?"} 小时`
                : `${strategy.estimatedHours} → ${view.estimatedHours} 小时`}
              {" · "}¥{view.estimatedCost ?? "?"}
            </div>
            {[...new Set([...strategy.claims, ...view.claims].map((c) => c.id))].map((claimId) => {
              const before = strategy.claims.find((c) => c.id === claimId);
              const after = view.claims.find((c) => c.id === claimId);
              const claim = after ?? before!;
              const hits = taken.filter((a) => a.targetClaimId === claimId);
              const lost = hits.some((a) => stateOf(a) === "supported");
              return (
                <button
                  key={claimId}
                  type="button"
                  data-claim={`${id}:${claimId}`}
                  className={`c-claim ${hot === `${id}:${claimId}` ? "hot" : ""} ${hits.some((a) => a.id === located) ? "located" : ""}`}
                  disabled={readOnly || !after}
                  title={after ? "向这条判断发起挑战" : "这条主张已撤回"}
                  onClick={() => onClaim(view, claimId)}
                >
                  <em>
                    {claimId} {CLAIM[claim.status]}
                    {!after && " · 已撤回"}
                    {!before && " · 新增"}
                    {hits.map((a) => (
                      <i key={a.id} className={`is-${stateOf(a)}`}>
                        {a.from} {WORD[stateOf(a)]}
                      </i>
                    ))}
                  </em>
                  <span>
                    <span className={lost || !after ? "struck" : ""}>
                      {before?.text ?? claim.text}
                    </span>
                  </span>
                  {before && after && before.text !== after.text && (
                    <span className={`changed ${rewriting ? "fresh" : ""}`}>
                      <Chars text={after.text} active={rewriting} delay={lead + 800} />
                    </span>
                  )}
                </button>
              );
            })}
            <ol className="steps">
              {view.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="first">
              <b>第一步</b> {view.firstAction}
            </div>
          </div>
        ) : (
          <div className="c-board-body quiet">
            {demo ? "等待演示步骤，内容为预设。" : "只显示真实生成的结果。"}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className={`c-stage3 ${activeAttack ? "has-float" : ""}`} ref={stage}>
      <div className="c-rig" ref={rig}>
        <div className="c-world" ref={world}>
          {board("A")}
          {board("B")}
          {board("C")}
        </div>
      </div>
      <svg className="c-threads" aria-hidden="true">
        {attacks.map((a) => (
          <g key={a.id} style={{ "--route": spaced(ROUTE_COLOR[a.from]) } as CSSProperties}>
            <path
              pathLength={1}
              ref={(node) => {
                if (node) paths.current.set(a.id, node);
                else paths.current.delete(a.id);
              }}
              data-attack={a.id}
              className={`c-thread is-${stateOf(a)} ${a.id === activeAttack?.id ? "on" : ""} ${a.id === located ? "located" : ""}`}
            />
            <path
              pathLength={1}
              ref={(node) => {
                if (node) flows.current.set(a.id, node);
                else flows.current.delete(a.id);
              }}
              className={`c-thread-flow is-${stateOf(a)} ${a.id === activeAttack?.id ? "on" : ""}`}
            />
            {(["from", "to"] as const).map((end) => (
              <circle
                key={end}
                r={end === "to" ? 3.2 : 2.2}
                className={`c-thread-dot is-${stateOf(a)} ${a.id === activeAttack?.id ? "on" : ""}`}
                ref={(node) => {
                  if (node) dots.current.set(`${a.id}:${end}`, node);
                  else dots.current.delete(`${a.id}:${end}`);
                }}
              />
            ))}
          </g>
        ))}
      </svg>
      <canvas className="c-fx" ref={canvas} aria-hidden="true" />
      <div
        className={`c-packet ${current?.stage === "verify" && activeAttack ? `is-${activeAttack.status}` : ""}`}
        ref={packet}
        style={{ "--route": spaced(ROUTE_COLOR[activeAttack?.from ?? "A"]) } as CSSProperties}
        aria-hidden="true"
      >
        {current?.packet}
      </div>
      <ChainDeck
        version={version}
        beats={beats}
        index={index}
        directed={directed}
        seeking={seeking}
        lead={lead}
        reviewing={reviewing}
        onStep={onStep}
      />
      <LiveRecord
        version={version}
        beat={current}
        index={index}
        directed={directed}
        seeking={seeking}
        lead={lead}
        onEvidence={onEvidence}
      />
    </div>
  );
}
