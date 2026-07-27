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
    const warning = state.diagnostics.find((item) => item.level === "warning");
    if (warning) ctx.ui.notify(warning.message, "warning");
  });
}
