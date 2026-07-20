import { describe, expect, it, vi } from "vitest";
import { discoverModels, MANAGED_CATALOG_URL } from "../src/discovery.js";
import type { ModelCache, OtariConfig } from "../src/types.js";

const base: OtariConfig = {
  baseUrl: "https://api.otari.ai/v1",
  token: "tk_secret",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
};

const response = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const cache: ModelCache = {
  schemaVersion: 1,
  fetchedAt: "2026-07-17T00:00:00.000Z",
  models: [{ id: "cached:model", source: "standard" }],
};

describe("discoverModels", () => {
  it("uses standard discovery and sends bearer auth", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tk_secret");
      expect(init?.redirect).toBe("error");
      return response(200, { data: [{ id: "anthropic:claude" }] });
    });
    const result = await discoverModels(base, undefined, fetcher as typeof fetch);
    expect(result.models.map((model) => model.id)).toEqual(["anthropic:claude"]);
    expect(result.source).toBe("standard");
  });

  it("uses the public managed catalog only for hosted 404", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      return target === MANAGED_CATALOG_URL
        ? response(200, {
            data: [{
              provider: "mzai",
              model: "org/model",
              input_price_per_million: "1",
              output_price_per_million: "2",
            }],
          })
        : response(404, { detail: "Not Found" });
    });
    const result = await discoverModels(base, undefined, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.models[0].id).toBe("mzai:org/model");
    expect(result.source).toBe("managed-catalog");
  });

  it("does not use hosted fallback for a custom endpoint", async () => {
    const fetcher = vi.fn(async () => response(404, {}));
    const result = await discoverModels(
      { ...base, baseUrl: "https://self.example/v1", officialHosted: false },
      cache,
      fetcher as typeof fetch,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.models[0]).toMatchObject({ id: "cached:model", source: "stale-cache" });
  });

  it.each([401, 403])("does not hide auth status %s with stale cache", async (status) => {
    const result = await discoverModels(base, cache, vi.fn(async () => response(status, {})) as typeof fetch);
    expect(result.models).toEqual([]);
    expect(result.diagnostics[0].code).toBe("discovery-auth");
  });

  it.each([429, 500])("uses stale cache for transient status %s", async (status) => {
    const result = await discoverModels(base, cache, vi.fn(async () => response(status, {})) as typeof fetch);
    expect(result.models[0]).toMatchObject({ id: "cached:model", source: "stale-cache" });
  });

  it("treats a valid empty 200 as authoritative", async () => {
    const result = await discoverModels(base, cache, vi.fn(async () => response(200, { data: [] })) as typeof fetch);
    expect(result.models).toEqual([]);
    expect(result.cacheUpdate).toEqual([]);
  });

  it("uses stale cache when a non-empty response contains no valid models", async () => {
    const result = await discoverModels(
      base,
      cache,
      vi.fn(async () => response(200, { data: [{ object: "model" }] })) as typeof fetch,
    );
    expect(result.models[0]).toMatchObject({ id: "cached:model", source: "stale-cache" });
    expect(result.diagnostics[0].code).toBe("discovery-invalid");
  });

  it("merges OTARI_MODELS and recovers a zero-model result", async () => {
    const result = await discoverModels(
      { ...base, environmentModels: ["anthropic:manual"] },
      cache,
      vi.fn(async () => response(200, { data: [] })) as typeof fetch,
    );
    expect(result.models[0]).toMatchObject({ id: "anthropic:manual", source: "environment" });
  });

  it("never includes the token in diagnostics", async () => {
    const result = await discoverModels(
      base,
      undefined,
      vi.fn(async () => { throw new Error("network down"); }) as typeof fetch,
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("tk_secret");
  });
});
