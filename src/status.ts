import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
): LifecycleUI {
  let ui: ExtensionContext["ui"] | undefined;
  const captureUI = (ctx: ExtensionContext) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
  };

  pi.on("model_select", (event, ctx) => {
    captureUI(ctx);
    updateStatus(ctx, event.model.provider, event.model.id);
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
  });

  return {
    reportDiagnostic(diagnostic) {
      ui?.notify(diagnostic.message, diagnostic.level);
    },
  };
}
