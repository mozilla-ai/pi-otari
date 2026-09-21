import {
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DiscoveryUnavailableError, discoverModels } from "./discovery.js";
import { selectorsToModels, toProviderModel } from "./model-mapper.js";
import { streamOtari } from "./stream-otari.js";
import type { Diagnostic, OtariConfig, OtariModel } from "./types.js";

const THINKING_LEVEL_MAP = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

function toRuntimeModel(
  model: OtariModel,
  baseUrl: string,
): Model<"openai-completions"> {
  const providerModel = toProviderModel(model);
  return {
    ...providerModel,
    provider: "otari",
    baseUrl,
    api: "openai-completions",
    ...(providerModel.reasoning
      ? { thinkingLevelMap: THINKING_LEVEL_MAP }
      : {}),
    compat: {
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
    },
  };
}

export interface ProviderDependencies {
  fetch?: typeof fetch;
  /** Receives every discovery diagnostic, whether returned or thrown. */
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export function registerOtariProvider(
  pi: ExtensionAPI,
  config: OtariConfig,
  models: OtariModel[],
  dependencies: ProviderDependencies = {},
): boolean {
  const streams = openAICompletionsApi();
  const staticModels = [
    ...new Map(
      [...models, ...selectorsToModels(config.environmentModels)].map(
        (model) => [model.id, model],
      ),
    ).values(),
  ];
  const provider = createProvider({
    id: "otari",
    name: "Otari",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: envApiKeyAuth("Otari API key", ["OTARI_API_KEY"]),
    },
    models: staticModels.map((model) => toRuntimeModel(model, config.baseUrl)),
    fetchModels: async (context) => {
      const storedToken =
        context.credential?.type === "api_key"
          ? context.credential.key
          : undefined;
      try {
        const result = await discoverModels(
          {
            ...config,
            token: storedToken ?? config.token,
            environmentModels: [],
          },
          dependencies.fetch ?? fetch,
        );
        for (const diagnostic of result.diagnostics)
          dependencies.onDiagnostic?.(diagnostic);
        return result.models.map((model) =>
          toRuntimeModel(model, config.baseUrl),
        );
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError)
          dependencies.onDiagnostic?.(error.diagnostic);
        throw error;
      }
    },
    api: {
      ...streams,
      streamSimple: streamOtari,
    },
  });
  // Pi persists discovered models, including each model's baseUrl, and serves
  // them from that cache before any network refresh. Without the following code,
  // a URL from an earlier configuration would survive an upgrade or an OTARI_BASE_URL
  // change until the user logged in again.
  pi.registerProvider({
    ...provider,
    getModels: () =>
      provider
        .getModels()
        .map((model) => ({ ...model, baseUrl: config.baseUrl })),
  });
  return true;
}
