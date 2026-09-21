import type { OtariConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.otari.ai/api/v1";
const HOSTED_HOSTNAME = new URL(DEFAULT_BASE_URL).hostname;
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

function parseBaseUrl(value: string | undefined): {
  baseUrl: string;
  officialHosted: boolean;
} {
  let url: URL;
  try {
    url = new URL(value?.trim() || DEFAULT_BASE_URL);
  } catch {
    throw new ConfigError("OTARI_BASE_URL must be a valid absolute URL");
  }
  if (url.username || url.password) {
    throw new ConfigError(
      "OTARI_BASE_URL must not contain embedded credentials",
    );
  }
  if (url.search || url.hash) {
    throw new ConfigError(
      "OTARI_BASE_URL must not contain a query string or fragment",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    throw new ConfigError(
      "OTARI_BASE_URL must use HTTPS; HTTP is allowed only for loopback hosts",
    );
  }
  const baseUrl = url.toString().replace(/\/+$/, "");
  // Pi appends /chat/completions and discovery appends /models, so the value
  // must carry the gateway's API prefix; no Otari gateway serves those at the
  // origin. Otari's own docs tell OpenAI-style clients the same thing.
  if (baseUrl === url.origin) {
    throw new ConfigError(
      `OTARI_BASE_URL must include the API prefix, for example ${url.origin}/api/v1`,
    );
  }
  const officialHosted = url.hostname === HOSTED_HOSTNAME;
  // Hosted Otari has exactly one API root. Anything else on that host, such as
  // the retired /v1 prefix, would fail every request, so say so at startup.
  if (officialHosted && baseUrl !== DEFAULT_BASE_URL) {
    throw new ConfigError(
      `Hosted Otari serves its API at ${DEFAULT_BASE_URL}; set OTARI_BASE_URL to that URL or leave it unset`,
    );
  }
  return { baseUrl, officialHosted };
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
  };
}
