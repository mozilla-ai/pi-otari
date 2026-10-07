import { describe, expect, it, vi } from "vitest";
import type { OtariConfig } from "../src/types.js";
import {
  createWebSearchState,
  probeWebSearch,
  webSearchActive,
  webSearchRefusalDetail,
  wrapFetchWithWebSearch,
} from "../src/web-search.js";

const config: OtariConfig = {
  baseUrl: "https://api.otari.ai/api/v1",
  token: "tk_test",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
  webSearch: true,
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const toolsCatalog = (entries: unknown[]): Response =>
  json(200, { object: "list", data: entries });

const completionInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const BASE_URL = "https://api.otari.ai/api/v1";
const COMPLETIONS_URL = `${BASE_URL}/chat/completions`;

describe("probeWebSearch", () => {
  it("reports available when the catalog lists otari_web_search as available", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.otari.ai/api/v1/tools");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer tk_test",
        );
        expect(init?.redirect).toBe("error");
        return toolsCatalog([
          { id: "otari_web_fetch", available: false },
          { id: "otari_web_search", available: true },
        ]);
      },
    );
    expect(
      await probeWebSearch(config, "tk_test", fetcher as typeof fetch),
    ).toBe("available");
  });

  it("reports unavailable when the tool is missing or not available", async () => {
    const missing = vi.fn(async () => toolsCatalog([]));
    expect(
      await probeWebSearch(config, "tk_test", missing as typeof fetch),
    ).toBe("unavailable");
    const off = vi.fn(async () =>
      toolsCatalog([{ id: "otari_web_search", available: false }]),
    );
    expect(await probeWebSearch(config, "tk_test", off as typeof fetch)).toBe(
      "unavailable",
    );
  });

  it.each([401, 403, 404, 500])(
    "reports unknown on HTTP %s, keeping requests eligible",
    async (status) => {
      const fetcher = vi.fn(async () => json(status, {}));
      expect(
        await probeWebSearch(config, "tk_test", fetcher as typeof fetch),
      ).toBe("unknown");
    },
  );

  it("reports unknown on a network failure, a malformed body, or no token", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await probeWebSearch(config, "tk_test", down as typeof fetch)).toBe(
      "unknown",
    );
    const malformed = vi.fn(async () => json(200, { unexpected: true }));
    expect(
      await probeWebSearch(config, "tk_test", malformed as typeof fetch),
    ).toBe("unknown");
    const fetcher = vi.fn();
    expect(
      await probeWebSearch(config, undefined, fetcher as typeof fetch),
    ).toBe("unknown");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("webSearchRefusalDetail", () => {
  it.each([
    "otari_web_search tool requested but no search backend is configured on this gateway. Set OTARI_WEB_SEARCH_URL on the gateway, or remove otari_web_search from `tools`.",
    "web search is not enabled for this workspace",
    "otari_web_search declarations contain an unsupported field",
    "otari_web_search and otari_web_fetch cannot be combined with otari_code_execution or mcp_servers in the same request yet; pick one.",
  ])("matches the gateway refusal: %s", (detail) => {
    expect(webSearchRefusalDetail({ detail })).toBe(detail);
  });

  it("matches a 422 validation error from a gateway that predates the tool", () => {
    expect(
      webSearchRefusalDetail({
        detail: [
          {
            type: "union_tag_invalid",
            loc: ["body", "tools", 0],
            msg: "Input tag 'otari_web_search' found using 'type' does not match any of the expected tags: 'function'",
            input: { type: "otari_web_search" },
          },
        ],
      }),
    ).toBe(
      "Input tag 'otari_web_search' found using 'type' does not match any of the expected tags: 'function'",
    );
    expect(
      webSearchRefusalDetail({
        detail: [
          {
            loc: ["body", "tools", 1],
            msg: "Field required",
            input: { type: "otari_web_search" },
          },
        ],
      }),
    ).toBe("Field required");
  });

  it("ignores other rejections and non-string details", () => {
    expect(
      webSearchRefusalDetail({
        detail:
          "reasoning_effort 'medium' is unsupported; available values: low, high",
      }),
    ).toBeUndefined();
    expect(
      webSearchRefusalDetail({
        detail: "No credential is configured for 'mzai' on this deployment",
      }),
    ).toBeUndefined();
    expect(
      webSearchRefusalDetail({ detail: [{ loc: ["tools"], msg: "x" }] }),
    ).toBeUndefined();
    expect(
      webSearchRefusalDetail({ error: { message: "otari_web_search" } }),
    ).toBeUndefined();
    expect(webSearchRefusalDetail("otari_web_search")).toBeUndefined();
  });
});

