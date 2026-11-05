"use client";
import { attackMeta, decisionMeta, evidenceMeta } from "@/components/status";
import { Modal } from "@/components/modal";
import { STAGE_LABELS, type ArenaVersion, type Attack } from "@/lib/contracts";
import { nameOf, type Beat } from "./beats";

type Row = { label: string; text: string; tone?: string };

/** Everything recorded about one step, in the order a reader would question it. */
function rowsOf(version: ArenaVersion, beat: Beat, known: Beat[]): Row[] {
  const clean = (rows: Row[]) => rows.filter((row) => row.text);
  if (beat.attack) {
    const a = beat.attack;
    const checked = known.some((b) => b.id === `v:${a.id}`);
    const reply = known
      .find((b) => b.id === `r:${a.targetStrategyId}`)
      ?.revision?.responses.find((r) => r.attackId === a.id);
    const evidence = version.evidence
      .filter((e) => e.attackId === a.id)
      .map((e) =>
        [
          e.title,
          e.expression ? `${e.expression} = ${e.result ?? "无法计算"}` : "",
          e.assumptions,
          e.content || evidenceMeta[e.status].label,
        ]
          .filter(Boolean)
          .map((part) => part.replace(/[。.]+$/, ""))
          .join("。"),
      );
    return clean([
      { label: `${a.targetStrategyId} 的原话`, text: a.claimQuote },
      { label: `${a.from} 为什么质疑`, text: a.reason },
      { label: "如果质疑成立", text: a.impact },
      { label: "怎么核验", text: a.verification },
      {
        label: "核验结果",
        text: checked ? [attackMeta[a.status].label, ...evidence].join("：") : "这一步还没有结果。",
        tone: checked ? `is-${a.status}` : "",
      },
      {
        label: `${a.targetStrategyId} 的回应`,
        text: reply
          ? [decisionMeta[reply.decision].label, reply.reason, reply.change]
              .filter(Boolean)
              .join("。")
          : "这一步还没有回应。",
      },
    ]);
  }
  if (beat.strategy) {
    const s = beat.strategy;
    return clean([
      { label: "核心思路", text: s.thesis },
      { label: "预计投入", text: `${s.estimatedHours ?? "?"} 小时，¥${s.estimatedCost ?? "?"}` },
      { label: "关键判断", text: s.claims.map((c) => `${c.id}：${c.text}`).join("\n") },
      { label: "步骤", text: s.steps.map((step, i) => `${i + 1}. ${step}`).join("\n") },
      { label: "第一步", text: s.firstAction },
      { label: "什么情况下放弃", text: s.failureCondition },
    ]);
  }
  if (beat.revision) {
    const r = beat.revision;
    return clean([
      { label: "这次修订", text: r.summary },
      { label: "改了什么", text: (beat.changes ?? []).join("、") || "没有改动。" },
      {
        label: "怎么回应质疑",
        text: r.responses
          .map((x) =>
            [decisionMeta[x.decision].label, x.reason, x.change].filter(Boolean).join("。"),
          )
          .join("\n"),
      },
      {
        label: "修订后的判断",
        text: r.strategy.claims.map((c) => `${c.id}：${c.text}`).join("\n"),
      },
    ]);
  }
  if (beat.verdict) {
    const v = beat.verdict;
    return clean([
      { label: "结论", text: v.headline },
      { label: "理由", text: v.rationale },
      { label: "下一步", text: v.nextActions.join("\n") },
      { label: "前提", text: v.conditions.join("\n") },
      { label: "仍需确认", text: v.uncertainties.join("\n") },
      { label: "退出条件", text: v.exitCondition },
    ]);
  }
  return [];
}

/** A step opened from the chain or the chart. The page behind it stays where it was. */
export function StepCard({
  version,
  beats,
  index,
  last,
  reviewing,
  onOpen,
  onStage,
  onEvidence,
  onClose,
}: {
  version: ArenaVersion;
  beats: Beat[];
  index: number;
  /** The furthest step the viewer has reached; later ones are not shown. */
  last: number;
  reviewing: boolean;
  onOpen: (index: number) => void;
  onStage: (index: number) => void;
  onEvidence: (attack: Attack) => void;
  onClose: () => void;
}) {
  const beat = beats[index];
  const known = reviewing ? beats : beats.slice(0, last + 1);
  return (
    <Modal title={`第 ${index + 1} 步 · ${STAGE_LABELS[beat.stage]}`} onClose={onClose}>
      <div className="c-step" key={beat.id}>
        <p className="who">
          {nameOf(beat.agent)}
          {beat.to ? ` → ${nameOf(beat.to)}` : ""}
        </p>
        <h3>{beat.title}</h3>
        <dl>
          {rowsOf(version, beat, known).map((row) => (
            <div key={row.label} className={row.tone}>
              <dt>{row.label}</dt>
              <dd>{row.text}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <button
            type="button"
            className="secondary-button"
            disabled={index <= 0}
            onClick={() => onOpen(index - 1)}
          >
            上一步
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={index >= last}
            onClick={() => onOpen(index + 1)}
          >
            下一步
          </button>
          <span />
          <button type="button" className="text-button" onClick={() => onStage(index)}>
            在舞台上看这一步
          </button>
          {beat.attack && (
            <button
              type="button"
              className="primary-button"
              onClick={() => onEvidence(beat.attack!)}
            >
              看证据
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
