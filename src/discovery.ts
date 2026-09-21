import { parseStandardModelList } from "./model-mapper.js";
import type {
  Diagnostic,
  DiscoveryResult,
  OtariConfig,
  OtariModel,
} from "./types.js";

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

function successful(models: OtariModel[], source: "standard"): DiscoveryResult {
  return {
    models,
    source: models.length > 0 ? source : "none",
    diagnostics: [],
  };
}

/** The other well-known Otari API root for this gateway, if the URL uses one. */
function siblingBaseUrl(baseUrl: string): string | undefined {
  if (baseUrl.endsWith("/api/v1"))
    return `${baseUrl.slice(0, -"/api/v1".length)}/v1`;
  if (baseUrl.endsWith("/v1"))
    return `${baseUrl.slice(0, -"/v1".length)}/api/v1`;
  return undefined;
}

/** True when the gateway answers its public health route under this root. */
async function servesApiAt(
  baseUrl: string,
  config: OtariConfig,
  fetcher: Fetcher,
): Promise<boolean> {
  try {
    const response = await request(
      `${baseUrl}/health`,
      undefined,
      config.discoveryTimeoutMs,
      fetcher,
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A 404 from a custom gateway almost always means OTARI_BASE_URL carries the
 * wrong API prefix: Otari 0.6.0 moved from /v1 to /api/v1. Probe the sibling
 * root's public health route, without the token, so the message can name the
 * exact value to set instead of guessing.
 */
async function describeNotFound(
  discoveryUrl: string,
  config: OtariConfig,
  fetcher: Fetcher,
): Promise<Diagnostic> {
  const sibling = siblingBaseUrl(config.baseUrl);
  if (sibling && (await servesApiAt(sibling, config, fetcher))) {
    return {
      level: "warning",
      code: "discovery-prefix",
      message: `Otari model discovery returned HTTP 404 at ${discoveryUrl}; this gateway serves its API at ${sibling}. Set OTARI_BASE_URL=${sibling}`,
    };
  }
  return {
    level: "warning",
    code: "discovery-http",
    message: `Otari model discovery returned HTTP 404 at ${discoveryUrl}; check that OTARI_BASE_URL includes the gateway's API prefix. Otari 0.6.0 and newer use /api/v1`,
  };
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
    const discoveryUrl = `${config.baseUrl}/models`;
    const response = await request(
      discoveryUrl,
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
      throw new DiscoveryUnavailableError({
        level: "warning",
        code: "discovery-http",
        message: `Otari model discovery returned HTTP ${response.status} at ${discoveryUrl}; hosted model discovery is unavailable. No public catalog fallback is supported`,
      });
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
    if (response.status === 404) {
      throw new DiscoveryUnavailableError(
        await describeNotFound(discoveryUrl, config, fetcher),
      );
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
