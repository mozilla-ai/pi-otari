import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOtariProvider } from "../src/provider.js";
import type { OtariConfig } from "../src/types.js";

const config: OtariConfig = {
  baseUrl: "https://api.otari.ai/v1",
  token: "tk_not_forwarded_to_registration",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
};

function fakePi(): ExtensionAPI {
  return { registerProvider: vi.fn() } as unknown as ExtensionAPI;
}

describe("registerOtariProvider", () => {
  it("registers OpenAI-compatible models using an environment reference", () => {
    const pi = fakePi();
    expect(registerOtariProvider(pi, config, [{ id: "anthropic:claude", source: "standard" }])).toBe(true);
    expect(pi.registerProvider).toHaveBeenCalledWith("otari", expect.objectContaining({
      baseUrl: config.baseUrl,
      api: "openai-completions",
      apiKey: "$OTARI_API_KEY",
      models: [expect.objectContaining({
        id: "anthropic:claude",
        compat: { maxTokensField: "max_tokens" },
      })],
    }));
    expect(JSON.stringify(vi.mocked(pi.registerProvider).mock.calls)).not.toContain(config.token);
  });

  it("does not register an empty provider", () => {
    const pi = fakePi();
    expect(registerOtariProvider(pi, config, [])).toBe(false);
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });
});
