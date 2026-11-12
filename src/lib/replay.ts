import type { ArenaEvent, ArenaVersion } from "./contracts";
import type { IntakeQuestion, RecordedAnswer } from "./intake-contracts";
import type { ReplayAction, ReplayProjection, ReplayStep } from "./replay-contracts";

export const REPLAY_ACTION_TITLES: Record<ReplayAction["kind"], string> = {
  questions: "展示本轮问题",
  answer: "填写已保存的回答",
  round_confirm: "确认本轮回答",
  summary_submit: "提交需求摘要并查漏",
  summary_confirm: "需求摘要已确认",
  handoff: "生成需求说明与执行提示词",
};

function questionKey(question: IntakeQuestion) {
  return JSON.stringify([
    question.id,
    question.title,
    question.type,
    question.options,
    question.unit,
    question.authorization ?? "",
  ]);
}

function completedHandoff(version: ArenaVersion) {
  const lastRun = version.clarification?.runs.at(-1);
  const summary = version.intake?.confirmation?.summary;
  return (
    version.status === "completed" &&
    version.clarification?.next === "completed" &&
    !version.clarification.draftOnly &&
    version.clarification.review?.ready === true &&
    lastRun?.role === "C" &&
    lastRun.status === "completed" &&
    "gaps" in lastRun.output &&
    lastRun.output.ready &&
    !lastRun.output.gaps.length &&
    !lastRun.output.conflicts.length &&
    version.clarification.review.basedOnRevision === lastRun.basedOnRevision &&
    !!summary &&
    (Object.keys(version.challenge) as (keyof ArenaVersion["challenge"])[]).every(
      (field) =>
        JSON.stringify(summary.challenge[field]) === JSON.stringify(version.challenge[field]),
    ) &&
    !version.intake?.confirmation?.pendingSummaryFields?.length
  );
}

function requestedDraftHandoff(version: ArenaVersion) {
  const state = version.clarification;
  const lastRun = state?.runs.at(-1);
  return (
    version.status === "paused" &&
    !version.waitingForIntake &&
    state?.requestedDraft === true &&
    state.draftOnly &&
    state.next === "completed" &&
    !!state.specification.trim() &&
    !!state.executionPrompt.trim() &&
    lastRun?.role === "C" &&
    lastRun.status === "completed"
  );
}

/** Rebuild only saved states when an older recording has no API-action provenance. */
function snapshotActions(version: ArenaVersion): ReplayAction[] {
  const state = version.clarification;
  if (!state) return [];
  const actions: ReplayAction[] = [];
  for (const [index, round] of state.rounds.entries()) {
    if (!round.questions.length) continue;
    const shown = new Set(round.questions.map(questionKey));
    const run = state.runs.findLast(
      (entry) =>
        round.runIds.includes(entry.id) &&
        entry.role === "B" &&
        entry.status === "completed" &&
        "questions" in entry.output &&
        entry.output.questions.some((question) => shown.has(questionKey(question))),
    );
    if (!run) continue;
    const base = {
      round: round.round,
      revision: round.revision,
      versionId: version.id,
      sourceRunId: run.id,
      questions: round.questions,
      source: {
        kind: "snapshot" as const,
        reference: `/versions/${version.id}/clarification/rounds/${index}`,
      },
    };
    actions.push({
      ...base,
      id: `snapshot:${run.id}:questions`,
      kind: "questions",
      createdAt: round.createdAt,
    });
    const following = state.rounds[index + 1];
    if (!following) continue;
    const answers = following.answers.filter((answer) => shown.has(questionKey(answer.question)));
    for (const answer of answers)
      actions.push({
        ...base,
        id: `snapshot:${run.id}:answer:${answer.questionId}`,
        kind: "answer",
        revision: following.revision,
        answers: [answer],
        createdAt: answer.confirmedAt,
      });
    // A saved value alone cannot prove that a confirmation action happened.
    if (
      answers.some((answer) => answer.confirmation === "confirmed" && !answer.needsReconfirmation)
    )
      actions.push({
        ...base,
        id: `snapshot:${run.id}:round-confirm`,
        kind: "round_confirm",
        revision: following.revision,
        answers,
        createdAt: answers.find((answer) => answer.confirmedAt)?.confirmedAt,
      });
  }
  const summary = version.intake?.confirmation?.summary;
  const lastRun = state.runs.at(-1);
  if (completedHandoff(version) && summary && lastRun) {
    const base = {
      round: lastRun.round,
      revision: summary.revision,
      versionId: version.id,
      sourceRunId: lastRun.id,
      createdAt: summary.confirmedAt,
      source: {
        kind: "snapshot" as const,
        reference: `/versions/${version.id}/intake/confirmation/summary`,
      },
    };
    actions.push(
      {
        ...base,
        id: `snapshot:${version.id}:summary-confirm`,
        kind: "summary_confirm",
        answers: version.intake?.answers,
        summary: { challenge: summary.challenge, assumptions: version.intake?.assumptions ?? [] },
      },
      { ...base, id: `snapshot:${version.id}:handoff`, kind: "handoff" },
    );
  } else if (requestedDraftHandoff(version) && lastRun) {
    actions.push({
      id: `snapshot:${version.id}:draft-handoff`,
      kind: "handoff",
      round: lastRun.round,
      revision: lastRun.basedOnRevision,
      versionId: version.id,
      sourceRunId: lastRun.id,
      source: {
        kind: "snapshot",
        reference: `/versions/${version.id}/clarification/requestedDraft`,
      },
    });
  }
  return actions;
}

