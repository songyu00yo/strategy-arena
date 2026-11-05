"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ArenaEvent, ArenaVersion, Verdict } from "@/lib/contracts";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { nameOf, outputOf, type Beat } from "./beats";
import { Chars, Decode, Dust, reducedMotion, ROUTE_COLOR } from "./effects";
import { STAGE_LABELS, type Stage } from "@/lib/contracts";

const reduced = reducedMotion;

/** Cold open: the question on black, what this game holds, then a shutter opens on the room. */
export function Intro({
  version,
  events,
  model,
  onReveal,
  onDone,
}: {
  version: ArenaVersion;
  events: ArenaEvent[];
  model: { id: string; promptVersion: string; schemaVersion: string };
  onReveal: () => void;
  onDone: () => void;
}) {
  const lines = [
    `${version.strategies.length} 条路线`,
    `${version.attacks.length} 次质疑`,
    `${version.evidence.length} 项证据`,
    `${events.length} 条步骤记录`,
    `同一模型 ${model.id} 分成五个角色`,
  ].filter((line) => !line.startsWith("0 "));
  const [count, setCount] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reducedMotion()) {
      onReveal();
      return onDone();
    }
    if (count < lines.length) {
      const timer = setTimeout(() => setCount(count + 1), count === 0 ? 800 : 130);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      onReveal();
      const open = box.current?.animate(
        [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(50% 0 50% 0)" }],
        { duration: 520, easing: "cubic-bezier(.76,0,.24,1)", fill: "forwards" },
      );
      if (open) open.onfinish = onDone;
      else onDone();
    }, 320);
    return () => clearTimeout(timer);
  }, [count, lines.length, onDone, onReveal]);
  useEffect(() => {
    const skip = () => {
      onReveal();
      onDone();
    };
    addEventListener("keydown", skip, { once: true });
    addEventListener("mousedown", skip, { once: true });
    return () => {
      removeEventListener("keydown", skip);
      removeEventListener("mousedown", skip);
    };
  }, [onDone, onReveal]);
  return (
    <div className="c-intro" ref={box} aria-hidden="true">
      <Dust />
      <p className="q">
        <Chars text={version.challenge.goal} active />
      </p>
      <ul>
        {lines.slice(0, count).map((line) => (
          <li key={line}>
            <Decode text={line} active />
          </li>
        ))}
      </ul>
    </div>
  );
}

const emberSets = new Map<string, string[]>();
const EMBERS = (route: string | null) => {
  const key = route ?? "none";
  let set = emberSets.get(key);
  if (!set) {
    set = [ROUTE_COLOR[route ?? ""] ?? "255,255,255", "120,130,150", "255,175,60"];
    emberSets.set(key, set);
  }
  return set;
};

const CHAPTER: Record<Stage, string> = {
  propose: "提案",
  attack: "质疑",
  verify: "核验",
  revise: "修订",
  judge: "裁决",
};

