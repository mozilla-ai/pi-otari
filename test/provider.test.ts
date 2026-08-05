import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerOtariProvider } from "../src/provider.js";
import type { OtariConfig } from "../src/types.js";

const config: OtariConfig = {
  baseUrl: "https://api.otari.ai/v1",
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

    await provider.refreshModels?.({
      credential: { type: "api_key", key: "tk_stored" },
      store: {
        read: async () => undefined,
        write: async (entry) => {
          storedModels = entry.models;
        },
        delete: async () => {},
      },
      allowNetwork: true,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storedModels).toEqual([
      expect.objectContaining({ id: "mzai:stored-model" }),
    ]);
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
    await registeredProvider(pi).refreshModels?.({
      store: {
        read: async () => undefined,
        write: async () => {},
        delete: async () => {},
      },
      allowNetwork: true,
    });
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
});
