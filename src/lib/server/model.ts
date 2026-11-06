import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AttackSchema,
  RevisionSchema,
  StrategySchema,
  VerdictSchema,
  SCHEMA_VERSION,
  type ModelResult,
  type ModelUsage,
  type ModelProvider,
  type Currency,
  type StageInput,
} from "../contracts";
import defaults from "../../../config/model.json";
import { BillingError, reserveBilling, settleBilling, holdBilling } from "./billing";
import { PROMPT_VERSION, SYSTEM, STAGE_PROMPTS } from "../../../prompts/protocol";
import {
  bindStrictReferences,
  jsonRepairFeedback,
  referenceInstructions,
  restoreStrictNulls,
  toStrictToolSchema,
} from "./strict-schema";

type Kind = keyof typeof STAGE_PROMPTS;
function numberEnv(name: string, fallback: number, min: number, max: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 配置无效`);
  return value;
}
export interface ModelConfig {
  configurationVersion: string;
  provider: ModelProvider;
  currency: Currency;
  reasoningEffort: "low" | null;
  baseUrl: string;
  temperature: number;
  structuredOutput: "json" | "strict-tool";
  id: string;
  configured: boolean;
  promptVersion: string;
  schemaVersion: string;
  maxOutputTokens: number;
  timeoutMs: number;
  inputPrice: number;
  outputPrice: number;
}
function officialEndpoint(provider: ModelProvider, value: string) {
  const endpoint = new URL(value);
  const expected = provider === "openai" ? "https://api.openai.com" : "https://api.deepseek.com";
  const paths = provider === "openai" ? ["/v1"] : ["", "/v1", "/beta"];
  if (
    endpoint.origin !== expected ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !paths.includes(endpoint.pathname.replace(/\/$/, ""))
  )
    throw new Error("模型密钥只能发送到对应服务商的官方 HTTPS 接口");
  return endpoint.toString().replace(/\/$/, "");
}
function apiKey(provider: ModelProvider) {
  return (
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.DEEPSEEK_API_KEY?.trim() || process.env.MODEL_API_KEY
  )?.trim();
}
export function getModelConfig(provider: ModelProvider = "deepseek"): ModelConfig {
  if (provider !== "deepseek" && provider !== "openai") throw new Error("未知模型服务商");
  const openai = provider === "openai";
  const structuredOutput =
    (openai ? process.env.OPENAI_STRUCTURED_OUTPUT : process.env.MODEL_STRUCTURED_OUTPUT) ||
    (openai ? "strict-tool" : defaults.structuredOutput);
  if (structuredOutput !== "json" && structuredOutput !== "strict-tool")
    throw new Error(`${openai ? "OPENAI" : "MODEL"}_STRUCTURED_OUTPUT 配置无效`);
  const id = openai
    ? process.env.OPENAI_MODEL_ID || "gpt-6.1-terra"
    : process.env.MODEL_ID || defaults.model;
  if (openai && id !== "gpt-6.1-terra")
    throw new Error("OPENAI_MODEL_ID 未配置对应价格；当前只支持 gpt-6.1-terra");
  if (
    openai &&
    process.env.OPENAI_REASONING_EFFORT &&
    process.env.OPENAI_REASONING_EFFORT !== "low"
  )
    throw new Error("OPENAI_REASONING_EFFORT 仅支持 low");
  const prefix = openai ? "OPENAI" : "MODEL";
  return {
    configurationVersion: openai ? "openai-1.1.0" : defaults.configVersion,
    provider,
    currency: openai ? "USD" : "CNY",
    reasoningEffort: openai ? "low" : null,
    baseUrl: officialEndpoint(
      provider,
      openai
        ? process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
        : process.env.MODEL_BASE_URL || defaults.baseUrl,
    ),
    temperature: openai ? 0 : numberEnv("MODEL_TEMPERATURE", defaults.temperature, 0, 2),
    structuredOutput,
    id,
    configured: Boolean(apiKey(provider)),
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    maxOutputTokens: numberEnv(`${prefix}_MAX_OUTPUT_TOKENS`, defaults.maxOutputTokens, 500, 6000),
    timeoutMs: numberEnv(`${prefix}_TIMEOUT_MS`, defaults.timeoutMs, 1000, 180000),
    // Native-currency uncached rates; cached input is counted without assuming an unverified discount.
    inputPrice: numberEnv(
      `${prefix}_INPUT_PRICE_PER_MILLION`,
      openai ? 1 : defaults.estimatedInputCnyPerMillion,
      openai ? 1 : 0.01,
      1000,
    ),
    outputPrice: numberEnv(
      `${prefix}_OUTPUT_PRICE_PER_MILLION`,
      openai ? 5 : defaults.estimatedOutputCnyPerMillion,
      openai ? 5 : 0.01,
      1000,
    ),
  };
}
export class ModelCallError extends Error {
  constructor(
    message: string,
    public uncertain = false,
    public usage?: ModelUsage,
    public repair?: { feedback: string; rejectedOutput: string },
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}
const stageSchemas = {
  propose: StrategySchema,
  attack: AttackSchema,
  revise: RevisionSchema,
  judge: VerdictSchema,
};
function maxInputTokens(input: StageInput, config: ModelConfig) {
  return (
    Math.max(
      ...(Object.keys(stageSchemas) as Kind[]).map((kind) =>
        Buffer.byteLength(
          JSON.stringify(buildRequestBody(kind, input, stageSchemas[kind], config)),
          "utf8",
        ),
      ),
    ) + 1024
  );
}
/** UTF-8 byte upper bound over every possible next-stage request plus conservative framing/output. */
export function estimateCallTokens(
  input: StageInput,
  config: ModelConfig = getModelConfig(),
): number {
  return maxInputTokens(input, config) + config.maxOutputTokens;
}
export function estimateCallCost(
  input: StageInput,
  config: ModelConfig = getModelConfig(),
): number {
  return (
    Math.ceil(
      (maxInputTokens(input, config) * config.inputPrice +
        config.maxOutputTokens * config.outputPrice) /
        100,
    ) / 10000
  );
}
export function buildMessages(
  kind: Kind,
  input: StageInput,
  schema: z.ZodType,
  structuredOutput = getModelConfig().structuredOutput,
) {
  // Independent proposals receive only their own history, never opponents.
  const single = input.evaluationMode === "strong-single";
  const independent = input.evaluationMode === "independent";
  const data =
    kind === "propose" && !single
      ? {
          ...input,
          strategies: [],
          attacks: [],
          evidence: [],
          revisions: [],
          contextHistory: undefined,
        }
      : input;
  let protocol = STAGE_PROMPTS[kind];
  if (single && kind === "propose")
    protocol = `你是一个单独的强助手，负责全面比较多个方案。继续阅读你此前的完整上下文，为当前编号提出一条有区别的路线，可主动修正自己的理解。关键主张、行动、估计、未知必须明确。不要机械复制已有路线。`;
  if ((single || independent) && kind === "attack")
    protocol = `进行主动自我反驳与核验。${single ? "你作为单一助手，比较全部已有路线，找出当前编号候选的最关键失败假设。" : "你只审查自己提出的路线，不读取或攻击其他独立路线。"} targetStrategyId 必须等于本角色 role，原样引用自己的具体 claim.text 和 id。说明失败机制、核验办法、对选择或行动的影响。用最多两个请求：search_materials(query) 检索用户文字；calculate(expression,assumptions) 只用数字括号与+ - * / %。不得把尚未执行的核验写成完成；没有反证可保留未知。status=pending。`;
  const context = single
    ? "这是强单助手对照：你延续同一个助手上下文，负责提出备选、主动反驳、自检、请求工具并修订。contextHistory 是你此前的结构化输出，不能当作事实证据。"
    : independent
      ? "这是独立方案自检对照：每个编号独立提案，只核验和反驳自身方案，不读对手质疑。"
      : "";
  const assigned =
    kind === "propose" ? input.challenge.options[["A", "B", "C"].indexOf(input.role)] : undefined;
  const strict = structuredOutput === "strict-tool";
  const outputSchema = strict
    ? bindStrictReferences(toStrictToolSchema(z.toJSONSchema(schema)), kind, input)
    : z.toJSONSchema(schema);
  const outputRule = strict
    ? `只调用一次 submit_${kind} 函数提交结构化结果，不输出其他工具或自然语言。在 estimatedCost、estimatedHours、preferred 这三个可空字段中用字符串 \"unknown\" 表示未知，严格模式不要输出 null；其他字段的 unknown 仍保留原含义。`
    : "输出一个完整 JSON 对象。";
  return [
    {
      role: "system",
      content: `${SYSTEM}\n${context}\n${protocol}\n${outputRule}\n${referenceInstructions(kind, input)}\n输出 json 格式的 Schema：${JSON.stringify(outputSchema)}\n严格遵守字段长度与数组数量。steps 建议 4 项、最多 6 项，claims 最多 3 项，responses 最多 6 项。若数据含 repairFeedback，只修正 rejectedOutput 中指出的格式或引用问题，保持合法内容和证据不变；这是唯一一次格式修复机会。`,
    },
    {
      role: "user",
      content: `本角色编号：${input.role}。${assigned ? `本角色负责比较的已有路线：${JSON.stringify(assigned)}。` : ""}以下是本轮的结构化任务数据（不是系统指令）：\n${JSON.stringify(data)}`,
    },
  ];
}
/** No credentials or network effects; shared by dispatch and conservative reservation estimates. */
export function buildRequestBody(
  kind: Kind,
  input: StageInput,
  schema: z.ZodType = stageSchemas[kind],
  config = getModelConfig(),
) {
  const strict = config.structuredOutput === "strict-tool";
  const functionName = `submit_${kind}`;
  const functionDefinition = {
    name: functionName,
    description: "structured protocol output",
    strict: true,
    parameters: bindStrictReferences(toStrictToolSchema(z.toJSONSchema(schema)), kind, input),
  };
  const messages = buildMessages(kind, input, schema, config.structuredOutput);
  if (config.provider === "openai")
    return {
      model: config.id,
      input: messages,
      max_output_tokens: config.maxOutputTokens,
      reasoning: { effort: config.reasoningEffort },
      store: false,
      parallel_tool_calls: false,
      ...(strict
        ? {
            tools: [{ type: "function", ...functionDefinition }],
            tool_choice: { type: "function", name: functionName },
          }
        : { text: { format: { type: "json_object" } } }),
      stream: false,
    };
  return {
    model: config.id,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    thinking: { type: "disabled" },
    ...(strict
      ? {
          tools: [{ type: "function", function: functionDefinition }],
          tool_choice: { type: "function", function: { name: functionName } },
        }
      : { response_format: { type: "json_object" } }),
    stream: false,
  };
}
async function generate<T>(
  kind: Kind,
  input: StageInput,
  schema: z.ZodType<T>,
  c: ModelConfig = getModelConfig(),
  attemptId: string = randomUUID(),
): Promise<ModelResult<T>> {
  if (!c.configured)
    throw new ModelCallError(
      `未配置 ${c.provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY（兼容 MODEL_API_KEY）"} 模型密钥，请检查服务器配置。`,
    );
  if (!apiKey(c.provider)) throw new ModelCallError("未配置对应服务商的模型密钥。");
  const base = new URL(officialEndpoint(c.provider, c.baseUrl));
  if (
    c.provider === "openai" &&
    (c.id !== "gpt-6.1-terra" ||
      c.currency !== "USD" ||
      c.reasoningEffort !== "low" ||
      c.inputPrice < 1 ||
      c.outputPrice < 5)
  )
    throw new ModelCallError("GPT 模型、推理强度或原币价格配置无效。");
  if (c.provider === "deepseek" && c.currency !== "CNY")
    throw new ModelCallError("DeepSeek 费用币种配置无效。");
  const strict = c.structuredOutput === "strict-tool";
  if (
    strict &&
    base.hostname === "api.deepseek.com" &&
    base.pathname.replace(/\/$/, "") !== "/beta"
  )
    throw new ModelCallError(
      "strict-tool 模式需要显式设置 MODEL_BASE_URL=https://api.deepseek.com/beta，不会自动切换接口。",
    );
  const functionName = `submit_${kind}`;
  const requestBody = buildRequestBody(kind, input, schema, c);
  // Every caller, including offline evaluators and smoke scripts, shares this reservation.
  try {
    reserveBilling({
      attemptId,
      provider: c.provider,
      currency: c.currency,
      estimatedAmount: Math.ceil(estimateCallCost(input, c) * 1e6),
      maxTokens: estimateCallTokens(input, c),
    });
  } catch (error) {
    const code = error instanceof BillingError ? error.code : "";
    const messages: Record<string, string> = {
      BILLING_LIMIT_REACHED: "共享模型额度已达到金额、请求次数或 Token 上限，本次请求未发送。",
      BILLING_INVALID_CONFIG:
        "共享计费配置缺失或无效，请检查服务器的共享账本路径和额度配置；本次请求未发送。",
      BILLING_SETTINGS_MISMATCH:
        "共享账本的固定额度与当前服务器配置不一致，请统一配置后再试；本次请求未发送。",
      BILLING_DUPLICATE_ATTEMPT:
        "本步骤已有模型请求记录，为避免重复收费，拒绝再次发送；原请求结果与预留额度需要核对。",
    };
    throw new ModelCallError(
      messages[code] || "共享计费账本暂时无法预留额度，本次请求未发送，请检查服务器计费状态。",
      code === "BILLING_DUPLICATE_ATTEMPT",
    );
  }
  const unknown = (message: string, usage?: ModelUsage) => {
    try {
      holdBilling(attemptId);
    } catch {
      /* A failed hold must never make a request retryable. */
    }
    return new ModelCallError(message, true, usage);
  };
  const settle = (
    amount: number,
    inputTokens = 0,
    outputTokens = 0,
    cachedInputTokens = 0,
    responseId?: string,
  ) => {
    try {
      settleBilling(attemptId, {
        amount,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        responseId,
      });
    } catch {
      throw unknown("本次模型费用未能确认入账，保留预留额度并停止。");
    }
  };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  let response: Response;
  try {
    response = await fetch(
      `${base.toString().replace(/\/$/, "")}/${c.provider === "openai" ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey(c.provider)}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        redirect: "error",
      },
    );
  } catch {
    clearTimeout(timer);
    throw unknown("模型连接中断或超时，服务端是否完成未知。本步骤不会自动重试，预留额度暂不释放。");
  }
  if (!response.ok) {
    clearTimeout(timer);
    // Never forward arbitrary provider bodies: they may contain request/private data.
    const message =
      response.status === 401
        ? `${c.provider === "openai" ? "OpenAI" : "DeepSeek"} 密钥未通过验证，请检查服务器配置。`
        : response.status === 402
          ? "模型账户余额不足，请在服务商后台检查。"
          : response.status === 429
            ? "模型服务限流，请稍后另开一局。"
            : `模型服务返回 HTTP ${response.status}，本步骤已停止。`;
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      settle(0);
      throw new ModelCallError(message);
    }
    throw unknown(message);
  }
  let raw: {
    id?: string;
    model?: string;
    status?: string;
    error?: unknown;
    output?: {
      type?: string;
      name?: string;
      arguments?: string;
      status?: string;
      content?: { type?: string; text?: string; refusal?: string }[];
    }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    choices?: {
      finish_reason?: string;
      message?: {
        content?: string;
        tool_calls?: { type?: string; function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };
  try {
    raw = await response.json();
  } catch {
    throw unknown("模型响应未完整接收，执行结果待确认。");
  } finally {
    clearTimeout(timer);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw unknown("模型返回的响应封装无效，无法确认用量，保留预留额度。");
  const u = raw.usage;
  const inputTokens = c.provider === "openai" ? u?.input_tokens : u?.prompt_tokens;
  const outputTokens = c.provider === "openai" ? u?.output_tokens : u?.completion_tokens;
  if (
    !u ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens! < 0 ||
    outputTokens! < 0
  )
    throw unknown("模型未返回可核对的用量，保留本次预留额度并停止。");
  const cachedInputTokens =
    (c.provider === "openai" ? u.input_tokens_details?.cached_tokens : u.prompt_cache_hit_tokens) ??
    0;
  if (
    !Number.isSafeInteger(cachedInputTokens) ||
    cachedInputTokens < 0 ||
    cachedInputTokens > inputTokens!
  )
    throw unknown("模型缓存用量无效，保留本次预留额度并停止。");
  if (c.provider === "openai" && ["queued", "in_progress"].includes(raw.status ?? ""))
    throw unknown("模型响应仍在处理中，最终用量未知，保留预留额度并停止。");
  // Both APIs' reported output total already includes reasoning; do not add it again.
  const amount = Math.ceil(inputTokens! * c.inputPrice + outputTokens! * c.outputPrice);
  const usage: ModelUsage = {
    inputTokens: inputTokens!,
    outputTokens: outputTokens!,
    cachedInputTokens,
    estimatedCny: c.currency === "CNY" ? amount / 1e6 : 0,
    ...(c.currency === "USD" ? { estimatedUsd: amount / 1e6 } : {}),
    currency: c.currency,
    provider: c.provider,
    billingAttemptId: attemptId,
    model: typeof raw.model === "string" ? raw.model : c.id,
    responseId: typeof raw.id === "string" ? raw.id : "not-returned",
    durationMs: Date.now() - started,
  };
  settle(amount, usage.inputTokens, usage.outputTokens, cachedInputTokens, usage.responseId);
  let output: string;
  if (c.provider === "openai") {
    if (raw.status !== "completed" || raw.error)
      throw new ModelCallError(
        "模型输出被截断、未完成或失败；已记录实际用量，不会自动补写。",
        false,
        usage,
      );
    if (!Array.isArray(raw.output))
      throw new ModelCallError("模型响应缺少结构化输出，已记录实际用量。", false, usage);
    if (
      raw.output.some(
        (item) =>
          item?.type === "message" &&
          Array.isArray(item.content) &&
          item.content.some((part) => part?.type === "refusal"),
      )
    )
      throw new ModelCallError(
        "模型拒绝了本次请求；已记录实际用量，不会自动重试或替换结果。",
        false,
        usage,
      );
    if (strict) {
      const calls = raw.output.filter((item) => item?.type === "function_call");
      if (
        calls.length !== 1 ||
        calls[0].name !== functionName ||
        typeof calls[0].arguments !== "string" ||
        (calls[0].status !== undefined && calls[0].status !== "completed") ||
        raw.output.some(
          (item) => !item || !["reasoning", "function_call"].includes(item.type ?? ""),
        )
      )
        throw new ModelCallError(
          "模型未返回唯一且匹配的结构化提交函数，已记录实际用量；不会切换输出模式。",
          false,
          usage,
        );
      output = calls[0].arguments;
    } else {
      const messages = raw.output.filter((item) => item?.type === "message");
      const content = messages[0]?.content;
      if (
        messages.length !== 1 ||
        !Array.isArray(content) ||
        content.length !== 1 ||
        content[0]?.type !== "output_text" ||
        typeof content[0].text !== "string" ||
        raw.output.some((item) => !item || !["reasoning", "message"].includes(item.type ?? ""))
      )
        throw new ModelCallError(
          "模型响应正文不是唯一文本，已记录实际用量，停止本步骤。",
          false,
          usage,
        );
      output = content[0].text;
    }
  } else {
    const choice = raw.choices?.[0];
    if (choice?.finish_reason !== (strict ? "tool_calls" : "stop"))
      throw new ModelCallError(
        "模型输出被截断或未正常完成；已记录实际用量，不会自动补写。",
        false,
        usage,
      );
    if (strict) {
      const calls = choice.message?.tool_calls;
      if (
        !Array.isArray(calls) ||
        calls.length !== 1 ||
        calls[0]?.type !== "function" ||
        calls[0]?.function?.name !== functionName ||
        typeof calls[0]?.function?.arguments !== "string"
      )
        throw new ModelCallError(
          "模型未返回唯一且匹配的结构化提交函数，已记录实际用量；不会切换输出模式。",
          false,
          usage,
        );
      output = calls[0].function.arguments;
    } else {
      if (typeof choice.message?.content !== "string")
        throw new ModelCallError(
          "模型响应正文不是文本，已记录实际用量，停止本步骤。",
          false,
          usage,
        );
      output = choice.message.content;
    }
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch (error) {
    throw new ModelCallError("模型没有返回有效 JSON；已记录实际用量。", false, usage, {
      feedback: jsonRepairFeedback(error, output),
      rejectedOutput: output.slice(0, 24000),
    });
  }
  const parsed = schema.safeParse(strict ? restoreStrictNulls(decoded) : decoded);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
      .join("；");
    throw new ModelCallError(
      `模型返回的字段不符合竞技协议（${paths}）；已记录用量。`,
      false,
      usage,
      { feedback: paths, rejectedOutput: output.slice(0, 24000) },
    );
  }
  return { value: parsed.data, usage };
}
export const generateStrategy = (
  input: StageInput,
  config: ModelConfig = getModelConfig(),
  attemptId?: string,
) => generate("propose", input, StrategySchema, config, attemptId);
export const generateAttack = (
  input: StageInput,
  config: ModelConfig = getModelConfig(),
  attemptId?: string,
) => generate("attack", input, AttackSchema, config, attemptId);
export const generateRevision = (
  input: StageInput,
  config: ModelConfig = getModelConfig(),
  attemptId?: string,
) => generate("revise", input, RevisionSchema, config, attemptId);
export const generateVerdict = (
  input: StageInput,
  config: ModelConfig = getModelConfig(),
  attemptId?: string,
) => generate("judge", input, VerdictSchema, config, attemptId);
// The legacy evaluator aggregates CNY only. Refuse USD until its aggregation is upgraded.
export function generateEvaluation(
  kind: Kind,
  input: StageInput,
  mode: NonNullable<StageInput["evaluationMode"]>,
  config: ModelConfig = getModelConfig(),
  attemptId?: string,
) {
  if (config.provider !== "deepseek" || config.currency !== "CNY")
    throw new ModelCallError("旧评测器仅支持 DeepSeek/CNY，尚未支持 GPT/USD 原币费用。");
  const data = { ...input, evaluationMode: mode };
  if (kind === "propose") return generateStrategy(data, config, attemptId);
  if (kind === "attack") return generateAttack(data, config, attemptId);
  if (kind === "revise") return generateRevision(data, config, attemptId);
  return generateVerdict(data, config, attemptId);
}
