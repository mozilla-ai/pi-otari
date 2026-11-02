import { type ApiKeyResolver, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import { DiscoveryUnavailableError, discoverModels } from "../src/discovery.js";
import {
	GATEWAY_TOOLS,
	GatewayToolState,
	probeGatewayTools,
	wrapFetchWithGatewayTools,
} from "../src/gateway-tools.js";
import { selectorsToModels, toProviderModel } from "../src/model-mapper.js";
import {
	type Catalog,
	describeStale,
	isStale,
	replacementsFor,
} from "../src/staleness.js";
import { createStreamOtari } from "../src/stream-otari.js";
import type { Diagnostic, OtariConfig, OtariModel } from "../src/types.js";

/**
 * Extension-owned API id for Otari models. Built-in API names are reserved;
 * the custom streamSimple delegates to omp's openai-completions stream after
 * rewriting the model's api, so Otari requests get the gateway behaviors
 * (conversation id, gateway tools, error explanations) on top of the stock
 * OpenAI-compatible transport.
 */
const OTARI_API = "otari-openai-completions";

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
		// Otari accepts Pi's thinking levels by name; omp's "effort" mode maps
		// the selected level onto the request's reasoning_effort unchanged.
		...(base.reasoning
			? { thinking: { mode: "effort" as const, efforts: THINKING_EFFORTS } }
			: {}),
	};
}

export interface OmpProviderDependencies {
	fetch?: typeof fetch;
	/** Receives every discovery diagnostic, whether returned or thrown. */
	onDiagnostic?: (diagnostic: Diagnostic) => void;
	/** Kept in step with each discovery; see staleness.ts. */
	catalog?: Catalog;
	/**
	 * Shared with the request path; each successful discovery refreshes the
	 * ones the config enables.
	 */
	gatewayTools?: readonly GatewayToolState[];
	/**
	 * The session's model registry, captured from the first session event.
	 * Custom stream handlers receive the provider-config apiKey as a literal
	 * string, so the request path resolves credentials through the registry
	 * instead: env-var resolution and /login precedence included.
	 */
	getRegistry?: () => ExtensionContext["modelRegistry"] | undefined;
}

export function registerOtariProvider(
	pi: ExtensionAPI,
	config: OtariConfig,
	models: OtariModel[],
	dependencies: OmpProviderDependencies = {},
): void {
	const staticModels = [
		...new Map(
			[...models, ...selectorsToModels(config.environmentModels)].map(
				(model) => [model.id, model],
			),
		).values(),
	];
	const catalog = dependencies.catalog ?? new Set<string>();
	const gatewayTools = (
		dependencies.gatewayTools ??
		GATEWAY_TOOLS.map((tool) => new GatewayToolState(tool))
	).filter((state) => config[state.tool.configKey]);
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
	pi.registerProvider("otari", {
		baseUrl: config.baseUrl,
		// Environment variable name, not a literal key. Because oauth is set, a
		// key stored with /login otari wins and this is only the fallback,
		// matching Pi's precedence.
		apiKey: "OTARI_API_KEY",
		api: OTARI_API,
		streamSimple: createStreamOtari(
			catalog,
			gatewayTools.length > 0
				? (inner) =>
						wrapFetchWithGatewayTools(inner, {
							baseUrl: config.baseUrl,
							tools: gatewayTools,
							onRefused: (tool, reason) =>
								dependencies.onDiagnostic?.({
									level: "warning",
									code: `${tool.id.replace(/^otari_/, "").replaceAll("_", "-")}-refused`,
									message: `Otari refused its ${tool.label} tool: ${reason.replace(/\.?$/, ".")} The request was retried without ${tool.label}, which stays off until the next model refresh. Set ${tool.setting}=off to stop declaring it.`,
								}),
						})
				: undefined,
			// Invoked by omp's auth layer for each request attempt. A stored
			// /login otari key wins over OTARI_API_KEY; without either, the
			// attempt fails with the usual missing-key error.
			(async () =>
				(await dependencies
					.getRegistry?.()
					?.getApiKeyForProvider("otari")) ?? config.token) as ApiKeyResolver,
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
		models: staticModels.map(toOmpModel),
		fetchDynamicModels: async (apiKey) => {
			const token = apiKey ?? config.token;
			const fetcher = dependencies.fetch ?? fetch;
			// Probe alongside discovery so a slow /tools never adds its own timeout
			// to the refresh. probeGatewayTools never rejects; its answer is only
			// applied once discovery has succeeded.
			const probe =
				gatewayTools.length > 0
					? probeGatewayTools(config, token, fetcher)
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
				if (probe) {
					const availability = await probe;
					for (const state of gatewayTools)
						state.probed(availability(state.tool.id));
				}
				return result.models.map(toOmpModel);
			} catch (error) {
				if (error instanceof DiscoveryUnavailableError)
					dependencies.onDiagnostic?.(error.diagnostic);
				throw error;
			}
		},
	});
}
