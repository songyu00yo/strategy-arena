"use client";
import { useEffect, useRef, useState } from "react";
import type { ArenaEvent, ArenaVersion, Attack, Verdict } from "@/lib/contracts";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { outputOf, type Beat } from "./beats";
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
  ];
  const [count, setCount] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reducedMotion()) {
      onReveal();
      return onDone();
    }
    if (count < lines.length) {
      const timer = setTimeout(() => setCount(count + 1), count === 0 ? 1500 : 240);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      onReveal();
      const open = box.current?.animate(
        [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(50% 0 50% 0)" }],
        { duration: 760, easing: "cubic-bezier(.76,0,.24,1)", fill: "forwards" },
      );
      if (open) open.onfinish = onDone;
      else onDone();
    }, 620);
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
      <Dust dark />
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
    set = [ROUTE_COLOR[route ?? ""] ?? "255,255,255", "255,255,255", "255,215,140"];
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

/** A chapter word sweeps across the whole frame whenever the game enters a new stage. */
export function Chapter({ stage, number }: { stage: Stage; number: number }) {
  return (
    <div className="c-chapter" aria-hidden="true">
      <i />
      <b>{CHAPTER[stage]}</b>
      <small>
        0{number} · {STAGE_LABELS[stage]}
      </small>
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
      { duration: 850, easing: "cubic-bezier(.7,0,.2,1)", fill: "both" },
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
    const timer = setTimeout(close, 3900);
    addEventListener("keydown", close);
    return () => {
      clearTimeout(timer);
      removeEventListener("keydown", close);
    };
  }, [verdict, onDone]);
  return (
    <div className="c-film" ref={box} aria-hidden="true">
      <Dust dark embers={EMBERS(verdict.preferred)} />
      <small>
        <Chars
          text={verdict.preferred ? `建议 ${verdict.preferred}` : "暂无单一建议"}
          active
          delay={350}
        />
      </small>
      <div className="head">
        <Chars text={verdict.headline} active delay={600} />
      </div>
      <ul>
        {verdict.conditions.slice(0, 2).map((line, i) => (
          <li key={line}>
            <Decode text={line} active delay={1100 + i * 220} />
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

/** The current dispute lifts off the wall and runs line by line; earlier ones stack behind it. */
export function FloatingWindows({
  version,
  beats,
  index,
  directed,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  directed: boolean;
}) {
  const current = beats[index];
  const shown = beats.slice(0, index + 1);
  const box = useRef<HTMLDivElement>(null);
  const attack = current?.attack;
  useEffect(() => {
    if (!box.current || !attack || !directed || reduced()) return;
    box.current.animate(
      [
        {
          transform: "translateY(90px) rotateX(24deg) scale(0.74)",
          opacity: 0,
          filter: "blur(10px)",
        },
        { transform: "none", opacity: 1, filter: "none" },
      ],
      { duration: 620, delay: 620, easing: "cubic-bezier(.2,.9,.2,1)", fill: "backwards" },
    );
    // Rising only belongs to a new dispute, not to each later step of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attack?.id]);
  const stateOf = (a: Attack) => (shown.some((b) => b.id === `v:${a.id}`) ? a.status : "pending");
  const past = shown
    .filter((b) => b.stage === "attack" && b.attack!.id !== attack?.id)
    .map((b) => b.attack!)
    .slice(-5);
  const strips = past.map((a, i) => (
    <div
      key={a.id}
      className="c-float-back"
      style={{
        scale: String(1 - (past.length - i) * 0.018),
        opacity: 1 - (past.length - i) * 0.1,
      }}
    >
      <b className={`is-${stateOf(a)}`}>
        {a.from}→{a.targetStrategyId} {attackMeta[stateOf(a)].label}
      </b>{" "}
      {a.reason}
    </div>
  ));
  if (!attack)
    return strips.length ? (
      <div className="c-float" aria-hidden="true">
        {strips}
      </div>
    ) : null;
  const checked = shown.some((b) => b.id === `v:${attack.id}`);
  const response = shown
    .find((b) => b.id === `r:${attack.targetStrategyId}`)
    ?.revision?.responses.find((r) => r.attackId === attack.id);
  const evidence = version.evidence.filter((e) => e.attackId === attack.id);
  const running = current.stage === "attack" ? 1 : current.stage === "verify" ? 2 : 3;
  const rows: [string, string][] = [
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
  ];
  return (
    <div className="c-float" aria-hidden="true">
      {strips}
      <div className="c-float-card" ref={box}>
        <div className="tb">
          <b>
            {attack.from} → {attack.targetStrategyId}.{attack.targetClaimId}
          </b>
          <span>{checked ? attackMeta[attack.status].label : "核验中"}</span>
        </div>
        <div className="body">
          {rows.map(([label, text], i) => (
            <div key={label} className={`ln ${i === running ? "run" : i < running ? "ran" : ""}`}>
              <em>{label}</em>
              <span>
                <Decode
                  text={text}
                  active={directed && i === running}
                  delay={i === 0 ? 1000 : 150}
                />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
