import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtariExtension } from "../src/index.js";
import type { RuntimeState } from "../src/types.js";

describe("package scaffold", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("supports an empty initial runtime state", () => {
    const state: RuntimeState = {
      models: [],
      diagnostics: [],
      discoverySource: "none",
    };
    expect(state.models).toEqual([]);
  });

  it("registers the provider without doing credential-dependent startup discovery", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "mzai:test-model" }] })),
    );
    vi.stubGlobal("fetch", fetcher);
    const registerProvider = vi.fn();
    const pi = {
      on: vi.fn(),
      registerProvider,
    } as unknown as ExtensionAPI;

    await createOtariExtension({
      env: { OTARI_API_KEY: "tk_env" },
      fetch: fetcher as typeof fetch,
    })(pi);

    expect(fetcher).not.toHaveBeenCalled();
    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "otari" }),
    );
  });

  it("registers native provider auth on Pi 0.81.0", async () => {
    const registerProvider = vi.fn();
    const pi = {
      on: vi.fn(),
      registerProvider,
    } as unknown as ExtensionAPI;

    await createOtariExtension({ env: {}, piVersion: "0.81.0" })(pi);

    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "otari" }),
    );
  });

  it("reports a clear upgrade message on unsupported Pi versions", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const registerProvider = vi.fn();
    const pi = {
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
      ),
      registerProvider,
    } as unknown as ExtensionAPI;

    await createOtariExtension({ env: {}, piVersion: "0.80.10" })(pi);
    const notify = vi.fn();
    await handlers.get("session_start")?.(
      { reason: "startup" },
      {
        hasUI: true,
        model: undefined,
        ui: { notify, setStatus: vi.fn() },
      },
    );

    expect(registerProvider).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "pi-otari requires Pi 0.81.0 or newer. Run `pi update`.",
      "error",
    );
  });

  it("registers Otari without an environment key so /login can find it", async () => {
    const registerProvider = vi.fn();
    const pi = {
      on: vi.fn(),
      registerProvider,
    } as unknown as ExtensionAPI;

    await createOtariExtension({ env: {} })(pi);

    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "otari" }),
    );
  });
});
