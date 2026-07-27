import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeState } from "./types.js";

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
): void {
  pi.on("model_select", (event, ctx) => {
    updateStatus(ctx, event.model.provider, event.model.id);
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, ctx.model?.provider, ctx.model?.id);
    if (!ctx.hasUI) return;

    const error = getState().diagnostics.find((item) => item.level === "error");
    if (error) {
      ctx.ui.notify(error.message, "error");
      return;
    }

    // Discovery diagnostics are surfaced natively by Pi's model refresh, which
    // runs after this event. The one thing we can check reliably at startup is
    // whether any credential (stored via /login or OTARI_API_KEY) exists.
    if (!(await isOtariConfigured(ctx))) {
      ctx.ui.notify(
        "No Otari credentials found.\n" +
          "Run /login otari to sign in, or set OTARI_API_KEY.",
        "warning",
      );
    }
  });
}
