import {
  type ExtensionAPI,
  type ExtensionFactory,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { ConfigError, loadOtariConfig } from "./config.js";
import { registerLifecycleUI } from "./status.js";
import type { OtariConfig, RuntimeState } from "./types.js";

const MINIMUM_PI_VERSION = [0, 81, 0] as const;

function supportsNativeProviderAuth(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_PI_VERSION.length; index += 1) {
    if (actual[index] !== MINIMUM_PI_VERSION[index]) {
      return actual[index] > MINIMUM_PI_VERSION[index];
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
    registerLifecycleUI(pi, () => state);

    if (!supportsNativeProviderAuth(dependencies.piVersion ?? VERSION)) {
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

    const { registerOtariProvider } = await import("./provider.js");
    registerOtariProvider(pi, config, [], {
      fetch: dependencies.fetch ?? fetch,
    });
    state = { ...state, config };
  };
}

export default createOtariExtension();
