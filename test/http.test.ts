import { describe, expect, it, vi } from "vitest";
import { request } from "../src/http.js";

describe("request", () => {
  it("sends a GET with bearer auth and no redirects", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));

    await request(
      "https://otari.test/api/v1/models",
      "tk",
      new AbortController().signal,
      fetcher,
    );

    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://otari.test/api/v1/models");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tk");
  });

  it("sends a body as a JSON POST", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));

    await request(
      "https://otari.test/api/v1/x",
      "tk",
      new AbortController().signal,
      fetcher,
      { a: 1 },
    );

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("aborts a request when the caller's signal aborts", async () => {
    const caller = new AbortController();
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        caller.abort();
        return new Response(String(init?.signal?.aborted));
      },
    );

    const response = await request(
      "https://otari.test/api/v1/x",
      undefined,
      caller.signal,
      fetcher,
    );

    expect(await response.text()).toBe("true");
  });
});
