"use client";
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { ArenaVersion, Attack, Strategy } from "@/lib/contracts";
import { attackMeta } from "@/components/status";
import { FloatingWindows } from "./fx";
import { Chars, reducedMotion, ROUTE_COLOR, Sparks, STATE_COLOR } from "./effects";
import type { Beat } from "./beats";

const CLAIM = { user: "用户给定", estimate: "估算", unknown: "待核", supported: "有据" };
const WORD: Record<Attack["status"], string> = {
  supported: "成立",
  refuted: "已反驳",
  unresolved: "未决",
  pending: "待核验",
};

/** CSS custom colours use the space-separated form so they can take an alpha. */
const spaced = (rgb: string) => rgb.replaceAll(",", " ");

type Flight = {
  attack: Attack;
  kind: "attack" | "verify";
  began: number;
  wait: number;
  duration: number;
  landed: boolean;
};

/** Three boards in real 3D space, filmed by a camera that follows each recorded step. */
export function RouteStage({
  version,
  beats,
  index,
  speed,
  directed,
  camera,
  entering,
  readOnly,
  onClaim,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  speed: number;
  directed: boolean;
  camera: boolean;
  entering: boolean;
  readOnly: boolean;
  onClaim: (strategy: Strategy, claimId: string) => void;
}) {
  const shown = beats.slice(0, index + 1);
  const current = beats[index] ?? null;
  const seen = new Set(shown.map((b) => b.id));
  const attacks = shown.filter((b) => b.stage === "attack").map((b) => b.attack!);
  const activeAttack = current?.attack;
  const stateOf = (a: Attack) => (seen.has(`v:${a.id}`) ? a.status : "pending");
  const hot = activeAttack ? `${activeAttack.targetStrategyId}:${activeAttack.targetClaimId}` : "";

  const stage = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fx = useRef<Sparks | null>(null);
  const packet = useRef<HTMLDivElement>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const flight = useRef<Flight | null>(null);
  const live = useRef(attacks);
  const filming = useRef(camera);
  useEffect(() => {
    live.current = attacks;
    filming.current = camera;
    if (!camera && rig.current) rig.current.style.transform = "none";
  });

  // Each step that moves to another role launches one flight along its thread.
  const beatId = current?.id;
  useEffect(() => {
    if (!activeAttack || !current || (current.stage !== "attack" && current.stage !== "verify")) {
      flight.current = null;
      return;
    }
    const animate = directed && !reducedMotion();
    flight.current = {
      attack: activeAttack,
      kind: current.stage,
      began: performance.now(),
      wait: animate ? (current.stage === "attack" ? 480 : 820) / speed : 0,
      duration: animate ? 1000 / speed : 0,
      landed: !animate,
    };
    const host = stage.current;
    if (animate && current.stage === "verify" && host) {
      // A scanning beam reads the whole board before the result lands.
      const box = host.querySelector(`[data-board="${current.to}"]`)?.getBoundingClientRect();
      const origin = host.getBoundingClientRect();
      if (box) {
        const beam = document.createElement("div");
        beam.className = "c-beam";
        beam.style.cssText = `left:${box.left - origin.left - 18}px;top:${box.top - origin.top}px;width:${box.width + 36}px`;
        host.appendChild(beam);
        beam.animate(
          [
            { transform: "translateY(0)", opacity: 0 },
            {
              transform: `translateY(${Math.min(box.height, 340) * 0.5}px)`,
              opacity: 1,
              offset: 0.25,
            },
            { transform: `translateY(${Math.min(box.height, 340)}px)`, opacity: 1, offset: 0.7 },
            { transform: "translateY(0)", opacity: 0 },
          ],
          { duration: 1000 / speed, easing: "cubic-bezier(.5,0,.5,1)" },
        ).onfinish = () => beam.remove();
      }
    }
    // Only a new step launches a flight; speed changes apply to the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId]);

  // Each kind of step gets its own choreography on the board that acts.
  useEffect(() => {
    const host = stage.current;
    if (!host || !current || !directed || reducedMotion()) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const node = host.querySelector<HTMLElement>(`[data-board="${current.agent}"]`);
    if (current.stage === "propose" && node) {
      // The route's giant letter crosses the room and lands on its board.
      const color = ROUTE_COLOR[current.agent];
      const giant = document.createElement("div");
      giant.className = "c-giant";
      giant.textContent = current.agent;
      giant.style.color = `rgb(${color})`;
      host.appendChild(giant);
      const W = host.clientWidth;
      const H = host.clientHeight;
      const tx = node.offsetLeft - W / 2;
      const ty = -H * 0.34;
      const fly = giant.animate(
        [
          {
            transform: "translate(-50%,-50%) scale(1.7)",
            opacity: 0,
            filter: "blur(30px)",
            offset: 0,
          },
          {
            transform: "translate(-50%,-50%) scale(1)",
            opacity: 1,
            filter: "blur(0)",
            offset: 0.34,
          },
          {
            transform: "translate(-50%,-50%) scale(1)",
            opacity: 1,
            filter: "blur(0)",
            offset: 0.5,
          },
          {
            transform: `translate(-50%,-50%) translate(${tx}px,${ty}px) scale(.06)`,
            opacity: 0.1,
            filter: "blur(0)",
            offset: 1,
          },
        ],
        { duration: 1250, easing: "cubic-bezier(.7,0,.2,1)", fill: "forwards" },
      );
      fly.onfinish = () => giant.remove();
      timers.push(
        setTimeout(() => {
          const box = node.getBoundingClientRect();
          const origin = host.getBoundingClientRect();
          fx.current?.impact(box.left - origin.left + 26, box.top - origin.top + 18, color, 1);
        }, 1180),
      );
    }
    if (current.stage === "attack" && node) {
      // The challenger draws back, then lunges.
      node.animate(
        [
          { translate: "0 0 0", rotate: "y 0deg" },
          {
            translate: "0 8px -130px",
            rotate: `y ${node.dataset.board === "C" ? 7 : -7}deg`,
            offset: 0.34,
          },
          { translate: "0 -6px 210px", rotate: "y 0deg", offset: 0.5 },
          { translate: "0 0 0", rotate: "y 0deg" },
        ],
        { duration: 1500 / speed, easing: "cubic-bezier(.3,0,.1,1)" },
      );
    }
    if (current.stage === "revise" && node) {
      // The old sentence burns off while the whole board turns over and comes back rewritten.
      const origin = host.getBoundingClientRect();
      node.querySelectorAll(".struck").forEach((line) => {
        const box = line.getBoundingClientRect();
        fx.current?.burn(
          box.left - origin.left,
          box.top - origin.top,
          box.width,
          ROUTE_COLOR[current.agent],
        );
      });
      node.animate(
        [
          { rotate: "y 0deg", filter: "blur(0)", scale: "1" },
          { rotate: "y 180deg", filter: "blur(5px)", scale: "0.88", offset: 0.5 },
          { rotate: "y 360deg", filter: "blur(0)", scale: "1" },
        ],
        { duration: 1250 / speed, delay: 200, easing: "cubic-bezier(.7,0,.2,1)" },
      );
    }
    return () => timers.forEach(clearTimeout);
    // A step's choreography plays once, when that step arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId]);

  // Threads are re-measured every frame from the real claims, so they stay attached through any camera move.
  useEffect(() => {
    const host = stage.current;
    const dot = packet.current;
    const surface = canvas.current;
    if (!host || !dot || !surface) return;
    const sparks = new Sparks(surface);
    fx.current = sparks;

    const stamp = (x: number, y: number, attack: Attack) => {
      const el = document.createElement("div");
      el.className = `c-stamp is-${attack.status}`;
      el.textContent = attackMeta[attack.status].label;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      host.appendChild(el);
      const fade = el.animate(
        [
          {
            transform: "translate(-50%,-50%) scale(3.4) rotate(-14deg)",
            opacity: 0,
            filter: "blur(6px)",
            offset: 0,
          },
          {
            transform: "translate(-50%,-50%) scale(1) rotate(-5deg)",
            opacity: 1,
            filter: "blur(0)",
            offset: 0.12,
          },
          { transform: "translate(-50%,-50%) scale(1) rotate(-5deg)", opacity: 1, offset: 0.78 },
          { transform: "translate(-50%,-50%) scale(1.06) rotate(-5deg)", opacity: 0, offset: 1 },
        ],
        { duration: 1700, easing: "cubic-bezier(.2,.9,.2,1)", fill: "forwards" },
      );
      fade.onfinish = () => el.remove();
      const flash = document.createElement("div");
      flash.className = "c-flash";
      flash.style.setProperty("--flash", spaced(STATE_COLOR[attack.status]));
      flash.style.setProperty("--x", `${x}px`);
      flash.style.setProperty("--y", `${y}px`);
      host.appendChild(flash);
      flash.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 760,
        easing: "ease-out",
      }).onfinish = () => flash.remove();
      if (attack.status === "supported")
        rig.current?.animate(
          [
            { translate: "0 0" },
            { translate: "-24px 15px" },
            { translate: "20px -14px" },
            { translate: "-13px 9px" },
            { translate: "6px -4px" },
            { translate: "0 0" },
          ],
          { duration: 620, easing: "ease-out" },
        );
    };

    // The doubted sentence lifts off its board and flies to the floating window.
    const tear = (attack: Attack) => {
      const claim = host.querySelector(
        `[data-claim="${attack.targetStrategyId}:${attack.targetClaimId}"]`,
      );
      const row = host.querySelector(".c-float-card");
      if (!claim || !row) return;
      const origin = host.getBoundingClientRect();
      const from = claim.getBoundingClientRect();
      const to = row.getBoundingClientRect();
      const el = document.createElement("div");
      el.className = "c-tear";
      el.textContent = attack.claimQuote;
      el.style.cssText = `left:${from.left - origin.left}px;top:${from.top - origin.top}px;width:${from.width}px`;
      host.appendChild(el);
      const fly = el.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: "translateY(-16px) scale(1.07) rotate(-1.5deg)", opacity: 1, offset: 0.25 },
          {
            transform: `translate(${to.left - from.left}px,${to.top + 26 - from.top}px) scale(.96)`,
            opacity: 0.2,
          },
        ],
        { duration: 680, easing: "cubic-bezier(.65,0,.2,1)", fill: "forwards" },
      );
      fly.onfinish = () => el.remove();
    };

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const origin = host.getBoundingClientRect();
      sparks.fit(origin.width, origin.height);
      const flying = flight.current;
      const elapsed = flying ? now - flying.began - flying.wait : 0;
      const k = flying
        ? flying.duration
          ? Math.max(0, Math.min(1, elapsed / flying.duration))
          : 1
        : 0;
      sparks.dust += ((filming.current ? 1 : 0) - sparks.dust) * Math.min(1, dt * 2);
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

      live.current.forEach((a, i) => {
        const path = paths.current.get(a.id);
        const from = host.querySelector(`[data-board="${a.from}"]`)?.getBoundingClientRect();
        const box = host
          .querySelector(`[data-board="${a.targetStrategyId}"]`)
          ?.getBoundingClientRect();
        if (!path || !from || !box) return;
        const claim = host
          .querySelector(`[data-claim="${a.targetStrategyId}:${a.targetClaimId}"]`)
          ?.getBoundingClientRect();
        const rightward = from.left < box.left;
        const y = claim
          ? Math.min(box.bottom - 8, Math.max(box.top + 8, claim.top + claim.height / 2))
          : box.top + 30;
        const sx = (rightward ? from.right : from.left) - origin.left;
        const sy = from.top + 34 + (i % 6) * 15 - origin.top;
        const tx = (rightward ? box.left : box.right) - origin.left;
        const ty = y - origin.top;
        const bend = Math.max(36, Math.abs(tx - sx) * 0.42) * (rightward ? 1 : -1);
        path.setAttribute("d", `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`);
        path.style.strokeDashoffset =
          flying?.kind === "attack" && flying.attack.id === a.id ? String(1 - eased) : "0";
      });

      dot.style.opacity = "0";
      const path = flying && paths.current.get(flying.attack.id);
      if (flying && path?.getAttribute("d")) {
        const color =
          flying.kind === "verify"
            ? STATE_COLOR[flying.attack.status]
            : (ROUTE_COLOR[flying.attack.from] ?? STATE_COLOR.attack);
        const point = path.getPointAtLength(path.getTotalLength() * eased);
        dot.style.left = `${point.x}px`;
        dot.style.top = `${point.y}px`;
        dot.style.opacity = elapsed < 0 ? "0" : "1";
        if (elapsed < 0 && flying.kind === "attack") sparks.charge(point.x, point.y, color);
        if (elapsed >= 0 && k < 1 && flying.duration) sparks.comet(point.x, point.y, color);
        if (k >= 1 && !flying.landed) {
          flying.landed = true;
          const strong = flying.kind === "verify" && flying.attack.status === "supported";
          sparks.impact(point.x, point.y, color, strong ? 2.6 : 1.5);
          host.querySelector(`[data-board="${flying.attack.targetStrategyId}"]`)?.animate(
            [
              { rotate: "y 0deg", translate: "0 0 0" },
              {
                rotate: `y ${point.x > origin.width / 2 ? 11 : -11}deg`,
                translate: "0 0 -90px",
                offset: 0.2,
              },
              { rotate: "y 0deg", translate: "0 0 0" },
            ],
            { duration: 900, easing: "cubic-bezier(.2,1.3,.3,1)" },
          );
          if (flying.kind === "attack") tear(flying.attack);
          else stamp(point.x + (point.x > origin.width / 2 ? -60 : 60), point.y, flying.attack);
        }
      }
      sparks.tick(dt);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // The camera: push in on whoever acts, frame both sides of a dispute, pull back for the verdict.
  useLayoutEffect(() => {
    const el = world.current;
    if (!el) return;
    if (!camera || !current || reducedMotion()) {
      el.style.transform = "none";
      return;
    }
    const W = el.clientWidth;
    const H = el.clientHeight;
    const centre = (id?: string) => {
      const board = el.querySelector<HTMLElement>(`[data-board="${id}"]`);
      return board
        ? {
            x: board.offsetLeft + board.offsetWidth / 2,
            y: board.offsetTop + board.offsetHeight / 2,
          }
        : { x: W / 2, y: H / 2 };
    };
    let scale = 1.38;
    let at = centre(current.agent);
    let turn = 0;
    if (current.stage === "attack" && current.to) {
      const a = centre(current.agent);
      const b = centre(current.to);
      at = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) + 30 };
      scale = Math.abs(a.x - b.x) > W * 0.5 ? 1.02 : 1.32;
      turn = a.x < b.x ? -3 : 3;
    } else if (current.stage === "verify" && current.to) {
      const board = el.querySelector<HTMLElement>(`[data-board="${current.to}"]`);
      const claim = el.querySelector<HTMLElement>(`[data-claim="${hot}"]`);
      const body = claim?.closest<HTMLElement>(".c-board-body");
      if (board && claim && body)
        at = {
          x: board.offsetLeft + board.offsetWidth / 2,
          y: board.offsetTop + body.offsetTop + claim.offsetTop - body.scrollTop + 60,
        };
      scale = 1.72;
    } else if (current.stage === "judge") {
      at = { x: W / 2, y: H / 2 };
      scale = 0.84;
    }
    const focusY = current.stage === "judge" ? H / 2 : H * 0.34;
    const roomX = Math.max(0, ((scale - 1) * W) / 2 + 30);
    const roomY = Math.max(0, ((scale - 1) * H) / 2 + 30);
    const x = Math.max(-roomX, Math.min(roomX, W / 2 - at.x * scale - ((1 - scale) * W) / 2));
    const framed = el.querySelector<HTMLElement>(`[data-board="${current.to ?? current.agent}"]`);
    // However close the camera gets, the top of the board in shot stays on screen.
    const lowest = 10 - H / 2 - ((framed?.offsetTop ?? 0) - H / 2) * scale;
    const y = Math.max(
      scale > 1 ? lowest : -roomY,
      Math.min(roomY, focusY - at.y * scale - ((1 - scale) * H) / 2),
    );
    el.style.transform = `translate3d(${x}px,${y}px,0) scale(${scale}) rotateY(${turn}deg)`;
  }, [camera, current, hot]);

  // Bring the doubted claim into view inside its board, without moving the page.
  useEffect(() => {
    if (!hot) return;
    const claim = stage.current?.querySelector<HTMLElement>(`[data-claim="${hot}"]`);
    const body = claim?.closest<HTMLElement>(".c-board-body");
    if (claim && body) body.scrollTop = Math.max(0, claim.offsetTop - 28);
  }, [hot]);

  // Boards fly out of the depth as the shutter opens.
  useEffect(() => {
    if (entering || reducedMotion()) return;
    stage.current?.querySelectorAll("[data-board]").forEach((node, i) => {
      node.animate(
        [
          { translate: "0 140px -700px", opacity: 0, filter: "blur(16px)" },
          { translate: "0 0 0", opacity: 1, filter: "blur(0)" },
        ],
        {
          duration: 1000,
          delay: 120 + i * 130,
          easing: "cubic-bezier(.16,1,.3,1)",
          fill: "backwards",
        },
      );
    });
  }, [entering]);

  // The room leans a little toward the pointer, and the wall moves the other way.
  useEffect(() => {
    if (reducedMotion()) return;
    const onMove = (e: MouseEvent) => {
      const nx = e.clientX / innerWidth - 0.5;
      const ny = e.clientY / innerHeight - 0.5;
      // At rest the boards hold still so their claims can be clicked; only the wall moves.
      if (rig.current)
        rig.current.style.transform = filming.current
          ? `rotateY(${nx * 2.6}deg) rotateX(${-ny * 2}deg)`
          : "none";
      const wall = document.querySelector<HTMLElement>(".c-stage");
      if (wall) wall.style.translate = `${-nx * 46}px ${-ny * 30}px`;
    };
    addEventListener("mousemove", onMove);
    return () => removeEventListener("mousemove", onMove);
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
    const enter = directed && current?.id === `p:${id}`;
    const rewriting = directed && current?.id === `r:${id}`;
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
              <Chars text={view.title} active={enter} delay={700} />
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
                  className={`c-claim ${hot === `${id}:${claimId}` ? "hot" : ""}`}
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
                      <Chars text={after.text} active={rewriting} delay={800} />
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
          <div className="c-board-body quiet">只显示真实生成的结果。</div>
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
          <path
            key={a.id}
            pathLength={1}
            ref={(node) => {
              if (node) paths.current.set(a.id, node);
              else paths.current.delete(a.id);
            }}
            className={`c-thread is-${stateOf(a)} ${a.id === activeAttack?.id ? "on" : ""}`}
            style={{ "--route": spaced(ROUTE_COLOR[a.from]) } as CSSProperties}
          />
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
      <FloatingWindows version={version} beats={beats} index={index} directed={directed} />
    </div>
  );
}
