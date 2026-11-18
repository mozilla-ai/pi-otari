import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  parseStandardModelList,
  toProviderModel,
} from "../src/model-mapper.js";

describe("model mapping", () => {
  it("parses OpenAI-compatible models and metadata", () => {
    const models = parseStandardModelList({
      object: "list",
      data: [
        {
          id: "anthropic:claude",
          name: "Claude",
          context_window: 200000,
          max_output_tokens: 32000,
          reasoning: true,
          input_modalities: ["text", "image", "audio"],
          pricing: { input_price_per_million: 3, output_price_per_million: 15 },
        },
      ],
    });
    expect(models[0]).toMatchObject({
      id: "anthropic:claude",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 32000,
      source: "standard",
      cost: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 },
    });
  });

  it("maps hosted capability metadata to Pi booleans", () => {
    const models = parseStandardModelList({
      data: [
        { id: "mzai:vision-reasoner", modality: "Vision", reasoning: true },
        { id: "mzai:text-model", modality: "Text-to-text", reasoning: false },
      ],
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "mzai:vision-reasoner",
        reasoning: true,
        input: ["text", "image"],
      }),
      expect.objectContaining({
        id: "mzai:text-model",
        reasoning: false,
        input: undefined,
      }),
    ]);
  });

  it("reads reasoning from Otari's supported_parameters", () => {
    const models = parseStandardModelList({
      data: [
        {
          id: "deepseek/deepseek-v4-flash",
          supported_parameters: ["tools", "tool_choice", "reasoning"],
        },
        { id: "openai/gpt-4o", supported_parameters: ["tools"] },
        {
          id: "x/flagged",
          reasoning: false,
          supported_parameters: ["reasoning"],
        },
        { id: "x/unknown" },
      ],
    });

    expect(models.map((model) => model.reasoning)).toEqual([
      true,
      false,
      false,
      undefined,
    ]);
    expect(toProviderModel(models[0]).reasoning).toBe(true);
  });

  it("prices cache reads and writes, at the input rate when unset", () => {
    const models = parseStandardModelList({
      data: [
        {
          id: "deepseek/deepseek-v4-flash",
          pricing: {
            input_price_per_million: 0.28,
            output_price_per_million: 0.42,
            cache_read_price_per_million: 0.028,
            cache_write_price_per_million: 0,
          },
        },
        {
          id: "x/no-cache-rates",
          pricing: {
            input_price_per_million: 1,
            output_price_per_million: 2,
            cache_read_price_per_million: null,
          },
        },
      ],
    });

    expect(models.map((model) => model.cost)).toEqual([
      { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
      { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
    ]);
  });

  it("accepts a valid empty list and rejects malformed model lists", () => {
    expect(parseStandardModelList({ data: [] })).toEqual([]);
    expect(() => parseStandardModelList({ models: [] })).toThrow("data array");
    expect(() =>
      parseStandardModelList({ data: [{ object: "model" }] }),
    ).toThrow("valid model");
  });

  it("uses conservative Pi defaults", () => {
    expect(
      toProviderModel({ id: "x:model", source: "environment" }),
    ).toMatchObject({
      id: "x:model",
      name: "x:model",
      reasoning: false,
      input: ["text"],
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});
