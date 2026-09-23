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
import {
  parseStandardModelList,
  THINKING_LEVEL_MAP,
} from "../src/model-mapper.ts";
import { replacementsFor } from "../src/staleness.ts";
import type { OtariModel } from "../src/types.ts";

const DEFAULT_MAX_TOKENS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 300_000;
const PROMPT = "Reply with exactly: ok";
/** Loaded by path through Pi's own extension loader, as `pi -e` does. */
const EXTENSION_PATH = resolve(import.meta.dirname, "../src/index.ts");
const THINKING_LEVELS = Object.keys(THINKING_LEVEL_MAP);
type LiveThinkingLevel = keyof typeof THINKING_LEVEL_MAP;
/** Fields the extension takes from Otari's entry rather than defaulting. */
const CAPABILITY_FIELDS = [
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
] satisfies Array<keyof OtariModel>;

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

/** The message, followed by the messages of the causes behind it. */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined
    ? error.message
    : `${error.message}: ${reasonOf(error.cause)}`;
}

function excerpt(text: string, limit = 500): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** The stage in progress, which the watchdog reports by name. */
let running = "";

/** Thrown by stage() once it has printed a failure, so nothing prints twice. */
class StageFailure extends Error {}

/**
 * One line per stage, then the notes its body collected. A failure is
 * reported here and propagates to the end of the script, so Pi's state is
 * removed on the way out.
 */
async function stage<T>(
  name: string,
  run: (note: (text: string) => void) => Promise<T>,
): Promise<T> {
  running = name;
  const notes: string[] = [];
  const note = (text: string) => {
    notes.push(`  ${text}`);
  };
  try {
    const result = await run(note);
    console.log(`ok - ${name}`);
    for (const line of notes) console.log(line);
    return result;
  } catch (error) {
    console.error(`not ok - ${name}`);
    for (const line of notes) console.error(line);
    console.error(reasonOf(error));
    throw new StageFailure(name);
  }
}

