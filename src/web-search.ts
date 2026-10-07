import { request } from "./discovery.js";
import { record } from "./model-mapper.js";
import type { OtariConfig } from "./types.js";

type Fetcher = typeof fetch;

/**
 * The `tools[]` entry that asks an Otari gateway to run web search itself: the
 * gateway offers the model its own `web_search` function, runs the search
 * mid-completion, and keeps that exchange out of the client stream. See "Web
 * search" in Otari's docs/tools.md.
 */
const WEB_SEARCH_TOOL = "otari_web_search";

/** Statuses a gateway may answer when it cannot accept the declaration. */
const REFUSAL_STATUSES = new Set([400, 403, 422]);

export type WebSearchAvailability = "available" | "unavailable" | "unknown";

/**
 * What the extension knows about the deployment's web search, shared by the
 * provider (which probes), the request path (which may be refused), and the
 * status line (which shows it).
 */
export class WebSearchState {
  private availability: WebSearchAvailability = "unknown";
  private refused = false;
  private acceptedDeclaration = false;
  private reportedReason: string | undefined;

  /** onChange runs after every change that can alter `offered`. */
  constructor(private readonly onChange: () => void = () => {}) {}

  /**
   * Whether requests may declare the tool. "unknown" stays optimistic: a
   * hybrid gateway does not serve GET /tools but may still run searches, and
   * a refusal costs one transparent retry.
   */
  get active(): boolean {
    return this.availability !== "unavailable" && !this.refused;
  }

  /**
   * Whether the gateway has accepted the declaration since the last refresh.
   * After that, a client error on a declared request is about something
   * else and passes through without a retry.
   */
  get accepted(): boolean {
    return this.acceptedDeclaration;
  }

  /** Whether to tell the user search is on: only on the catalog's word. */
  get offered(): boolean {
    return this.availability === "available" && !this.refused;
  }

  /**
   * Record a completed probe. Like every refresh it starts over: an earlier
   * refusal lifts, as its warning says, and the declaration is unproven again.
   */
  probed(availability: WebSearchAvailability): void {
    this.availability = availability;
    this.refused = false;
    this.acceptedDeclaration = false;
    this.onChange();
  }

  /** Record that the gateway took a request carrying the declaration. */
  accept(): void {
    this.acceptedDeclaration = true;
  }

  /**
   * Record that the gateway refused the declaration. Returns true when this
   * reason has not been reported yet, so concurrent and repeated refusals
   * warn once.
   */
  refuse(reason: string): boolean {
    if (!this.refused) {
      this.refused = true;
      this.onChange();
    }
    if (this.reportedReason === reason) return false;
    this.reportedReason = reason;
    return true;
  }
}

/**
 * Ask the gateway whether it runs otari_web_search, from GET {baseUrl}/tools —
 * the same catalog read Otari's dashboard uses, answered to the workspace
 * token. Only a parsed answer counts as evidence: any HTTP, network, or shape
 * failure is "unknown", which keeps requests eligible for the declaration.
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
      .find((item) => item?.id === WEB_SEARCH_TOOL);
    return entry?.available === true ? "available" : "unavailable";
  } catch {
    return "unknown";
  }
}

/**
 * The gateway's reason for a rejection, for the user's warning only. Otari
 * sends it as a FastAPI `detail`: a string, or a list of `{msg}` entries for a
 * validation error.
 */
export async function rejectionReason(response: Response): Promise<string> {
  try {
    const detail = record(await response.json())?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((entry) => record(entry)?.msg)
        .filter((msg): msg is string => typeof msg === "string");
      if (messages.length > 0) return messages.join("; ");
    }
  } catch {}
  return `HTTP ${response.status}`;
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * Only a POST to this deployment's own chat completions endpoint qualifies:
 * same origin, and the base URL's path plus /chat/completions, ignoring a
 * query string or trailing slash.
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

/** The request's JSON body, unless it already declares the tool itself. */
function bodyToDeclare(
  init?: RequestInit,
): Record<string, unknown> | undefined {
  if (typeof init?.body !== "string") return undefined;
  let body: Record<string, unknown> | undefined;
  try {
    body = record(JSON.parse(init.body));
  } catch {
    return undefined;
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.some((tool) => record(tool)?.type === WEB_SEARCH_TOOL)
    ? undefined
    : body;
}

export interface WebSearchFetchOptions {
  /** Only completions sent to this deployment declare the tool. */
  baseUrl: string;
  state: WebSearchState;
  /** Called once per distinct reason the gateway gives for a refusal. */
  onRefused: (reason: string) => void;
}

/**
 * Wrap the fetch Pi's OpenAI client uses so every Otari chat completion
 * declares otari_web_search while the state allows it.
 *
 * A refusal is recognised by its effect, not its wording, since Otari answers
 * 400 or 422 for many other mistakes too: when a request we added the
 * declaration to fails with a client error and the same request without it
 * succeeds, the declaration was the cause, and web search stops. When the
 * retry fails too, the error was about something else; its response is
 * returned and web search stays on. Either outcome, like any successful
 * declared request, settles the question until the next refresh, so at most
 * one completion per refresh is sent twice.
 *
 * Requests that are not Otari completions, have no JSON string body (the SDK
 * always sends one), or already declare the tool pass through untouched.
 */
export function wrapFetchWithWebSearch(
  inner: Fetcher,
  { baseUrl, state, onRefused }: WebSearchFetchOptions,
): Fetcher {
  return async (input, init) => {
    const body =
      state.active && isCompletionRequest(baseUrl, input, init)
        ? bodyToDeclare(init)
        : undefined;
    if (!body) return inner(input, init);

    const tools = Array.isArray(body.tools) ? body.tools : [];
    const response = await inner(input, {
      ...init,
      body: JSON.stringify({
        ...body,
        tools: [...tools, { type: WEB_SEARCH_TOOL }],
      }),
    });
    if (response.ok) state.accept();
    if (!REFUSAL_STATUSES.has(response.status) || state.accepted)
      return response;

    // Read the reason now, which also releases the refused connection.
    const reason = await rejectionReason(response);
    const retry = await inner(input, init);
    if (!retry.ok) state.accept();
    else if (state.refuse(reason)) onRefused(reason);
    return retry;
  };
}
