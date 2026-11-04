import { z } from "zod";
import {
  AttackSchema,
  RevisionSchema,
  StrategySchema,
  VerdictSchema,
  SCHEMA_VERSION,
  type ModelResult,
  type ModelUsage,
  type StageInput,
} from "../contracts";
import defaults from "../../../config/model.json";
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
export function getModelConfig() {
  const endpoint = new URL(process.env.MODEL_BASE_URL || defaults.baseUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("模型接口必须是无查询参数、无凭据的 HTTPS 地址");
  const structuredOutput = process.env.MODEL_STRUCTURED_OUTPUT || defaults.structuredOutput;
  if (structuredOutput !== "json" && structuredOutput !== "strict-tool")
    throw new Error("MODEL_STRUCTURED_OUTPUT 配置无效");
  return {
    configurationVersion: defaults.configVersion,
    baseUrl: endpoint.toString().replace(/\/$/, ""),
    temperature: numberEnv("MODEL_TEMPERATURE", defaults.temperature, 0, 2),
    structuredOutput,
    id: process.env.MODEL_ID || defaults.model,
    configured: Boolean(process.env.MODEL_API_KEY?.trim()),
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    maxOutputTokens: numberEnv("MODEL_MAX_OUTPUT_TOKENS", defaults.maxOutputTokens, 500, 6000),
    timeoutMs: numberEnv("MODEL_TIMEOUT_MS", defaults.timeoutMs, 1000, 180000),
    inputPrice: numberEnv(
      "MODEL_INPUT_PRICE_PER_MILLION",
      defaults.estimatedInputCnyPerMillion,
      0.01,
      1000,
    ),
    outputPrice: numberEnv(
      "MODEL_OUTPUT_PRICE_PER_MILLION",
      defaults.estimatedOutputCnyPerMillion,
      0.01,
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
function maxInputTokens(input: StageInput, config: ReturnType<typeof getModelConfig>) {
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
export function estimateCallTokens(input: StageInput): number {
  const config = getModelConfig();
  return maxInputTokens(input, config) + config.maxOutputTokens;
}
export function estimateCallCost(input: StageInput): number {
  const config = getModelConfig();
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
  const outputOptions = strict
    ? {
        tools: [
          {
            type: "function",
            function: {
              name: functionName,
              description: "structured protocol output",
              strict: true,
              parameters: bindStrictReferences(
                toStrictToolSchema(z.toJSONSchema(schema)),
                kind,
                input,
              ),
            },
          },
        ],
        tool_choice: { type: "function", function: { name: functionName } },
      }
    : { response_format: { type: "json_object" } };
  return {
    model: config.id,
    messages: buildMessages(kind, input, schema, config.structuredOutput),
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    thinking: { type: "disabled" },
    ...outputOptions,
    stream: false,
  };
}
async function generate<T>(
  kind: Kind,
  input: StageInput,
  schema: z.ZodType<T>,
): Promise<ModelResult<T>> {
  const c = getModelConfig();
  if (!c.configured)
    throw new ModelCallError(
      "未配置模型密钥。请在服务器的 .env.local 填写 MODEL_API_KEY，重启后再试。",
    );
  const base = new URL(c.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password)
    throw new ModelCallError("模型接口必须使用不含凭据的 HTTPS 地址。");
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
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${base.toString().replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MODEL_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    clearTimeout(timer);
    throw new ModelCallError(
      "模型连接中断或超时，服务端是否完成未知。本步骤不会自动重试，预留额度暂不释放。",
      true,
    );
  }
  if (!response.ok) {
    clearTimeout(timer);
    // Never forward arbitrary provider bodies: they may contain request/private data.
    const message =
      response.status === 401
        ? "DeepSeek 密钥未通过验证，请检查本地配置。"
        : response.status === 402
          ? "模型账户余额不足，请在服务商后台检查。"
          : response.status === 429
            ? "模型服务限流，请稍后另开一局。"
            : `模型服务返回 HTTP ${response.status}，本步骤已停止。`;
    throw new ModelCallError(message, response.status >= 500 || response.status === 408);
  }
  let raw: {
    id?: string;
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
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
    throw new ModelCallError("模型响应未完整接收，执行结果待确认。", true);
  } finally {
    clearTimeout(timer);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ModelCallError("模型返回的响应封装无效，无法确认用量，保留预留额度。", true);
  const u = raw.usage;
  if (
    !u ||
    !Number.isFinite(u.prompt_tokens) ||
    !Number.isFinite(u.completion_tokens) ||
    u.prompt_tokens! < 0 ||
    u.completion_tokens! < 0
  )
    throw new ModelCallError("模型未返回可核对的用量，保留本次预留额度并停止。", true);
  const usage: ModelUsage = {
    inputTokens: u.prompt_tokens!,
    outputTokens: u.completion_tokens!,
    cachedInputTokens:
      typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : 0,
    estimatedCny: (u.prompt_tokens! * c.inputPrice + u.completion_tokens! * c.outputPrice) / 1e6,
    model: typeof raw.model === "string" ? raw.model : c.id,
    responseId: typeof raw.id === "string" ? raw.id : "not-returned",
    durationMs: Date.now() - started,
  };
  const choice = raw.choices?.[0];
  if (choice?.finish_reason !== (strict ? "tool_calls" : "stop"))
    throw new ModelCallError(
      "模型输出被截断或未正常完成；已记录实际用量，不会自动补写。",
      false,
      usage,
    );
  let output: string;
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
      throw new ModelCallError("模型响应正文不是文本，已记录实际用量，停止本步骤。", false, usage);
    output = choice.message.content;
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
export const generateStrategy = (input: StageInput) => generate("propose", input, StrategySchema);
export const generateAttack = (input: StageInput) => generate("attack", input, AttackSchema);
export const generateRevision = (input: StageInput) => generate("revise", input, RevisionSchema);
export const generateVerdict = (input: StageInput) => generate("judge", input, VerdictSchema);
// Offline evaluation only. Public ChallengeSchema strips these experimental options.
export function generateEvaluation(
  kind: Kind,
  input: StageInput,
  mode: NonNullable<StageInput["evaluationMode"]>,
) {
  const data = { ...input, evaluationMode: mode };
  if (kind === "propose") return generateStrategy(data);
  if (kind === "attack") return generateAttack(data);
  if (kind === "revise") return generateRevision(data);
  return generateVerdict(data);
}
