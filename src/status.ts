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

export function registerLifecycleUI(
  pi: ExtensionAPI,
  getState: () => RuntimeState,
): void {
  pi.on("model_select", (event, ctx) => {
    updateStatus(ctx, event.model.provider, event.model.id);
  });

  pi.on("session_start", (_event, ctx) => {
    updateStatus(ctx, ctx.model?.provider, ctx.model?.id);
    if (!ctx.hasUI) return;

    const state = getState();
    const error = state.diagnostics.find((item) => item.level === "error");
    if (error) {
      ctx.ui.notify(error.message, "error");
      return;
    }
    if (state.models.length === 0) {
      ctx.ui.notify(
        "Pi–Otari found no available models.\n" +
          "Set OTARI_MODELS to one or more Otari selectors, then run /reload.\n" +
          'Example: OTARI_MODELS="anthropic:claude-sonnet-4-6"',
        "warning",
      );
      return;
    }
    const warning = state.diagnostics.find((item) => item.level === "warning");
    if (warning) ctx.ui.notify(warning.message, "warning");
  });
}
