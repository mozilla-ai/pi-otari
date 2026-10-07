import { request } from "./discovery.js";
import type { OtariConfig } from "./types.js";

type Fetcher = typeof fetch;

/**
 * The `tools[]` entry that asks an Otari gateway to run web search itself: the
 * gateway offers the model its own `web_search` function, runs the search
 * mid-completion, and keeps that exchange out of the client stream. See "Web
 * search" in Otari's docs/tools.md.
 */
export const OTARI_WEB_SEARCH_DECLARATION = {
  type: "otari_web_search",
} as const;

export type WebSearchAvailability = "available" | "unavailable" | "unknown";

export interface WebSearchState {
  /** Last answer from the gateway's tools catalog, or "unknown" before it answered. */
  availability: WebSearchAvailability;
  /** Set when the gateway refused the declaration; cleared by the next completed probe. */
  rejected: boolean;
  /** The last refusal shown to the user, so repeats and concurrent refusals stay quiet. */
  reportedRefusal?: string;
  /** Called after availability or rejected changes, e.g. to redraw the status line. */
  onChange?: () => void;
}

export function createWebSearchState(onChange?: () => void): WebSearchState {
  return { availability: "unknown", rejected: false, onChange };
}

/**
 * True while a request may declare the tool. "unknown" stays optimistic: a
 * hybrid gateway does not serve GET /tools but may still run searches, and a
 * refusal costs one transparent retry (see wrapFetchWithWebSearch).
 */
export function webSearchActive(state: WebSearchState): boolean {
  return state.availability !== "unavailable" && !state.rejected;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Ask the gateway whether it runs otari_web_search, from GET {baseUrl}/tools —
 * the same catalog read Otari's dashboard uses, answered to the workspace
 * token. Only a parsed answer counts as evidence: any HTTP, network, or shape
 * failure is "unknown", which keeps requests eligible for injection.
 */
export async function probeWebSearch(
  config: OtariConfig,
  token: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<WebSearchAvailability> {
  if (!token) return "unknown";
  try {
    const response = await request(
      `${config.baseUrl}/tools`,
      token,
      config.discoveryTimeoutMs,
      fetcher,
    );
    if (!response.ok) return "unknown";
    const root = record(await response.json());
    if (!root || !Array.isArray(root.data)) return "unknown";
    const entry = root.data
      .map(record)
      .find((item) => item?.id === OTARI_WEB_SEARCH_DECLARATION.type);
    return entry?.available === true ? "available" : "unavailable";
  } catch {
    return "unknown";
  }
}

/**
 * Match the gateway's own refusal texts for a declared otari_web_search, which
 * travel in the FastAPI `detail` field: no search backend configured (400),
 * web search off for the workspace (403), an unsupported declaration field
 * (400), or a managed-tool conflict (400). A gateway that predates the tool
 * rejects the unknown `tools[].type` as a FastAPI validation error (422), whose
 * `detail` is a list of `{loc, msg}` entries naming otari_web_search. Nothing
 * else disables injection: a 401 is about the key, and an upstream provider
 * error is about the model.
 */
const WEB_SEARCH_REFUSAL =
  /otari_web_search|web search is not enabled for this workspace/;

const REFUSAL_STATUSES = new Set([400, 403, 422]);

export function webSearchRefusalDetail(body: unknown): string | undefined {
  const detail = record(body)?.detail;
  if (typeof detail === "string")
    return WEB_SEARCH_REFUSAL.test(detail) ? detail : undefined;
  if (!Array.isArray(detail)) return undefined;
  const messages = detail.flatMap((entry) => {
    const item = record(entry);
    const text = JSON.stringify([item?.loc, item?.msg, item?.input]);
    return item && WEB_SEARCH_REFUSAL.test(text)
      ? [typeof item.msg === "string" ? item.msg : text]
      : [];
  });
  return messages.length > 0 ? messages.join("; ") : undefined;
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * Only a POST to this deployment's own chat completions endpoint qualifies:
 * same origin, and the base URL's path plus /chat/completions, ignoring a
 * query string or trailing slash. Anything else, including another provider's
 * URL that happens to reach this fetch, passes through untouched.
 */
function isCompletionRequest(
  baseUrl: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") return false;
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const base = new URL(baseUrl);
    return (
      url.origin === base.origin &&
      withoutTrailingSlash(url.pathname) ===
        `${withoutTrailingSlash(base.pathname)}/chat/completions`
    );
  } catch {
    return false;
  }
}

function isDeclaration(tool: unknown): boolean {
  return record(tool)?.type === OTARI_WEB_SEARCH_DECLARATION.type;
}

function parseJsonBody(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "string") return undefined;
  try {
    return record(JSON.parse(body));
  } catch {
    return undefined;
  }
}

/**
 * Wrap the fetch Pi's OpenAI client uses so every Otari chat completion
 * declares otari_web_search while the gateway welcomes it. A refusal flips the
 * shared state and the request is retried once without the declaration, so a
 * gateway that cannot search reads as "no web search", never as a broken
 * completion. Bodies that are not JSON strings (the SDK always sends one) pass
 * through untouched, and a request that already declares the tool keeps its
 * own declaration. onRejected fires once per distinct refusal text, however
 * many requests in flight hit it.
 */
export function wrapFetchWithWebSearch(
  inner: Fetcher,
  baseUrl: string,
  state: WebSearchState,
  onRejected: (detail: string) => void,
): Fetcher {
  return async (input, init) => {
    if (!webSearchActive(state) || !isCompletionRequest(baseUrl, input, init)) {
      return inner(input, init);
    }
    const body = parseJsonBody(init?.body);
    if (!body) return inner(input, init);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const declared = tools.some(isDeclaration);
    const response = await inner(
      input,
      declared
        ? init
        : {
            ...init,
            body: JSON.stringify({
              ...body,
              tools: [...tools, OTARI_WEB_SEARCH_DECLARATION],
            }),
          },
    );
    if (!REFUSAL_STATUSES.has(response.status)) return response;
    let detail: string | undefined;
    try {
      detail = webSearchRefusalDetail(await response.clone().json());
    } catch {
      return response;
    }
    if (detail === undefined) return response;
    // Release the refused response's connection before retrying.
    await response.body?.cancel().catch(() => {});
    if (!state.rejected) {
      state.rejected = true;
      state.onChange?.();
    }
    if (state.reportedRefusal !== detail) {
      state.reportedRefusal = detail;
      onRejected(detail);
    }
    // Strip every declaration, the caller's own included, so the retry
    // cannot be refused for the same reason.
    const { tools: _tools, ...rest } = body;
    const remaining = tools.filter((tool) => !isDeclaration(tool));
    return inner(input, {
      ...init,
      body: JSON.stringify(
        Array.isArray(body.tools) ? { ...rest, tools: remaining } : rest,
      ),
    });
  };
}
