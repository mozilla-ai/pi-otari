import {
  asStaleCache,
  mergeModels,
  parseManagedCatalog,
  parseStandardModelList,
  selectorsToModels,
} from "./model-mapper.js";
import type { Diagnostic, DiscoveryResult, ModelCache, OtariConfig, OtariModel } from "./types.js";

export const MANAGED_CATALOG_URL = "https://api.otari.ai/api/v1/managed-models-pricing/mzai-models";

type Fetcher = typeof fetch;

async function request(
  url: string,
  token: string | undefined,
  timeoutMs: number,
  fetcher: Fetcher,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    return await fetcher(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function transientFallback(
  cache: ModelCache | undefined,
  environment: OtariModel[],
  diagnostic: Diagnostic,
): DiscoveryResult {
  const stale = cache ? asStaleCache(cache.models) : [];
  return {
    models: mergeModels(stale, environment, [], []),
    source: stale.length > 0 ? "stale-cache" : environment.length > 0 ? "environment" : "none",
    diagnostics: [diagnostic],
  };
}

function successful(
  models: OtariModel[],
  environment: OtariModel[],
  source: "standard" | "managed-catalog",
): DiscoveryResult {
  return {
    models: source === "standard"
      ? mergeModels([], environment, [], models)
      : mergeModels([], environment, models, []),
    source: models.length > 0 ? source : environment.length > 0 ? "environment" : "none",
    diagnostics: [],
    cacheUpdate: models,
  };
}

async function managedFallback(
  config: OtariConfig,
  cache: ModelCache | undefined,
  environment: OtariModel[],
  fetcher: Fetcher,
): Promise<DiscoveryResult> {
  try {
    const response = await request(MANAGED_CATALOG_URL, undefined, config.discoveryTimeoutMs, fetcher);
    if (!response.ok) {
      return transientFallback(cache, environment, {
        level: "warning",
        code: "managed-catalog-http",
        message: `Otari managed catalog returned HTTP ${response.status}`,
      });
    }
    return successful(parseManagedCatalog(await response.json()), environment, "managed-catalog");
  } catch {
    return transientFallback(cache, environment, {
      level: "warning",
      code: "managed-catalog-unavailable",
      message: "Otari managed catalog is temporarily unavailable",
    });
  }
}

export async function discoverModels(
  config: OtariConfig,
  cache: ModelCache | undefined,
  fetcher: Fetcher = fetch,
): Promise<DiscoveryResult> {
  const environment = selectorsToModels(config.environmentModels);
  if (!config.token) {
    return transientFallback(cache, environment, {
      level: "error",
      code: "token-missing",
      message: "Set OTARI_API_KEY and run /reload",
    });
  }

  try {
    const response = await request(
      `${config.baseUrl}/models`,
      config.token,
      config.discoveryTimeoutMs,
      fetcher,
    );
    if (response.ok) {
      try {
        return successful(parseStandardModelList(await response.json()), environment, "standard");
      } catch {
        return transientFallback(cache, environment, {
          level: "warning",
          code: "discovery-invalid",
          message: "Otari returned an invalid model-list response",
        });
      }
    }
    if ((response.status === 404 || response.status === 405) && config.officialHosted) {
      return managedFallback(config, cache, environment, fetcher);
    }
    if (response.status === 401 || response.status === 403) {
      return {
        models: environment,
        source: environment.length > 0 ? "environment" : "none",
        diagnostics: [{
          level: "error",
          code: "discovery-auth",
          message: `Otari model discovery returned HTTP ${response.status}; check OTARI_API_KEY and workspace access`,
        }],
      };
    }
    return transientFallback(cache, environment, {
      level: "warning",
      code: response.status === 429 ? "discovery-rate-limit" : "discovery-http",
      message: `Otari model discovery returned HTTP ${response.status}`,
    });
  } catch {
    return transientFallback(cache, environment, {
      level: "warning",
      code: "discovery-unavailable",
      message: "Otari model discovery is temporarily unavailable",
    });
  }
}
