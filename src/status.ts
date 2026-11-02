import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { GatewayToolState } from "./gateway-tools.js";
import { createLifecycle, type LifecycleUI } from "./lifecycle.js";
import type { Catalog } from "./staleness.js";
import type { RuntimeState } from "./types.js";

export type { LifecycleUI } from "./lifecycle.js";

async function isOtariConfigured(ctx: ExtensionContext): Promise<boolean> {
  try {
    return (await ctx.modelRegistry.getProviderAuth("otari")) !== undefined;
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

  pi.on("model_select", (event, ctx) => {
    lifecycle.selectModel(ctx, event.model);
  });

  pi.on("session_start", async (_event, ctx) => {
    await lifecycle.startSession(ctx, () => isOtariConfigured(ctx));
  });

  return lifecycle;
}
