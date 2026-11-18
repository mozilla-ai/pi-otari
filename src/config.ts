import type { OtariConfig } from "./types.js";

/** The otari.ai regions, each with its own API root. A key works only in the region that minted it. */
export const HOSTED_REGIONS = [
  { id: "otari", label: "otari.ai", baseUrl: "https://api.otari.ai/api/v1" },
  {
    id: "otari-eu",
    label: "otari.ai, EU region",
    baseUrl: "https://eu.api.otari.ai/api/v1",
  },
] as const;

export const DEFAULT_BASE_URL: string = HOSTED_REGIONS[0].baseUrl;
const DEFAULT_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]"]);
const IPV4_LOOPBACK_PATTERN = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || IPV4_LOOPBACK_PATTERN.test(hostname);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30000) {
    throw new ConfigError(
      "OTARI_DISCOVERY_TIMEOUT_MS must be an integer between 1000 and 30000",
    );
  }
  return timeout;
}

function parseSwitch(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  const normalized = value.trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(normalized)) return false;
  if (["on", "1", "true", "yes"].includes(normalized)) return true;
  throw new ConfigError(`${name} must be on or off`);
}

function parseModels(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** The otari.ai region served from this hostname, if any. */
export function hostedRegionFor(hostname: string) {
  return HOSTED_REGIONS.find(
    (region) => new URL(region.baseUrl).hostname === hostname,
  );
}

export interface Deployment {
  baseUrl: string;
  officialHosted: boolean;
}

/**
 * Validate a gateway base URL. `name` is how the value is named in errors.
 * With `addPrefix`, a bare origin gets Otari's /api/v1 prefix instead of
 * being rejected, for a URL typed at the login prompt.
 */
export function parseBaseUrl(
  value: string | undefined,
  name = "OTARI_BASE_URL",
  { addPrefix = false }: { addPrefix?: boolean } = {},
): Deployment {
  let url: URL;
  try {
    url = new URL(value?.trim() || DEFAULT_BASE_URL);
  } catch {
    throw new ConfigError(`${name} must be a valid absolute URL`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${name} must not contain embedded credentials`);
  }
  if (url.search || url.hash) {
    throw new ConfigError(
      `${name} must not contain a query string or fragment`,
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    throw new ConfigError(
      `${name} must use HTTPS; HTTP is allowed only for loopback hosts`,
    );
  }
  let baseUrl = url.toString().replace(/\/+$/, "");
  // Pi appends /chat/completions and discovery appends /models, so the value
  // must carry the gateway's API prefix; no Otari gateway serves those at the
  // origin. Otari's own docs tell OpenAI-style clients the same thing.
  if (baseUrl === url.origin) {
    if (!addPrefix) {
      throw new ConfigError(
        `${name} must include the API prefix, for example ${url.origin}/api/v1`,
      );
    }
    baseUrl = `${url.origin}/api/v1`;
  }
  const region = hostedRegionFor(url.hostname);
  // Each otari.ai region has exactly one API root. Anything else on that
  // host, such as the retired /v1 prefix, would fail every request, so say so
  // at startup.
  if (region && baseUrl !== region.baseUrl) {
    throw new ConfigError(
      `Hosted Otari serves its API at ${region.baseUrl}; set ${name} to that URL`,
    );
  }
  return { baseUrl, officialHosted: region !== undefined };
}

/**
 * Point the shared config at another deployment, such as the one a stored
 * /login credential names. Every consumer reads `config.baseUrl` per call,
 * so discovery, requests and routing follow.
 */
export function useDeployment(config: OtariConfig, deployment: Deployment) {
  config.baseUrl = deployment.baseUrl;
  config.officialHosted = deployment.officialHosted;
}

export function loadOtariConfig(
  env: NodeJS.ProcessEnv = process.env,
): OtariConfig {
  const { baseUrl, officialHosted } = parseBaseUrl(env.OTARI_BASE_URL);
  const token = env.OTARI_API_KEY?.trim() || undefined;
  return {
    baseUrl,
    token,
    discoveryTimeoutMs: parseTimeout(env.OTARI_DISCOVERY_TIMEOUT_MS),
    environmentModels: parseModels(env.OTARI_MODELS),
    officialHosted,
    webSearch: parseSwitch("OTARI_WEB_SEARCH", env.OTARI_WEB_SEARCH),
    webFetch: parseSwitch("OTARI_WEB_FETCH", env.OTARI_WEB_FETCH),
  };
}
