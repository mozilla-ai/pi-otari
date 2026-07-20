import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toProviderModel } from "./model-mapper.js";
import type { OtariConfig, OtariModel } from "./types.js";

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
    models: models.map(toProviderModel),
  });
  return true;
}
