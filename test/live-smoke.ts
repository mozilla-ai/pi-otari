/**
 * Live compatibility check against a running Otari gateway. Run it on your
 * own machine with a disposable key before requesting review for a change to
 * discovery, the provider, streaming, or URL handling; see CONTRIBUTING.md.
 * Every stage prints one line, and the first failing stage stops the run with
 * the gateway's own reason where there is one.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ConfigError, loadOtariConfig } from "../src/config.ts";
import { THINKING_LEVEL_MAP } from "../src/model-mapper.ts";

const DEFAULT_MAX_TOKENS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 300_000;
const PROMPT = "Reply with exactly: ok";
/** Loaded by path through Pi's own extension loader, as `pi -e` does. */
const EXTENSION_PATH = resolve(import.meta.dirname, "../src/index.ts");
const THINKING_LEVELS = Object.keys(THINKING_LEVEL_MAP);
type LiveThinkingLevel = keyof typeof THINKING_LEVEL_MAP;
const CAPABILITY_FIELDS = [
  "reasoning",
  "input_modalities",
  "modality",
  "context_window",
  "max_output_tokens",
];

function parseMaxTokens(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_TOKENS;
  const parsed = Number(value);
  assert.ok(
    Number.isInteger(parsed) && parsed > 0,
    `Set OTARI_LIVE_TEST_MAX_TOKENS to a positive integer, or leave it unset for the default of ${DEFAULT_MAX_TOKENS}`,
  );
  return parsed;
}

function parseReasoning(
  value: string | undefined,
): LiveThinkingLevel | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const level = value.trim();
  assert.ok(
    THINKING_LEVELS.includes(level),
    `Set OTARI_LIVE_TEST_REASONING to one of ${THINKING_LEVELS.join(", ")}, or leave it unset to prompt without reasoning`,
  );
  return level as LiveThinkingLevel;
}

/**
 * The token and URL go through the extension's own parser, so a URL the
 * extension would reject fails here with its reason, named for the live
 * variable.
 */
function parseGateway(token: string | undefined, baseUrl: string | undefined) {
  try {
    return loadOtariConfig({ OTARI_API_KEY: token, OTARI_BASE_URL: baseUrl });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new Error(
      error.message.replaceAll("OTARI_BASE_URL", "OTARI_LIVE_TEST_BASE_URL"),
    );
  }
}

/** One line per passed stage; the first failure ends the run. */
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    console.log(`ok - ${name}`);
    return result;
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function excerpt(text: string, limit = 500): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** The model half of a `provider:model` selector, split at the first colon. */
function modelPart(selector: string): string {
  const separator = selector.indexOf(":");
  return separator === -1 ? selector : selector.slice(separator + 1);
}

const { token, model, baseUrl, maxTokens, reasoning } = await stage(
  "configuration",
  async () => {
    const model = process.env.OTARI_LIVE_TEST_MODEL?.trim();
    const maxTokens = parseMaxTokens(process.env.OTARI_LIVE_TEST_MAX_TOKENS);
    const reasoning = parseReasoning(process.env.OTARI_LIVE_TEST_REASONING);
    const { token, baseUrl } = parseGateway(
      process.env.OTARI_LIVE_TEST_TOKEN,
      process.env.OTARI_LIVE_TEST_BASE_URL,
    );
    assert.ok(
      token,
      "Set OTARI_LIVE_TEST_TOKEN to an API key for the Otari gateway under test",
    );
    assert.ok(
      model,
      "Set OTARI_LIVE_TEST_MODEL to a model selector that gateway lists, for example nebius:Qwen/Qwen3-30B-A3B-Instruct-2507",
    );
    console.log(
      `  ${baseUrl}, model ${model}, ${maxTokens} output tokens${reasoning ? `, reasoning ${reasoning}` : ""}`,
    );
    return { token, model, baseUrl, maxTokens, reasoning };
  },
);

const watchdog = setTimeout(() => {
  console.error("not ok - watchdog");
  console.error(
    `The run did not finish within ${RUN_TIMEOUT_MS / 1000} s. Check that the gateway at ${baseUrl} is responding, then rerun`,
  );
  process.exit(1);
}, RUN_TIMEOUT_MS);

