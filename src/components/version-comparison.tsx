"use client";

import { useState } from "react";
import type { ArenaVersion } from "@/lib/contracts";
import { challengeChanges } from "@/lib/challenge-changes";
import { strategyChanges } from "./text-diff";
import { Modal } from "./modal";

export function VersionComparison({
  version,
  parent,
}: {
  version: ArenaVersion;
  parent?: ArenaVersion;
}) {
  const [sourceOpen, setSourceOpen] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<HTMLButtonElement | null>(null);
  const inputChanges = parent ? challengeChanges(parent.challenge, version.challenge) : [];
  return (
    <section className="version-comparison" aria-label="版本变化">
      {version.followUp && (
        <>
          <button
            type="button"
            className="text-button"
            aria-expanded={!!sourceOpen}
            aria-haspopup="dialog"
            onClick={(event) => setSourceOpen(event.currentTarget)}
          >
            本次补充 · 查看原文与意见
          </button>
          {sourceOpen && (
            <Modal title="本次补充" trigger={sourceOpen} onClose={() => setSourceOpen(null)}>
              <div className="version-feedback-source">
                <small>
                  来源：{parent ? `V${parent.number}` : "原版本"} · 步骤 {version.followUp.stepId}
                </small>
                <blockquote>{version.followUp.quote}</blockquote>
                <strong>你的补充</strong>
                <p>{version.followUp.text}</p>
              </div>
            </Modal>
          )}
        </>
      )}
      {parent && (
        <>
          <button
            type="button"
            className="text-button"
            aria-expanded={!!open}
            aria-haspopup="dialog"
            onClick={(event) => setOpen(event.currentTarget)}
          >
            对比上一版 V{parent.number} → V{version.number}
          </button>
          {open && (
            <Modal
              title={`版本变化 · V${parent.number} → V${version.number}`}
              trigger={open}
              onClose={() => setOpen(null)}
              wide
            >
              <div className="version-comparison-content">
                <h3>输入变化</h3>
                {inputChanges.length ? (
                  inputChanges.map((change) => (
                    <section key={change.key}>
                      <h4>{change.label}</h4>
                      <div className="version-pair">
                        <p>
                          <small>上一版</small>
                          {change.before || "未填写"}
                        </p>
                        <p>
                          <small>本版</small>
                          {change.after || "未填写"}
                        </p>
                      </div>
                    </section>
                  ))
                ) : (
                  <p>任务条件未改动，本次新增了补充意见或调整了模型。</p>
                )}
                <h3>结论记录</h3>
                <div className="version-pair">
                  <p>
                    <small>V{parent.number}</small>
                    {parent.verdict?.headline ?? "上一版未形成完整结论"}
                  </p>
                  <p>
                    <small>V{version.number}</small>
                    {version.verdict?.headline ?? "新一轮还在推演，结论尚未形成"}
                  </p>
                </div>
                {parent.verdict &&
                  version.verdict &&
                  parent.verdict.preferred === version.verdict.preferred && (
                    <p>
                      {version.verdict.preferred
                        ? `两版记录的建议路线均为 ${version.verdict.preferred}，具体内容以各版原文为准。`
                        : "两版均未指定优先路线。"}
                    </p>
                  )}
                <h3>路线内容</h3>
                {(["A", "B", "C"] as const).map((route) => {
                  const before =
                    parent.revisions.find((entry) => entry.strategyId === route)?.strategy ??
                    parent.strategies.find((entry) => entry.id === route);
                  const after =
                    version.revisions.find((entry) => entry.strategyId === route)?.strategy ??
                    version.strategies.find((entry) => entry.id === route);
                  const changes = before && after ? strategyChanges(before, after) : [];
                  return (
                    <section key={route}>
                      <h4>路线 {route}</h4>
                      {!after ? (
                        <p>本版还没有这条路线的结果。</p>
                      ) : !before ? (
                        <p>本版新增记录：{after.title}</p>
                      ) : !changes.length ? (
                        <p>已记录的路线内容没有变化。</p>
                      ) : (
                        changes.map((change) => (
                          <div key={change.label}>
                            <strong>{change.label}</strong>
                            <div className="version-pair">
                              <p>
                                <small>上一版</small>
                                {change.before}
                              </p>
                              <p>
                                <small>本版</small>
                                {change.after}
                              </p>
                            </div>
                          </div>
                        ))
                      )}
                    </section>
                  );
                })}
              </div>
            </Modal>
          )}
        </>
      )}
    </section>
  );
}
