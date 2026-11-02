import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { ConfigError, loadOtariConfig } from "../src/config.js";
import { GATEWAY_TOOLS, GatewayToolState } from "../src/gateway-tools.js";
import type { Catalog } from "../src/staleness.js";
import type { OtariConfig, RuntimeState } from "../src/types.js";
import { registerOtariProvider } from "./provider.js";
import { registerLifecycleUI } from "./status.js";

/**
 * omp entry point for the Otari extension. package.json declares it under
 * `omp.extensions`, which omp prefers over the Pi manifest's `pi.extensions`;
 * Pi never loads this file. Host-independent logic (config, discovery,
 * staleness, gateway tools, the stream wrapper) is shared with the Pi entry
 * under src/.
 */
export default function otariExtension(pi: ExtensionAPI): void {
	pi.setLabel("Otari");
	let state: RuntimeState = {
		models: [],
		diagnostics: [],
		discoverySource: "none",
	};
	const catalog: Catalog = new Set();
	// The request path resolves Otari credentials through the registry (see
	// provider.ts); capture it from the first session that has one.
	let registry: ExtensionContext["modelRegistry"] | undefined;
	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});
	// Created before any config check so the status line and the provider share
	// one answer to "which tools does this deployment run for us".
	const gatewayTools = GATEWAY_TOOLS.map(
		(tool) => new GatewayToolState(tool, () => ui.refreshStatus()),
	);
	const ui = registerLifecycleUI(pi, () => state, catalog, gatewayTools);

	let config: OtariConfig;
	try {
		config = loadOtariConfig(process.env);
	} catch (error) {
		const message =
			error instanceof ConfigError
				? error.message
				: "Invalid omp–Otari configuration";
		state = {
			models: [],
			discoverySource: "none",
			diagnostics: [{ level: "error", code: "config", message }],
		};
		return;
	}

	registerOtariProvider(pi, config, [], {
		catalog,
		gatewayTools,
		getRegistry: () => registry,
		onDiagnostic: (diagnostic) => ui.reportDiagnostic(diagnostic),
	});
	state = { ...state, config };
}
