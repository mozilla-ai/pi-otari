import {
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OTARI_COMPAT,
  THINKING_LEVEL_MAP,
  toProviderModel,
} from "./model-mapper.js";
import {
  createProviderCore,
  type ProviderDependencies,
} from "./provider-core.js";
import { createStreamOtari } from "./stream-otari.js";
import type { OtariConfig, OtariModel } from "./types.js";

export type { ProviderDependencies } from "./provider-core.js";

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
    compat: OTARI_COMPAT,
  };
}

/** Origin of a URL, or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Pi persists discovered models with the base URL they were discovered from
 * and restores them before any network refresh, merged over the OTARI_MODELS
 * baseline by id. A cached entry is only evidence about that deployment: after
 * OTARI_BASE_URL moves to a different origin, keep nothing from the previous
 * one. The stored list is scoped before that merge, so an OTARI_MODELS entry
 * with the same id stays as configured. Entries from the same origin under
 * another prefix are considered as the same deployment after an API move
 * (Otari 0.6.0: /v1 to /api/v1) and follow the configured URL.
 */
function scopeToBackend<T extends { baseUrl: string }>(
  models: readonly T[],
  baseUrl: string,
): T[] {
  const origin = originOf(baseUrl);
  return models.flatMap((model) => {
    if (model.baseUrl === baseUrl) return [model];
    if (origin !== undefined && originOf(model.baseUrl) === origin)
      return [{ ...model, baseUrl }];
    return [];
  });
}

export function registerOtariProvider(
  pi: ExtensionAPI,
  config: OtariConfig,
  models: OtariModel[],
  dependencies: ProviderDependencies = {},
): boolean {
  const streams = openAICompletionsApi();
  const core = createProviderCore(config, models, dependencies);
  const provider = createProvider({
    id: "otari",
    name: "Otari",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: envApiKeyAuth("Otari API key", ["OTARI_API_KEY"]),
    },
    models: core.staticModels.map((model) =>
      toRuntimeModel(model, config.baseUrl),
    ),
    fetchModels: async (context) => {
      const storedToken =
        context.credential?.type === "api_key"
          ? context.credential.key
          : undefined;
      const discovered = await core.discover(storedToken ?? config.token);
      return discovered.map((model) => toRuntimeModel(model, config.baseUrl));
    },
    api: {
      ...streams,
      streamSimple: createStreamOtari(
        core.catalog,
        streams.streamSimple,
        core.wrapFetch,
      ),
    },
  });
  pi.registerProvider({
    ...provider,
    // Scope the stored list to this deployment before createProvider restores
    // it, and seed the catalog from the same list: it is the last successful
    // discovery, so selectors can be checked from session start, with the
    // network refresh taking over once it answers.
    refreshModels: async (context) => {
      const stored = context.stored && {
        ...context.stored,
        models: scopeToBackend(
          context.stored.models.filter((model) => model.provider === "otari"),
          config.baseUrl,
        ),
      };
      if (stored) core.setCatalog(stored.models.map((model) => model.id));
      return provider.refreshModels?.({ ...context, stored });
    },
  });
  return true;
}
