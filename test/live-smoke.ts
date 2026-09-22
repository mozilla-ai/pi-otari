/**
 * Live compatibility check against a running Otari gateway. Run it on your
 * own machine with a disposable key before requesting review for a change to
 * discovery, the provider, streaming, or URL handling; see CONTRIBUTING.md.
 * Every stage prints one line, and the first failing stage stops the run with
 * the gateway's own reason where there is one.
 */
import assert from "node:assert/strict";

const DEFAULT_BASE_URL = "https://api.otari.ai/api/v1";
const DEFAULT_MAX_TOKENS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const PROMPT = "Reply with exactly: ok";

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
        model,
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

console.log("Live Otari smoke test passed");
