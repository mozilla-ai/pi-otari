import {
  type ExtensionAPI,
  type ExtensionFactory,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { ConfigError, loadOtariConfig } from "./config.js";
import type { Catalog } from "./staleness.js";
import { registerLifecycleUI } from "./status.js";
import type { OtariConfig, RuntimeState } from "./types.js";

const MINIMUM_PI_VERSION = [0, 81, 0] as const;
// Subagent routing reads its settings with pi.getSettings(), added in 0.99.0.
const ROUTING_PI_VERSION = [0, 99, 0] as const;

function isAtLeast(version: string, minimum: readonly number[]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) {
      return actual[index] > minimum[index];
    }
  }
  return !version.slice(match[0].length).startsWith("-");
}

export interface ExtensionDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  piVersion?: string;
}

export function createOtariExtension(
  dependencies: ExtensionDependencies = {},
): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    let state: RuntimeState = {
      models: [],
      diagnostics: [],
      discoverySource: "none",
    };
    const catalog: Catalog = new Set();
    const ui = registerLifecycleUI(pi, () => state, catalog);

    const piVersion = dependencies.piVersion ?? VERSION;
    if (!isAtLeast(piVersion, MINIMUM_PI_VERSION)) {
      state = {
        models: [],
        discoverySource: "none",
        diagnostics: [
          {
            level: "error",
            code: "pi-version",
            message: "pi-otari requires Pi 0.81.0 or newer. Run `pi update`.",
          },
        ],
      };
      return;
    }

    let config: OtariConfig;
    try {
      config = loadOtariConfig(dependencies.env ?? process.env);
    } catch (error) {
      const message =
        error instanceof ConfigError
          ? error.message
          : "Invalid Pi–Otari configuration";
      state = {
        models: [],
        discoverySource: "none",
        diagnostics: [
          {
            level: "error",
            code: "config-invalid",
            message,
          },
        ],
      };
      return;
    }

    const [{ registerOtariProvider }, routing] = await Promise.all([
      import("./provider.js"),
      isAtLeast(piVersion, ROUTING_PI_VERSION)
        ? import("./subagent-routing.js")
        : undefined,
    ]);
    registerOtariProvider(pi, config, [], {
      fetch: dependencies.fetch ?? fetch,
      onDiagnostic: (diagnostic) => ui.reportDiagnostic(diagnostic),
      catalog,
    });
    routing?.registerSubagentRouting(pi, config, {
      fetch: dependencies.fetch ?? fetch,
    });
    state = { ...state, config };
  };
}

export default createOtariExtension();
