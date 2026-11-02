import { DiscoveryUnavailableError, discoverModels } from "./discovery.js";
import {
  GATEWAY_TOOLS,
  GatewayToolState,
  probeGatewayTools,
  wrapFetchWithGatewayTools,
} from "./gateway-tools.js";
import { selectorsToModels } from "./model-mapper.js";
import {
  type Catalog,
  describeStale,
  isStale,
  replacementsFor,
} from "./staleness.js";
import type { Diagnostic, OtariConfig, OtariModel } from "./types.js";

export interface ProviderDependencies {
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
}

/**
 * The host-independent half of the Otari provider. Each host's provider.ts
 * maps these models into its own registration and wires the hooks to its own
 * refresh and request paths.
 */
export interface ProviderCore {
  /** The models passed in, merged by id with the OTARI_MODELS selectors. */
  staticModels: OtariModel[];
  catalog: Catalog;
  /** Decorates the request fetch to declare Otari's gateway tools, if any. */
  wrapFetch: ((inner: typeof fetch) => typeof fetch) | undefined;
  /** Replace the catalog with a known list, such as the last discovery. */
  setCatalog(ids: Iterable<string>): void;
  /**
   * Discover Otari's models with `token`, refreshing the catalog and the
   * gateway tools and reporting diagnostics. Rejects when discovery fails.
   */
  discover(token: string | undefined): Promise<OtariModel[]>;
  /**
   * Fill the catalog from Otari when nothing has filled it yet, for hosts
   * that may skip discovery on a cached model list. Resolves once the catalog
   * is filled or discovery has failed; failures stay quiet, since the host's
   * own refresh reports them.
   */
  seedCatalog(token: string | undefined): Promise<void>;
}

export function createProviderCore(
  config: OtariConfig,
  models: OtariModel[],
  dependencies: ProviderDependencies = {},
): ProviderCore {
  const staticModels = [
    ...new Map(
      [...models, ...selectorsToModels(config.environmentModels)].map(
        (model) => [model.id, model],
      ),
    ).values(),
  ];
  const catalog = dependencies.catalog ?? new Set<string>();
  // Looked up per call, so a fetch swapped in after registration is used.
  const fetcher = () => dependencies.fetch ?? fetch;
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
  const setCatalog = (ids: Iterable<string>) => {
    catalog.clear();
    for (const id of ids) catalog.add(id);
  };
  const discovered = (result: { models: OtariModel[] }) => {
    setCatalog(result.models.map((model) => model.id));
    reportStaleSelectors();
  };
  const discoverWith = (token: string | undefined) =>
    discoverModels({ ...config, token, environmentModels: [] }, fetcher());

  let seeding: Promise<void> | undefined;

  return {
    staticModels,
    catalog,
    wrapFetch:
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
    setCatalog,
    async discover(token) {
      // Probe alongside discovery so a slow /tools never adds its own timeout
      // to the refresh. probeGatewayTools never rejects; its answer is only
      // applied once discovery has succeeded.
      const probe =
        gatewayTools.length > 0
          ? probeGatewayTools(config, token, fetcher())
          : undefined;
      try {
        const result = await discoverWith(token);
        for (const diagnostic of result.diagnostics)
          dependencies.onDiagnostic?.(diagnostic);
        discovered(result);
        if (probe) {
          const availability = await probe;
          for (const state of gatewayTools)
            state.probed(availability(state.tool.id));
        }
        return result.models;
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError)
          dependencies.onDiagnostic?.(error.diagnostic);
        throw error;
      }
    },
    seedCatalog(token) {
      if (catalog.size > 0) return Promise.resolve();
      seeding ??= discoverWith(token)
        .then((result) => {
          // A refresh that answered meanwhile is the newer list.
          if (catalog.size === 0) discovered(result);
        })
        .catch(() => {})
        .finally(() => {
          seeding = undefined;
        });
      return seeding;
    },
  };
}
