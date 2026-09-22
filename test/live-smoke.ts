/**
 * Live compatibility check against a running Otari gateway. Run it on your
 * own machine with a disposable key before requesting review for a change to
 * discovery, the provider, streaming, or URL handling; see CONTRIBUTING.md.
 * Every stage prints one line, and the first failing stage stops the run with
 * the gateway's own reason where there is one.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://api.otari.ai/api/v1";
const DEFAULT_MAX_TOKENS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;
const PROMPT = "Reply with exactly: ok";
/** Loaded by path through Pi's own extension loader, as `pi -e` does. */
const EXTENSION_PATH = resolve(import.meta.dirname, "../src/index.ts");
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

const { token, model, baseUrl, maxTokens } = await stage(
  "configuration",
  async () => {
    const token = process.env.OTARI_LIVE_TEST_TOKEN;
    const model = process.env.OTARI_LIVE_TEST_MODEL;
    const baseUrl = (process.env.OTARI_LIVE_TEST_BASE_URL ?? DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    const maxTokens = parseMaxTokens(process.env.OTARI_LIVE_TEST_MAX_TOKENS);
    assert.ok(
      token,
      "Set OTARI_LIVE_TEST_TOKEN to an API key for the Otari gateway under test",
    );
    assert.ok(
      model,
      "Set OTARI_LIVE_TEST_MODEL to a model selector that gateway lists, for example nebius:Qwen/Qwen3-30B-A3B-Instruct-2507",
    );
    console.log(`  ${baseUrl}, model ${model}, ${maxTokens} output tokens`);
    return { token, model, baseUrl, maxTokens };
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
 * it, so the live variables take the place of whatever the developer's shell
 * carries. Pi's own state lives in temporary directories for the run.
 */
const { session, cleanup } = await stage(
  "extension loads in a Pi session",
  async () => {
    process.env.OTARI_API_KEY = token;
    process.env.OTARI_BASE_URL = baseUrl;
    delete process.env.OTARI_MODELS;
    const agentDir = await mkdtemp(join(tmpdir(), "pi-otari-live-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-otari-live-cwd-"));
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
    assert.equal(
      errors.length,
      0,
      `Pi could not load ${EXTENSION_PATH}:\n${errors.map((item) => `  ${item.error}`).join("\n")}`,
    );
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    // A registered provider with a usable key resolves auth. An extension
    // that rejected its configuration registers nothing.
    const auth = await session.modelRuntime.getAuth("otari");
    assert.ok(
      auth,
      `The extension did not register the otari provider for ${baseUrl}. Hosted Otari serves its API at ${DEFAULT_BASE_URL}; a self-hosted URL must include the gateway's API prefix, such as /api/v1`,
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

clearTimeout(watchdog);
session.dispose();
await cleanup();
console.log("Live Otari smoke test passed");
process.exit(0);
