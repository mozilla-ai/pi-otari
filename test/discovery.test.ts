import { describe, expect, it, vi } from "vitest";
import { discoverModels, MANAGED_CATALOG_URL } from "../src/discovery.js";
import type { OtariConfig } from "../src/types.js";

const base: OtariConfig = {
  baseUrl: "https://api.otari.ai/api/v1",
  token: "tk_secret",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
};

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("discoverModels", () => {
  it("uses hosted workspace discovery and sends bearer auth", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.otari.ai/api/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer tk_secret",
        );
        expect(init?.redirect).toBe("error");
        return response(200, {
          object: "list",
          data: [
            {
              id: "mistral:mistral-medium-3-5",
              object: "model",
              owned_by: "mistral",
            },
          ],
        });
      },
    );
    const result = await discoverModels(base, fetcher as typeof fetch);
    expect(result.models.map((model) => model.id)).toEqual([
      "mistral:mistral-medium-3-5",
    ]);
    expect(result.source).toBe("standard");
  });

  it("keeps custom discovery at OTARI_BASE_URL/models", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://self.example/v1/models");
      return response(200, { data: [{ id: "custom:test-model" }] });
    });
    const result = await discoverModels(
      { ...base, baseUrl: "https://self.example/v1", officialHosted: false },
      fetcher as typeof fetch,
    );
    expect(result.models.map((model) => model.id)).toEqual([
      "custom:test-model",
    ]);
  });

  it.each([404, 405])(
    "uses the public managed catalog only for hosted %s",
    async (status) => {
      const fetcher = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          const target = String(url);
          if (target === MANAGED_CATALOG_URL) {
            expect(new Headers(init?.headers).get("authorization")).toBeNull();
            return response(200, {
              data: [
                {
                  provider: "mzai",
                  model: "org/model",
                  input_price_per_million: "1",
                  output_price_per_million: "2",
                },
              ],
            });
          }
          return response(status, { detail: "Not Found" });
        },
      );
      const result = await discoverModels(base, fetcher as typeof fetch);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.models[0].id).toBe("mzai:org/model");
      expect(result.source).toBe("managed-catalog");
    },
  );

  it("rejects a managed-catalog outage without replacing native cache", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url) === MANAGED_CATALOG_URL
        ? response(500, {})
        : response(404, {}),
    );
    await expect(
      discoverModels(base, fetcher as typeof fetch),
    ).rejects.toMatchObject({
      name: "DiscoveryUnavailableError",
      diagnostic: { code: "managed-catalog-http" },
    });
  });

  it("does not use hosted fallback for a custom endpoint", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) =>
      response(404, {}),
    );
    await expect(
      discoverModels(
        { ...base, baseUrl: "https://self.example/v1", officialHosted: false },
        fetcher as typeof fetch,
      ),
    ).rejects.toMatchObject({
      name: "DiscoveryUnavailableError",
      diagnostic: { code: "discovery-http" },
    });
    expect(fetcher.mock.calls.map((call) => String(call[0]))).not.toContain(
      MANAGED_CATALOG_URL,
    );
  });

  it.each([401, 403])(
    "treats auth status %s as authoritative",
    async (status) => {
      const result = await discoverModels(
        base,
        vi.fn(async () => response(status, {})) as typeof fetch,
      );
      expect(result.models).toEqual([]);
      expect(result.diagnostics[0].code).toBe("discovery-auth");
      expect(result.diagnostics[0].message).toContain("/login otari");
    },
  );

  it.each([429, 500])(
    "rejects transient status %s without replacing Pi's native model cache",
    async (status) => {
      await expect(
        discoverModels(
          base,
          vi.fn(async () => response(status, {})) as typeof fetch,
        ),
      ).rejects.toMatchObject({
        name: "DiscoveryUnavailableError",
        diagnostic: {
          code: status === 429 ? "discovery-rate-limit" : "discovery-http",
        },
      });
    },
  );

  it("treats a valid empty 200 as authoritative", async () => {
    const result = await discoverModels(
      base,
      vi.fn(async () => response(200, { data: [] })) as typeof fetch,
    );
    expect(result.models).toEqual([]);
    expect(result.source).toBe("none");
  });

  it("rejects an invalid non-empty model response", async () => {
    await expect(
      discoverModels(
        base,
        vi.fn(async () =>
          response(200, { data: [{ object: "model" }] }),
        ) as typeof fetch,
      ),
    ).rejects.toMatchObject({
      name: "DiscoveryUnavailableError",
      diagnostic: { code: "discovery-invalid" },
    });
  });

  it("leaves OTARI_MODELS to the provider's static model baseline", async () => {
    const result = await discoverModels(
      { ...base, environmentModels: ["mzai:manual-model"] },
      vi.fn(async () => response(200, { data: [] })) as typeof fetch,
    );
    expect(result.models).toEqual([]);
    expect(result.source).toBe("none");
  });

  it("rejects network failures without exposing the token", async () => {
    let error: unknown;
    try {
      await discoverModels(
        base,
        vi.fn(async () => {
          throw new Error("network down");
        }) as typeof fetch,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "DiscoveryUnavailableError",
      diagnostic: { code: "discovery-unavailable" },
    });
    expect(JSON.stringify(error)).not.toContain("tk_secret");
  });

  it("guides missing credentials to native login", async () => {
    const result = await discoverModels({ ...base, token: undefined });
    expect(result.models).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ code: "token-missing" });
    expect(result.diagnostics[0].message).toContain("/login otari");
  });

  describe("custom 404 prefix detection", () => {
    const custom = (baseUrl: string): OtariConfig => ({
      ...base,
      baseUrl,
      officialHosted: false,
    });
    const gatewayServing = (root: string) =>
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === `${root}/health`) {
          expect(new Headers(init?.headers).get("authorization")).toBeNull();
          return response(200, { status: "healthy" });
        }
        return response(404, { detail: "Not Found" });
      });

    it("names the /api/v1 root when a /v1 URL hits a current gateway", async () => {
      const fetcher = gatewayServing("https://self.example/api/v1");
      await expect(
        discoverModels(
          custom("https://self.example/v1"),
          fetcher as typeof fetch,
        ),
      ).rejects.toMatchObject({
        diagnostic: {
          code: "discovery-prefix",
          message: expect.stringContaining(
            "Set OTARI_BASE_URL=https://self.example/api/v1",
          ),
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("names the /v1 root when an /api/v1 URL hits an older gateway", async () => {
      const fetcher = gatewayServing("https://self.example/v1");
      await expect(
        discoverModels(
          custom("https://self.example/api/v1"),
          fetcher as typeof fetch,
        ),
      ).rejects.toMatchObject({
        diagnostic: {
          code: "discovery-prefix",
          message: expect.stringContaining(
            "Set OTARI_BASE_URL=https://self.example/v1",
          ),
        },
      });
    });

    it("falls back to a static hint when the probe fails", async () => {
      const fetcher = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/health"))
          throw new Error("connection refused");
        return response(404, {});
      });
      await expect(
        discoverModels(
          custom("https://self.example/v1"),
          fetcher as typeof fetch,
        ),
      ).rejects.toMatchObject({
        diagnostic: {
          code: "discovery-http",
          message: expect.stringContaining("/api/v1"),
        },
      });
    });

    it("does not probe when the URL has no recognised prefix", async () => {
      const fetcher = vi.fn(async () => response(404, {}));
      await expect(
        discoverModels(
          custom("https://self.example/gateway"),
          fetcher as typeof fetch,
        ),
      ).rejects.toMatchObject({ diagnostic: { code: "discovery-http" } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("leaves the hosted 404 path to the managed fallback", async () => {
      const fetcher = vi.fn(async (url: string | URL | Request) =>
        String(url) === MANAGED_CATALOG_URL
          ? response(200, { data: [] })
          : response(404, {}),
      );
      await discoverModels(base, fetcher as typeof fetch);
      expect(fetcher.mock.calls.map((call) => String(call[0]))).not.toContain(
        "https://api.otari.ai/v1/health",
      );
    });
  });
});
