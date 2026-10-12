import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { readRoutingSettings } from "../src/subagent-settings.js";

const routing = (subagentRouting: unknown) => ({ otari: { subagentRouting } });

describe("readRoutingSettings", () => {
  it.each([
    ["no settings", {}],
    ["no otari block", { theme: "dark" }],
    ["no routing block", { otari: {} }],
    ["enabled missing", routing({})],
    ["enabled false", routing({ enabled: false })],
  ])("is off with %s", (_name, settings) => {
    expect(readRoutingSettings(settings)).toEqual({ enabled: false });
  });

  it("is on without a list, so Otari uses its own", () => {
    expect(readRoutingSettings(routing({ enabled: true }))).toEqual({
      enabled: true,
    });
  });

  it("is on with the user's list", () => {
    const candidates = {
      "openai:gpt-5-mini": "Simple, mechanical work.",
      "anthropic:claude-opus-5-5": null,
    };
    expect(readRoutingSettings(routing({ enabled: true, candidates }))).toEqual(
      { enabled: true, candidates },
    );
  });

  it.each([
    ["enabled is not a boolean", { enabled: "yes" }, "enabled"],
    ["candidates is not an object", { enabled: true, candidates: [] }, "map"],
    [
      "one candidate",
      { enabled: true, candidates: { "openai:gpt-5-mini": null } },
      "two",
    ],
    [
      "256 candidates",
      {
        enabled: true,
        candidates: Object.fromEntries(
          Array.from({ length: 256 }, (_, i) => [`openai:m-${i}`, null]),
        ),
      },
      "255",
    ],
    [
      "a name that is not an Otari model id",
      {
        enabled: true,
        candidates: { "openai:gpt-5-mini": null, sonnet: null },
      },
      '"sonnet"',
    ],
    [
      "a description that is not text",
      {
        enabled: true,
        candidates: { "openai:gpt-5-mini": null, "openai:o4-mini": 3 },
      },
      "description",
    ],
    [
      "a description that is too long",
      {
        enabled: true,
        candidates: {
          "openai:gpt-5-mini": null,
          "openai:o4-mini": "x".repeat(1025),
        },
      },
      "1024",
    ],
  ])("refuses %s", (_name, block, message) => {
    expect(() => readRoutingSettings(routing(block))).toThrow(ConfigError);
    expect(() => readRoutingSettings(routing(block))).toThrow(message);
  });
});
