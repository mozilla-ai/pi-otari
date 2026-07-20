import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelCost, OtariModel } from "./types.js";

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
}

function price(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : 0;
}

function parseInput(value: unknown): Array<"text" | "image"> | undefined {
  if (!Array.isArray(value)) return undefined;
  const supported = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
  return supported.length > 0 ? [...new Set(supported)] : undefined;
}

function parseStandardEntry(value: unknown): OtariModel | undefined {
  const item = record(value);
  if (!item || typeof item.id !== "string" || item.id.trim() === "") return undefined;
  const pricing = record(item.pricing);
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined,
    reasoning: typeof item.reasoning === "boolean" ? item.reasoning : undefined,
    input: parseInput(item.input_modalities),
    contextWindow: positiveNumber(item.context_window),
    maxTokens: positiveNumber(item.max_output_tokens),
    cost: pricing ? {
      input: price(pricing.input_price_per_million),
      output: price(pricing.output_price_per_million),
      cacheRead: 0,
      cacheWrite: 0,
    } : undefined,
    source: "standard",
  };
}

export function parseStandardModelList(value: unknown): OtariModel[] {
  const root = record(value);
  if (!root || !Array.isArray(root.data)) throw new Error("Model response must contain a data array");
  const models = root.data.map(parseStandardEntry).filter((item): item is OtariModel => item !== undefined);
  if (root.data.length > 0 && models.length === 0) {
    throw new Error("Model response contains no valid model entries");
  }
  return models;
}

export function parseManagedCatalog(value: unknown): OtariModel[] {
  const root = record(value);
  if (!root || !Array.isArray(root.data)) throw new Error("Managed catalog must contain a data array");
  const models = root.data.flatMap((value) => {
    const item = record(value);
    if (!item || typeof item.provider !== "string" || typeof item.model !== "string") return [];
    const provider = item.provider.trim();
    const model = item.model.trim();
    if (!provider || !model) return [];
    return [{
      id: `${provider}:${model}`,
      name: model,
      cost: {
        input: price(item.input_price_per_million),
        output: price(item.output_price_per_million),
        cacheRead: price(item.cache_read_price_per_million),
        cacheWrite: price(item.cache_write_price_per_million),
      },
      source: "managed-catalog" as const,
    }];
  });
  if (root.data.length > 0 && models.length === 0) {
    throw new Error("Managed catalog contains no valid model entries");
  }
  return models;
}

export function selectorsToModels(selectors: string[]): OtariModel[] {
  return selectors.map((id) => ({ id, name: id, source: "environment" }));
}

export function asStaleCache(models: OtariModel[]): OtariModel[] {
  return models.map((model) => ({ ...model, source: "stale-cache" }));
}

export function mergeModels(
  stale: OtariModel[],
  environment: OtariModel[],
  managed: OtariModel[],
  standard: OtariModel[],
): OtariModel[] {
  const byId = new Map<string, OtariModel>();
  for (const group of [stale, environment, managed, standard]) {
    for (const model of group) byId.set(model.id, model);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function toProviderModel(model: OtariModel): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: model.cost ?? ZERO_COST,
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxTokens ?? 16384,
  };
}