/**
 * The extension reads its configuration from the environment when Pi loads
 * it, so the live values are the only OTARI_* variables left to read. Pi's
 * own state lives in temporary directories for the run.
 */
const { session, cleanup } = await stage(
  "extension loads in a Pi session",
  async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OTARI_") && !key.startsWith("OTARI_LIVE_TEST_"))
        delete process.env[key];
    }
    process.env.OTARI_API_KEY = token;
    process.env.OTARI_BASE_URL = baseUrl;
    const agentDir = await mkdtemp(join(tmpdir(), "pi-otari-live-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-otari-live-cwd-"));
    // One request per prompt: a gateway error is the finding, so Pi's turn
    // retries stay off for this session.
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: false } }),
    );
    const cleanup = async () => {
      await rm(agentDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      additionalExtensionPaths: [EXTENSION_PATH],
    });
    await resourceLoader.reload();
    const { errors } = resourceLoader.getExtensions();
    assert.ok(
      errors.length === 0,
      `Pi could not load ${EXTENSION_PATH}:\n${errors.map((item) => `  ${item.error}`).join("\n")}`,
    );
    // The check covers the prompt itself: tool definitions stay out of the
    // request, and nothing can run a tool on the developer's machine.
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    // A registered provider with a usable key resolves auth. The extension
    // explains a refusal to register through Pi's UI, which this session
    // does not have.
    const auth = await session.modelRuntime.getAuth("otari");
    assert.ok(
      auth,
      "Pi loaded the extension, but it registered no otari provider. Run `pi -e ./src/index.ts` with the same OTARI_API_KEY and OTARI_BASE_URL to see the reason it reports at startup",
    );
    return { session, cleanup };
  },
);

/**
 * Otari does not yet publish capability metadata (#6). Say what the entry
 * carries and what Pi registered, so the run shows the day the fields appear
 * and nothing fails on their absence until then.
 */
async function reportCapabilities(registered: {
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
}): Promise<void> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = (await response.json()) as {
    data?: Array<Record<string, unknown>>;
  };
  const entry = payload.data?.find((item) => item.id === model);
  const present = CAPABILITY_FIELDS.filter(
    (field) => entry?.[field] !== undefined && entry?.[field] !== null,
  );
  console.log(
    `  capability fields from Otari: ${present.length > 0 ? present.join(", ") : "none"}`,
  );
  console.log(
    `  registered in Pi as: reasoning ${registered.reasoning ? "on" : "off"}, input ${registered.input.join("+")}, context ${registered.contextWindow}, max output ${registered.maxTokens}`,
  );
}

/**
 * Discovery as Pi performs it: the extension's fetchModels against the
 * configured URL, parsed and registered through the provider. A selector the
 * list omits is the #41 situation, so name the current selector when the same
 * model is listed under another prefix.
 */
const discovered = await stage(
  "model discovery through the extension",
  async () => {
    const result = await session.modelRuntime.refresh({
      providers: ["otari"],
      allowNetwork: true,
      force: true,
    });
    const failure = result.errors.get("otari");
    if (failure) throw new Error(failure.message);
    const models = session.modelRuntime.getModels("otari");
    assert.ok(
      models.length > 0,
      `Otari at ${baseUrl} lists no models for this key. Enable a provider and model in that workspace, then rerun`,
    );
    const listed = models.map((item) => item.id);
    const selected = models.find((item) => item.id === model);
    if (!selected) {
      const alternates = listed.filter(
        (id) => modelPart(id) === modelPart(model),
      );
      const hint =
        alternates.length > 0
          ? `The same model is listed as ${alternates.map((id) => `"${id}"`).join(" and ")}; set OTARI_LIVE_TEST_MODEL to one of those.`
          : `Set OTARI_LIVE_TEST_MODEL to one of the ${listed.length} listed selectors:\n${listed.map((id) => `  ${id}`).join("\n")}`;
      throw new Error(`Otari at ${baseUrl} does not list "${model}". ${hint}`);
    }
    console.log(`  ${listed.length} models listed, including ${model}`);
    await reportCapabilities(selected);
    return selected;
  },
);

