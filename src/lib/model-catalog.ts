import type { Currency, ModelProvider } from "./contracts";

export const MODEL_IDS = [
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "deepseek-flash",
] as const;
export type ModelId = (typeof MODEL_IDS)[number];
export const DEFAULT_MODEL_ID: ModelId = "gpt-6.1-terra";
export interface CatalogModel {
  id: ModelId;
  label: string;
  provider: ModelProvider;
  currency: Currency;
  inputPrice: number;
  outputPrice: number;
}
// Native-currency uncached input/output rates per million tokens, verified 2026-11-06.
export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: "gpt-6.1-terra",
    label: "GPT 6.1 Terra",
    provider: "openai",
    currency: "USD",
    inputPrice: 1,
    outputPrice: 5,
  },
  {
    id: "gpt-6.1-sol",
    label: "GPT 6.1 Sol",
    provider: "openai",
    currency: "USD",
    inputPrice: 2,
    outputPrice: 10,
  },
  {
    id: "gpt-6-astra",
    label: "GPT 6 Astra",
    provider: "openai",
    currency: "USD",
    inputPrice: 10,
    outputPrice: 50,
  },
  {
    id: "gpt-6-luna",
    label: "GPT 6 Luna",
    provider: "openai",
    currency: "USD",
    inputPrice: 0.1,
    outputPrice: 0.5,
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    currency: "CNY",
    inputPrice: 2.4,
    outputPrice: 9.6,
  },
];
export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && (MODEL_IDS as readonly string[]).includes(value);
}
export function catalogModel(id: ModelId): CatalogModel {
  const model = MODEL_CATALOG.find((entry) => entry.id === id);
  if (!model) throw new Error("未知或未配置价格的模型");
  return model;
}
