import { describe, expect, it } from "vitest";
import { ConfigError, loadOtariConfig } from "../src/config.js";

const hosted = "https://api.otari.ai/v1";

describe("loadOtariConfig", () => {
  it("uses hosted defaults and trims model selectors", () => {
    const config = loadOtariConfig({
      OTARI_API_KEY: "tk_test",
      OTARI_MODELS:
        " anthropic:claude-sonnet-4-6, ,anthropic:claude-sonnet-4-6,mzai:model ",
    });
    expect(config).toMatchObject({
      baseUrl: hosted,
      token: "tk_test",
      discoveryTimeoutMs: 5000,
      environmentModels: ["anthropic:claude-sonnet-4-6", "mzai:model"],
      officialHosted: true,
    });
  });

  it.each([
    ["http://127.0.0.1:8000/v1///", "http://127.0.0.1:8000/v1"],
    ["http://127.0.0.2:8000/v1", "http://127.0.0.2:8000/v1"],
  ])("accepts IPv4 loopback URL %s", (baseUrl, expected) => {
    expect(loadOtariConfig({ OTARI_BASE_URL: baseUrl }).baseUrl).toBe(expected);
  });

  it.each([
    "http://otari.example.com/v1",
    "ftp://localhost/v1",
    "https://user:pass@otari.example.com/v1",
    "https://api.otari.ai/v1?workspace=other",
    "https://api.otari.ai/v1#fragment",
  ])("rejects unsafe URL %s", (baseUrl) => {
    expect(() => loadOtariConfig({ OTARI_BASE_URL: baseUrl })).toThrow(
      ConfigError,
    );
  });

  it.each(["999", "30001", "not-a-number"])("rejects timeout %s", (value) => {
    expect(() =>
      loadOtariConfig({ OTARI_DISCOVERY_TIMEOUT_MS: value }),
    ).toThrow(ConfigError);
  });
});