/**
 * A plain request outside Pi. Otari puts the reason for a rejection in a
 * `detail` field that Pi's OpenAI client does not display, so this is the
 * stage that shows it when inference fails for a listed model.
 */
await stage("non-streaming completion", async () => {
  const url = `${baseUrl}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: discovered.id,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: maxTokens,
        stream: false,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No response from ${url} within ${REQUEST_TIMEOUT_MS / 1000} s: ${reason}. Check that the gateway is reachable and OTARI_LIVE_TEST_BASE_URL includes its API prefix`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${url} answered HTTP ${response.status}: ${excerpt(await response.text())}`,
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: unknown };
    }>;
  };
  const choice = payload.choices?.[0];
  const text =
    typeof choice?.message?.content === "string"
      ? choice.message.content.trim()
      : "";
  if (text === "") {
    if (choice?.finish_reason === "length") {
      throw new Error(
        `${model} used all ${maxTokens} output tokens before producing text. Raise OTARI_LIVE_TEST_MAX_TOKENS, or choose an instruct model that answers without reasoning first`,
      );
    }
    throw new Error(
      `${model} returned no text. Response: ${excerpt(JSON.stringify(payload))}`,
    );
  }
  console.log(`  ${model} replied: ${excerpt(text, 80)}`);
});

/**
 * The prompt travels as a user's does: Pi's agent loop, the extension's
 * stream wrapper, and pi-ai's streaming client, against the discovered model
 * with its output capped at the configured bound. Otari publishes no
 * reasoning flag yet (#6), so the extension registers every model without
 * reasoning and Pi would clamp any level to off. The opt-in registers the
 * copy as the extension registers a reasoning model, so the requested level
 * reaches the gateway through the same transport.
 */
await stage("streaming completion through Pi", async () => {
  const selected = {
    ...discovered,
    maxTokens,
    ...(reasoning
      ? { reasoning: true, thinkingLevelMap: THINKING_LEVEL_MAP }
      : {}),
  };
  await session.setModel(selected);
  if (reasoning) {
    session.setThinkingLevel(reasoning);
    assert.equal(
      session.state.thinkingLevel,
      reasoning,
      `Pi offers ${session.getAvailableThinkingLevels().join(", ")} for ${model}`,
    );
  }
  const before = session.state.messages.length;
  await session.prompt(PROMPT);
  const replies = session.state.messages
    .slice(before)
    .filter((item): item is AssistantMessage => item.role === "assistant");
  const reply = replies.at(-1);
  assert.ok(reply, `Pi recorded no assistant reply from ${model}`);
  if (reply.stopReason === "error") {
    throw new Error(
      `Pi reported an error for ${model}:\n${reply.errorMessage ?? "(no message)"}`,
    );
  }
  if (reply.stopReason === "length") {
    throw new Error(
      `${model} used all ${maxTokens} output tokens before finishing. Raise OTARI_LIVE_TEST_MAX_TOKENS, or choose an instruct model that answers without reasoning first`,
    );
  }
  assert.ok(
    reply.stopReason === "stop",
    `${model} stopped with "${reply.stopReason}" instead of "stop"`,
  );
  assert.ok(
    replies.length === 1,
    `Pi sent ${replies.length} requests for one prompt (stop reasons: ${replies.map((item) => item.stopReason).join(", ")}). Expected a single reply`,
  );
  const text = reply.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  assert.ok(
    text !== "",
    `${model} streamed no text. Content: ${excerpt(JSON.stringify(reply.content))}`,
  );
  const thinking = reply.content.some((part) => part.type === "thinking");
  console.log(`  ${model} replied: ${excerpt(text, 80)}`);
  console.log(
    `  thinking level ${session.state.thinkingLevel}${thinking ? ", reasoning content streamed" : ""}; ${reply.usage.input} input, ${reply.usage.output} output tokens`,
  );
});

clearTimeout(watchdog);
session.dispose();
await cleanup();
console.log("Live Otari smoke test passed");
process.exit(0);