/** The stage word lands huge, then flies up and becomes its label on the timeline. */
export function Chapter({ stage }: { stage: Stage }) {
  const word = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = word.current;
    if (!el || reduced()) return;
    const timer = setTimeout(() => {
      const to = document.querySelector(".c-time .seg.here span")?.getBoundingClientRect();
      const from = el.getBoundingClientRect();
      if (!to) return;
      const scale = Math.max(0.04, to.height / from.height);
      el.animate(
        [
          { transform: "none", opacity: 1 },
          {
            transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px,${
              to.top + to.height / 2 - (from.top + from.height / 2)
            }px) scale(${scale})`,
            opacity: 0.25,
          },
        ],
        { duration: 420, easing: "cubic-bezier(.7,0,.15,1)", fill: "forwards" },
      );
    }, 360);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="c-chapter" aria-hidden="true">
      <b ref={word}>
        <Chars text={CHAPTER[stage]} active />
      </b>
    </div>
  );
}

/** The verdict lands: black bursts out of the chosen board, then folds into the verdict panel. */
export function VerdictFilm({ verdict, onDone }: { verdict: Verdict; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || reducedMotion()) return onDone();
    const pick = document
      .querySelector(`[data-board="${verdict.preferred ?? "B"}"]`)
      ?.getBoundingClientRect();
    const x = pick ? pick.left + pick.width / 2 : innerWidth / 2;
    const y = pick ? pick.top + pick.height / 2 : innerHeight / 2;
    el.animate(
      [
        { clipPath: `circle(0px at ${x}px ${y}px)` },
        { clipPath: `circle(150vmax at ${x}px ${y}px)` },
      ],
      { duration: 600, delay: 350, easing: "cubic-bezier(.7,0,.2,1)", fill: "both" },
    );
    let closing: Animation | undefined;
    const close = () => {
      if (closing) return;
      const panel = document.querySelector(".c-verdict")?.getBoundingClientRect();
      const inset = panel
        ? `inset(${panel.top}px ${innerWidth - panel.right}px ${innerHeight - panel.bottom}px ${panel.left}px)`
        : "inset(50%)";
      closing = el.animate(
        [
          { clipPath: "inset(0 0 0 0)", opacity: 1 },
          { clipPath: inset, opacity: 1, offset: 0.85 },
          { clipPath: inset, opacity: 0 },
        ],
        { duration: 800, easing: "cubic-bezier(.76,0,.24,1)", fill: "forwards" },
      );
      closing.onfinish = onDone;
    };
    const timer = setTimeout(close, 2500);
    addEventListener("keydown", close);
    return () => {
      clearTimeout(timer);
      removeEventListener("keydown", close);
    };
    // Runs once: a poll that refreshes the record must not restart the verdict's timing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="c-film" ref={box} aria-hidden="true">
      <Dust embers={EMBERS(verdict.preferred)} />
      <small>
        <Chars
          text={verdict.preferred ? `建议 ${verdict.preferred}` : "暂无单一建议"}
          active
          delay={520}
        />
      </small>
      <div className="head">
        <Chars text={verdict.headline} active delay={650} />
      </div>
      <ul>
        {verdict.conditions.slice(0, 2).map((line, i) => (
          <li key={line}>
            <Decode text={line} active delay={1000 + i * 150} />
          </li>
        ))}
      </ul>
    </div>
  );
}

type WallRecord = { id: string; title: string; meta: string; lines: string[] };

/** What the wall may show: this game's stored records only. An empty game has an empty wall. */
function wallRecords(version: ArenaVersion, events: ArenaEvent[]): WallRecord[] {
  const records: WallRecord[] = [];
  for (const s of version.strategies)
    records.push({
      id: `s:${s.id}`,
      title: `方案 ${s.id} 提案`,
      meta: s.title,
      lines: [s.thesis, ...s.steps, ...s.claims.map((c) => `${c.id}: ${c.text}`), s.firstAction],
    });
  for (const a of version.attacks)
    records.push({
      id: `a:${a.id}`,
      title: `${a.from} 质疑 ${a.targetStrategyId}`,
      meta: a.targetClaimId,
      lines: [a.claimQuote, a.reason, a.impact, a.verification],
    });
  for (const e of version.evidence)
    records.push({
      id: `e:${e.id}`,
      title: "核验证据",
      meta: e.title,
      lines: [e.expression ?? "", e.assumptions, e.content, e.source].filter(Boolean),
    });
  for (const event of events) {
    const output = outputOf(event);
    if (output)
      records.push({
        id: `o:${event.seq}`,
        title: `模型输出 ${event.actor}`,
        meta: event.stage ?? "",
        lines: JSON.stringify(output, null, 1).split("\n"),
      });
  }
  return records.slice(0, 18);
}

type Panel = {
  el: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  phase: number;
  lines: string[];
  row: number;
  ch: number;
  wait: number;
  rows: HTMLElement[];
  fresh: boolean;
};

/** Real records typing themselves out on panels set back in space. */
export function RecordWall({ version, events }: { version: ArenaVersion; events: ArenaEvent[] }) {
  const stage = useRef<HTMLDivElement>(null);
  const panels = useRef(new Map<string, Panel>());
  const records = wallRecords(version, events);
  const signature = records.map((r) => r.id).join();
  const latest = useRef(records);
  useEffect(() => {
    latest.current = records;
  });
  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    latest.current.forEach((record, i) => {
      if (panels.current.has(record.id)) return;
      const el = document.createElement("div");
      el.className = "c-cw";
      const head = document.createElement("div");
      head.className = "tb";
      const name = document.createElement("b");
      name.textContent = record.title;
      const meta = document.createElement("span");
      meta.textContent = record.meta;
      head.append(name, meta);
      const body = document.createElement("div");
      body.className = "body";
      // Panels arrive already written, then retype one at a time, so the wall is never blank.
      const rows = record.lines.map((line) => {
        const row = document.createElement("div");
        row.textContent = line;
        body.appendChild(row);
        return row;
      });
      el.append(head, body);
      const col = i % 6;
      const line = Math.floor(i / 6);
      const z = -320 - ((i * 137) % 900);
      const blur = Math.min(1.8, (-z - 320) / 480);
      el.style.filter = `blur(${blur}px)`;
      el.style.opacity = String(0.95 - blur * 0.18);
      host.appendChild(el);
      panels.current.set(record.id, {
        el,
        x: (col - 2.5) * 400 + (line % 2) * 120,
        y: (line - 1.2) * 330,
        z,
        phase: (i * 1.7) % 6.28,
        lines: record.lines,
        row: 0,
        ch: 0,
        wait: -((i * 1700) % 9000) - 800,
        fresh: true,
        rows,
      });
    });
    for (const [id, panel] of panels.current)
      if (!latest.current.some((r) => r.id === id)) {
        panel.el.remove();
        panels.current.delete(id);
      }
  }, [signature]);
  useEffect(() => {
    const all = panels.current;
    const place = (p: Panel, t: number) => {
      const dx = Math.sin(t / 7000 + p.phase) * 30;
      const dy = Math.cos(t / 9000 + p.phase) * 18;
      p.el.style.transform = `translate3d(${p.x + dx - 180}px, ${p.y + dy - 150}px, ${p.z}px)`;
    };
    if (reduced()) {
      for (const p of all.values()) {
        place(p, 0);
        p.rows.forEach((row, i) => (row.textContent = p.lines[i]));
      }
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(64, t - last);
      last = t;
      for (const p of all.values()) {
        place(p, t);
        p.wait += dt;
        if (p.fresh) {
          if (p.wait < 0) continue;
          p.fresh = false;
          p.rows.forEach((row) => (row.textContent = ""));
        }
        while (p.wait > 22 && p.row < p.lines.length) {
          p.wait -= 22;
          p.ch += 1;
          p.rows[p.row].textContent = p.lines[p.row].slice(0, p.ch);
          if (p.ch >= p.lines[p.row].length) {
            p.row += 1;
            p.ch = 0;
          }
        }
        if (p.row >= p.lines.length && p.wait > 5000) {
          p.rows.forEach((row) => (row.textContent = ""));
          p.row = 0;
          p.ch = 0;
          p.wait = 0;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [signature]);
  return (
    <div className="c-wall" aria-hidden="true">
      <div className="c-stage" ref={stage} />
    </div>
  );
}

const STAGE_WORD: Record<Stage, string> = STAGE_LABELS;

/** The chain of thought: every step so far stays in view as a card, the newest in front. */
export function ChainDeck({
  version,
  beats,
  index,
  directed,
  lead,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  directed: boolean;
  lead: number;
}) {
  const shown = beats.slice(0, index + 1);
  const front = useRef<HTMLDivElement>(null);
  const current = beats[index];
  useEffect(() => {
    if (!front.current || !directed || reduced()) return;
    front.current.animate(
      [
        {
          translate: "90px 12px",
          rotate: "y -12deg",
          scale: "1.02",
          opacity: 0,
          filter: "blur(3px)",
        },
        { translate: "0 0", rotate: "y 0deg", scale: "1", opacity: 1, filter: "blur(0)" },
      ],
      { duration: 520, delay: lead + 40, easing: "cubic-bezier(.16,1.05,.3,1)", fill: "backwards" },
    );
    // Only a new step brings a card in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  if (!shown.length) return null;
  const attack = current?.attack;
  const seenIds = new Set(shown.map((b) => b.id));
  const checked = !!attack && seenIds.has(`v:${attack.id}`);
  const response =
    attack &&
    shown
      .find((b) => b.id === `r:${attack.targetStrategyId}`)
      ?.revision?.responses.find((r) => r.attackId === attack.id);
  const evidence = attack ? version.evidence.filter((e) => e.attackId === attack.id) : [];
  const running = current?.stage === "attack" ? 1 : current?.stage === "verify" ? 2 : 3;
  const rows: [string, string][] = attack
    ? [
        [`${attack.targetStrategyId} 原话`, attack.claimQuote],
        [`${attack.from} 质疑`, attack.reason],
        [
          "核验",
          checked
            ? [
                attackMeta[attack.status].label,
                ...evidence.map(
                  (e) =>
                    `${e.expression ? `${e.expression} = ${e.result ?? "无法计算"} ` : ""}${e.content || evidenceMeta[e.status].label}`,
                ),
              ].join(" · ")
            : "等待",
        ],
        [
          `${attack.targetStrategyId} 回应`,
          response
            ? `${decisionMeta[response.decision].label}。${response.reason} ${response.change}`
            : "等待",
        ],
      ]
    : [];
  return (
    <div
      className="c-deck"
      aria-hidden="true"
      style={{ "--n": Math.max(shown.length - 1, 1) } as CSSProperties}
    >
      {shown.map((beat, i) => {
        const depth = shown.length - 1 - i;
        const isFront = depth === 0;
        const dispute = isFront && !!attack;
        return (
          <div
            key={beat.id}
            ref={isFront ? front : undefined}
            className={`c-deck-card ${isFront ? "c-deck-now" : ""} ${dispute ? "c-float-card" : ""}`}
            style={
              {
                "--d": depth,
                "--route": (ROUTE_COLOR[beat.agent] ?? "11,13,16").replaceAll(",", " "),
                zIndex: 100 - depth,
              } as CSSProperties
            }
          >
            <div className="tb">
              <b>
                {String(i + 1).padStart(2, "0")} {nameOf(beat.agent)}
                {beat.to ? ` → ${nameOf(beat.to)}` : ""}
              </b>
              <span>
                {dispute
                  ? checked
                    ? attackMeta[attack.status].label
                    : "核验中"
                  : STAGE_WORD[beat.stage]}
              </span>
            </div>
            {dispute ? (
              <div className="body">
                {rows.map(([label, text], r) => (
                  <div
                    key={label}
                    className={`ln ${r === running ? "run" : r < running ? "ran" : ""}`}
                  >
                    <em>{label}</em>
                    <span>
                      <Decode
                        text={text}
                        active={directed && r === running}
                        delay={lead + (r === 0 ? 700 : 300)}
                      />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="body plain">
                <strong>{beat.title}</strong>
                <p>{beat.plain}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
