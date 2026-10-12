export type Fetcher = typeof fetch;

/**
 * One request to Otari: bearer auth when a token is given, no redirects, and
 * aborted when `signal` aborts. A `body` makes it a JSON POST. Read the
 * response under the same signal, so a body that stalls is cut off too.
 */
export async function request(
  url: string,
  token: string | undefined,
  signal: AbortSignal,
  fetcher: Fetcher,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetcher(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal,
  });
}
