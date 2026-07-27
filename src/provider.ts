import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toProviderModel } from "./model-mapper.js";
import { streamOtari } from "./stream-otari.js";
import type { OtariConfig, OtariModel } from "./types.js";

const THINKING_LEVEL_MAP = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

export function registerOtariProvider(
  pi: ExtensionAPI,
  config: OtariConfig,
  models: OtariModel[],
): boolean {
  if (models.length === 0) return false;
  pi.registerProvider("otari", {
    name: "Otari",
    baseUrl: config.baseUrl,
    apiKey: "$OTARI_API_KEY",
    api: "openai-completions",
    streamSimple: streamOtari,
    models: models.map((model) => ({
      ...toProviderModel(model),
      reasoning: true,
      thinkingLevelMap: THINKING_LEVEL_MAP,
      compat: {
        maxTokensField: "max_tokens",
        supportsDeveloperRole: false,
      },
    })),
  });
  return true;
}
