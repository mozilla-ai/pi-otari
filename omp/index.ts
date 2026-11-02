import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ConfigError, loadOtariConfig } from "../src/config.js";
import { GATEWAY_TOOLS, GatewayToolState } from "../src/gateway-tools.js";
import type { Catalog } from "../src/staleness.js";
import type { OtariConfig, RuntimeState } from "../src/types.js";
import { registerGuardrails } from "./guardrails.js";
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
  // Created before any config check so the status line and the provider share
  // one answer to "which tools does this deployment run for us".
  const gatewayTools = GATEWAY_TOOLS.map(
    (tool) => new GatewayToolState(tool, () => ui.refreshStatus()),
  );
  const ui = registerLifecycleUI(pi, () => state, catalog, gatewayTools);
  // Guardrails do not depend on Otari model routing, so they are registered
  // before the config check below can return early.
  registerGuardrails(pi);

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

  const provider = registerOtariProvider(pi, config, [], {
    catalog,
    gatewayTools,
    onDiagnostic: (diagnostic) => ui.reportDiagnostic(diagnostic),
  });
  state = { ...state, config };
  // Sessions served from omp's model cache never run discovery; fill the
  // catalog in the background so staleness checks work, then check the
  // restored model against it.
  pi.on("session_start", (_event, ctx) => {
    if (catalog.size > 0) return;
    void ctx.modelRegistry
      .getApiKeyForProvider("otari")
      .catch(() => undefined)
      .then((apiKey) => provider.seedCatalog(apiKey))
      .then(() => ui.recheckModel());
  });
}
