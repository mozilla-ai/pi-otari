import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ConfigError } from "./config.js";
import { type Fetcher, request } from "./http.js";
import { THINKING_LEVEL_MAP } from "./model-mapper.js";
import {
  type Candidates,
  type RoutingSettings,
  readRoutingSettings,
} from "./subagent-settings.js";
import type { OtariConfig } from "./types.js";

/** How long a spawn waits for Otari before it starts on its usual model. */
export const DEADLINE_MS = 3000;

const PROVIDER = "otari";
// Otari's limits on the facts it is sent; longer values would cost the answer.
const MAX_PROMPT_CHARS = 65_536;
const MAX_AGENT_CHARS = 128;
const MAX_MODEL_CHARS = 256;
// Otari's reason goes into a notice, so only a short line of it.
const MAX_REASON_CHARS = 200;
// pi-subagents reads one of these after the last colon as a thinking level.
const THINKING_LEVELS = ["off", ...Object.keys(THINKING_LEVEL_MAP)];
// An assistant message that stops this way runs none of its tool calls.
const NO_TOOL_RUN = ["error", "aborted", "length"];

interface Recommendation {
  model?: unknown;
  reason?: unknown;
}

/** What every launch in one message needs before Otari can be asked. */
interface Setup {
  kind: "ready";
  token: string;
  candidates?: Candidates;
}

/** What happens to one launch. */
type Decision =
  /** Left as it is, without a word. */
  | { kind: "skip" }
  /** Routing cannot work until the user fixes something; said once. */
  | { kind: "off"; notice: string }
  /** Starts on `model`, a full pi model id. */
  | { kind: "routed"; model: string; reason?: string }
  /** Starts on its usual model, because of `why`. */
  | { kind: "failed"; why: string };

const SKIP: Decision = { kind: "skip" };

export interface SubagentRoutingDependencies {
  fetch: Fetcher;
}

/**
 * A single pi-subagents launch: one agent and one task. Workflows, parallel
 * tasks and chains start several children from one call, and one model for
 * all of them would be wrong, so they are left alone. Pi drops optional
 * nulls before the tool runs, so a null counts as absent.
 */
function isSingleLaunch(input: Record<string, unknown>): boolean {
  return (
    typeof input.agent === "string" &&
    typeof input.task === "string" &&
    input.action == null &&
    input.workflow == null &&
    input.tasks == null &&
    input.chain == null
  );
}

/** True when a decision made for `before` still holds for `after`. */
function sameLaunch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return (
    before.agent === after.agent &&
    before.task === after.task &&
    (before.model ?? undefined) === (after.model ?? undefined)
  );
}

function thinkingSuffix(model: unknown): string {
  if (typeof model !== "string") return "";
  const level = model.slice(model.lastIndexOf(":") + 1);
  return model.includes(":") && THINKING_LEVELS.includes(level)
    ? `:${level}`
    : "";
}

/** The first `max` UTF-16 units of `text`, without half of a surrogate pair. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** `text` as one short line, safe to show in the terminal. */
function plain(text: string): string {
  return clamp(text.replace(/\p{Cc}+/gu, " ").trim(), MAX_REASON_CHARS);
}

function canRun(ctx: ExtensionContext, id: string): boolean {
  const model = ctx.modelRegistry.find(PROVIDER, id);
  return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
}

function runnable(ctx: ExtensionContext, candidates: Candidates): Candidates {
  return Object.fromEntries(
    Object.entries(candidates).filter(([id]) => canRun(ctx, id)),
  );
}

async function apiKey(
  ctx: ExtensionContext,
  config: OtariConfig,
): Promise<string | undefined> {
  try {
    return (
      (await ctx.modelRegistry.getProviderAuth(PROVIDER))?.auth.apiKey ??
      config.token
    );
  } catch {
    return config.token;
  }
}

