import type {
  PlanningAnswerInput,
  PlanningEvent,
  PlanningQuestion,
  PlanningSnapshot,
} from "@/lib/planning-contracts";

export function acceptPlanningSnapshot(
  incoming: PlanningSnapshot,
  current: PlanningSnapshot | null,
) {
  return (
    !current ||
    (incoming.session.id === current.session.id &&
      incoming.snapshotVersion >= current.snapshotVersion)
  );
}

export function newPlanningEvents(snapshot: PlanningSnapshot, cursor: number): PlanningEvent[] {
  return snapshot.events.filter((event) => event.seq > cursor).sort((a, b) => a.seq - b.seq);
}

export function activePlanningQuestion(snapshot: PlanningSnapshot, event: PlanningEvent) {
  return snapshot.session.questions.find(
    (question) =>
      question.status === "active" &&
      question.id === event.questionId &&
      question.version === event.questionVersion,
  );
}

export function emptyPlanningAnswer(question: PlanningQuestion): PlanningAnswerInput {
  return {
    questionId: question.id,
    questionVersion: question.version,
    state: "answered",
    optionIds: [],
    text: "",
    number: null,
  };
}

export function planningAnswerError(
  question: PlanningQuestion,
  answer: PlanningAnswerInput,
): string | null {
  if (answer.questionId !== question.id || answer.questionVersion !== question.version)
    return "问题已更新，请查看最新内容。";
  if (answer.state === "unknown")
    return question.allowUnknown ? null : "这项决定需要一个明确回答。";
  if (answer.state === "skipped") return question.allowSkip ? null : "这项决定目前不能跳过。";
  if (answer.optionIds.some((id) => !question.options.some((option) => option.id === id)))
    return "选项已变化，请重新查看。";
  if (question.type === "number")
    return answer.number !== null && Number.isFinite(answer.number) ? null : "请填写一个有效数字。";
  if (question.type === "text") return answer.text.trim() ? null : "请填写回答。";
  if (question.type === "single" && answer.optionIds.length > 1) return "这项决定只选择一个方向。";
  // A user's own proposal is a real answer, even when none of the proposed options fits.
  if (answer.text.trim() && !answer.optionIds.length) return null;
  const minimum = question.minSelections ?? 1;
  const maximum = question.type === "single" ? 1 : question.maxSelections;
  if (answer.optionIds.length < minimum) return `请选择至少 ${minimum} 项，或写下你自己的想法。`;
  if (maximum !== null && answer.optionIds.length > maximum) return `最多选择 ${maximum} 项。`;
  return null;
}

export function answerText(question: PlanningQuestion, answer: PlanningAnswerInput) {
  if (answer.state === "unknown") return "暂时不知道";
  if (answer.state === "skipped") return "暂时跳过";
  return [
    ...answer.optionIds
      .map((id) => question.options.find((option) => option.id === id)?.label)
      .filter(Boolean),
    answer.number !== null ? `${answer.number}${question.unit ? ` ${question.unit}` : ""}` : "",
    answer.text,
  ]
    .filter(Boolean)
    .join("；");
}
