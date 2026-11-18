import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadOtariConfig } from "../src/config.js";
import { GatewayToolState, WEB_SEARCH } from "../src/gateway-tools.js";
import { registerOtariProvider } from "../src/provider.js";
import type { OtariConfig } from "../src/types.js";

const config: OtariConfig = {
  baseUrl: "https://api.otari.ai/api/v1",
  token: "tk_not_forwarded_to_registration",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
  webSearch: true,
  webFetch: true,
};

/** A tools catalog with nothing to offer: discovery probes it after /models. */
const noTools = new Response(JSON.stringify({ data: [] }), { status: 200 });

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

  describe("login", () => {
    type Interaction = Parameters<
      NonNullable<NonNullable<Provider["auth"]["apiKey"]>["login"]>
    >[0];
    type Prompt = Parameters<Interaction["prompt"]>[0];

    /** Answers each prompt by its type, recording what was asked. */
    function interaction(answers: Partial<Record<Prompt["type"], string>>) {
      const prompts: Prompt[] = [];
      const notices: string[] = [];
      const value: Interaction = {
        prompt: async (prompt) => {
          prompts.push(prompt);
          return answers[prompt.type] ?? "";
        },
        notify: (event) => {
          if ("message" in event) notices.push(event.message);
        },
        signal: new AbortController().signal,
      };
      return { value, prompts, notices };
    }

    function modelsOk() {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    function setup(fetcher: (url: string) => Response | Promise<Response>) {
      const own = { ...config };
      const fetchMock = vi.fn(async (url: string | URL | Request) =>
        fetcher(String(url)),
      );
      const pi = fakePi();
      registerOtariProvider(pi, own, [], {
        fetch: fetchMock as unknown as typeof fetch,
      });
      const auth = registeredProvider(pi).auth.apiKey;
      if (!auth?.login) throw new Error("Expected API-key login");
      return { own, fetchMock, auth, login: auth.login };
    }

    it("offers otari.ai, its EU region and your own gateway, then stores the key with its gateway", async () => {
      const { login, fetchMock, auth } = setup(modelsOk);
      expect(auth.name).toBe("Otari API key");
      const { value, prompts } = interaction({
        select: "otari-eu",
        secret: " tk_eu ",
      });

      expect(await login(value)).toEqual({
        type: "api_key",
        key: "tk_eu",
        env: { OTARI_BASE_URL: "https://eu.api.otari.ai/api/v1" },
      });
      const select = prompts[0];
      expect(select?.type).toBe("select");
      expect(select?.type === "select" && select.options).toEqual([
        expect.objectContaining({
          id: "otari",
          description: "https://api.otari.ai/api/v1",
        }),
        expect.objectContaining({
          id: "otari-eu",
          description: "https://eu.api.otari.ai/api/v1",
        }),
        expect.objectContaining({ id: "custom" }),
      ]);
      expect(prompts[1]).toMatchObject({ type: "secret" });
      expect(prompts[1]?.message).toContain("Otari API key");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://eu.api.otari.ai/api/v1/models",
        expect.anything(),
      );
    });

    it("asks for your own gateway's URL and adds the API prefix", async () => {
      const { login, own } = setup(modelsOk);
      const { value, prompts } = interaction({
        select: "custom",
        text: "http://localhost:8000",
        secret: "tk_local",
      });

      expect(await login(value)).toEqual({
        type: "api_key",
        key: "tk_local",
        env: { OTARI_BASE_URL: "http://localhost:8000/api/v1" },
      });
      expect(prompts.map((prompt) => prompt.type)).toEqual([
        "select",
        "text",
        "secret",
      ]);
      expect(own).toMatchObject({
        baseUrl: "http://localhost:8000/api/v1",
        officialHosted: false,
      });
    });

    it("rejects a non-loopback HTTP gateway URL", async () => {
      const { login, fetchMock } = setup(modelsOk);
      const { value } = interaction({
        select: "custom",
        text: "http://otari.example.com",
        secret: "tk",
      });
      await expect(login(value)).rejects.toThrow(/HTTPS/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("moves to the region a 421 names", async () => {
      const { login, fetchMock } = setup((url) =>
        url.startsWith("https://api.otari.ai/")
          ? new Response(
              JSON.stringify({
                detail:
                  "This API key belongs to eu.api.otari.ai. Send requests there.",
              }),
              { status: 421 },
            )
          : modelsOk(),
      );
      const { value, notices } = interaction({
        select: "otari",
        secret: "tk_eu",
      });

      expect(await login(value)).toMatchObject({
        env: { OTARI_BASE_URL: "https://eu.api.otari.ai/api/v1" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(notices.join("\n")).toContain("EU region");
    });

    it("never follows a 421 to a host outside otari.ai", async () => {
      const { login, fetchMock } = setup(
        () =>
          new Response(
            JSON.stringify({
              detail: "This API key belongs to evil.example. Send it there.",
            }),
            { status: 421 },
          ),
      );
      const { value } = interaction({ select: "otari", secret: "tk" });
      await expect(login(value)).rejects.toThrow("HTTP 421");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails the login when the gateway rejects the key", async () => {
      const { login } = setup(() => new Response("", { status: 401 }));
      const { value } = interaction({ select: "otari", secret: "tk_bad" });
      await expect(login(value)).rejects.toThrow(/rejected the API key/);
    });

    it("fails the login when the gateway cannot be reached", async () => {
      const { login } = setup(() => {
        throw new TypeError("fetch failed");
      });
      const { value } = interaction({
        select: "custom",
        text: "http://localhost:9",
        secret: "tk",
      });
      await expect(login(value)).rejects.toThrow(
        "Could not reach Otari at http://localhost:9/api/v1: fetch failed",
      );
    });

    it("cancels when no key is entered", async () => {
      const { login, fetchMock } = setup(modelsOk);
      const { value } = interaction({ select: "otari", secret: "  " });
      await expect(login(value)).rejects.toThrow("Login cancelled");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resolves a stored key with its gateway, and an environment key with OTARI_BASE_URL", async () => {
      const { auth, own } = setup(modelsOk);
      const signal = new AbortController().signal;
      const ctx = {
        env: async (name: string) =>
          name === "OTARI_API_KEY" ? "tk_env" : undefined,
        fileExists: async () => false,
      };

      expect(
        await auth.resolve({
          ctx,
          signal,
          credential: {
            type: "api_key",
            key: "tk_eu",
            env: { OTARI_BASE_URL: "https://eu.api.otari.ai/api/v1" },
          },
        }),
      ).toMatchObject({
        auth: { apiKey: "tk_eu", baseUrl: "https://eu.api.otari.ai/api/v1" },
        source: "stored credential",
      });
      expect(own.baseUrl).toBe("https://eu.api.otari.ai/api/v1");

      // After /logout the environment pair applies again.
      expect(await auth.resolve({ ctx, signal })).toMatchObject({
        auth: { apiKey: "tk_env", baseUrl: "https://api.otari.ai/api/v1" },
        source: "OTARI_API_KEY",
      });
      expect(own.baseUrl).toBe("https://api.otari.ai/api/v1");

      // A key saved before logins recorded a gateway uses OTARI_BASE_URL.
      expect(
        await auth.resolve({
          ctx,
          signal,
          credential: { type: "api_key", key: "tk_old" },
        }),
      ).toMatchObject({
        auth: { apiKey: "tk_old", baseUrl: "https://api.otari.ai/api/v1" },
      });
    });

    it("discovers models from the gateway a stored credential names", async () => {
      const { own, fetchMock } = setup((url) =>
        url.endsWith("/tools")
          ? noTools.clone()
          : new Response(JSON.stringify({ data: [{ id: "mzai:eu" }] }), {
              status: 200,
            }),
      );
      const pi = fakePi();
      registerOtariProvider(pi, own, [], {
        fetch: fetchMock as unknown as typeof fetch,
      });
      const provider = registeredProvider(pi);
      await provider.refreshModels?.(
        refreshContext({
          credential: {
            type: "api_key",
            key: "tk_eu",
            env: { OTARI_BASE_URL: "https://eu.api.otari.ai/api/v1" },
          },
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://eu.api.otari.ai/api/v1/models",
        expect.anything(),
      );
      expect(provider.getModels()).toEqual([
        expect.objectContaining({
          id: "mzai:eu",
          baseUrl: "https://eu.api.otari.ai/api/v1",
        }),
      ]);
    });
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
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer tk_stored",
        );
        if (String(url).endsWith("/tools")) return noTools.clone();
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

    // /models, then the gateway tools probe against /tools.
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    expect(fetcher).toHaveBeenCalledTimes(2);
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
      if (String(url) === "https://api.otari.ai/api/v1/tools")
        return noTools.clone();
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
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/tools")) return noTools.clone();
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
    // /models, plus the gateway tools probe that runs alongside it.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(persisted).toBe("untouched");
    expect(provider.getModels()).toEqual([
      expect.objectContaining({ id: cached.id }),
    ]);
  });

  it("keeps an OTARI_MODELS entry whose id matches a model cached from another origin", async () => {
    const pi = fakePi();
    registerOtariProvider(
      pi,
      {
        ...config,
        baseUrl: "https://otari.example.com/api/v1",
        officialHosted: false,
        environmentModels: ["nebius:test-model"],
      },
      [],
    );
    const provider = registeredProvider(pi);
    await restoreCached(provider, [
      cachedModel("https://api.otari.ai/api/v1", "nebius:test-model"),
    ]);
    expect(provider.getModels()).toEqual([
      expect.objectContaining({
        id: "nebius:test-model",
        baseUrl: "https://otari.example.com/api/v1",
      }),
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
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/tools")) return noTools.clone();
      return new Response(JSON.stringify(bodies.shift()), { status: 200 });
    });
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

  it("marks web search available when the tools catalog lists it, clearing a refusal", async () => {
    const webSearch = new GatewayToolState(WEB_SEARCH);
    webSearch.refuse("earlier refusal");
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === `${config.baseUrl}/tools`) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer tk_stored",
          );
          return new Response(
            JSON.stringify({
              data: [{ id: "otari_web_search", available: true }],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ data: [{ id: "mzai:stored-model" }] }),
          { status: 200 },
        );
      },
    );
    const pi = fakePi();
    registerOtariProvider(pi, config, [], {
      fetch: fetcher as typeof fetch,
      gatewayTools: [webSearch],
    });
    await registeredProvider(pi).refreshModels?.(
      refreshContext({ credential: { type: "api_key", key: "tk_stored" } }),
    );
    expect(webSearch.offered).toBe(true);
  });

  it("clears a refusal on the next refresh even when the probe cannot tell", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/tools")
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ data: [{ id: "mzai:model" }] }), {
            status: 200,
          }),
    );
    const webSearch = new GatewayToolState(WEB_SEARCH);
    webSearch.refuse("earlier refusal");
    const pi = fakePi();
    registerOtariProvider(pi, config, [], {
      fetch: fetcher as typeof fetch,
      gatewayTools: [webSearch],
    });
    await registeredProvider(pi).refreshModels?.(refreshContext());
    expect([webSearch.active, webSearch.offered]).toEqual([true, false]);
  });

  it("probes /tools alongside discovery, not after it", async () => {
    let releaseModels: (() => void) | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/tools")) return noTools.clone();
      await new Promise<void>((resolve) => {
        releaseModels = resolve;
      });
      return new Response(JSON.stringify({ data: [{ id: "mzai:model" }] }), {
        status: 200,
      });
    });
    const pi = fakePi();
    registerOtariProvider(pi, config, [], { fetch: fetcher as typeof fetch });
    const refresh = registeredProvider(pi).refreshModels?.(refreshContext());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releaseModels?.();
    await refresh;
  });

  it("skips the tools probe when every gateway tool is configured off", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(JSON.stringify({ data: [{ id: "mzai:model" }] }), {
          status: 200,
        }),
    );
    const webSearch = new GatewayToolState(WEB_SEARCH);
    const pi = fakePi();
    registerOtariProvider(
      pi,
      { ...config, webSearch: false, webFetch: false },
      [],
      {
        fetch: fetcher as typeof fetch,
        gatewayTools: [webSearch],
      },
    );
    await registeredProvider(pi).refreshModels?.(refreshContext());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toBe(
      `${config.baseUrl}/models`,
    );
    expect(webSearch.offered).toBe(false);
  });

  it("leaves web search state untouched when discovery fails", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 500 }));
    const webSearch = new GatewayToolState(WEB_SEARCH);
    webSearch.probed("available");
    const pi = fakePi();
    registerOtariProvider(pi, config, [], {
      fetch: fetcher as typeof fetch,
      gatewayTools: [webSearch],
    });
    await expect(
      registeredProvider(pi).refreshModels?.(refreshContext()),
    ).rejects.toThrow();
    expect(webSearch.offered).toBe(true);
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
