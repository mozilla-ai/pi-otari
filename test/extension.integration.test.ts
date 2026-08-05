import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtariExtension } from "../src/index.js";

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function sse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks)
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

describe("Pi–Otari integration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves the selected reasoning level and reports a rejected level without retrying", async () => {
    let completionCount = 0;
    let completionPayload: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: [{ id: "test-model", reasoning: true }] }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        completionCount += 1;
        completionPayload = await body(request);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                "reasoning_effort 'medium' is unsupported; available values: low, high",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP server");

    vi.stubEnv("OTARI_API_KEY", "tk_integration");
    vi.stubEnv("OTARI_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
    const agentDir = await mkdtemp(join(tmpdir(), "pi-otari-integration-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-otari-cwd-"));
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [createOtariExtension()],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      thinkingLevel: "medium",
    });
    try {
      await session.modelRuntime.refresh({ allowNetwork: true });
      const model = session.modelRuntime.getModel("otari", "test-model");
      expect(model).toBeDefined();
      if (!model) throw new Error("Expected Otari model");
      await session.setModel(model);
      await session.prompt("Reply with done.");

      expect(completionPayload?.reasoning_effort).toBe("medium");
      expect(
        (
          completionPayload?.messages as Array<{ role: string }> | undefined
        )?.[0]?.role,
      ).toBe("system");
      expect(completionCount).toBe(1);
      expect(session.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "error",
        errorMessage: expect.stringContaining(
          'Otari model "test-model" rejected reasoning level "medium".',
        ),
      });
      expect(
        (session.state.messages.at(-1) as { errorMessage?: string })
          .errorMessage,
      ).toContain("available values: low, high");
    } finally {
      session.dispose();
      server.close();
      await once(server, "close");
    }
  });

  it("routes the selected model through Otari and continues after a tool call", async () => {
    let completionCount = 0;
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer tk_integration");
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        completionCount += 1;
        const payload = await body(request);
        expect(payload.model).toBe("test-model");
        if (completionCount === 1) {
          sse(response, [
            toolChunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "echo", arguments: '{"text":"hello"}' },
                },
              ],
            }),
            toolChunk({}, "tool_calls"),
          ]);
        } else {
          expect(JSON.stringify(payload.messages)).toContain("hello");
          sse(response, [
            toolChunk({ role: "assistant", content: "done" }),
            toolChunk({}, "stop"),
          ]);
        }
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP server");

    vi.stubEnv("OTARI_API_KEY", "tk_integration");
    vi.stubEnv("OTARI_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
    const agentDir = await mkdtemp(join(tmpdir(), "pi-otari-integration-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-otari-cwd-"));
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [
        createOtariExtension(),
        (pi: ExtensionAPI) =>
          pi.registerTool({
            name: "echo",
            label: "Echo",
            description: "Return the supplied text",
            parameters: Type.Object({ text: Type.String() }),
            async execute(_id, params) {
              return {
                content: [{ type: "text", text: params.text }],
                details: {},
              };
            },
          }),
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      await session.modelRuntime.refresh({ allowNetwork: true });
      const model = session.modelRuntime.getModel("otari", "test-model");
      expect(model).toBeDefined();
      if (!model) throw new Error("Expected Otari model");
      await session.setModel(model);
      await session.prompt("Use echo, then finish.");
      expect(completionCount).toBe(2);
      expect(session.state.messages.at(-1)?.role).toBe("assistant");
    } finally {
      session.dispose();
      server.close();
      await once(server, "close");
    }
  });

  it("stores an API key through login without adding it to model context", async () => {
    let discoveryCount = 0;
    let completionCount = 0;
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer tk_login_integration");
      if (request.method === "GET" && request.url === "/v1/models") {
        discoveryCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "mzai:test-model" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        completionCount += 1;
        sse(response, [
          toolChunk({ role: "assistant", content: "done" }),
          toolChunk({}, "stop"),
        ]);
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP server");

    vi.stubEnv("OTARI_API_KEY", "");
    vi.stubEnv("OTARI_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
    const agentDir = await mkdtemp(join(tmpdir(), "pi-otari-login-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-otari-cwd-"));
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [createOtariExtension()],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    let resumedSession:
      | Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;

    try {
      await session.modelRuntime.login("otari", "api_key", {
        prompt: async () => "tk_login_integration",
        notify: () => {},
      });
      expect(discoveryCount).toBeGreaterThan(0);
      expect(JSON.stringify(session.state.messages)).not.toContain(
        "tk_login_integration",
      );

      const model = session.modelRuntime.getModel("otari", "mzai:test-model");
      expect(model).toBeDefined();
      if (!model) throw new Error("Expected Otari model after login");
      await session.setModel(model);
      await session.prompt("Reply with done.");

      expect(completionCount).toBe(1);
      expect(JSON.stringify(session.state.messages)).not.toContain(
        "tk_login_integration",
      );

      const resumedLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories: [createOtariExtension()],
      });
      await resumedLoader.reload();
      resumedSession = (
        await createAgentSession({
          cwd,
          agentDir,
          resourceLoader: resumedLoader,
          sessionManager: SessionManager.inMemory(cwd),
        })
      ).session;
      await resumedSession.modelRuntime.refresh({ allowNetwork: false });
      expect(await resumedSession.modelRuntime.getAuth("otari")).toMatchObject({
        auth: { apiKey: "tk_login_integration" },
        source: "stored credential",
      });
      const resumedModel = resumedSession.modelRuntime.getModel(
        "otari",
        "mzai:test-model",
      );
      expect(resumedModel).toBeDefined();
      if (!resumedModel) throw new Error("Expected persisted Otari model");
      await resumedSession.setModel(resumedModel);
      await resumedSession.prompt("Reply with done again.");
      expect(completionCount).toBe(2);

      await resumedSession.modelRuntime.logout("otari");
      expect(
        await resumedSession.modelRuntime.getAuth("otari"),
      ).toBeUndefined();
    } finally {
      resumedSession?.dispose();
      session.dispose();
      server.close();
      await once(server, "close");
    }
  });
});
