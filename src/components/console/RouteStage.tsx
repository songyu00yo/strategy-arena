"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArenaVersion, Attack, Strategy } from "@/lib/contracts";
import { FloatingWindows } from "./fx";
import type { Beat } from "./beats";

const CLAIM = { user: "用户给定", estimate: "估算", unknown: "待核", supported: "有据" };
const WORD: Record<Attack["status"], string> = {
  supported: "成立",
  refuted: "已反驳",
  unresolved: "未决",
  pending: "待核验",
};
const reduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Thread = { id: string; d: string };

/** Three proposal boards in a triptych. Each challenge is a thread from one board to the exact claim it doubts. */
export function RouteStage({
  version,
  beats,
  index,
  stepMs,
  entering,
  readOnly,
  onClaim,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  stepMs: number;
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

  const stage = useRef<HTMLDivElement>(null);
  const packet = useRef<HTMLDivElement>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const [threads, setThreads] = useState<Thread[]>([]);
  const signature = attacks.map((a) => a.id).join();
  const hot = activeAttack ? `${activeAttack.targetStrategyId}:${activeAttack.targetClaimId}` : "";

  // Threads are measured from the real claims, so they stay attached at any screen size.
  useLayoutEffect(() => {
    const host = stage.current;
    if (!host) return;
    const measure = () => {
      const origin = host.getBoundingClientRect();
      const next = attacks.flatMap((a, i) => {
        const from = host.querySelector(`[data-board="${a.from}"]`)?.getBoundingClientRect();
        const board = host.querySelector(`[data-board="${a.targetStrategyId}"]`);
        const box = board?.getBoundingClientRect();
        if (!from || !box) return [];
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
        return [{ id: a.id, d: `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}` }];
      });
      setThreads(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    host.querySelectorAll("[data-board]").forEach((node) => observer.observe(node));
    const settled = setTimeout(measure, 800);
    return () => {
      observer.disconnect();
      clearTimeout(settled);
    };
    // The attack list is summarised by its signature; the board layout changes with the float.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, hot, entering]);

  // Bring the doubted claim into view inside its board, without moving the page.
  useEffect(() => {
    if (!hot) return;
    const claim = stage.current?.querySelector<HTMLElement>(`[data-claim="${hot}"]`);
    const body = claim?.closest<HTMLElement>(".c-board-body");
    if (claim && body) body.scrollTop = Math.max(0, claim.offsetTop - 28);
  }, [hot]);

  // A label travels the live thread once per step.
  useEffect(() => {
    const dot = packet.current;
    if (!dot) return;
    dot.style.opacity = "0";
    const path = activeAttack && paths.current.get(activeAttack.id);
    if (!path) return;
    const length = path.getTotalLength();
    const place = (at: number) => {
      const point = path.getPointAtLength(at);
      dot.style.left = `${point.x}px`;
      dot.style.top = `${point.y}px`;
      dot.style.opacity = "1";
    };
    if (reduced()) return place(length);
    const began = performance.now();
    const duration = Math.min(1100, stepMs * 0.55);
    let frame = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - began) / duration);
      place(length * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2));
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [current?.id, activeAttack, stepMs, threads]);

  // Boards rise out of the record wall once the opening ends.
  useEffect(() => {
    if (entering || reduced()) return;
    stage.current?.querySelectorAll("[data-board]").forEach((node, i) => {
      node.animate(
        [
          { translate: "0 46px", scale: "0.9", opacity: 0, filter: "blur(8px)" },
          { translate: "0 0", scale: "1", opacity: 1, filter: "blur(0)" },
        ],
        { duration: 620, delay: i * 90, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" },
      );
    });
  }, [entering]);

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
    return (
      <section
        key={id}
        data-board={id}
        aria-label={`路线 ${id}`}
        className={`c-board c-board-${id} ${speaking ? "speaking" : ""} ${target ? "target" : ""} ${pick ? "pick" : ""}`}
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
            <h3>{view.title}</h3>
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
                  <span className={lost || !after ? "struck" : ""}>
                    {before?.text ?? claim.text}
                  </span>
                  {before && after && before.text !== after.text && (
                    <span className="changed">{after.text}</span>
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
      {board("A")}
      {board("B")}
      {board("C")}
      <svg className="c-threads" aria-hidden="true">
        {threads.map((thread) => {
          const a = attacks.find((x) => x.id === thread.id);
          if (!a) return null;
          return (
            <path
              key={thread.id}
              ref={(node) => {
                if (node) paths.current.set(thread.id, node);
                else paths.current.delete(thread.id);
              }}
              className={`c-thread is-${stateOf(a)} ${a.id === activeAttack?.id ? "on" : ""}`}
              d={thread.d}
            />
          );
        })}
      </svg>
      <div
        className={`c-packet ${current?.stage === "verify" && activeAttack ? `is-${activeAttack.status}` : ""}`}
        ref={packet}
        aria-hidden="true"
      >
        {current?.packet}
      </div>
      <FloatingWindows version={version} beats={beats} index={index} />
    </div>
  );
}
