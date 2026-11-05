import type { Challenge, ModelMode, ModelProvider } from "./contracts";

export const ROUTING_POLICY_VERSION = "cost-first-1.0.0";
export const ROUTING_MATERIAL_LENGTH = 6000;
export const ROUTING_CONSTRAINT_COUNT = 4;

/** A transparent input rule, not a prediction of model quality or task difficulty. */
export function routeModel(
  challenge: Challenge,
  mode: ModelMode,
): {
  provider: ModelProvider;
  policyVersion: string;
  reason: string;
} {
  const result = (provider: ModelProvider, reason: string) => ({
    provider,
    policyVersion: ROUTING_POLICY_VERSION,
    reason,
  });
  if (mode !== "auto")
    return result(
      mode === "gpt" ? "openai" : "deepseek",
      `你手动选择了 ${mode === "gpt" ? "GPT" : "DeepSeek"}。`,
    );
  const length = Array.from(challenge.materials.trim()).length;
  const count =
    challenge.constraints.split(/[\n；;]+/).filter((s) => s.trim()).length +
    Number(challenge.budget !== null) +
    Number(challenge.timeHours !== null);
  const reasons = [];
  if (length >= ROUTING_MATERIAL_LENGTH)
    reasons.push(`材料有 ${length} 字符，达到 ${ROUTING_MATERIAL_LENGTH} 字符`);
  if (count >= ROUTING_CONSTRAINT_COUNT)
    reasons.push(
      `按换行或分号分隔，加上预算与时间，共 ${count} 项限制，达到 ${ROUTING_CONSTRAINT_COUNT} 项`,
    );
  if (reasons.length) return result("openai", `自动选择 GPT：${reasons.join("；")}。`);
  return result("deepseek", "自动选择 DeepSeek：材料少于 6000 字符且限制少于 4 项，优先控制费用。");
}
