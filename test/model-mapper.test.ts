import { describe, expect, it } from "vitest";
import {
  mergeModels,
  parseManagedCatalog,
  parseStandardModelList,
  selectorsToModels,
  toProviderModel,
} from "../src/model-mapper.js";

describe("model mapping", () => {
  it("parses OpenAI-compatible models and metadata", () => {
    const models = parseStandardModelList({
      object: "list",
      data: [{
        id: "anthropic:claude",
        name: "Claude",
        context_window: 200000,
        max_output_tokens: 32000,
        reasoning: true,
        input_modalities: ["text", "image", "audio"],
        pricing: { input_price_per_million: 3, output_price_per_million: 15 },
      }],
    });
    expect(models[0]).toMatchObject({
      id: "anthropic:claude",
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 32000,
      source: "standard",
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("accepts a valid empty list and rejects malformed model lists", () => {
    expect(parseStandardModelList({ data: [] })).toEqual([]);
    expect(() => parseStandardModelList({ models: [] })).toThrow("data array");
    expect(() => parseStandardModelList({ data: [{ object: "model" }] })).toThrow("valid model");
    expect(() => parseManagedCatalog({ data: [{ provider: "mzai" }] })).toThrow("valid model");
  });

  it("maps the hosted managed catalog", () => {
    expect(parseManagedCatalog({
      data: [{
        provider: "mzai",
        model: "org/model",
        input_price_per_million: "0.5",
        output_price_per_million: "2",
      }],
    })[0]).toMatchObject({
      id: "mzai:org/model",
      source: "managed-catalog",
      cost: { input: 0.5, output: 2 },
    });
  });

  it("keeps rich remote metadata over environment and stale cache", () => {
    const merged = mergeModels(
      [{ id: "x:model", name: "stale", source: "stale-cache" }],
      selectorsToModels(["x:model", "y:model"]),
      [],
      [{ id: "x:model", name: "remote", source: "standard" }],
    );
    expect(merged.map((model) => [model.id, model.name])).toEqual([
      ["x:model", "remote"],
      ["y:model", "y:model"],
    ]);
  });

  it("uses conservative Pi defaults", () => {
    expect(toProviderModel({ id: "x:model", source: "environment" })).toMatchObject({
      id: "x:model",
      name: "x:model",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});
