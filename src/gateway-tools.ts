import { type Fetcher, request } from "./http.js";
import { record } from "./model-mapper.js";
import type { OtariConfig } from "./types.js";

/**
 * A tool an Otari gateway runs itself when a request declares it in `tools[]`:
 * the gateway offers the model its own function, runs it mid-completion, and
 * keeps that exchange out of the client stream. See Otari's docs/tools.md.
 */
export interface GatewayTool {
  /** The `tools[]` type, also its id in GET /tools. */
  id: string;
  /** How the status line and warnings name it. */
  label: string;
  /** The environment variable that turns it off. */
  setting: string;
  /** The config field that variable is parsed into. */
  configKey: "webSearch" | "webFetch";
}

export const WEB_SEARCH: GatewayTool = {
  id: "otari_web_search",
  label: "web search",
  setting: "OTARI_WEB_SEARCH",
  configKey: "webSearch",
};

export const WEB_FETCH: GatewayTool = {
  id: "otari_web_fetch",
  label: "web fetch",
  setting: "OTARI_WEB_FETCH",
  configKey: "webFetch",
};

/** In the order they are declared; a refusal is checked last tool first. */
export const GATEWAY_TOOLS = [WEB_SEARCH, WEB_FETCH] as const;

/** Statuses a gateway may answer when it cannot accept a declaration. */
const REFUSAL_STATUSES = new Set([400, 403, 422]);

export type ToolAvailability = "available" | "unavailable" | "unknown";

/**
 * What the extension knows about one gateway tool on this deployment, shared
 * by the provider (which probes), the request path (which may be refused), and
 * the status line (which shows it).
 */
export class GatewayToolState {
  private availability: ToolAvailability = "unknown";
  private refused = false;
  private acceptedDeclaration = false;
  private reportedReason: string | undefined;

  /** onChange runs after every change that can alter `offered`. */
  constructor(
    readonly tool: GatewayTool,
    private readonly onChange: () => void = () => {},
  ) {}

  /**
   * Whether requests may declare the tool. "unknown" stays optimistic: a
   * hybrid gateway does not serve GET /tools but may still run the tool, and
   * a refusal costs one transparent retry.
   */
  get active(): boolean {
    return this.availability !== "unavailable" && !this.refused;
  }

  /**
   * Whether the gateway has accepted the declaration since the last refresh.
   * After that, a client error on a declared request is about something
   * else and does not lead to dropping this tool.
   */
  get accepted(): boolean {
    return this.acceptedDeclaration;
  }

  /** Whether to tell the user the tool is on: only on the catalog's word. */
  get offered(): boolean {
    return this.availability === "available" && !this.refused;
  }

  /**
   * Record a completed probe. Like every refresh it starts over: an earlier
   * refusal lifts, as its warning says, and the declaration is unproven again.
   */
  probed(availability: ToolAvailability): void {
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
 * Ask the gateway which tools it runs, from GET {baseUrl}/tools — the same
 * catalog read Otari's dashboard uses, answered to the workspace token. Only a
 * parsed answer counts as evidence: any HTTP, network, or shape failure makes
 * every tool "unknown", which keeps requests eligible for its declaration.
 */
export async function probeGatewayTools(
  config: OtariConfig,
  token: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<(id: string) => ToolAvailability> {
  const unknown = () => "unknown" as const;
  if (!token) return unknown;
  try {
    const response = await request(
      `${config.baseUrl}/tools`,
      token,
      AbortSignal.timeout(config.discoveryTimeoutMs),
      fetcher,
    );
    if (!response.ok) return unknown;
    const root = record(await response.json());
    if (!root || !Array.isArray(root.data)) return unknown;
    const entries = root.data.map(record);
    return (id) =>
      entries.find((item) => item?.id === id)?.available === true
        ? "available"
        : "unavailable";
  } catch {
    return unknown;
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

function jsonBody(init?: RequestInit): Record<string, unknown> | undefined {
  if (typeof init?.body !== "string") return undefined;
  try {
    return record(JSON.parse(init.body));
  } catch {
    return undefined;
  }
}

export interface GatewayToolsFetchOptions {
  /** Only completions sent to this deployment declare the tools. */
  baseUrl: string;
  /** The tools to declare, each while its state allows it. */
  tools: readonly GatewayToolState[];
  /** Called once per tool for each distinct reason the gateway gives. */
  onRefused: (tool: GatewayTool, reason: string) => void;
}

/**
 * Wrap the fetch Pi's OpenAI client uses so every Otari chat completion
 * declares each gateway tool its state allows, after the request's own tools.
 *
 * A refusal is recognised by its effect, not its wording, since Otari answers
 * 400, 403, or 422 for many other mistakes too: when a declared request fails
 * with such a client error, it is sent again without the last tool the gateway
 * has not yet accepted, and so on until an attempt succeeds or none is left.
 *
 * When one succeeds, only the tool dropped just before it is known to be
 * refused: it stays off until the next refresh. Tools dropped earlier may have
 * failed only alongside it, so they stay on and are tried again on the next
 * request, which settles them the same way. The tools that went through are
 * accepted. When the client error survives every retry, it was about
 * something else: that response is returned and every tool is accepted, so
 * later errors pass straight through until the next refresh. Any other
 * failure on a retry (a 429 or 5xx) settles nothing.
 *
 * Requests that are not Otari completions, have no JSON string body (the SDK
 * always sends one), or already declare every tool pass through untouched.
 */
export function wrapFetchWithGatewayTools(
  inner: Fetcher,
  { baseUrl, tools, onRefused }: GatewayToolsFetchOptions,
): Fetcher {
  return async (input, init) => {
    // Checked before parsing, since the body carries the whole transcript.
    if (!tools.some((state) => state.active)) return inner(input, init);
    const body = isCompletionRequest(baseUrl, input, init)
      ? jsonBody(init)
      : undefined;
    const own = Array.isArray(body?.tools) ? body.tools : [];
    const declared = new Set(own.map((tool) => record(tool)?.type));
    let sent = tools.filter(
      (state) => state.active && !declared.has(state.tool.id),
    );
    if (!body || sent.length === 0) return inner(input, init);

    const send = (states: GatewayToolState[]) =>
      states.length === 0
        ? inner(input, init)
        : inner(input, {
            ...init,
            body: JSON.stringify({
              ...body,
              tools: [...own, ...states.map(({ tool }) => ({ type: tool.id }))],
            }),
          });

    let response = await send(sent);
    const dropped: GatewayToolState[] = [];
    let reason = "";
    while (REFUSAL_STATUSES.has(response.status)) {
      const suspect = [...sent].reverse().find((state) => !state.accepted);
      if (!suspect) break;
      // Read the reason now, which also releases the refused connection.
      reason = await rejectionReason(response);
      dropped.push(suspect);
      sent = sent.filter((state) => state !== suspect);
      response = await send(sent);
    }

    const culprit = dropped.at(-1);
    if (response.ok) {
      for (const state of sent) state.accept();
      if (culprit?.refuse(reason)) onRefused(culprit.tool, reason);
    } else if (culprit && REFUSAL_STATUSES.has(response.status)) {
      for (const state of [...sent, ...dropped]) state.accept();
    }
    return response;
  };
}
