import { parseManagedCatalog, parseStandardModelList } from "./model-mapper.js";
import type {
  Diagnostic,
  DiscoveryResult,
  OtariConfig,
  OtariModel,
} from "./types.js";

export const MANAGED_CATALOG_URL =
  "https://api.otari.ai/api/v1/managed-models-pricing/mzai-models";

type Fetcher = typeof fetch;

export class DiscoveryUnavailableError extends Error {
  constructor(public readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "DiscoveryUnavailableError";
  }
}

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

function successful(
  models: OtariModel[],
  source: "standard" | "managed-catalog",
): DiscoveryResult {
  return {
    models,
    source: models.length > 0 ? source : "none",
    diagnostics: [],
  };
}

async function managedFallback(
  config: OtariConfig,
  fetcher: Fetcher,
): Promise<DiscoveryResult> {
  try {
    const response = await request(
      MANAGED_CATALOG_URL,
      undefined,
      config.discoveryTimeoutMs,
      fetcher,
    );
    if (!response.ok) {
      throw new DiscoveryUnavailableError({
        level: "warning",
        code: "managed-catalog-http",
        message: `Otari managed catalog returned HTTP ${response.status}`,
      });
    }
    return successful(
      parseManagedCatalog(await response.json()),
      "managed-catalog",
    );
  } catch (error) {
    if (error instanceof DiscoveryUnavailableError) throw error;
    throw new DiscoveryUnavailableError({
      level: "warning",
      code: "managed-catalog-unavailable",
      message: "Otari managed catalog is temporarily unavailable",
    });
  }
}

export async function discoverModels(
  config: OtariConfig,
  fetcher: Fetcher = fetch,
): Promise<DiscoveryResult> {
  if (!config.token) {
    return {
      models: [],
      source: "none",
      diagnostics: [
        {
          level: "error",
          code: "token-missing",
          message:
            "Run /login otari to save an Otari API key, or set OTARI_API_KEY and run /reload",
        },
      ],
    };
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
        return successful(
          parseStandardModelList(await response.json()),
          "standard",
        );
      } catch {
        throw new DiscoveryUnavailableError({
          level: "warning",
          code: "discovery-invalid",
          message: "Otari returned an invalid model-list response",
        });
      }
    }
    if (
      (response.status === 404 || response.status === 405) &&
      config.officialHosted
    ) {
      return managedFallback(config, fetcher);
    }
    if (response.status === 401 || response.status === 403) {
      return {
        models: [],
        source: "none",
        diagnostics: [
          {
            level: "error",
            code: "discovery-auth",
            message: `Otari model discovery returned HTTP ${response.status}; run /login otari with a valid key or update OTARI_API_KEY, then confirm workspace access`,
          },
        ],
      };
    }
    const diagnostic: Diagnostic = {
      level: "warning",
      code: response.status === 429 ? "discovery-rate-limit" : "discovery-http",
      message: `Otari model discovery returned HTTP ${response.status}`,
    };
    throw new DiscoveryUnavailableError(diagnostic);
  } catch (error) {
    if (error instanceof DiscoveryUnavailableError) throw error;
    throw new DiscoveryUnavailableError({
      level: "warning",
      code: "discovery-unavailable",
      message: "Otari model discovery is temporarily unavailable",
    });
  }
}
