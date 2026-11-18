import type {
  ApiKeyAuth,
  ApiKeyCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
  ConfigError,
  type Deployment,
  HOSTED_REGIONS,
  hostedRegionFor,
  parseBaseUrl,
  useDeployment,
} from "./config.js";
import { type Fetcher, request } from "./http.js";
import type { OtariConfig } from "./types.js";

/** Where a stored credential keeps the gateway it was minted for. */
export const BASE_URL_KEY = "OTARI_BASE_URL";
const API_KEY_ENV = "OTARI_API_KEY";
const OWN_GATEWAY = "custom";

/** The deployment a stored credential names, if it names a valid one. */
export function storedDeployment(
  credential: { type: string; env?: Record<string, string> } | undefined,
): Deployment | undefined {
  const value =
    credential?.type === "api_key" ? credential.env?.[BASE_URL_KEY] : undefined;
  if (!value) return undefined;
  try {
    return parseBaseUrl(value);
  } catch {
    return undefined;
  }
}

/**
 * The otari.ai host a 421 names. otari.ai serves a key only in the region
 * that minted it and says which one: "... belongs to eu.api.otari.ai. Send
 * ...". Only an otari.ai region is trusted, so a gateway cannot redirect the
 * key anywhere else.
 */
async function misdirectedRegion(response: Response) {
  let detail = "";
  try {
    const body: unknown = await response.json();
    const value = (body as { detail?: unknown } | null)?.detail;
    detail = typeof value === "string" ? value : JSON.stringify(body);
  } catch {
    return undefined;
  }
  const host = /belongs to (\S+?)\.?\s+Send/.exec(detail)?.[1];
  return host ? hostedRegionFor(host) : undefined;
}

async function pickDeployment(
  interaction: ProviderAuthInteraction,
  current: Deployment,
): Promise<Deployment> {
  const choice = await interaction.prompt({
    type: "select",
    message: "Which Otari?",
    options: [
      ...HOSTED_REGIONS.map((region) => ({
        id: region.id,
        label: region.label,
        description: region.baseUrl,
      })),
      {
        id: OWN_GATEWAY,
        label: "Your own gateway…",
        description:
          "A self-hosted or local Otari, such as http://localhost:8000",
      },
    ],
  });
  interaction.signal.throwIfAborted();
  const region = HOSTED_REGIONS.find((item) => item.id === choice);
  if (region) return { baseUrl: region.baseUrl, officialHosted: true };
  if (choice !== OWN_GATEWAY) throw new Error("Login cancelled");

  const typed = await interaction.prompt({
    type: "text",
    message: "Otari gateway URL (/api/v1 is added when left out)",
    placeholder: current.officialHosted
      ? "http://localhost:8000"
      : current.baseUrl,
  });
  interaction.signal.throwIfAborted();
  try {
    return parseBaseUrl(
      typed.trim() || (current.officialHosted ? "" : current.baseUrl),
      "The gateway URL",
      { addPrefix: true },
    );
  } catch (error) {
    if (error instanceof ConfigError && !typed.trim())
      throw new Error("Login cancelled: no gateway URL entered");
    throw error;
  }
}

/**
 * Check the key against the deployment's model list, so a wrong key, region
 * or URL fails at /login instead of on the first request. Returns the
 * deployment to keep, which differs only when otari.ai says the key belongs
 * to its other region.
 */
async function verify(
  deployment: Deployment,
  key: string,
  config: OtariConfig,
  fetcher: Fetcher,
  interaction: ProviderAuthInteraction,
  moved = false,
): Promise<Deployment> {
  interaction.notify({
    type: "progress",
    message: `Checking the key with Otari at ${deployment.baseUrl}`,
  });
  let response: Response;
  try {
    response = await request(
      `${deployment.baseUrl}/models`,
      key,
      AbortSignal.any([
        interaction.signal,
        AbortSignal.timeout(config.discoveryTimeoutMs),
      ]),
      fetcher,
    );
  } catch (error) {
    interaction.signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach Otari at ${deployment.baseUrl}: ${reason}`,
    );
  }
  if (response.ok) return deployment;
  if (response.status === 421 && deployment.officialHosted && !moved) {
    const region = await misdirectedRegion(response);
    if (region && region.baseUrl !== deployment.baseUrl) {
      interaction.notify({
        type: "info",
        message: `This key belongs to ${region.label}; using ${region.baseUrl}.`,
      });
      return verify(
        { baseUrl: region.baseUrl, officialHosted: true },
        key,
        config,
        fetcher,
        interaction,
        true,
      );
    }
  }
  if (response.status === 401 || response.status === 403)
    throw new Error(
      `Otari at ${deployment.baseUrl} rejected the API key (HTTP ${response.status})`,
    );
  if (response.status === 404 && !deployment.officialHosted)
    throw new Error(
      `${deployment.baseUrl}/models was not found (HTTP 404); check the gateway URL and its API prefix (Otari 0.6.0 and newer use /api/v1)`,
    );
  throw new Error(
    `Otari at ${deployment.baseUrl} answered HTTP ${response.status}`,
  );
}

/**
 * API-key auth for Otari whose credential also records which deployment the
 * key belongs to: otari.ai, its EU region, or a self-hosted gateway. A stored
 * key and its gateway win over OTARI_API_KEY and OTARI_BASE_URL, which are
 * the fallback pair. Resolution points the shared config at the deployment in
 * use, so discovery, routing and gateway tools follow the key.
 */
export function otariApiKeyAuth(
  config: OtariConfig,
  fetcher: () => Fetcher,
): ApiKeyAuth {
  const fromEnvironment: Deployment = {
    baseUrl: config.baseUrl,
    officialHosted: config.officialHosted,
  };
  return {
    name: "Otari API key",
    async login(interaction): Promise<ApiKeyCredential> {
      interaction.signal.throwIfAborted();
      const picked = await pickDeployment(interaction, fromEnvironment);
      const key = (
        await interaction.prompt({
          type: "secret",
          message: `Enter Otari API key for ${picked.baseUrl}`,
        })
      ).trim();
      interaction.signal.throwIfAborted();
      if (!key) throw new Error("Login cancelled: no API key entered");
      const deployment = await verify(
        picked,
        key,
        config,
        fetcher(),
        interaction,
      );
      useDeployment(config, deployment);
      return {
        type: "api_key",
        key,
        env: { [BASE_URL_KEY]: deployment.baseUrl },
      };
    },
    async resolve({ ctx, credential, signal }) {
      signal.throwIfAborted();
      if (credential?.key) {
        const deployment = storedDeployment(credential) ?? fromEnvironment;
        useDeployment(config, deployment);
        return {
          auth: { apiKey: credential.key, baseUrl: deployment.baseUrl },
          env: credential.env,
          source: "stored credential",
        };
      }
      const key = await ctx.env(API_KEY_ENV);
      signal.throwIfAborted();
      if (!key) return undefined;
      useDeployment(config, fromEnvironment);
      return {
        auth: { apiKey: key, baseUrl: fromEnvironment.baseUrl },
        source: API_KEY_ENV,
      };
    },
  };
}
