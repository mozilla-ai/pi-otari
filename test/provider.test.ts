import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadOtariConfig } from "../src/config.js";
import { registerOtariProvider } from "../src/provider.js";
import type { OtariConfig } from "../src/types.js";

const config: OtariConfig = {
  baseUrl: "https://api.otari.ai/api/v1",
  token: "tk_not_forwarded_to_registration",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
};

function fakePi(): ExtensionAPI {
  return { registerProvider: vi.fn() } as unknown as ExtensionAPI;
}

function registeredProvider(pi: ExtensionAPI): Provider {
  return vi.mocked(pi.registerProvider).mock
    .calls[0]?.[0] as unknown as Provider;
}

type RefreshContext = Parameters<NonNullable<Provider["refreshModels"]>>[0];

/** Minimal refresh context: publications apply immediately, nothing persists. */
function refreshContext(
  overrides: Partial<RefreshContext> = {},
): RefreshContext {
  return {
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function cachedModel(
  baseUrl: string,
  id = "nebius:openai/gpt-oss-120b",
): Model<"openai-completions"> {
  return {
    id,
    name: id,
    provider: "otari",
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

/** Cache-only refresh, as Pi runs it at startup before any network access. */
async function restoreCached(
  provider: Provider,
  models: Model<"openai-completions">[],
): Promise<void> {
  await provider.refreshModels?.(
    refreshContext({
      credential: { type: "api_key", key: "tk_stored" },
      stored: { models, checkedAt: 0 },
      allowNetwork: false,
    }),
  );
}

describe("registerOtariProvider", () => {
  it("registers models with discovered reasoning capabilities", () => {
    const pi = fakePi();
    expect(
      registerOtariProvider(pi, config, [
        { id: "mzai:reasoning-model", reasoning: true, source: "standard" },
        { id: "mzai:text-model", reasoning: false, source: "standard" },
      ]),
    ).toBe(true);

    const provider = registeredProvider(pi);
    expect(provider).toMatchObject({
      id: "otari",
      baseUrl: config.baseUrl,
    });
    expect(provider.getModels()[0]).toMatchObject({
      id: "mzai:reasoning-model",
      api: "openai-completions",
      reasoning: true,
      thinkingLevelMap: {
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: {
        maxTokensField: "max_tokens",
        supportsDeveloperRole: false,
      },
    });
    expect(provider.getModels()[1]).toMatchObject({
      id: "mzai:text-model",
      reasoning: false,
    });
    expect(provider.getModels()[1]?.thinkingLevelMap).toBeUndefined();
    expect(JSON.stringify(provider)).not.toContain(config.token);
  });

  it("stores login input as an API-key credential without OAuth", async () => {
    const pi = fakePi();
    registerOtariProvider(pi, config, []);
    const provider = registeredProvider(pi);
    const login = provider.auth.apiKey?.login;
    expect(login).toBeTypeOf("function");
    expect(provider.auth.oauth).toBeUndefined();
    expect(
      await login?.({
        prompt: async (prompt) => {
          expect(prompt.type).toBe("secret");
          expect(prompt.message).toContain("Otari API key");
          return "tk_stored";
        },
        notify: () => {},
        signal: new AbortController().signal,
      }),
    ).toEqual({ type: "api_key", key: "tk_stored" });
  });

  it("keeps OTARI_MODELS as a static provider baseline", () => {
    const pi = fakePi();
    registerOtariProvider(
      pi,
      { ...config, environmentModels: ["mzai:manual-model"] },
      [],
    );
    expect(registeredProvider(pi).getModels()).toEqual([
      expect.objectContaining({ id: "mzai:manual-model" }),
    ]);
  });

  it("provides dynamic model discovery for post-login refresh", () => {
    const pi = fakePi();
    registerOtariProvider(pi, config, []);
    expect(registeredProvider(pi).refreshModels).toBeTypeOf("function");
  });

  it("uses a stored API key for dynamic discovery before the environment key", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer tk_stored",
        );
        return new Response(
          JSON.stringify({ data: [{ id: "mzai:stored-model" }] }),
          { status: 200 },
        );
      },
    );
    const pi = fakePi();
    registerOtariProvider(pi, config, [], { fetch: fetcher as typeof fetch });
    const provider = registeredProvider(pi);
    let storedModels: unknown;

    await provider.refreshModels?.(
      refreshContext({
        credential: { type: "api_key", key: "tk_stored" },
        publish: async (publication) => {
          storedModels = publication.persist?.models;
          publication.update?.();
          return true;
        },
      }),
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storedModels).toEqual([
      expect.objectContaining({ id: "mzai:stored-model" }),
    ]);
    expect(provider.getModels()).toEqual(storedModels);
  });

  it("uses OTARI_API_KEY for discovery when no stored credential exists", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer tk_not_forwarded_to_registration",
        );
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    );
    const pi = fakePi();
    registerOtariProvider(pi, config, [], { fetch: fetcher as typeof fetch });
    await registeredProvider(pi).refreshModels?.(refreshContext());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("registers Otari before models are discovered so login is available", () => {
    const pi = fakePi();
    registerOtariProvider(pi, config, []);
    expect(pi.registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "otari",
        name: "Otari",
        auth: expect.objectContaining({
          apiKey: expect.objectContaining({
            name: "Otari API key",
            login: expect.any(Function),
          }),
        }),
      }),
    );
  });

  it("targets hosted /api/v1 for both discovery and inference by default", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.otari.ai/api/v1/models");
      return new Response(
        JSON.stringify({ data: [{ id: "nebius:openai/gpt-oss-120b" }] }),
        { status: 200 },
      );
    });
    const pi = fakePi();
    registerOtariProvider(
      pi,
      loadOtariConfig({ OTARI_API_KEY: "tk_default" }),
      [],
      {
        fetch: fetcher as typeof fetch,
      },
    );
    const provider = registeredProvider(pi);
    await provider.refreshModels?.(
      refreshContext({ credential: { type: "api_key", key: "tk_default" } }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [model] = provider.getModels();
    expect(`${model?.baseUrl}/chat/completions`).toBe(
      "https://api.otari.ai/api/v1/chat/completions",
    );
  });

  it("carries models cached under the same host's old API prefix to the configured URL", async () => {
    const fetcher = vi.fn();
    const pi = fakePi();
    registerOtariProvider(pi, config, [], { fetch: fetcher as typeof fetch });
    const provider = registeredProvider(pi);
    await restoreCached(provider, [cachedModel("https://api.otari.ai/v1")]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider.getModels()).toEqual([
      expect.objectContaining({
        id: "nebius:openai/gpt-oss-120b",
        baseUrl: config.baseUrl,
      }),
    ]);
  });

  it("drops models cached under a different origin", async () => {
    const pi = fakePi();
    registerOtariProvider(
      pi,
      {
        ...config,
        baseUrl: "http://localhost:8000/api/v1",
        officialHosted: false,
      },
      [],
    );
    const provider = registeredProvider(pi);
    await restoreCached(provider, [
      cachedModel("https://api.otari.ai/api/v1"),
      cachedModel("http://localhost:8001/api/v1", "local:other-model"),
    ]);
    expect(provider.getModels()).toEqual([]);
  });

  it("keeps the OTARI_MODELS baseline while dropping another origin's cache", async () => {
    const pi = fakePi();
    registerOtariProvider(
      pi,
      {
        ...config,
        baseUrl: "https://otari.example.com/api/v1",
        officialHosted: false,
        environmentModels: ["anthropic:claude-sonnet-5"],
      },
      [],
    );
    const provider = registeredProvider(pi);
    await restoreCached(provider, [cachedModel("https://api.otari.ai/api/v1")]);
    expect(provider.getModels()).toEqual([
      expect.objectContaining({
        id: "anthropic:claude-sonnet-5",
        baseUrl: "https://otari.example.com/api/v1",
      }),
    ]);
  });

  it("reports discovery diagnostics, but not a successful discovery", async () => {
    const statuses = [404, 401, 200];
    const fetcher = vi.fn(async (_url: string | URL | Request) => {
      const status = statuses.shift() ?? 200;
      return new Response(
        JSON.stringify(
          status === 200
            ? { data: [{ id: "nebius:openai/gpt-oss-120b" }] }
            : {},
        ),
        { status },
      );
    });
    const onDiagnostic = vi.fn();
    const pi = fakePi();
    registerOtariProvider(
      pi,
      {
        ...config,
        baseUrl: "https://self.example/gateway",
        officialHosted: false,
      },
      [],
      { fetch: fetcher as typeof fetch, onDiagnostic },
    );
    const provider = registeredProvider(pi);
    await expect(provider.refreshModels?.(refreshContext())).rejects.toThrow();
    await expect(provider.refreshModels?.(refreshContext())).rejects.toThrow();
    await provider.refreshModels?.(refreshContext());
    expect(onDiagnostic.mock.calls.map((call) => call[0].code)).toEqual([
      "discovery-http",
      "discovery-auth",
    ]);
  });

  it("keeps the cached catalog when the key is rejected", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 401 }));
    const pi = fakePi();
    registerOtariProvider(pi, config, [], { fetch: fetcher as typeof fetch });
    const provider = registeredProvider(pi);
    const cached = cachedModel(config.baseUrl);
    let persisted: unknown = "untouched";
    await expect(
      provider.refreshModels?.(
        refreshContext({
          credential: { type: "api_key", key: "tk_revoked" },
          stored: { models: [cached], checkedAt: 0 },
          publish: async (publication) => {
            if (publication.persist !== undefined)
              persisted = publication.persist;
            publication.update?.();
            return true;
          },
        }),
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(persisted).toBe("untouched");
    expect(provider.getModels()).toEqual([
      expect.objectContaining({ id: cached.id }),
    ]);
  });

  it("seeds the catalog from the stored list of this deployment", async () => {
    const catalog = new Set<string>();
    const pi = fakePi();
    registerOtariProvider(pi, config, [], { catalog });
    await restoreCached(registeredProvider(pi), [
      cachedModel(config.baseUrl, "nebius:openai/gpt-oss-120b"),
      cachedModel("https://otari.example.com/api/v1", "other:model"),
    ]);
    expect([...catalog]).toEqual(["nebius:openai/gpt-oss-120b"]);
  });

  it("replaces the catalog on each discovery and clears it on an empty one", async () => {
    const bodies = [
      { data: [{ id: "nebius:openai/gpt-oss-120b" }] },
      { data: [] },
    ];
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(bodies.shift()), { status: 200 }),
    );
    const catalog = new Set(["stale:seed"]);
    const pi = fakePi();
    registerOtariProvider(pi, config, [], {
      fetch: fetcher as typeof fetch,
      catalog,
    });
    const provider = registeredProvider(pi);
    await provider.refreshModels?.(refreshContext());
    expect([...catalog]).toEqual(["nebius:openai/gpt-oss-120b"]);
    await provider.refreshModels?.(refreshContext());
    expect(catalog.size).toBe(0);
  });

  it("leaves the catalog untouched when discovery fails", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 500 }));
    const catalog = new Set(["nebius:openai/gpt-oss-120b"]);
    const pi = fakePi();
    registerOtariProvider(pi, config, [], {
      fetch: fetcher as typeof fetch,
      catalog,
    });
    await expect(
      registeredProvider(pi).refreshModels?.(refreshContext()),
    ).rejects.toThrow();
    expect([...catalog]).toEqual(["nebius:openai/gpt-oss-120b"]);
  });

  it("warns once about an OTARI_MODELS selector discovery does not list, naming its replacement", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "nebius:openai/gpt-oss-120b" }] }),
          { status: 200 },
        ),
    );
    const onDiagnostic = vi.fn();
    const pi = fakePi();
    registerOtariProvider(
      pi,
      {
        ...config,
        environmentModels: [
          "mzai:openai/gpt-oss-120b",
          "nebius:openai/gpt-oss-120b",
        ],
      },
      [],
      { fetch: fetcher as typeof fetch, onDiagnostic },
    );
    const provider = registeredProvider(pi);
    await provider.refreshModels?.(refreshContext());
    await provider.refreshModels?.(refreshContext());
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic.mock.calls[0][0]).toMatchObject({
      level: "warning",
      code: "selector-stale",
    });
    const { message } = onDiagnostic.mock.calls[0][0];
    expect(message).toContain('"mzai:openai/gpt-oss-120b"');
    expect(message).toContain('listed as "nebius:openai/gpt-oss-120b"');
    expect(message).toContain("OTARI_MODELS");
    // The selector stays registered: OTARI_MODELS may name models discovery omits.
    expect(provider.getModels().map((model) => model.id)).toEqual([
      "mzai:openai/gpt-oss-120b",
      "nebius:openai/gpt-oss-120b",
    ]);
  });

  it("does not judge OTARI_MODELS selectors when discovery returns no models", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const onDiagnostic = vi.fn();
    const pi = fakePi();
    registerOtariProvider(
      pi,
      { ...config, environmentModels: ["anthropic:claude-sonnet-5"] },
      [],
      { fetch: fetcher as typeof fetch, onDiagnostic },
    );
    await registeredProvider(pi).refreshModels?.(refreshContext());
    expect(onDiagnostic.mock.calls.map((call) => call[0].code)).toEqual([
      "discovery-empty",
    ]);
  });
});
