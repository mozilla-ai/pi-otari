import type { OtariConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.otari.ai/v1";
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
  return {
    baseUrl,
    officialHosted: baseUrl === DEFAULT_BASE_URL,
  };
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