/** Settle as `work` does, or reject with the reason when `signal` aborts first. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Ask Otari for the model, or throw an error whose message says why not. */
async function recommend(
  ctx: ExtensionContext,
  config: OtariConfig,
  dependencies: SubagentRoutingDependencies,
  { token, candidates }: Setup,
  toolCallId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Decision> {
  const requested = typeof input.model === "string" ? input.model : null;
  const response = await request(
    `${config.baseUrl}/routing/recommend`,
    token,
    signal,
    dependencies.fetch,
    {
      harness: "pi",
      session_id: ctx.sessionManager.getSessionId(),
      tool_use_id: toolCallId,
      agent_type: clamp(String(input.agent), MAX_AGENT_CHARS),
      prompt: clamp(String(input.task), MAX_PROMPT_CHARS),
      parent_model: ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "unknown",
      requested_model:
        requested && requested.length <= MAX_MODEL_CHARS ? requested : null,
      ...(candidates ? { candidates } : {}),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let answer: Recommendation;
  try {
    answer = (await response.json()) as Recommendation;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("unreadable answer");
  }
  const model = answer?.model;
  if (typeof model !== "string" || model === "") {
    throw new Error("the answer names no model");
  }
  if (candidates && !Object.hasOwn(candidates, model)) {
    throw new Error(`${model} is not one of your candidates`);
  }
  if (!canRun(ctx, model)) {
    throw new Error(`pi cannot run ${PROVIDER}/${model}`);
  }
  // A level only means something to a reasoning model.
  const suffix = ctx.modelRegistry.find(PROVIDER, model)?.reasoning
    ? thinkingSuffix(input.model)
    : "";
  // Without a level of its own after it, pi-subagents would read the end of
  // the id as one.
  if (!suffix && thinkingSuffix(model)) {
    throw new Error(`${model} ends in what pi-subagents reads as a level`);
  }
  return {
    kind: "routed",
    model: `${PROVIDER}/${model}${suffix}`,
    reason:
      typeof answer.reason === "string" ? plain(answer.reason) : undefined,
  };
}

/**
 * Before pi-subagents starts a subagent, ask Otari which model it should run
 * on, and start it there. Off unless pi's settings turn it on. Any failure
 * leaves the launch as it was: routing never blocks a subagent.
 */
export function registerSubagentRouting(
  pi: ExtensionAPI,
  config: OtariConfig,
  dependencies: SubagentRoutingDependencies,
): void {
  const shownNotices = new Set<string>();
  // Pi prepares the tool calls of one message one after another, so every
  // launch in it is asked about at once, when the message ends.
  const asked = new Map<
    string,
    { input: Record<string, unknown>; decision: Promise<Decision> }
  >();

  /** Read the settings, the key and the candidates, or say why not. */
  async function setUp(ctx: ExtensionContext): Promise<Setup | Decision> {
    let settings: RoutingSettings;
    try {
      settings = readRoutingSettings(pi.getSettings());
    } catch (error) {
      return {
        kind: "off",
        notice:
          error instanceof ConfigError
            ? error.message
            : "pi's settings could not be read.",
      };
    }
    if (!settings.enabled) return SKIP;
    const token = await apiKey(ctx, config);
    if (!token) {
      return {
        kind: "off",
        notice:
          "there is no Otari API key. Run `/login otari` or set OTARI_API_KEY.",
      };
    }
    if (!settings.candidates) return { kind: "ready", token };
    const candidates = runnable(ctx, settings.candidates);
    if (Object.keys(candidates).length < 2) {
      return {
        kind: "failed",
        why: "fewer than two of your candidates are available in pi",
      };
    }
    return { kind: "ready", token, candidates };
  }

  /** Decide one launch. Never rejects: any failure is a decision too. */
  async function decide(
    ctx: ExtensionContext,
    setup: Promise<Setup | Decision>,
    toolCallId: string,
    input: Record<string, unknown>,
  ): Promise<Decision> {
    let turn: AbortSignal | undefined;
    try {
      turn = ctx.signal;
    } catch {
      // The session this launch belonged to is gone.
      return SKIP;
    }
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new Error(`no answer within ${DEADLINE_MS / 1000} seconds`),
        ),
      DEADLINE_MS,
    );
    const signal = turn
      ? AbortSignal.any([deadline.signal, turn])
      : deadline.signal;
    try {
      const ready = await until(setup, signal);
      if (ready.kind !== "ready") return ready;
      return await until(
        recommend(ctx, config, dependencies, ready, toolCallId, input, signal),
        signal,
      );
    } catch (error) {
      // A cancelled turn starts no subagent; there is nothing to say.
      if (turn?.aborted) return SKIP;
      return {
        kind: "failed",
        why: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  pi.on("message_end", (event, ctx) => {
    const { message } = event;
    if (message.role !== "assistant") return;
    if (NO_TOOL_RUN.includes(message.stopReason)) return;
    if (!pi.getActiveTools().includes("subagent")) return;
    const launches = message.content.flatMap((block) =>
      block.type === "toolCall" &&
      block.name === "subagent" &&
      isSingleLaunch(block.arguments)
        ? [block]
        : [],
    );
    // A launch whose id is empty or shared cannot be told apart from the
    // others; it is decided when it starts.
    const ids = launches.map((block) => block.id);
    const distinct = launches.filter(
      (block) =>
        block.id !== "" && ids.indexOf(block.id) === ids.lastIndexOf(block.id),
    );
    if (distinct.length === 0) return;
    const setup = setUp(ctx);
    for (const block of distinct) {
      const input = { ...block.arguments };
      asked.set(block.id, {
        input,
        decision: decide(ctx, setup, block.id, input),
      });
    }
  });

  pi.on("turn_end", () => {
    asked.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    if (!isSingleLaunch(input)) return;

    const saved = asked.get(event.toolCallId);
    asked.delete(event.toolCallId);
    // Pi, or another extension, may have changed the launch since its
    // message ended; a decision for other facts does not count.
    const decision = await (saved && sameLaunch(saved.input, input)
      ? saved.decision
      : decide(ctx, setUp(ctx), event.toolCallId, input));

    const agent = String(input.agent);
    switch (decision.kind) {
      case "skip":
        return;
      case "off":
        if (ctx.hasUI && !shownNotices.has(decision.notice)) {
          ctx.ui.notify(
            `Subagent routing is off: ${decision.notice}`,
            "warning",
          );
          shownNotices.add(decision.notice);
        }
        return;
      case "routed":
        // pi-subagents reads the mutated input; an explicit model wins over
        // the agent's own.
        input.model = decision.model;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `${agent} starts on ${decision.model}, Otari's choice${decision.reason ? ` (${decision.reason})` : ""}`,
            "info",
          );
        }
        return;
      case "failed":
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Otari did not decide (${decision.why}); ${agent} starts on its usual model`,
            "warning",
          );
        }
    }
  });
}
