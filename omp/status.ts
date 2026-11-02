import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { GatewayToolState } from "../src/gateway-tools.js";
import { createLifecycle, type LifecycleUI } from "../src/lifecycle.js";
import type { Catalog } from "../src/staleness.js";
import type { RuntimeState } from "../src/types.js";

/**
 * Whether the user has an Otari credential: OTARI_API_KEY or a key stored with
 * /login otari. hasConcreteAuth cannot answer this, since the provider's
 * apiKey (an env-var name) counts as a configured key whether or not the
 * variable is set.
 */
function isOtariConfigured(
  ctx: ExtensionContext,
  token: string | undefined,
): boolean {
  if (token) return true;
  try {
    const kind = ctx.modelRegistry.authStorage.keys.source("otari")?.kind;
    return kind === "oauth" || kind === "api_key" || kind === "runtime";
  } catch {
    // A transient credential-store error is not evidence of missing auth;
    // stay quiet rather than nag a user who may already be logged in.
    return true;
  }
}

export function registerLifecycleUI(
  pi: ExtensionAPI,
  getState: () => RuntimeState,
  catalog: Catalog,
  gatewayTools: readonly GatewayToolState[] = [],
): LifecycleUI {
  const lifecycle = createLifecycle(getState, catalog, gatewayTools);

  // omp has no model_select event; turn_start is the first point a /model
  // switch is visible. It fires on every turn, so a stale model is warned
  // about once until the selection changes.
  pi.on("turn_start", (_event, ctx) => {
    lifecycle.showModel(ctx, ctx.model);
  });

  pi.on("session_start", async (_event, ctx) => {
    await lifecycle.startSession(ctx, () =>
      isOtariConfigured(ctx, getState().config?.token),
    );
  });

  return lifecycle;
}