async function main(): Promise<void> {
  const { token, model, baseUrl, maxTokens, reasoning } = await stage(
    "configuration",
    async (note) => {
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
      note(
        `${baseUrl}, model ${model}, ${maxTokens} output tokens${reasoning ? `, reasoning ${reasoning}` : ""}`,
      );
      return { token, model, baseUrl, maxTokens, reasoning };
    },
  );

  /**
   * The capability fields Otari's entry carries (#6). The extension defaults
   * the rest, so this is a note rather than a check until Otari publishes them.
   */
  async function capabilityFields(): Promise<string> {
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const entry = parseStandardModelList(await response.json()).find(
        (item) => item.id === model,
      );
      const present = CAPABILITY_FIELDS.filter(
        (field) => entry?.[field] !== undefined,
      );
      return present.length > 0 ? present.join(", ") : "none";
    } catch (error) {
      return `not read (${reasonOf(error)})`;
    }
  }

  // Pi's state for the run: its settings and credential store, and a working
  // directory. Both are removed when the run ends.
  const agentDir = await mkdtemp(join(tmpdir(), "pi-otari-live-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-otari-live-cwd-"));
  const removeState = () =>
    Promise.all(
      [agentDir, cwd].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  // A stage that never settles cannot fail on its own, so the watchdog ends
  // the run for it.
  const watchdog = setTimeout(async () => {
    console.error(`not ok - ${running}`);
    console.error(
      `No result after ${RUN_TIMEOUT_MS / 1000} s; the run stopped waiting`,
    );
    await removeState();
    process.exit(1);
  }, RUN_TIMEOUT_MS);

  try {
    const session = await stage("extension loads in a Pi session", async () => {
      // Only the live token and URL reach the extension's environment.
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("OTARI_") && !key.startsWith("OTARI_LIVE_TEST_"))
          delete process.env[key];
      }
      process.env.OTARI_API_KEY = token;
      process.env.OTARI_BASE_URL = baseUrl;
      // Retries and compact-and-retry stay off, so the first reply is the one
      // checked.
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
      );
      // Only the extension under test loads; nothing from the developer's
      // home directory reaches the session.
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
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
      return session;
    });

    try {
      /**
       * Discovery as Pi performs it: the extension's fetchModels against the
       * configured URL, parsed and registered through the provider. When the
       * selector is missing, name the listed selector for the same model (#41).
       */
      const discovered = await stage(
        "model discovery through the extension",
        async (note) => {
          const result = await session.modelRuntime.refresh({
            providers: ["otari"],
            allowNetwork: true,
            force: true,
          });
          const failure = result.errors.get("otari");
          if (failure) throw failure;
          const models = session.modelRuntime.getModels("otari");
          assert.ok(
            models.length > 0,
            `Otari at ${baseUrl} lists no models for this key. Enable a provider and model in that workspace, then rerun`,
          );
          const listed = models.map((item) => item.id);
          const selected = models.find((item) => item.id === model);
          if (!selected) {
            const alternates = replacementsFor(model, new Set(listed));
            const hint =
              alternates.length > 0
                ? `The same model is listed as ${alternates.map((id) => `"${id}"`).join(" and ")}; set OTARI_LIVE_TEST_MODEL to one of those.`
                : `Set OTARI_LIVE_TEST_MODEL to one of the ${listed.length} listed selectors:\n${listed.map((id) => `  ${id}`).join("\n")}`;
            throw new Error(
              `Otari at ${baseUrl} does not list "${model}". ${hint}`,
            );
          }
          note(`${listed.length} models listed, including ${model}`);
          note(`capability fields from Otari: ${await capabilityFields()}`);
          note(
            `registered in Pi as: reasoning ${selected.reasoning ? "on" : "off"}, input ${selected.input.join("+")}, context ${selected.contextWindow}, max output ${selected.maxTokens}`,
          );
          return selected;
        },
      );

      /**
       * A plain request outside Pi. Otari puts the reason for a rejection in a
       * `detail` field that Pi's OpenAI client does not display, so this is
       * the stage that shows it when inference fails for a listed model.
       */
      await stage("non-streaming completion", async (note) => {
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
              model,
              messages: [{ role: "user", content: PROMPT }],
              max_tokens: maxTokens,
              stream: false,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          throw new Error(`No response from ${url}`, { cause: error });
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
        note(`${model} replied: ${excerpt(text, 80)}`);
      });

      /**
       * The prompt travels as a user's does: Pi's agent loop, the extension's
       * stream wrapper, and pi-ai's streaming client, with output capped at
       * the configured bound. Otari publishes no reasoning flag yet (#6), so
       * the extension registers every model with reasoning off and Pi would
       * clamp the level. Mark the copy the way the extension marks a reasoning
       * model, so the level reaches the gateway through the same transport
       * and the reply carries reasoning content.
       */
      await stage("streaming completion through Pi", async (note) => {
        const selected = {
          ...discovered,
          maxTokens,
          ...(reasoning
            ? { reasoning: true, thinkingLevelMap: THINKING_LEVEL_MAP }
            : {}),
        };
        await session.setModel(selected);
        if (reasoning) session.setThinkingLevel(reasoning);
        const before = session.state.messages.length;
        await session.prompt(PROMPT);
        const replies = session.state.messages
          .slice(before)
          .filter(
            (item): item is AssistantMessage => item.role === "assistant",
          );
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
        if (reasoning) {
          assert.ok(
            thinking,
            `${model} streamed no reasoning content at level ${reasoning}. Set OTARI_LIVE_TEST_MODEL to a model that returns reasoning content, or leave OTARI_LIVE_TEST_REASONING unset`,
          );
        }
        note(`${model} replied: ${excerpt(text, 80)}`);
        note(
          `thinking level ${session.state.thinkingLevel}${thinking ? ", reasoning content streamed" : ""}; ${reply.usage.input} input, ${reply.usage.output} output tokens`,
        );
      });
    } finally {
      session.dispose();
    }
  } finally {
    clearTimeout(watchdog);
    await removeState();
  }
}

try {
  await main();
  console.log("Live Otari smoke test passed");
} catch (error) {
  if (!(error instanceof StageFailure))
    console.error(`not ok - ${reasonOf(error)}`);
  process.exitCode = 1;
}
