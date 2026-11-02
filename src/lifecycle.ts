import type { GatewayToolState } from "./gateway-tools.js";
import {
  type Catalog,
  describeStale,
  isStale,
  replacementsFor,
} from "./staleness.js";
import type { Diagnostic, RuntimeState } from "./types.js";

/**
 * The slice of a session event context the lifecycle UI uses. Pi and omp
 * contexts both satisfy it, so the behavior lives here and each host only
 * wires its own events.
 */
export interface LifecycleContext {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
  model?: { provider: string; id: string };
}

type SelectedModel = { provider?: string; id?: string } | undefined;

export interface LifecycleUI {
  /**
   * Show a discovery diagnostic through the UI captured from the most recent
   * session event. Neither host reports a failed provider refresh with the
   * underlying message, so the extension has to relay it.
   */
  reportDiagnostic(diagnostic: Diagnostic): void;
  /**
   * Redraw the status line for the last selected model, for changes that
   * arrive between session events (a tools probe or refusal).
   */
  refreshStatus(): void;
  /**
   * Check the last shown model against the catalog again, for a catalog
   * that fills after the session started.
   */
  recheckModel(): void;
}

/** What a host's event wiring calls into; see src/status.ts and omp/status.ts. */
export interface LifecycleCore extends LifecycleUI {
  /**
   * A model was explicitly selected: show it and warn when it is stale, even
   * if it was warned about before.
   */
  selectModel(ctx: LifecycleContext, model: SelectedModel): void;
  /**
   * The current model may have changed: show it and warn when it is stale,
   * unless that stale model is the one last warned about.
   */
  showModel(ctx: LifecycleContext, model: SelectedModel): void;
  /**
   * Session start: show the restored model, then report a configuration
   * error, missing credentials, or a stale restored model.
   */
  startSession(
    ctx: LifecycleContext,
    hasCredential: () => boolean | Promise<boolean>,
  ): Promise<void>;
}

export function createLifecycle(
  getState: () => RuntimeState,
  catalog: Catalog,
  gatewayTools: readonly GatewayToolState[] = [],
): LifecycleCore {
  let ui: LifecycleContext["ui"] | undefined;
  // Diagnostics that arrive before any session event has shown a UI, such as
  // a discovery the host runs before session_start; shown once one has.
  let pending: Diagnostic[] | undefined = [];
  let shown:
    | { ctx: LifecycleContext; provider?: string; id?: string }
    | undefined;
  let warned: string | undefined;

  const updateStatus = () => {
    if (!shown) return;
    const { ctx, provider, id } = shown;
    const offered = gatewayTools
      .filter((state) => state.offered)
      .map((state) => ` · ${state.tool.label}`)
      .join("");
    ctx.ui.setStatus(
      "pi-otari",
      provider === "otari" && id ? `Otari → ${id}${offered}` : undefined,
    );
  };
  const show = (ctx: LifecycleContext, model: SelectedModel) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
    if (ui && pending) {
      for (const diagnostic of pending)
        ui.notify(diagnostic.message, diagnostic.level);
      pending = undefined;
    }
    shown = { ctx, provider: model?.provider, id: model?.id };
    updateStatus();
  };

  // Discovery is the authority on what Otari routes. Warn user when the
  // selected model is missing from the last discovered list, remembering the
  // stale model last warned about so a repeated check stays quiet.
  const warnIfStale = (ctx: LifecycleContext, model: SelectedModel) => {
    const baseUrl = getState().config?.baseUrl;
    if (
      model?.provider !== "otari" ||
      !model.id ||
      !isStale(catalog, model.id)
    ) {
      warned = undefined;
      return;
    }
    if (!ctx.hasUI || !baseUrl || warned === model.id) return;
    warned = model.id;
    ctx.ui.notify(
      describeStale(model.id, baseUrl, replacementsFor(model.id, catalog)),
      "warning",
    );
  };

  return {
    selectModel(ctx, model) {
      show(ctx, model);
      warned = undefined;
      warnIfStale(ctx, model);
    },
    showModel(ctx, model) {
      show(ctx, model);
      warnIfStale(ctx, model);
    },
    async startSession(ctx, hasCredential) {
      show(ctx, ctx.model);
      if (!ctx.hasUI) return;

      const error = getState().diagnostics.find(
        (item) => item.level === "error",
      );
      if (error) {
        ctx.ui.notify(error.message, "error");
        return;
      }

      // Discovery diagnostics arrive later through reportDiagnostic, once the
      // host refreshes the catalog. The one thing we can check reliably at
      // startup is whether any credential (stored via /login or
      // OTARI_API_KEY) exists.
      if (!(await hasCredential())) {
        ctx.ui.notify(
          "No Otari credentials found.\n" +
            "Run /login otari to sign in, or set OTARI_API_KEY.",
          "warning",
        );
      }
      warned = undefined;
      warnIfStale(ctx, ctx.model);
    },
    reportDiagnostic(diagnostic) {
      if (ui) ui.notify(diagnostic.message, diagnostic.level);
      else pending?.push(diagnostic);
    },
    refreshStatus: updateStatus,
    recheckModel() {
      if (shown) warnIfStale(shown.ctx, shown);
    },
  };
}
