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

function context(model?: { provider: string; id: string }) {
  return {
    model,
    hasUI: true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
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

  it("notifies once when no models are available", async () => {
    const { handlers } = harness({
      models: [],
      diagnostics: [],
      discoverySource: "none",
    });
    const ctx = context();
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("OTARI_MODELS"),
      "warning",
    );
  });

  it("does not show a success notification", async () => {
    const { handlers } = harness({
      models: [{ id: "mzai:model", source: "managed-catalog" }],
      diagnostics: [],
      discoverySource: "managed-catalog",
    });
    const ctx = context({ provider: "otari", id: "mzai:model" });
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-otari",
      "Otari → mzai:model",
    );
  });
});
