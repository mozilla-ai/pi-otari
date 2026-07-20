const token = process.env.OTARI_LIVE_TEST_TOKEN;
const model = process.env.OTARI_LIVE_TEST_MODEL;
const baseUrl = (
  process.env.OTARI_LIVE_TEST_BASE_URL ?? "https://api.otari.ai/v1"
).replace(/\/+$/, "");

if (!token || !model) {
  throw new Error(
    "Set OTARI_LIVE_TEST_TOKEN and OTARI_LIVE_TEST_MODEL to run the live smoke test",
  );
}

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    max_tokens: 8,
    stream: false,
  }),
  redirect: "error",
  signal: AbortSignal.timeout(30000),
});

if (!response.ok)
  throw new Error(`Live Otari request failed with HTTP ${response.status}`);
const payload = (await response.json()) as {
  choices?: Array<{ message?: { content?: string } }>;
};
if (!payload.choices?.[0]?.message?.content) {
  throw new Error("Live Otari response contained no text");
}
console.log("Live Otari smoke test passed");