const ACTION_ORDER: Record<ReplayAction["kind"], number> = {
  questions: 0,
  answer: 1,
  round_confirm: 2,
  summary_submit: 3,
  summary_confirm: 4,
  handoff: 5,
};

/** Preserve actual role-call order. Action anchors place accepted inputs between those calls. */
export function buildClarificationReplay(
  version: ArenaVersion,
  recordedActions?: readonly ReplayAction[],
): ReplayStep[] {
  if (version.workflow !== "clarification" || !version.clarification) return [];
  const runs = version.clarification.runs;
  const currentActions = recordedActions?.filter(
    (action) => !action.versionId || action.versionId === version.id,
  );
  const actions = currentActions?.length ? currentActions : snapshotActions(version);
  const before = new Map<string, ReplayAction[]>();
  const after = new Map<string, ReplayAction[]>();
  for (const action of actions) {
    if (action.versionId && action.versionId !== version.id) continue;
    const anchor = action.sourceRunId
      ? runs.find((run) => run.id === action.sourceRunId)
      : action.kind === "summary_submit"
        ? runs.find((run) => run.round === action.round)
        : action.kind === "summary_confirm" || action.kind === "handoff"
          ? runs.findLast((run) => run.round === action.round)
          : runs.findLast((run) => run.round === action.round && run.role === "B");
    if (!anchor) continue;
    const collection = action.kind === "summary_submit" ? before : after;
    const group = collection.get(anchor.id) ?? [];
    group.push(action);
    collection.set(anchor.id, group);
  }
  const steps: ReplayStep[] = [];
  const append = (actions: ReplayAction[] = []) => {
    for (const action of [...actions].sort(
      (left, right) => ACTION_ORDER[left.kind] - ACTION_ORDER[right.kind],
    ))
      steps.push({ id: `replay:${action.id}`, replayAction: action });
  };
  for (const run of runs) {
    append(before.get(run.id));
    steps.push({ id: `clarification:${run.id}`, clarificationRun: run });
    append(after.get(run.id));
  }
  return steps;
}

/** Selection and typing are visible before confirmation, without inheriting an older confirmation. */
export function pendingReplayAnswer(answer: RecordedAnswer): RecordedAnswer {
  const copy = structuredClone(answer);
  copy.confirmation = "pending";
  delete copy.confirmedAt;
  delete copy.confirmedRevision;
  return copy;
}

function sameValue(left: RecordedAnswer, right: RecordedAnswer) {
  return (
    left.state === right.state &&
    JSON.stringify(left.value) === JSON.stringify(right.value) &&
    questionKey(left.question) === questionKey(right.question)
  );
}

function confirmedAnswer(answer: RecordedAnswer) {
  const value = Array.isArray(answer.value) ? answer.value.join("、") : answer.value;
  return (
    answer.state === "answered" &&
    answer.confirmation === "confirmed" &&
    !answer.needsReconfirmation &&
    !!value.trim()
  );
}

function eventRecord(event: ArenaEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object"
    ? (event.data as Record<string, unknown>)
    : {};
}

