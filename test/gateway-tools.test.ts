import { describe, expect, it, vi } from "vitest";
import {
  GatewayToolState,
  probeGatewayTools,
  rejectionReason,
  WEB_FETCH,
  WEB_SEARCH,
  wrapFetchWithGatewayTools,
} from "../src/gateway-tools.js";
import type { OtariConfig } from "../src/types.js";

const BASE_URL = "https://api.otari.ai/api/v1";
const COMPLETIONS_URL = `${BASE_URL}/chat/completions`;

const config: OtariConfig = {
  baseUrl: BASE_URL,
  token: "tk_test",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: true,
  webSearch: true,
  webFetch: true,
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

const ok = () => json(200, { ok: true });

const SEARCH_REFUSAL = "web search is not enabled for this workspace";
const FETCH_REFUSAL = "web fetch is not authorized for this workspace";

describe("GatewayToolState", () => {
  it("is active while unknown or available, offered only when available", () => {
    const state = new GatewayToolState(WEB_SEARCH);
    expect([state.active, state.offered]).toEqual([true, false]);
    state.probed("available");
    expect([state.active, state.offered]).toEqual([true, true]);
    state.probed("unavailable");
    expect([state.active, state.offered]).toEqual([false, false]);
  });

  it("holds a refusal until the next probe, whatever it answers", () => {
    const onChange = vi.fn();
    const state = new GatewayToolState(WEB_SEARCH, onChange);
    state.probed("available");
    state.refuse("no backend");
    expect([state.active, state.offered]).toEqual([false, false]);
    state.probed("unknown");
    expect(state.active).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("reports each refusal reason once", () => {
    const onChange = vi.fn();
    const state = new GatewayToolState(WEB_SEARCH, onChange);
    expect(state.refuse("no backend")).toBe(true);
    expect(state.refuse("no backend")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    state.probed("unknown");
    expect(state.refuse("no backend")).toBe(false);
    expect(state.refuse("workspace off")).toBe(true);
  });
});

describe("probeGatewayTools", () => {
  it("reports each tool as the catalog lists it", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(`${BASE_URL}/tools`);
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
    const availability = await probeGatewayTools(
      config,
      "tk_test",
      fetcher as typeof fetch,
    );
    expect(availability(WEB_SEARCH.id)).toBe("available");
    expect(availability(WEB_FETCH.id)).toBe("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when the tool is missing or not available", async () => {
    const missing = vi.fn(async () => toolsCatalog([]));
    expect(
      (await probeGatewayTools(config, "tk_test", missing as typeof fetch))(
        WEB_FETCH.id,
      ),
    ).toBe("unavailable");
    const off = vi.fn(async () =>
      toolsCatalog([{ id: "otari_web_search", available: false }]),
    );
    expect(
      (await probeGatewayTools(config, "tk_test", off as typeof fetch))(
        WEB_SEARCH.id,
      ),
    ).toBe("unavailable");
  });

  it.each([401, 403, 404, 500])(
    "reports unknown on HTTP %s, keeping requests eligible",
    async (status) => {
      const fetcher = vi.fn(async () => json(status, {}));
      const availability = await probeGatewayTools(
        config,
        "tk_test",
        fetcher as typeof fetch,
      );
      expect(availability(WEB_SEARCH.id)).toBe("unknown");
      expect(availability(WEB_FETCH.id)).toBe("unknown");
    },
  );

  it("reports unknown on a network failure, a malformed body, or no token", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      (await probeGatewayTools(config, "tk_test", down as typeof fetch))(
        WEB_SEARCH.id,
      ),
    ).toBe("unknown");
    const malformed = vi.fn(async () => json(200, { unexpected: true }));
    expect(
      (await probeGatewayTools(config, "tk_test", malformed as typeof fetch))(
        WEB_SEARCH.id,
      ),
    ).toBe("unknown");
    const fetcher = vi.fn();
    expect(
      (await probeGatewayTools(config, undefined, fetcher as typeof fetch))(
        WEB_SEARCH.id,
      ),
    ).toBe("unknown");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("rejectionReason", () => {
  it("reads a string detail, or the messages of a validation error", async () => {
    expect(await rejectionReason(json(403, { detail: SEARCH_REFUSAL }))).toBe(
      SEARCH_REFUSAL,
    );
    expect(
      await rejectionReason(
        json(422, {
          detail: [
            { loc: ["body", "tools", 0], msg: "unknown tool type" },
            { loc: ["body"], msg: "second problem" },
          ],
        }),
      ),
    ).toBe("unknown tool type; second problem");
  });

  it("falls back to the status when the body says nothing usable", async () => {
    expect(await rejectionReason(new Response("nope", { status: 400 }))).toBe(
      "HTTP 400",
    );
    expect(await rejectionReason(json(422, { detail: [{}] }))).toBe("HTTP 422");
  });
});

describe("wrapFetchWithGatewayTools", () => {
  /**
   * A fetch stub that records each request body and answers from `reply`.
   * Declares web search alone unless given other tool states.
   */
  function harness(
    reply: (call: number) => Response | Promise<Response> = ok,
    state = new GatewayToolState(WEB_SEARCH),
    tools: GatewayToolState[] = [state],
  ) {
    const bodies: string[] = [];
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return reply(bodies.length);
      },
    );
    const onRefused = vi.fn();
    const wrapped = wrapFetchWithGatewayTools(fetcher as typeof fetch, {
      baseUrl: BASE_URL,
      tools,
      onRefused,
    });
    const sentTools = (call: number) => JSON.parse(bodies[call]).tools;
    return { wrapped, fetcher, bodies, sentTools, onRefused, state };
  }

  it("appends the declaration after the request's own tools", async () => {
    const { wrapped, sentTools, bodies } = harness();
    await wrapped(
      COMPLETIONS_URL,
      completionInit({
        model: "m",
        tools: [{ type: "function", function: { name: "bash" } }],
      }),
    );
    expect(sentTools(0)).toEqual([
      { type: "function", function: { name: "bash" } },
      { type: "otari_web_search" },
    ]);
    expect(JSON.parse(bodies[0]).model).toBe("m");
  });

  it("creates the tools array when the request has none", async () => {
    const { wrapped, sentTools } = harness();
    await wrapped(COMPLETIONS_URL, completionInit({ model: "m" }));
    expect(sentTools(0)).toEqual([{ type: "otari_web_search" }]);
  });

  it("declares on this deployment's completions URL with a query or trailing slash", async () => {
    const { wrapped, sentTools } = harness();
    await wrapped(`${COMPLETIONS_URL}?api-version=1`, completionInit({}));
    await wrapped(`${COMPLETIONS_URL}/`, completionInit({}));
    expect(sentTools(0)).toEqual([{ type: "otari_web_search" }]);
    expect(sentTools(1)).toEqual([{ type: "otari_web_search" }]);
  });

  it("leaves everything but an Otari completion with a JSON body alone", async () => {
    const { wrapped, fetcher, bodies } = harness();
    const ownDeclaration = completionInit({
      tools: [{ type: "otari_web_search", max_uses: 2 }],
    });
    await wrapped(
      "https://api.openai.com/v1/chat/completions",
      completionInit({}),
    );
    await wrapped(
      "https://api.otari.ai/other/chat/completions",
      completionInit({}),
    );
    await wrapped(`${BASE_URL}/models`, { method: "GET" });
    await wrapped(COMPLETIONS_URL, { method: "GET" });
    await wrapped(COMPLETIONS_URL, { method: "POST" });
    await wrapped(COMPLETIONS_URL, ownDeclaration);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(bodies.slice(0, 5).join("")).not.toContain("otari_web_search");
    expect(vi.mocked(fetcher).mock.calls[5][1]).toBe(ownDeclaration);
  });

  it("declares nothing once the catalog said unavailable", async () => {
    const state = new GatewayToolState(WEB_SEARCH);
    state.probed("unavailable");
    const { wrapped, bodies } = harness(ok, state);
    await wrapped(COMPLETIONS_URL, completionInit({ model: "m" }));
    expect(bodies[0]).not.toContain("otari_web_search");
  });

  it.each([400, 403, 422])(
    "stops declaring when a %s goes away without the declaration",
    async (status) => {
      const { wrapped, fetcher, sentTools, onRefused, state } = harness(
        (call) =>
          call === 1 ? json(status, { detail: SEARCH_REFUSAL }) : ok(),
      );
      const response = await wrapped(
        COMPLETIONS_URL,
        completionInit({ model: "m", tools: [] }),
      );
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(sentTools(0)).toEqual([{ type: "otari_web_search" }]);
      expect(sentTools(1)).toEqual([]);
      expect(state.active).toBe(false);
      expect(onRefused).toHaveBeenCalledWith(WEB_SEARCH, SEARCH_REFUSAL);

      await wrapped(COMPLETIONS_URL, completionInit({ model: "m" }));
      expect(sentTools(2)).toBeUndefined();
      expect(onRefused).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps web search on when the error survives the retry", async () => {
    const { wrapped, fetcher, onRefused, state } = harness((call) =>
      json(400, { detail: `reasoning_effort unsupported (${call})` }),
    );
    const response = await wrapped(
      COMPLETIONS_URL,
      completionInit({ model: "m" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      detail: "reasoning_effort unsupported (2)",
    });
    expect(state.active).toBe(true);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("checks a client error against the declaration once per refresh", async () => {
    const { wrapped, fetcher, state } = harness(() =>
      json(400, { detail: "unknown model" }),
    );
    await wrapped(COMPLETIONS_URL, completionInit({}));
    await wrapped(COMPLETIONS_URL, completionInit({}));
    expect(fetcher).toHaveBeenCalledTimes(3);
    state.probed("unknown");
    await wrapped(COMPLETIONS_URL, completionInit({}));
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not retry once a declared request has succeeded", async () => {
    const { wrapped, fetcher, state } = harness((call) =>
      call === 1 ? ok() : json(400, { detail: "unknown model" }),
    );
    await wrapped(COMPLETIONS_URL, completionInit({}));
    const response = await wrapped(COMPLETIONS_URL, completionInit({}));
    expect(response.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state.active).toBe(true);
  });

  it("does not retry server errors", async () => {
    const { wrapped, fetcher, state } = harness(() => json(500, {}));
    const response = await wrapped(COMPLETIONS_URL, completionInit({}));
    expect(response.status).toBe(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.active).toBe(true);
  });

  it("warns once when concurrent requests are refused", async () => {
    const pending: Array<() => void> = [];
    const { wrapped, onRefused } = harness(async (call) => {
      if (call > 3) return ok();
      await new Promise<void>((resolve) => pending.push(resolve));
      return json(400, { detail: SEARCH_REFUSAL });
    });
    const requests = [1, 2, 3].map(() =>
      wrapped(COMPLETIONS_URL, completionInit({ model: "m" })),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    for (const resolve of pending) resolve();
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  describe("with web search and web fetch", () => {
    function both(reply: (call: number) => Response | Promise<Response>) {
      const search = new GatewayToolState(WEB_SEARCH);
      const fetchTool = new GatewayToolState(WEB_FETCH);
      return {
        ...harness(reply, search, [search, fetchTool]),
        search,
        fetchTool,
      };
    }

    it("declares both, search first, after the request's own tools", async () => {
      const { wrapped, sentTools } = both(ok);
      await wrapped(
        COMPLETIONS_URL,
        completionInit({ tools: [{ type: "function" }] }),
      );
      expect(sentTools(0)).toEqual([
        { type: "function" },
        { type: "otari_web_search" },
        { type: "otari_web_fetch" },
      ]);
    });

    it("adds only the tool the request does not declare itself", async () => {
      const { wrapped, sentTools } = both(ok);
      await wrapped(
        COMPLETIONS_URL,
        completionInit({ tools: [{ type: "otari_web_search", max_uses: 2 }] }),
      );
      expect(sentTools(0)).toEqual([
        { type: "otari_web_search", max_uses: 2 },
        { type: "otari_web_fetch" },
      ]);
    });

    it("drops only fetch when the gateway refuses it and keeps search", async () => {
      const { wrapped, fetcher, sentTools, onRefused, search, fetchTool } =
        both((call) =>
          call === 1 ? json(403, { detail: FETCH_REFUSAL }) : ok(),
        );
      const response = await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(sentTools(1)).toEqual([{ type: "otari_web_search" }]);
      expect([search.active, search.accepted]).toEqual([true, true]);
      expect(fetchTool.active).toBe(false);
      expect(onRefused).toHaveBeenCalledExactlyOnceWith(
        WEB_FETCH,
        FETCH_REFUSAL,
      );
    });

    it("blames only search when it alone was refused, keeping fetch", async () => {
      // No search backend: any request declaring search is a 400.
      const { wrapped, fetcher, sentTools, onRefused, search, fetchTool } =
        both((call) =>
          call <= 2 ? json(400, { detail: SEARCH_REFUSAL }) : ok(),
        );
      const response = await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(sentTools(2)).toBeUndefined();
      expect(search.active).toBe(false);
      expect([fetchTool.active, fetchTool.accepted]).toEqual([true, false]);
      expect(onRefused).toHaveBeenCalledExactlyOnceWith(
        WEB_SEARCH,
        SEARCH_REFUSAL,
      );

      // Fetch only failed alongside search, so the next request tries it alone.
      await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(sentTools(3)).toEqual([{ type: "otari_web_fetch" }]);
      expect(fetchTool.accepted).toBe(true);
    });

    it("finds a second refused tool on the next request, with its own reason", async () => {
      const { wrapped, fetcher, onRefused, search, fetchTool } = both((call) =>
        call === 1 || call === 2
          ? json(400, { detail: SEARCH_REFUSAL })
          : call === 4
            ? json(403, { detail: FETCH_REFUSAL })
            : ok(),
      );
      await wrapped(COMPLETIONS_URL, completionInit({}));
      await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(fetcher).toHaveBeenCalledTimes(5);
      expect([search.active, fetchTool.active]).toEqual([false, false]);
      expect(onRefused).toHaveBeenNthCalledWith(1, WEB_SEARCH, SEARCH_REFUSAL);
      expect(onRefused).toHaveBeenNthCalledWith(2, WEB_FETCH, FETCH_REFUSAL);
    });

    it("settles nothing when a retry fails for another reason", async () => {
      const { wrapped, fetcher, sentTools, onRefused, search, fetchTool } =
        both((call) =>
          call === 1
            ? json(403, { detail: FETCH_REFUSAL })
            : call === 2
              ? json(503, {})
              : ok(),
        );
      const response = await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(response.status).toBe(503);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect([search.accepted, fetchTool.accepted]).toEqual([false, false]);
      expect(onRefused).not.toHaveBeenCalled();
      await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(sentTools(2)).toEqual([
        { type: "otari_web_search" },
        { type: "otari_web_fetch" },
      ]);
    });

    it("does not parse the body once no tool is active", async () => {
      const { wrapped, fetcher, search, fetchTool } = both(ok);
      search.probed("unavailable");
      fetchTool.probed("unavailable");
      const parse = vi.spyOn(JSON, "parse");
      const init = completionInit({ model: "m" });
      parse.mockClear();
      await wrapped(COMPLETIONS_URL, init);
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
      expect(vi.mocked(fetcher).mock.calls[0][1]).toBe(init);
    });

    it("keeps both on when the error survives every retry", async () => {
      const { wrapped, fetcher, onRefused, search, fetchTool } = both(() =>
        json(400, { detail: "unknown model" }),
      );
      const response = await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(response.status).toBe(400);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect([search.active, fetchTool.active]).toEqual([true, true]);
      expect(onRefused).not.toHaveBeenCalled();
      // Settled until the next refresh: later errors pass straight through.
      await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it("never drops a tool the gateway has already accepted", async () => {
      const { wrapped, fetcher, sentTools, search, fetchTool } = both((call) =>
        call === 2 ? json(403, { detail: FETCH_REFUSAL }) : ok(),
      );
      search.accept();
      await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetchTool.accepted).toBe(true);
      fetchTool.probed("unknown");
      await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(sentTools(2)).toEqual([{ type: "otari_web_search" }]);
      expect([search.active, fetchTool.active]).toEqual([true, false]);
    });

    it("declares nothing for a tool the catalog marks unavailable", async () => {
      const { wrapped, sentTools, fetchTool } = both(ok);
      fetchTool.probed("unavailable");
      await wrapped(COMPLETIONS_URL, completionInit({}));
      expect(sentTools(0)).toEqual([{ type: "otari_web_search" }]);
    });
  });
});
