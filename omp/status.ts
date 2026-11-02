import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { GatewayToolState } from "../src/gateway-tools.js";
import {
	type Catalog,
	describeStale,
	isStale,
	replacementsFor,
} from "../src/staleness.js";
import type { Diagnostic, RuntimeState } from "../src/types.js";

export interface LifecycleUI {
	/**
	 * Show a discovery diagnostic through the UI captured from the most recent
	 * session event. omp reports a failed provider refresh without the
	 * underlying message, so the extension has to relay it.
	 */
	reportDiagnostic(diagnostic: Diagnostic): void;
	/**
	 * Redraw the status line for the last selected model, for changes that
	 * arrive between session events (a tools probe or refusal).
	 */
	refreshStatus(): void;
}

function updateStatus(
	ctx: ExtensionContext,
	provider: string | undefined,
	id: string | undefined,
	gatewayTools: readonly GatewayToolState[] = [],
): void {
	const offered = gatewayTools
		.filter((state) => state.offered)
		.map((state) => ` · ${state.tool.label}`)
		.join("");
	ctx.ui.setStatus(
		"pi-otari",
		provider === "otari" && id ? `Otari → ${id}${offered}` : undefined,
	);
}

function isOtariConfigured(ctx: ExtensionContext): boolean {
	try {
		return ctx.modelRegistry.hasConcreteAuth("otari");
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
	let ui: ExtensionContext["ui"] | undefined;
	let shown:
		| { ctx: ExtensionContext; provider?: string; id?: string }
		| undefined;
	const captureUI = (ctx: ExtensionContext) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
	};
	const showStatus = (
		ctx: ExtensionContext,
		provider: string | undefined,
		id: string | undefined,
	) => {
		shown = { ctx, provider, id };
		updateStatus(ctx, provider, id, gatewayTools);
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

	// omp has no model_select event; turn_start is the first point a /model
	// switch is visible, and session_start covers the restored model.
	pi.on("turn_start", (_event, ctx) => {
		captureUI(ctx);
		showStatus(ctx, ctx.model?.provider, ctx.model?.id);
		warnIfStale(ctx, ctx.model);
	});

	pi.on("session_start", (_event, ctx) => {
		captureUI(ctx);
		showStatus(ctx, ctx.model?.provider, ctx.model?.id);
		if (!ctx.hasUI) return;

		const error = getState().diagnostics.find((item) => item.level === "error");
		if (error) {
			ctx.ui.notify(error.message, "error");
			return;
		}

		// Discovery diagnostics arrive later through reportDiagnostic, once omp
		// refreshes the catalog. The one thing we can check reliably at startup
		// is whether any credential (stored via /login or OTARI_API_KEY) exists.
		if (!isOtariConfigured(ctx)) {
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
		refreshStatus() {
			if (shown)
				updateStatus(shown.ctx, shown.provider, shown.id, gatewayTools);
		},
	};
}
