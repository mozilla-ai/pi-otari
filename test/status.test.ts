import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerLifecycleUI } from "../src/status.js";
import type { RuntimeState } from "../src/types.js";

function harness(state: RuntimeState) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
    ),
  } as unknown as ExtensionAPI;
  registerLifecycleUI(pi, () => state);
  return { handlers };
}

function context(options?: {
  model?: { provider: string; id: string };
  auth?: unknown;
  authError?: Error;
}) {
  return {
    model: options?.model,
    hasUI: true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    modelRegistry: {
      getProviderAuth: vi.fn(async () => {
        if (options?.authError) throw options.authError;
        // Default: a configured credential unless a test opts into "unconfigured".
        return "auth" in (options ?? {}) ? options?.auth : { auth: {} };
      }),
    },
  };
}

describe("lifecycle UI", () => {
  it("shows routing status only for Otari models", async () => {
    const { handlers } = harness({
      models: [],
      diagnostics: [],
      discoverySource: "none",
    });
    const ctx = context();
    await handlers.get("model_select")?.(
      { model: { provider: "otari", id: "anthropic:claude" } },
      ctx,
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-otari",
      "Otari → anthropic:claude",
    );
    await handlers.get("model_select")?.(
      { model: { provider: "openai", id: "gpt" } },
      ctx,
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-otari", undefined);
  });

  it("prompts for login when no Otari credentials are configured", async () => {
    const { handlers } = harness({
      models: [],
      diagnostics: [],
      discoverySource: "none",
    });
    const ctx = context({ auth: undefined });
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(ctx.modelRegistry.getProviderAuth).toHaveBeenCalledWith("otari");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/login otari"),
      "warning",
    );
  });

  it("stays quiet when a credential is already configured", async () => {
    const { handlers } = harness({
      models: [],
      diagnostics: [],
      discoverySource: "none",
    });
    const ctx = context();
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not nag when the credential check fails transiently", async () => {
    const { handlers } = harness({
      models: [],
      diagnostics: [],
      discoverySource: "none",
    });
    const ctx = context({ authError: new Error("store unavailable") });
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("surfaces a configuration error and skips the login prompt", async () => {
    const { handlers } = harness({
      models: [],
      diagnostics: [
        { level: "error", code: "config-invalid", message: "bad base url" },
      ],
      discoverySource: "none",
    });
    const ctx = context({ auth: undefined });
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("bad base url", "error");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });

  it("does not show a success notification", async () => {
    const { handlers } = harness({
      models: [{ id: "mzai:model", source: "managed-catalog" }],
      diagnostics: [],
      discoverySource: "managed-catalog",
    });
    const ctx = context({ model: { provider: "otari", id: "mzai:model" } });
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-otari",
      "Otari → mzai:model",
    );
  });
});
