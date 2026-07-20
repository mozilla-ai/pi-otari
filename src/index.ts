import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readModelCache, writeModelCache } from "./cache.js";
import { ConfigError, loadOtariConfig } from "./config.js";
import { discoverModels } from "./discovery.js";
import { registerOtariProvider } from "./provider.js";
import { registerLifecycleUI } from "./status.js";
import type { Diagnostic, RuntimeState } from "./types.js";

export interface ExtensionDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  agentDir?: () => string;
}

export function createOtariExtension(dependencies: ExtensionDependencies = {}): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    let state: RuntimeState = {
      models: [],
      diagnostics: [],
      discoverySource: "none",
    };
    registerLifecycleUI(pi, () => state);

    let config;
    try {
      config = loadOtariConfig(dependencies.env ?? process.env);
    } catch (error) {
      const message = error instanceof ConfigError
        ? error.message
        : "Invalid Pi–Otari configuration";
      state = {
        models: [],
        discoverySource: "none",
        diagnostics: [{
          level: "error",
          code: "config-invalid",
          message,
        }],
      };
      return;
    }

    const agentDir = (dependencies.agentDir ?? getAgentDir)();
    const cacheResult = await readModelCache(agentDir);
    const discovery = await discoverModels(
      config,
      cacheResult.cache,
      dependencies.fetch ?? fetch,
    );
    const diagnostics: Diagnostic[] = [
      ...(cacheResult.diagnostic ? [cacheResult.diagnostic] : []),
      ...discovery.diagnostics,
    ];

    if (discovery.cacheUpdate !== undefined) {
      try {
        await writeModelCache(agentDir, discovery.cacheUpdate);
      } catch {
        diagnostics.push({
          level: "warning",
          code: "cache-write",
          message: "Could not update the Pi–Otari model cache",
        });
      }
    }

    registerOtariProvider(pi, config, discovery.models);
    state = {
      config,
      models: discovery.models,
      diagnostics,
      discoverySource: discovery.source,
    };
  };
}

export default createOtariExtension();
