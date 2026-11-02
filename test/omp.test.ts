import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerOtariProvider } from "../omp/provider.js";
import { registerLifecycleUI } from "../omp/status.js";
import type { Catalog } from "../src/staleness.js";
import type { OtariConfig, RuntimeState } from "../src/types.js";

// omp's pi-ai needs Bun at import time; the provider only uses these two.
const streamSimple = vi.hoisted(() => vi.fn());
vi.mock("@oh-my-pi/pi-ai", () => ({
  streamSimple,
  THINKING_EFFORTS: ["minimal", "low", "medium", "high", "xhigh"],
}));

const config: OtariConfig = {
  baseUrl: "https://api.otari.ai/api/v1",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
  webSearch: false,
  webFetch: false,
};

function modelsResponse(ids: string[]) {
  return new Response(
    JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function registerProvider(
  overrides: Partial<OtariConfig> = {},
  fetcher: typeof fetch = vi.fn(async () => modelsResponse(["openai:gpt-5"])),
) {
  const registerProvider = vi.fn();
  const pi = { registerProvider } as unknown as ExtensionAPI;
  const catalog: Catalog = new Set();
  const provider = registerOtariProvider(pi, { ...config, ...overrides }, [], {
    catalog,
    fetch: fetcher,
  });
  const providerConfig = registerProvider.mock.calls[0][1] as ProviderConfig;
  return { provider, providerConfig, catalog, fetcher };
}

describe("omp provider", () => {
  it("registers Otari's OpenAI wire settings on every model", () => {
    const { providerConfig } = registerProvider({
      environmentModels: ["openai:gpt-5"],
    });
    expect(providerConfig.models?.[0].compat).toEqual({
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
    });
  });

  it("streams through omp's openai-completions transport with the key omp resolved", () => {
    const { providerConfig } = registerProvider();
    streamSimple.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
    });
    providerConfig.streamSimple?.(
      {
        id: "openai:gpt-5",
        provider: "otari",
        api: "otari-openai-completions",
      } as never,
      { messages: [] } as never,
      { apiKey: "stored-key" } as never,
    );
    expect(streamSimple).toHaveBeenCalledOnce();
    const [model, , options] = streamSimple.mock.calls[0];
    expect(model.api).toBe("openai-completions");
    expect(options.apiKey).toBe("stored-key");
  });

  it("seeds an empty catalog from Otari when omp skips discovery", async () => {
    const { provider, catalog, fetcher } = registerProvider();
    await provider.seedCatalog("key");
    expect([...catalog]).toEqual(["openai:gpt-5"]);
    const headers = new Headers(vi.mocked(fetcher).mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer key");
  });

  it("does not send the unset env-var name as a key", async () => {
    const { provider, fetcher } = registerProvider();
    await provider.seedCatalog("OTARI_API_KEY");
    // With no key, discovery against the hosted gateway is not attempted.
    for (const [, init] of vi.mocked(fetcher).mock.calls)
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("leaves a filled catalog alone and swallows seeding failures", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    const { provider, catalog } = registerProvider({}, failing);
    await expect(provider.seedCatalog("key")).resolves.toBeUndefined();
    expect(catalog.size).toBe(0);
    catalog.add("openai:gpt-5");
    await provider.seedCatalog("key");
    expect(failing).toHaveBeenCalledOnce();
  });
});

function lifecycle(state: RuntimeState, catalog: Catalog = new Set()) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
    ),
  } as unknown as ExtensionAPI;
  const ui = registerLifecycleUI(pi, () => state, catalog);
  return { handlers, ui };
}

function context(options: {
  model?: { provider: string; id: string };
  source?: { kind: string };
}) {
  return {
    model: options.model,
    hasUI: true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    modelRegistry: {
      authStorage: { keys: { source: vi.fn(() => options.source) } },
    },
  };
}

const state = (token?: string): RuntimeState => ({
  models: [],
  diagnostics: [],
  discoverySource: "none",
  config: { ...config, token },
});

describe("omp lifecycle UI", () => {
  it("warns about missing credentials even though the provider has an apiKey config", async () => {
    const { handlers } = lifecycle(state());
    // omp reports the env-var name config as a "config" source.
    const ctx = context({ source: { kind: "config" } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No Otari credentials found"),
      "warning",
    );
  });

  it("stays quiet with OTARI_API_KEY set or a /login key stored", async () => {
    for (const [token, kind] of [
      ["env-key", "config"],
      [undefined, "api_key"],
      [undefined, "oauth"],
    ] as const) {
      const { handlers } = lifecycle(state(token));
      const ctx = context({ source: { kind } });
      await handlers.get("session_start")?.({}, ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    }
  });

  it("warns about a stale model once per selection, not every turn", () => {
    const catalog: Catalog = new Set(["openai:gpt-5"]);
    const { handlers } = lifecycle(state("key"), catalog);
    const stale = context({ model: { provider: "otari", id: "openai:old" } });
    for (let i = 0; i < 3; i++) handlers.get("turn_start")?.({}, stale);
    expect(stale.ui.notify).toHaveBeenCalledOnce();

    const fresh = context({ model: { provider: "otari", id: "openai:gpt-5" } });
    handlers.get("turn_start")?.({}, fresh);
    handlers.get("turn_start")?.({}, stale);
    expect(stale.ui.notify).toHaveBeenCalledTimes(2);
  });

  it("checks the restored model again once the catalog fills", async () => {
    const catalog: Catalog = new Set();
    const { handlers, ui } = lifecycle(state("key"), catalog);
    const ctx = context({ model: { provider: "otari", id: "openai:old" } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    catalog.add("openai:gpt-5");
    ui.recheckModel();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("openai:old"),
      "warning",
    );
  });

  it("shows a diagnostic reported before the session started", async () => {
    const { handlers, ui } = lifecycle(state("key"));
    ui.reportDiagnostic({
      level: "warning",
      code: "selector-stale",
      message: "early",
    });
    const ctx = context({ source: { kind: "api_key" } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("early", "warning");
  });
});