describe("webSearchActive", () => {
  it("is optimistic on unknown, off on unavailable or rejected", () => {
    const state = createWebSearchState();
    expect(webSearchActive(state)).toBe(true);
    state.availability = "available";
    expect(webSearchActive(state)).toBe(true);
    state.availability = "unavailable";
    expect(webSearchActive(state)).toBe(false);
    state.availability = "available";
    state.rejected = true;
    expect(webSearchActive(state)).toBe(false);
  });
});

describe("wrapFetchWithWebSearch", () => {
  const ok = () => json(200, { ok: true });

  it("appends the declaration after the request's own tools", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => ok(),
    );
    const state = createWebSearchState();
    state.availability = "available";
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      state,
      vi.fn(),
    );
    const body = {
      model: "m",
      stream: true,
      tools: [{ type: "function", function: { name: "bash" } }],
    };
    await wrapped(COMPLETIONS_URL, completionInit(body));
    const sent = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(sent.tools).toEqual([
      { type: "function", function: { name: "bash" } },
      { type: "otari_web_search" },
    ]);
    expect(sent.model).toBe("m");
  });

  it("creates the tools array when the request has none", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => ok(),
    );
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      createWebSearchState(),
      vi.fn(),
    );
    await wrapped(COMPLETIONS_URL, completionInit({ model: "m" }));
    const sent = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(sent.tools).toEqual([{ type: "otari_web_search" }]);
  });

  it("does not declare the tool twice", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => ok(),
    );
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      createWebSearchState(),
      vi.fn(),
    );
    await wrapped(
      COMPLETIONS_URL,
      completionInit({
        model: "m",
        tools: [{ type: "otari_web_search", max_uses: 2 }],
      }),
    );
    const sent = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(sent.tools).toEqual([{ type: "otari_web_search", max_uses: 2 }]);
  });

  it("leaves other requests and non-JSON bodies alone", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => ok(),
    );
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      createWebSearchState(),
      vi.fn(),
    );
    await wrapped("https://api.otari.ai/api/v1/models", { method: "GET" });
    await wrapped(COMPLETIONS_URL, { method: "GET" });
    await wrapped(COMPLETIONS_URL, { method: "POST" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(fetcher).mock.calls) {
      expect(String(call[1]?.body ?? "")).not.toContain("otari_web_search");
    }
  });

  it("declares nothing once the catalog said unavailable", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => ok(),
    );
    const state = createWebSearchState();
    state.availability = "unavailable";
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      state,
      vi.fn(),
    );
    await wrapped(COMPLETIONS_URL, completionInit({ model: "m" }));
    expect(String(vi.mocked(fetcher).mock.calls[0][1]?.body)).not.toContain(
      "otari_web_search",
    );
  });

  it.each([400, 403])(
    "retries without the declaration after a %s refusal, then stops declaring",
    async (status) => {
      const detail =
        status === 403
          ? "web search is not enabled for this workspace"
          : "otari_web_search tool requested but no search backend is configured on this gateway.";
      const bodies: string[] = [];
      const fetcher = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) => {
          bodies.push(String(init?.body));
          return bodies.length === 1 ? json(status, { detail }) : ok();
        },
      );
      const state = createWebSearchState();
      state.availability = "available";
      const onRejected = vi.fn();
      const wrapped = wrapFetchWithWebSearch(
        fetcher as typeof fetch,
        BASE_URL,
        state,
        onRejected,
      );

      const response = await wrapped(
        COMPLETIONS_URL,
        completionInit({ model: "m", tools: [] }),
      );
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.parse(bodies[0]).tools).toEqual([
        { type: "otari_web_search" },
      ]);
      expect(JSON.parse(bodies[1]).tools).toEqual([]);
      expect(state.rejected).toBe(true);
      expect(onRejected).toHaveBeenCalledTimes(1);
      expect(onRejected).toHaveBeenCalledWith(detail);

      await wrapped(COMPLETIONS_URL, completionInit({ model: "m" }));
      expect(JSON.parse(bodies[2]).tools).toBeUndefined();
      expect(onRejected).toHaveBeenCalledTimes(1);
    },
  );

  it("returns an unrelated 400 as-is, with no retry and no state change", async () => {
    const fetcher = vi.fn(async () =>
      json(400, { detail: "reasoning_effort 'medium' is unsupported" }),
    );
    const state = createWebSearchState();
    const onRejected = vi.fn();
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      state,
      onRejected,
    );
    const response = await wrapped(
      COMPLETIONS_URL,
      completionInit({ model: "m" }),
    );
    expect(response.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.rejected).toBe(false);
    expect(webSearchActive(state)).toBe(true);
    expect(onRejected).not.toHaveBeenCalled();
  });

  const refusal = (status = 400) =>
    json(status, {
      detail:
        "otari_web_search tool requested but no search backend is configured on this gateway.",
    });

  it("retries a 422 validation refusal without the declaration", async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return bodies.length === 1
          ? json(422, {
              detail: [
                {
                  loc: ["body", "tools", 0],
                  msg: "Input tag 'otari_web_search' found using 'type' does not match any of the expected tags: 'function'",
                },
              ],
            })
          : ok();
      },
    );
    const state = createWebSearchState();
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      state,
      vi.fn(),
    );
    const response = await wrapped(
      COMPLETIONS_URL,
      completionInit({ model: "m" }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(bodies[1]).tools).toBeUndefined();
    expect(state.rejected).toBe(true);
  });

  it("strips the caller's own declaration on retry", async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return bodies.length === 1 ? refusal() : ok();
      },
    );
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      createWebSearchState(),
      vi.fn(),
    );
    const response = await wrapped(
      COMPLETIONS_URL,
      completionInit({
        model: "m",
        tools: [
          { type: "function", function: { name: "bash" } },
          { type: "otari_web_search", max_uses: 2 },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(bodies[1]).tools).toEqual([
      { type: "function", function: { name: "bash" } },
    ]);
  });

  it("warns once when concurrent requests are refused, and notifies state changes", async () => {
    const pending: Array<() => void> = [];
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls > 3) return ok();
      await new Promise<void>((resolve) => pending.push(resolve));
      return refusal();
    });
    const onChange = vi.fn();
    const state = createWebSearchState(onChange);
    const onRejected = vi.fn();
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      state,
      onRejected,
    );
    const requests = [1, 2, 3].map(() =>
      wrapped(COMPLETIONS_URL, completionInit({ model: "m" })),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    for (const resolve of pending) resolve();
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("cancels the refused response's body before retrying", async () => {
    // clone() swaps a real Response's body for a tee branch, so spy on a
    // stand-in whose body stays put.
    const cancel = vi.fn(async () => {});
    const refused = {
      status: 400,
      clone: () => refusal(),
      body: { cancel },
    } as unknown as Response;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(ok());
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      createWebSearchState(),
      vi.fn(),
    );
    await wrapped(COMPLETIONS_URL, completionInit({ model: "m" }));
    expect(cancel).toHaveBeenCalled();
  });

  it("declares on this deployment's completions URL with a query or trailing slash", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => ok(),
    );
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      createWebSearchState(),
      vi.fn(),
    );
    await wrapped(`${COMPLETIONS_URL}?api-version=1`, completionInit({}));
    await wrapped(`${COMPLETIONS_URL}/`, completionInit({}));
    for (const call of vi.mocked(fetcher).mock.calls) {
      expect(JSON.parse(String(call[1]?.body)).tools).toEqual([
        { type: "otari_web_search" },
      ]);
    }
  });

  it("never declares on completions sent anywhere but the Otari base URL", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => ok(),
    );
    const wrapped = wrapFetchWithWebSearch(
      fetcher as typeof fetch,
      BASE_URL,
      createWebSearchState(),
      vi.fn(),
    );
    await wrapped(
      "https://api.openai.com/v1/chat/completions",
      completionInit({}),
    );
    await wrapped(
      "https://api.otari.ai/other/chat/completions",
      completionInit({}),
    );
    for (const call of vi.mocked(fetcher).mock.calls) {
      expect(String(call[1]?.body)).not.toContain("otari_web_search");
    }
  });
});
