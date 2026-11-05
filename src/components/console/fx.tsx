"use client";
import { useEffect, useRef, useState } from "react";
import type { ArenaEvent, ArenaVersion, Attack } from "@/lib/contracts";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { outputOf, type Beat } from "./beats";

const reduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Opening: the question, then what this game really holds, counted line by line. */
export function Intro({
  version,
  events,
  model,
  onDone,
}: {
  version: ArenaVersion;
  events: ArenaEvent[];
  model: { id: string; promptVersion: string; schemaVersion: string };
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
  useEffect(() => {
    if (reduced()) return onDone();
    const timer = setTimeout(
      () => (count < lines.length ? setCount(count + 1) : onDone()),
      count < lines.length ? 190 : 650,
    );
    return () => clearTimeout(timer);
  }, [count, lines.length, onDone]);
  useEffect(() => {
    addEventListener("keydown", onDone, { once: true });
    addEventListener("mousedown", onDone, { once: true });
    return () => {
      removeEventListener("keydown", onDone);
      removeEventListener("mousedown", onDone);
    };
  }, [onDone]);
  return (
    <div className="c-intro" aria-hidden="true">
      <p className="q">{version.challenge.goal}</p>
      <ul>
        {lines.slice(0, count).map((line) => (
          <li key={line}>{line}</li>
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
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
}) {
  const current = beats[index];
  const shown = beats.slice(0, index + 1);
  const box = useRef<HTMLDivElement>(null);
  const attack = current?.attack;
  useEffect(() => {
    if (!box.current || !attack || reduced()) return;
    box.current.animate(
      [
        { transform: "translateY(70px) scale(0.78)", opacity: 0, filter: "blur(6px)" },
        { transform: "none", opacity: 1, filter: "none" },
      ],
      { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }, [attack?.id, attack]);
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
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
