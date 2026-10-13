import {
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DiscoveryUnavailableError, discoverModels } from "./discovery.js";
import {
  selectorsToModels,
  THINKING_LEVEL_MAP,
  toProviderModel,
} from "./model-mapper.js";
import {
  type Catalog,
  describeStale,
  isStale,
  replacementsFor,
} from "./staleness.js";
import { createStreamOtari } from "./stream-otari.js";
import type { Diagnostic, OtariConfig, OtariModel } from "./types.js";
import {
  probeWebSearch,
  WebSearchState,
  wrapFetchWithWebSearch,
} from "./web-search.js";

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

export interface ProviderDependencies {
  fetch?: typeof fetch;
  /** Receives every discovery diagnostic, whether returned or thrown. */
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Kept in step with each discovery; see staleness.ts. */
  catalog?: Catalog;
  /** Shared with the request path; each successful discovery refreshes it. */
  webSearch?: WebSearchState;
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
  const catalog = dependencies.catalog ?? new Set<string>();
  const webSearch = dependencies.webSearch ?? new WebSearchState();
  const reported = new Set<string>();
  // OTARI_MODELS entries stay registered as given, since they may name models
  // discovery does not list. Once Otari has answered, tell the user about the
  // ones it did not list, once per selector, naming the current selector for
  // the same model where there is one.
  const reportStaleSelectors = () => {
    for (const id of config.environmentModels) {
      if (!isStale(catalog, id) || reported.has(id)) continue;
      reported.add(id);
      dependencies.onDiagnostic?.({
        level: "warning",
        code: "selector-stale",
        message: `${describeStale(id, config.baseUrl, replacementsFor(id, catalog))} "${id}" is set in OTARI_MODELS; update or remove it there.`,
      });
    }
  };
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
      const token = storedToken ?? config.token;
      const fetcher = dependencies.fetch ?? fetch;
      // Probe alongside discovery so a slow /tools never adds its own timeout
      // to the refresh. probeWebSearch never rejects; its answer is only
      // applied once discovery has succeeded.
      const probe = config.webSearch
        ? probeWebSearch(config, token, fetcher)
        : undefined;
      try {
        const result = await discoverModels(
          { ...config, token, environmentModels: [] },
          fetcher,
        );
        for (const diagnostic of result.diagnostics)
          dependencies.onDiagnostic?.(diagnostic);
        catalog.clear();
        for (const model of result.models) catalog.add(model.id);
        reportStaleSelectors();
        if (probe) webSearch.probed(await probe);
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
      streamSimple: createStreamOtari(
        catalog,
        config.webSearch
          ? (inner) =>
              wrapFetchWithWebSearch(inner, {
                baseUrl: config.baseUrl,
                state: webSearch,
                onRefused: (reason) =>
                  dependencies.onDiagnostic?.({
                    level: "warning",
                    code: "web-search-refused",
                    message: `Otari refused its web search tool: ${reason.replace(/\.?$/, ".")} The request was retried without web search, which stays off until the next model refresh. Set OTARI_WEB_SEARCH=off to stop declaring it.`,
                  }),
              })
          : undefined,
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
      if (stored) {
        catalog.clear();
        for (const model of stored.models) catalog.add(model.id);
      }
      return provider.refreshModels?.({ ...context, stored });
    },
  });
  return true;
}
