import { describe, expect, it } from "vitest";
import {
  describeStale,
  isStale,
  modelPart,
  replacementsFor,
} from "../src/staleness.js";

const catalog = new Set([
  "nebius:openai/gpt-oss-120b",
  "together:openai/gpt-oss-120b",
  "anthropic:claude-sonnet-5",
]);

describe("modelPart", () => {
  it("splits a selector at its first colon only", () => {
    expect(modelPart("nebius:openai/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
    expect(modelPart("openrouter:vendor/model:exacto")).toBe(
      "vendor/model:exacto",
    );
    expect(modelPart("bare-model")).toBe("bare-model");
  });
});

describe("isStale", () => {
  it("judges nothing until discovery has answered with a list", () => {
    expect(isStale(new Set(), "mzai:openai/gpt-oss-120b")).toBe(false);
  });

  it("flags a selector the list omits and accepts one it contains", () => {
    expect(isStale(catalog, "mzai:openai/gpt-oss-120b")).toBe(true);
    expect(isStale(catalog, "anthropic:claude-sonnet-5")).toBe(false);
  });
});

describe("replacementsFor", () => {
  it("lists every provider that serves the same model", () => {
    expect(replacementsFor("mzai:openai/gpt-oss-120b", catalog)).toEqual([
      "nebius:openai/gpt-oss-120b",
      "together:openai/gpt-oss-120b",
    ]);
  });

  it("offers nothing when no listed model shares the name", () => {
    expect(replacementsFor("mzai:gemini-2.5-pro", catalog)).toEqual([]);
  });

  it("does not offer a selector as its own replacement", () => {
    expect(replacementsFor("nebius:openai/gpt-oss-120b", catalog)).toEqual([
      "together:openai/gpt-oss-120b",
    ]);
  });
});

describe("describeStale", () => {
  it("names the deployment, the selector, and its replacements", () => {
    const message = describeStale(
      "mzai:openai/gpt-oss-120b",
      "https://api.otari.ai/api/v1",
      ["nebius:openai/gpt-oss-120b"],
    );
    expect(message).toContain("https://api.otari.ai/api/v1");
    expect(message).toContain('"mzai:openai/gpt-oss-120b"');
    expect(message).toContain('listed as "nebius:openai/gpt-oss-120b"');
    expect(message).toContain("/model");
  });

  it("names Otari without a deployment when no URL is given", () => {
    const message = describeStale("mzai:openai/gpt-oss-120b", undefined, []);
    expect(message.startsWith("Otari does not list")).toBe(true);
    expect(message).not.toContain("http");
  });

  it("says when no listed model matches", () => {
    expect(
      describeStale("mzai:gemini-2.5-pro", "https://api.otari.ai/api/v1", []),
    ).toContain("no listed model has the same name");
  });
});
