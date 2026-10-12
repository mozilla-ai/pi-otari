import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEADLINE_MS,
  registerSubagentRouting,
} from "../src/subagent-routing.js";
import type { OtariConfig } from "../src/types.js";

const config: OtariConfig = {
  baseUrl: "https://otari.test/api/v1",
  token: "tk_env",
  discoveryTimeoutMs: 5000,
  environmentModels: [],
  officialHosted: false,
};

const KNOWN = [
  "otari/openai:gpt-5-mini",
  "otari/anthropic:claude-sonnet-5-5",
  "otari/anthropic:claude-opus-5-5",
];

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Options {
  settings?: unknown;
  getSettings?: () => unknown;
  fetch?: typeof fetch;
  known?: string[];
  notReasoning?: string[];
  storedKey?: string;
  providerAuth?: () => Promise<unknown>;
  token?: string;
  hasUI?: boolean;
  signal?: AbortSignal;
  activeTools?: string[];
}

function harness(options: Options = {}) {
  const handlers = new Map<
    string,
    (event: unknown, ctx: unknown) => Promise<unknown>
  >();
  const pi = {
    on: vi.fn((name: string, handler: never) => handlers.set(name, handler)),
    getActiveTools: () => options.activeTools ?? ["read", "subagent"],
    getSettings: vi.fn(
      options.getSettings ??
        (() =>
          options.settings ?? {
            otari: { subagentRouting: { enabled: true } },
          }),
    ),
  } as unknown as ExtensionAPI;
  const fetcher = vi.fn(
    options.fetch ??
      (async () =>
        answer({
          model: "openai:gpt-5-mini",
          reason: "jev-1.13.0 chose openai:gpt-5-mini with 74%",
        })),
  );
  registerSubagentRouting(
    pi,
    "token" in options ? { ...config, token: options.token } : config,
    { fetch: fetcher },
  );
  const known = new Set(options.known ?? KNOWN);
  const notReasoning = new Set(options.notReasoning ?? []);
  const notify = vi.fn();
  const ctx = {
    hasUI: options.hasUI ?? true,
    signal: options.signal,
    model: { provider: "otari", id: "anthropic:claude-opus-5-5" },
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: {
      find: (provider: string, id: string) =>
        known.has(`${provider}/${id}`)
          ? { provider, id, reasoning: !notReasoning.has(id) }
          : undefined,
      hasConfiguredAuth: () => true,
      getProviderAuth:
        options.providerAuth ??
        (async () =>
          options.storedKey
            ? { auth: { apiKey: options.storedKey } }
            : undefined),
    },
    ui: { notify },
  };
  const spawn = async (
    input: Record<string, unknown>,
    toolName = "subagent",
    toolCallId = "call-1",
  ) => {
    const event = { type: "tool_call", toolCallId, toolName, input };
    const result = await handlers.get("tool_call")?.(event, ctx);
    return { input: event.input, result };
  };
  // The parent model's message, with these launches in it, ends.
  const endMessage = (
    launches:
      | Record<string, Record<string, unknown>>
      | Array<[string, Record<string, unknown>]>,
  ) =>
    handlers.get("message_end")?.(
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: (Array.isArray(launches)
            ? launches
            : Object.entries(launches)
          ).map(([id, args]) => ({
            type: "toolCall",
            id,
            name: "subagent",
            arguments: args,
          })),
        },
      },
      ctx,
    );
  const endTurn = () => handlers.get("turn_end")?.({ type: "turn_end" }, ctx);
  return { spawn, endMessage, endTurn, ctx, fetcher, notify };
}

const sentBody = (fetcher: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));

