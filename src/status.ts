import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Catalog,
  describeStale,
  isStale,
  replacementsFor,
} from "./staleness.js";
import type { Diagnostic, RuntimeState } from "./types.js";

export interface LifecycleUI {
  /**
   * Show a discovery diagnostic through the UI captured from the most recent
   * session event. Pi reports a failed provider refresh as "Could not refresh
   * otari" without the underlying message, so the extension has to relay it.
   */
  reportDiagnostic(diagnostic: Diagnostic): void;
}

function updateStatus(
  ctx: ExtensionContext,
  provider: string | undefined,
  id: string | undefined,
): void {
  ctx.ui.setStatus(
    "pi-otari",
    provider === "otari" && id ? `Otari → ${id}` : undefined,
  );
}

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
): LifecycleUI {
  let ui: ExtensionContext["ui"] | undefined;
  const captureUI = (ctx: ExtensionContext) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
  };

  // Discovery is the authority on what Otari routes. Warn user when the
  // previously selected model is missing from the last discovered list.
  const warnIfStale = (
    ctx: ExtensionContext,
    model: { provider: string; id: string } | undefined,
  ) => {
    const baseUrl = getState().config?.baseUrl;
    if (!ctx.hasUI || !baseUrl || model?.provider !== "otari") return;
    if (!isStale(catalog, model.id)) return;
    ctx.ui.notify(
      describeStale(model.id, baseUrl, replacementsFor(model.id, catalog)),
      "warning",
    );
  };

  pi.on("model_select", (event, ctx) => {
    captureUI(ctx);
    updateStatus(ctx, event.model.provider, event.model.id);
    warnIfStale(ctx, event.model);
  });

  pi.on("session_start", async (_event, ctx) => {
    captureUI(ctx);
    updateStatus(ctx, ctx.model?.provider, ctx.model?.id);
    if (!ctx.hasUI) return;

    const error = getState().diagnostics.find((item) => item.level === "error");
    if (error) {
      ctx.ui.notify(error.message, "error");
      return;
    }

    // Discovery diagnostics arrive later through reportDiagnostic, once Pi
    // refreshes the catalog. The one thing we can check reliably at startup is
    // whether any credential (stored via /login or OTARI_API_KEY) exists.
    if (!(await isOtariConfigured(ctx))) {
      ctx.ui.notify(
        "No Otari credentials found.\n" +
          "Run /login otari to sign in, or set OTARI_API_KEY.",
        "warning",
      );
    }
    warnIfStale(ctx, ctx.model);
  });

  return {
    reportDiagnostic(diagnostic) {
      ui?.notify(diagnostic.message, diagnostic.level);
    },
  };
}
