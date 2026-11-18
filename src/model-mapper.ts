import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelCost, OtariModel } from "./types.js";

/** Conservative fallbacks for models whose metadata omits these limits. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/** Pi's thinking levels pass through to Otari by name, xhigh and max included. */
export const THINKING_LEVEL_MAP = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

/**
 * OpenAI wire settings for every Otari model: Otari routes to backends that
 * take max_tokens and do not accept the developer role.
 */
export const OTARI_COMPAT = {
  maxTokensField: "max_tokens",
  supportsDeveloperRole: false,
} as const;

const ZERO_COST: ModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** The value as a plain object, or undefined when it is not one. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0
    ? number
    : undefined;
}

function price(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? number
    : 0;
}

/** A cache rate, or the input rate when unset, which is how Otari bills it. */
function cachePrice(value: unknown, input: number): number {
  return value === null || value === undefined ? input : price(value);
}

/**
 * Whether the entry marks the model as reasoning-capable: an explicit
 * `reasoning` flag, else `reasoning` in Otari's `supported_parameters`.
 */
function parseReasoning(item: Record<string, unknown>): boolean | undefined {
  if (typeof item.reasoning === "boolean") return item.reasoning;
  if (!Array.isArray(item.supported_parameters)) return undefined;
  return item.supported_parameters.includes("reasoning");
}

function parseCost(
  pricing: Record<string, unknown> | undefined,
): ModelCost | undefined {
  if (!pricing) return undefined;
  const input = price(pricing.input_price_per_million);
  return {
    input,
    output: price(pricing.output_price_per_million),
    cacheRead: cachePrice(pricing.cache_read_price_per_million, input),
    cacheWrite: cachePrice(pricing.cache_write_price_per_million, input),
  };
}

function parseInput(value: unknown): Array<"text" | "image"> | undefined {
  if (!Array.isArray(value)) return undefined;
  const supported = value.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return supported.length > 0 ? [...new Set(supported)] : undefined;
}

function parseModality(value: unknown): Array<"text" | "image"> | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().toLowerCase() === "vision"
    ? ["text", "image"]
    : undefined;
}

function parseStandardEntry(value: unknown): OtariModel | undefined {
  const item = record(value);
  if (!item || typeof item.id !== "string" || item.id.trim() === "")
    return undefined;
  return {
    id: item.id.trim(),
    name:
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : undefined,
    reasoning: parseReasoning(item),
    input: parseInput(item.input_modalities) ?? parseModality(item.modality),
    contextWindow: positiveNumber(item.context_window),
    maxTokens: positiveNumber(item.max_output_tokens),
    cost: parseCost(record(item.pricing)),
    source: "standard",
  };
}

export function parseStandardModelList(value: unknown): OtariModel[] {
  const root = record(value);
  if (!root || !Array.isArray(root.data))
    throw new Error("Model response must contain a data array");
  const models = root.data
    .map(parseStandardEntry)
    .filter((item): item is OtariModel => item !== undefined);
  if (root.data.length > 0 && models.length === 0) {
    throw new Error("Model response contains no valid model entries");
  }
  return models;
}

export function selectorsToModels(selectors: string[]): OtariModel[] {
  return selectors.map((id) => ({ id, name: id, source: "environment" }));
}

/** Otari serves chat models only. */
type ProviderChatModelConfig = Extract<
  ProviderModelConfig,
  { reasoning: boolean }
>;

export function toProviderModel(model: OtariModel): ProviderChatModelConfig {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: model.cost ?? ZERO_COST,
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}
