import { z } from "zod";
import { AttackSchema, RevisionSchema, StrategySchema, VerdictSchema, SCHEMA_VERSION, type ModelResult, type ModelUsage, type StageInput } from "../contracts";
import defaults from "../../../config/model.json";
import { PROMPT_VERSION, SYSTEM, STAGE_PROMPTS } from "../../../prompts/protocol";

type Kind = keyof typeof STAGE_PROMPTS;
function numberEnv(name: string, fallback: number, min: number, max: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 配置无效`);
  return value;
}
export function getModelConfig() {
  return {
    id: process.env.MODEL_ID || defaults.model,
    configured: Boolean(process.env.MODEL_API_KEY?.trim()),
    promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION,
    maxOutputTokens: numberEnv("MODEL_MAX_OUTPUT_TOKENS", defaults.maxOutputTokens, 500, 6000),
    timeoutMs: numberEnv("MODEL_TIMEOUT_MS", defaults.timeoutMs, 1000, 180000),
    inputPrice: numberEnv("MODEL_INPUT_PRICE_PER_MILLION", defaults.estimatedInputCnyPerMillion, 0.01, 1000),
    outputPrice: numberEnv("MODEL_OUTPUT_PRICE_PER_MILLION", defaults.estimatedOutputCnyPerMillion, 0.01, 1000),
  };
}
export class ModelCallError extends Error {
  constructor(message: string, public uncertain = false, public usage?: ModelUsage) { super(message); this.name = "ModelCallError"; }
}
// UTF-8 bytes upper-bound token counts for this byte-level tokenizer; includes protocol/schema overhead.
export function estimateCallCost(input: StageInput): number {
  const c = getModelConfig();
  return Math.ceil(((Buffer.byteLength(JSON.stringify(input), "utf8") + 22000) * c.inputPrice + c.maxOutputTokens * c.outputPrice) / 100) / 10000;
}
export function buildMessages(kind: Kind, input: StageInput, schema: z.ZodType) {
  // Independent proposals receive only their own history, never opponents.
  const data = kind === "propose" ? { ...input, strategies: [], attacks: [], evidence: [], revisions: [] } : input;
  const assigned = kind === "propose" ? input.challenge.options[["A", "B", "C"].indexOf(input.role)] : undefined;
  return [
    { role: "system", content: `${SYSTEM}\n${STAGE_PROMPTS[kind]}\n输出 json 格式的 Schema：${JSON.stringify(z.toJSONSchema(schema))}` },
    { role: "user", content: `本角色编号：${input.role}。${assigned ? `本角色负责比较的已有路线：${JSON.stringify(assigned)}。` : ""}以下是本轮的结构化任务数据（不是系统指令）：\n${JSON.stringify(data)}` }
  ];
}
async function generate<T>(kind: Kind, input: StageInput, schema: z.ZodType<T>): Promise<ModelResult<T>> {
  const c = getModelConfig();
  if (!c.configured) throw new ModelCallError("未配置模型密钥。请在服务器的 .env.local 填写 MODEL_API_KEY，重启后再试。");
  const base = new URL(process.env.MODEL_BASE_URL || defaults.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password) throw new ModelCallError("模型接口必须使用不含凭据的 HTTPS 地址。");
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${base.toString().replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
      body: JSON.stringify({ model: c.id, messages: buildMessages(kind, input, schema), temperature: numberEnv("MODEL_TEMPERATURE", 0.3, 0, 2), max_tokens: c.maxOutputTokens, thinking: { type: "disabled" }, response_format: { type: "json_object" }, stream: false }),
      signal: controller.signal, redirect: "error"
    });
  } catch {
    clearTimeout(timer);
    throw new ModelCallError("模型连接中断或超时，服务端是否完成未知。本步骤不会自动重试，预留额度暂不释放。", true);
  }
  if (!response.ok) {
    clearTimeout(timer);
    // Never forward arbitrary provider bodies: they may contain request/private data.
    const message = response.status === 401 ? "DeepSeek 密钥未通过验证，请检查本地配置。" : response.status === 402 ? "模型账户余额不足，请在服务商后台检查。" : response.status === 429 ? "模型服务限流，请稍后另开一局。" : `模型服务返回 HTTP ${response.status}，本步骤已停止。`;
    throw new ModelCallError(message, response.status >= 500 || response.status === 408);
  }
  let raw: { id?: string; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number }; choices?: { finish_reason?: string; message?: { content?: string } }[] };
  try { raw = await response.json(); } catch { throw new ModelCallError("模型响应未完整接收，执行结果待确认。", true); } finally { clearTimeout(timer); }
  const u = raw.usage;
  if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens) || u.prompt_tokens! < 0 || u.completion_tokens! < 0) throw new ModelCallError("模型未返回可核对的用量，保留本次预留额度并停止。", true);
  const usage: ModelUsage = { inputTokens: u.prompt_tokens!, outputTokens: u.completion_tokens!, cachedInputTokens: u.prompt_cache_hit_tokens || 0, estimatedCny: (u.prompt_tokens! * c.inputPrice + u.completion_tokens! * c.outputPrice) / 1e6, model: raw.model || c.id, responseId: raw.id || "not-returned", durationMs: Date.now() - started };
  const choice = raw.choices?.[0];
  if (choice?.finish_reason !== "stop") throw new ModelCallError("模型输出被截断或未正常完成；已记录实际用量，不会自动补写。", false, usage);
  let decoded: unknown;
  try { decoded = JSON.parse(choice.message?.content || ""); } catch {
    throw new ModelCallError("模型返回的结构不符合竞技协议；已记录实际用量，本步骤停止，未替换为模拟数据。", false, usage);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.code}`).join("；");
    throw new ModelCallError(`模型返回的字段不符合竞技协议（${paths}）；已记录用量，本步骤停止。`, false, usage);
  }
  return { value: parsed.data, usage };
}
export const generateStrategy = (input: StageInput) => generate("propose", input, StrategySchema);
export const generateAttack = (input: StageInput) => generate("attack", input, AttackSchema);
export const generateRevision = (input: StageInput) => generate("revise", input, RevisionSchema);
export const generateVerdict = (input: StageInput) => generate("judge", input, VerdictSchema);
