import { streamSimple, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import { OTARI_COMPAT, toProviderModel } from "../src/model-mapper.js";
import {
  createProviderCore,
  type ProviderDependencies,
} from "../src/provider-core.js";
import {
  createStreamOtari,
  type OtariDelegateStream,
} from "../src/stream-otari.js";
import type { OtariConfig, OtariModel } from "../src/types.js";

/**
 * Extension-owned API id for Otari models. Built-in API names are reserved;
 * the custom streamSimple delegates to omp's openai-completions stream after
 * rewriting the model's api, so Otari requests get the gateway behaviors
 * (conversation id, gateway tools, error explanations) on top of the stock
 * OpenAI-compatible transport.
 */
const OTARI_API = "otari-openai-completions";

/**
 * The provider-config apiKey. omp resolves it per request, together with
 * /login precedence, and hands the custom stream the resolved key. With the
 * variable unset it resolves to this literal text, which is no credential.
 */
const API_KEY_ENV = "OTARI_API_KEY";

/**
 * omp's own openai-completions transport. The api is rewritten so dispatch
 * reaches the stock streamer instead of re-entering the custom one; the
 * model's compat stays unresolved, so the streamer resolves the OpenAI wire
 * policy from the model's compat config (see toOmpModel).
 */
type OmpStreamArgs = Parameters<typeof streamSimple>;
const ompOpenAICompletions = ((
  model: OmpStreamArgs[0],
  context: OmpStreamArgs[1],
  options?: OmpStreamArgs[2],
) =>
  streamSimple(
    { ...model, api: "openai-completions" },
    context,
    options,
  )) as unknown as OtariDelegateStream;

function toOmpModel(model: OtariModel): ProviderModelConfig {
  // Field-by-field from the shared mapper: its return type carries Pi's
  // compat unions, which do not assign to omp's ProviderModelConfig.
  const base = toProviderModel(model);
  return {
    id: base.id,
    name: base.name,
    reasoning: base.reasoning,
    input: base.input,
    cost: base.cost,
    contextWindow: base.contextWindow,
    maxTokens: base.maxTokens,
    compat: OTARI_COMPAT,
    // Otari accepts Pi's thinking levels by name; omp's "effort" mode maps
    // the selected level onto the request's reasoning_effort unchanged.
    ...(base.reasoning
      ? { thinking: { mode: "effort" as const, efforts: THINKING_EFFORTS } }
      : {}),
  };
}

export interface OmpOtariProvider {
  /**
   * omp skips fetchDynamicModels while its model cache is fresh, which would
   * leave the catalog empty and every staleness check off for the session;
   * see ProviderCore.seedCatalog.
   */
  seedCatalog(apiKey: string | undefined): Promise<void>;
}

export function registerOtariProvider(
  pi: ExtensionAPI,
  config: OtariConfig,
  models: OtariModel[],
  dependencies: ProviderDependencies = {},
): OmpOtariProvider {
  const core = createProviderCore(config, models, dependencies);
  const credential = (apiKey: string | undefined) =>
    apiKey && apiKey !== API_KEY_ENV ? apiKey : config.token;
  pi.registerProvider("otari", {
    baseUrl: config.baseUrl,
    // Environment variable name, not a literal key. Because oauth is set, a
    // key stored with /login otari wins and this is only the fallback,
    // matching Pi's precedence.
    apiKey: API_KEY_ENV,
    api: OTARI_API,
    streamSimple: createStreamOtari(
      core.catalog,
      ompOpenAICompletions,
      core.wrapFetch,
    ) as unknown as NonNullable<ProviderConfig["streamSimple"]>,
    oauth: {
      name: "Otari",
      // API-key login, not OAuth: a masked prompt keeps the key out of the
      // transcript, and returning the string stores it as the credential.
      login: async (callbacks) => {
        const key = await callbacks.onPrompt({
          message: "Otari workspace API key",
          secret: true,
        });
        if (!key.trim()) throw new Error("Login cancelled: no API key entered");
        return key.trim();
      },
    },
    models: core.staticModels.map(toOmpModel),
    fetchDynamicModels: async (apiKey) =>
      (await core.discover(credential(apiKey))).map(toOmpModel),
  });

  return {
    seedCatalog: (apiKey) => core.seedCatalog(credential(apiKey)),
  };
}