describe("subagent routing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the subagent on Otari's choice", async () => {
    const { spawn, fetcher, notify } = harness({ storedKey: "tk_stored" });

    const { input, result } = await spawn({ agent: "scout", task: "Find X" });

    expect(result).toBeUndefined();
    expect(input.model).toBe("otari/openai:gpt-5-mini");
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://otari.test/api/v1/routing/recommend");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer tk_stored",
    );
    expect(sentBody(fetcher)).toEqual({
      harness: "pi",
      session_id: "session-1",
      tool_use_id: "call-1",
      agent_type: "scout",
      prompt: "Find X",
      parent_model: "otari/anthropic:claude-opus-5-5",
      requested_model: null,
    });
    expect(notify).toHaveBeenCalledWith(
      "scout starts on otari/openai:gpt-5-mini, Otari's choice (jev-1.13.0 chose openai:gpt-5-mini with 74%)",
      "info",
    );
  });

  it("falls back to the configured key when none is stored", async () => {
    const { spawn, fetcher } = harness();

    await spawn({ agent: "scout", task: "Find X" });

    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer tk_env",
    );
  });

  it("sends the caller's model as a fact and keeps its thinking level", async () => {
    const { spawn, fetcher } = harness();

    const { input } = await spawn({
      agent: "scout",
      task: "Find X",
      model: "otari/anthropic:claude-opus-5-5:high",
    });

    expect(sentBody(fetcher).requested_model).toBe(
      "otari/anthropic:claude-opus-5-5:high",
    );
    expect(input.model).toBe("otari/openai:gpt-5-mini:high");
  });

  it("sends the user's candidates that pi can run", async () => {
    const candidates = {
      "openai:gpt-5-mini": "Simple work.",
      "anthropic:claude-opus-5-5": null,
      "mistral:devstral-medium": "Not served to this user.",
    };
    const { spawn, fetcher } = harness({
      settings: { otari: { subagentRouting: { enabled: true, candidates } } },
    });

    await spawn({ agent: "scout", task: "Find X" });

    expect(sentBody(fetcher).candidates).toEqual({
      "openai:gpt-5-mini": "Simple work.",
      "anthropic:claude-opus-5-5": null,
    });
  });

  it("does not ask when fewer than two candidates are available", async () => {
    const candidates = {
      "openai:gpt-5-mini": null,
      "mistral:devstral-medium": null,
    };
    const { spawn, fetcher, notify } = harness({
      settings: { otari: { subagentRouting: { enabled: true, candidates } } },
    });

    const { input } = await spawn({ agent: "scout", task: "Find X" });

    expect(fetcher).not.toHaveBeenCalled();
    expect(input.model).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      "Otari did not decide (fewer than two of your candidates are available in pi); scout starts on its usual model",
      "warning",
    );
  });

  it.each([
    ["an HTTP error", async () => answer({ detail: "nope" }, 503), "HTTP 503"],
    [
      "an answer that is not JSON",
      async () => new Response("<html>"),
      "unreadable answer",
    ],
    [
      "an answer with no model",
      async () => answer({}),
      "the answer names no model",
    ],
    [
      "a model pi cannot run",
      async () => answer({ model: "mistral:devstral-medium" }),
      "pi cannot run otari/mistral:devstral-medium",
    ],
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
      "fetch failed",
    ],
  ])("keeps the usual model on %s", async (_name, fetch, why) => {
    const { spawn, notify } = harness({
      fetch: fetch as typeof globalThis.fetch,
    });

    const { input, result } = await spawn({
      agent: "scout",
      task: "Find X",
      model: "otari/anthropic:claude-sonnet-5-5",
    });

    expect(result).toBeUndefined();
    expect(input.model).toBe("otari/anthropic:claude-sonnet-5-5");
    expect(notify).toHaveBeenCalledWith(
      `Otari did not decide (${why}); scout starts on its usual model`,
      "warning",
    );
  });

  it("keeps the usual model when Otari picks outside the sent list", async () => {
    const candidates = {
      "openai:gpt-5-mini": null,
      "anthropic:claude-sonnet-5-5": null,
    };
    const { spawn } = harness({
      settings: { otari: { subagentRouting: { enabled: true, candidates } } },
      fetch: async () => answer({ model: "anthropic:claude-opus-5-5" }),
    });

    const { input } = await spawn({ agent: "scout", task: "Find X" });

    expect(input.model).toBeUndefined();
  });

  it.each([
    ["another tool", { agent: "scout", task: "x" }, "read"],
    ["a control action", { action: "status", id: "r1" }, "subagent"],
    ["a workflow", { workflow: true, task: "x" }, "subagent"],
    ["parallel tasks", { tasks: [{ agent: "a", task: "x" }] }, "subagent"],
    ["a chain", { chain: [{ agent: "a", task: "x" }] }, "subagent"],
    ["a launch with no task", { agent: "scout" }, "subagent"],
  ])("leaves %s alone", async (_name, input, toolName) => {
    const { spawn, fetcher } = harness();

    await spawn(input, toolName);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does nothing when routing is off", async () => {
    const { spawn, fetcher } = harness({ settings: {} });

    await spawn({ agent: "scout", task: "Find X" });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports bad settings once and does not ask", async () => {
    const { spawn, fetcher, notify } = harness({
      settings: { otari: { subagentRouting: { enabled: "yes" } } },
    });

    await spawn({ agent: "scout", task: "Find X" });
    await spawn({ agent: "scout", task: "Find Y" });

    expect(fetcher).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Subagent routing is off: otari.subagentRouting.enabled must be true or false.",
      "warning",
    );
  });
  it("drops the thinking level when Otari picks a model without reasoning", async () => {
    const { spawn } = harness({ notReasoning: ["openai:gpt-5-mini"] });

    const { input } = await spawn({
      agent: "scout",
      task: "Find X",
      model: "otari/anthropic:claude-opus-5-5:high",
    });

    expect(input.model).toBe("otari/openai:gpt-5-mini");
  });

  it("refuses an id that pi-subagents would read as ending in a level", async () => {
    const { spawn, notify } = harness({
      known: [...KNOWN, "otari/ollama:qwen3:max"],
      fetch: async () => answer({ model: "ollama:qwen3:max" }),
    });

    const { input } = await spawn({ agent: "scout", task: "Find X" });

    expect(input.model).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      "Otari did not decide (ollama:qwen3:max ends in what pi-subagents reads as a level); scout starts on its usual model",
      "warning",
    );
  });

  it("keeps such an id when the launch's level follows it", async () => {
    const { spawn } = harness({
      known: [...KNOWN, "otari/ollama:qwen3:max"],
      fetch: async () => answer({ model: "ollama:qwen3:max" }),
    });

    const { input } = await spawn({
      agent: "scout",
      task: "Find X",
      model: "otari/anthropic:claude-opus-5-5:high",
    });

    expect(input.model).toBe("otari/ollama:qwen3:max:high");
  });

  it("does not take an inherited property for a candidate", async () => {
    const candidates = {
      "openai:gpt-5-mini": null,
      "anthropic:claude-sonnet-5-5": null,
    };
    const { spawn, notify } = harness({
      settings: { otari: { subagentRouting: { enabled: true, candidates } } },
      fetch: async () => answer({ model: "constructor" }),
    });

    await spawn({ agent: "scout", task: "Find X" });

    expect(notify).toHaveBeenCalledWith(
      "Otari did not decide (constructor is not one of your candidates); scout starts on its usual model",
      "warning",
    );
  });

  it("keeps the agent name and the task within Otari's limits", async () => {
    const { spawn, fetcher } = harness();
    // An emoji is two UTF-16 units; the limit falls between them.
    const task = `${"a".repeat(65_535)}😀`;

    await spawn({ agent: "a".repeat(200), task });

    const sent = sentBody(fetcher);
    expect(sent.agent_type).toBe("a".repeat(128));
    expect(sent.prompt).toBe("a".repeat(65_535));
  });

  it("gives up when the answer's body stalls past the deadline", async () => {
    vi.useFakeTimers();
    const { spawn, notify } = harness({
      fetch: async () =>
        new Response(new ReadableStream({ start() {} }), { status: 200 }),
    });

    const launched = spawn({ agent: "scout", task: "Find X" });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const { input } = await launched;

    expect(input.model).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      "Otari did not decide (no answer within 3 seconds); scout starts on its usual model",
      "warning",
    );
  });

  it("gives up when finding the key takes past the deadline", async () => {
    vi.useFakeTimers();
    const { spawn, fetcher } = harness({
      providerAuth: () => new Promise(() => {}),
    });

    const launched = spawn({ agent: "scout", task: "Find X" });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const { input } = await launched;

    expect(fetcher).not.toHaveBeenCalled();
    expect(input.model).toBeUndefined();
  });

  it("stops asking, and says nothing, when the turn is cancelled", async () => {
    const turn = new AbortController();
    let seen: AbortSignal | undefined;
    const { spawn, notify } = harness({
      signal: turn.signal,
      fetch: (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });

    const launched = spawn({ agent: "scout", task: "Find X" });
    await vi.waitFor(() => expect(seen).toBeDefined());
    turn.abort();
    const { input } = await launched;

    expect(seen?.aborted).toBe(true);
    expect(input.model).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not ask without an API key, and says so once", async () => {
    const { spawn, fetcher, notify } = harness({ token: undefined });

    await spawn({ agent: "scout", task: "Find X" });
    await spawn({ agent: "scout", task: "Find Y" });

    expect(fetcher).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Subagent routing is off: there is no Otari API key. Run `/login otari` or set OTARI_API_KEY.",
      "warning",
    );
  });

  it("starts the subagent as usual when pi's settings cannot be read", async () => {
    const { spawn, fetcher, notify } = harness({
      getSettings: () => {
        throw new Error("settings.json is being written");
      },
    });

    const { input, result } = await spawn({ agent: "scout", task: "Find X" });

    expect(result).toBeUndefined();
    expect(input.model).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Subagent routing is off: pi's settings could not be read.",
      "warning",
    );
  });

  it("reports bad settings later when there was no UI to report them", async () => {
    const settings = { otari: { subagentRouting: { enabled: "yes" } } };
    const { spawn, ctx, notify } = harness({ settings, hasUI: false });

    await spawn({ agent: "scout", task: "Find X" });
    expect(notify).not.toHaveBeenCalled();
    ctx.hasUI = true;
    await spawn({ agent: "scout", task: "Find Y" });

    expect(notify).toHaveBeenCalledWith(
      "Subagent routing is off: otari.subagentRouting.enabled must be true or false.",
      "warning",
    );
  });

  it("asks about every launch in a message at once", async () => {
    const pending: Array<(response: Response) => void> = [];
    const { spawn, endMessage, fetcher } = harness({
      fetch: () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    });
    const scout = { agent: "scout", task: "Find X" };
    const worker = { agent: "worker", task: "Fix Y" };

    await endMessage({ "call-1": scout, "call-2": worker });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    for (const resolve of pending) {
      resolve(answer({ model: "openai:gpt-5-mini" }));
    }
    const first = await spawn({ ...scout }, "subagent", "call-1");
    const second = await spawn({ ...worker }, "subagent", "call-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.input.model).toBe("otari/openai:gpt-5-mini");
    expect(second.input.model).toBe("otari/openai:gpt-5-mini");
  });

  it("forgets answers for launches that never ran when the turn ends", async () => {
    const { spawn, endMessage, endTurn, fetcher } = harness();

    await endMessage({ "call-1": { agent: "scout", task: "Find X" } });
    await endTurn();
    await spawn({ agent: "scout", task: "Find X" });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks Otari once for a launch sent with null optional fields", async () => {
    const { spawn, endMessage, fetcher } = harness();

    await endMessage({
      "call-1": {
        agent: "scout",
        task: "Find X",
        tasks: null,
        chain: null,
        action: null,
      },
    });
    // Pi drops the nulls before the tool call.
    const { input } = await spawn({ agent: "scout", task: "Find X" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(input.model).toBe("otari/openai:gpt-5-mini");
  });

  it("asks again when the launch changed after its message ended", async () => {
    const { spawn, endMessage, fetcher } = harness();

    await endMessage({ "call-1": { agent: "scout", task: "Find X" } });
    const { input } = await spawn({
      agent: "scout",
      task: "Find X",
      model: "otari/anthropic:claude-opus-5-5:high",
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(input.model).toBe("otari/openai:gpt-5-mini:high");
  });

  it("does not ask ahead when pi has no subagent tool", async () => {
    const { endMessage, fetcher } = harness({ activeTools: ["read"] });

    await endMessage({ "call-1": { agent: "scout", task: "Find X" } });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not ask ahead for launches that share an id", async () => {
    const { endMessage, fetcher } = harness();

    await endMessage([
      ["call-0", { agent: "scout", task: "Find X" }],
      ["call-0", { agent: "worker", task: "Fix Y" }],
      ["", { agent: "worker", task: "Fix Z" }],
    ]);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads the settings and the key once for all launches in a message", async () => {
    const providerAuth = vi.fn(async () => undefined);
    const { endMessage, fetcher } = harness({ providerAuth });

    await endMessage({
      "call-1": { agent: "scout", task: "Find X" },
      "call-2": { agent: "worker", task: "Fix Y" },
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(providerAuth).toHaveBeenCalledTimes(1);
  });

  it("says there is no key, not that candidates are missing", async () => {
    const candidates = {
      "openai:gpt-5-mini": null,
      "anthropic:claude-opus-5-5": null,
    };
    const { spawn, fetcher, notify } = harness({
      token: undefined,
      settings: { otari: { subagentRouting: { enabled: true, candidates } } },
    });

    await spawn({ agent: "scout", task: "Find X" });

    expect(fetcher).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Subagent routing is off: there is no Otari API key. Run `/login otari` or set OTARI_API_KEY.",
      "warning",
    );
  });

  it("settles quietly when the session ends while it asks", async () => {
    let found: (auth: unknown) => void = () => {};
    const { endMessage, ctx } = harness({
      settings: {
        otari: {
          subagentRouting: {
            enabled: true,
            candidates: {
              "openai:gpt-5-mini": null,
              "anthropic:claude-opus-5-5": null,
            },
          },
        },
      },
      providerAuth: () =>
        new Promise((resolve) => {
          found = resolve;
        }),
    });

    await endMessage({ "call-1": { agent: "scout", task: "Find X" } });
    // Like pi's context after /new, every getter now throws.
    for (const name of ["signal", "modelRegistry"]) {
      Object.defineProperty(ctx, name, {
        get: () => {
          throw new Error("stale context");
        },
      });
    }
    found(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("shows Otari's reason as one short, plain line", async () => {
    const { spawn, notify } = harness({
      fetch: async () =>
        answer({
          model: "openai:gpt-5-mini",
          reason: `\u001b[31mred\u001b[0m\n${"x".repeat(500)}`,
        }),
    });

    await spawn({ agent: "scout", task: "Find X" });

    const [message] = notify.mock.calls[0] as [string];
    const reason = message.slice(message.indexOf("(") + 1, -1);
    expect(reason).toBe(`[31mred [0m ${"x".repeat(188)}`);
  });
});
