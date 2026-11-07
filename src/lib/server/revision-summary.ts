import type { Revision } from "../contracts";

type ResponseDecision = Pick<Revision["responses"][number], "attackId" | "decision">;

/** Replace a model's summary only when response normalization changes its stated outcome. */
export function normalizedRevisionSummary(
  summary: string,
  originalResponses: readonly ResponseDecision[],
  responses: readonly ResponseDecision[],
  changed: boolean,
): string {
  const original = new Map(
    originalResponses.map((response) => [response.attackId, response.decision]),
  );
  if (!responses.some((response) => original.get(response.attackId) !== response.decision))
    return summary;

  const counts = { accept: 0, reject: 0, unresolved: 0 };
  for (const response of responses) counts[response.decision]++;
  const action = changed ? "行动、资源或成立条件有变化。" : "未检测到行动、资源或成立条件变化。";
  return `校验后：接受${counts.accept}项质疑，拒绝${counts.reject}项，未解决${counts.unresolved}项。${action}未解决的质疑不算已解决或已证实。`;
}
