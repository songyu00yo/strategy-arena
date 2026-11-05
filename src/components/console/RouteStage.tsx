"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ArenaVersion, Attack, Strategy } from "@/lib/contracts";
import { FloatingWindows } from "./fx";
import { Chars, reducedMotion } from "./effects";
import type { Beat } from "./beats";

const CLAIM = { user: "用户给定", estimate: "估算", unknown: "待核", supported: "有据" };
const WORD: Record<Attack["status"], string> = {
  supported: "成立",
  refuted: "已反驳",
  unresolved: "未决",
  pending: "待核验",
};

/** Three proposal boards. Each challenge is a thread from one board to the exact claim it doubts. */
export function RouteStage({
  version,
  beats,
  index,
  speed,
  directed,
  focused,
  readOnly,
  onClaim,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  speed: number;
  directed: boolean;
  focused: boolean;
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
  const flies = current?.stage === "attack" || current?.stage === "verify";

  const stage = useRef<HTMLDivElement>(null);
  const packet = useRef<HTMLDivElement>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const flying = useRef(false);
  const live = useRef(attacks);
  const activeId = useRef<string | undefined>(undefined);
  useEffect(() => {
    live.current = attacks;
    activeId.current = flies ? activeAttack?.id : undefined;
  });
  const signature = attacks.map((a) => a.id).join();

  // Threads are measured from the real claims, so they stay attached at any size and scroll.
  useLayoutEffect(() => {
    const host = stage.current;
    const dot = packet.current;
    if (!host || !dot) return;
    const measure = () => {
      const origin = host.getBoundingClientRect();
      attacks.forEach((a, i) => {
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
      });
      const active = activeId.current && paths.current.get(activeId.current);
      if (active && !flying.current) {
        const end = active.getPointAtLength(active.getTotalLength());
        dot.style.left = `${end.x}px`;
        dot.style.top = `${end.y}px`;
      }
    };
    activeId.current = flies ? activeAttack?.id : undefined;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    host.querySelectorAll("[data-board]").forEach((node) => observer.observe(node));
    host.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      host.removeEventListener("scroll", measure, true);
    };
    // The attack list is summarised by its signature; `hot` changes which claim is scrolled to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, hot, flies]);

  // Bring the doubted claim into view inside its board.
  useLayoutEffect(() => {
    if (!hot) return;
    const claim = stage.current?.querySelector<HTMLElement>(`[data-claim="${hot}"]`);
    const body = claim?.closest<HTMLElement>(".c-board-body");
    if (claim && body) body.scrollTop = Math.max(0, claim.offsetTop - 28);
  }, [hot]);

  // A new step draws its thread once, with a label travelling along it and a small ring on arrival.
  const beatId = current?.id;
  useEffect(() => {
    const host = stage.current;
    const dot = packet.current;
    if (!host || !dot) return;
    const attack = flies ? activeAttack : undefined;
    const path = attack && paths.current.get(attack.id);
    if (!attack || !path) {
      dot.style.opacity = "0";
      return;
    }
    dot.style.opacity = "1";
    const length = path.getTotalLength();
    const place = (at: number) => {
      const point = path.getPointAtLength(at);
      dot.style.left = `${point.x}px`;
      dot.style.top = `${point.y}px`;
    };
    if (!directed || reducedMotion()) {
      place(length);
      return;
    }
    const drawing = current?.stage === "attack";
    const began = performance.now();
    const duration = 620 / speed;
    let frame = 0;
    flying.current = true;
    const tick = (now: number) => {
      const k = Math.min(1, (now - began) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      place(length * eased);
      if (drawing) path.style.strokeDashoffset = String(1 - eased);
      if (k < 1) {
        frame = requestAnimationFrame(tick);
        return;
      }
      flying.current = false;
      const end = path.getPointAtLength(length);
      const ring = document.createElement("div");
      ring.className = `c-ring is-${current?.stage === "verify" ? attack.status : "pending"}`;
      ring.style.left = `${end.x}px`;
      ring.style.top = `${end.y}px`;
      host.appendChild(ring);
      ring.animate(
        [
          { transform: "scale(.3)", opacity: 0.8 },
          { transform: "scale(1.5)", opacity: 0 },
        ],
        { duration: 420, easing: "ease-out" },
      ).onfinish = () => ring.remove();
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      flying.current = false;
      path.style.strokeDashoffset = "0";
    };
    // Only a new step launches a flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId]);

  const involved = (id: string) => {
    if (!focused || !current || current.stage === "judge") return true;
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
      >
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
              <Chars text={view.title} active={enter} />
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
                      <i key={`${a.id}:${stateOf(a)}`} className={`is-${stateOf(a)}`}>
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
                      <Chars text={after.text} active={rewriting} />
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
    <div className="c-stage3" ref={stage}>
      {board("A")}
      {board("B")}
      {board("C")}
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
          />
        ))}
      </svg>
      <div
        className={`c-packet ${current?.stage === "verify" && activeAttack ? `is-${activeAttack.status}` : ""}`}
        ref={packet}
        aria-hidden="true"
      >
        {current?.packet}
      </div>
      <FloatingWindows version={version} beats={beats} index={index} directed={directed} />
    </div>
  );
}