/** All displayed facts come from the visible prefix. Interaction confirmation commits near its end. */
export function projectReplay(
  version: ArenaVersion,
  steps: readonly ReplayStep[],
  index: number,
  events: readonly ArenaEvent[] = [],
  progress = 1,
): ReplayProjection {
  const projection: ReplayProjection = {
    answers: [],
    items: [],
    retiredIds: [],
    conflicts: [],
    unresolved: [],
    calls: 0,
    tokens: 0,
    usage: [],
    logs: [],
    summaryConfirmed: false,
    handoffComplete: false,
  };
  const answers = new Map<string, RecordedAnswer>();
  const items = new Map<string, ReplayProjection["items"][number]>();
  const retired = new Set<string>();
  const calls = new Set<string>();
  const runIds = new Set<string>();
  const pending = new Map<string, { title: string; question?: IntakeQuestion }>();
  const reviewGapIds = new Set<string>();
  const shown = steps.slice(0, Math.max(0, index + 1));
  let untrackedCalls = 0;
  const setAnswer = (answer: RecordedAnswer) => {
    const prior = answers.get(answer.questionId);
    if (prior && !sameValue(prior, answer)) {
      const affected = new Set([answer.questionId]);
      for (const changedId of affected) {
        for (const candidate of answers.values()) {
          if (
            !affected.has(candidate.questionId) &&
            candidate.question.dependsOn?.includes(changedId)
          ) {
            affected.add(candidate.questionId);
            answers.set(candidate.questionId, {
              ...pendingReplayAnswer(candidate),
              needsReconfirmation: true,
            });
            pending.set(candidate.question.decisionId ?? candidate.questionId, {
              title: candidate.question.title,
              question: candidate.question,
            });
          }
        }
      }
    }
    answers.set(answer.questionId, structuredClone(answer));
  };
  const acceptAnswers = (recorded: readonly RecordedAnswer[]) => {
    for (const answer of recorded) setAnswer(answer);
    for (const answer of recorded) {
      // The accepted batch is authoritative even when dependency order differs from question order.
      answers.set(answer.questionId, structuredClone(answer));
      const id = answer.question.decisionId ?? answer.questionId;
      const current = pending.get(id);
      if (
        confirmedAnswer(answer) &&
        (!current?.question || questionKey(current.question) === questionKey(answer.question))
      )
        pending.delete(id);
    }
  };
  for (const [position, step] of shown.entries()) {
    const run = step.clarificationRun;
    if (run && !runIds.has(run.id)) {
      runIds.add(run.id);
      if (run.callIds) run.callIds.forEach((id) => calls.add(id));
      else untrackedCalls++;
      projection.usage.push(...run.usage);
      const output = run.output;
      if ("items" in output) {
        for (const item of output.items) {
          items.set(item.id, item);
          retired.delete(item.id);
        }
        for (const item of output.retired) {
          retired.add(item.id);
          pending.delete(item.id);
          reviewGapIds.delete(item.id);
        }
      }
      if ("questions" in output)
        projection.conflicts = output.conflicts.map((entry) => entry.description);
      if ("gaps" in output) {
        const currentGaps = new Set(output.gaps.map((item) => item.id));
        for (const id of reviewGapIds) {
          const reviewed =
            output.ready || output.coverage.some((entry) => entry.decisionIds.includes(id));
          if (!currentGaps.has(id) && reviewed) {
            pending.delete(id);
            reviewGapIds.delete(id);
          }
        }
        for (const item of output.gaps) {
          items.set(item.id, item);
          pending.set(item.id, { title: item.title });
          reviewGapIds.add(item.id);
        }
        projection.conflicts = [...new Set([...projection.conflicts, ...output.conflicts])];
      }
    }
    const action = step.replayAction;
    if (!action) continue;
    const committed = position < shown.length - 1 || progress >= 0.8;
    if (action.kind === "questions")
      for (const question of action.questions ?? [])
        pending.set(question.decisionId ?? question.id, { title: question.title, question });
    if (action.kind === "answer") {
      projection.summaryConfirmed = false;
      projection.handoffComplete = false;
      for (const answer of action.answers ?? []) {
        setAnswer(pendingReplayAnswer(answer));
        pending.set(answer.question.decisionId ?? answer.questionId, {
          title: answer.question.title,
          question: answer.question,
        });
      }
    }
    if (action.kind === "round_confirm" && committed) acceptAnswers(action.answers ?? []);
    if (action.kind === "summary_submit") {
      projection.summaryConfirmed = false;
      projection.summary = action.summary ? structuredClone(action.summary) : undefined;
    }
    if (
      action.kind === "summary_confirm" &&
      committed &&
      version.intake?.confirmation?.summary &&
      !version.clarification?.draftOnly
    ) {
      acceptAnswers(action.answers ?? []);
      projection.summary = action.summary ? structuredClone(action.summary) : undefined;
      projection.summaryConfirmed = true;
    }
    if (action.kind === "handoff" && committed)
      projection.handoffComplete =
        (projection.summaryConfirmed && !pending.size && completedHandoff(version)) ||
        requestedDraftHandoff(version);
  }
  projection.answers = [...answers.values()];
  projection.items = [...items.values()];
  projection.retiredIds = [...retired];
  projection.unresolved = [...new Set([...pending.values()].map((item) => item.title))];
  projection.calls = calls.size + untrackedCalls;
  projection.tokens = projection.usage.reduce(
    (sum, usage) => sum + usage.inputTokens + usage.outputTokens,
    0,
  );
  projection.logs = events.filter((event) => {
    if (event.versionId !== version.id) return false;
    const data = eventRecord(event);
    const linkedIds = [
      data.id,
      data.runId,
      data.callId,
      ...(Array.isArray(data.callIds) ? data.callIds : []),
    ];
    return (
      linkedIds.some((id) => typeof id === "string" && (runIds.has(id) || calls.has(id))) ||
      projection.handoffComplete
    );
  });
  return projection;
}
