import { describe, expect, it } from "vitest";
import { ConfigError, loadOtariConfig } from "../src/config.js";

const hosted = "https://api.otari.ai/api/v1";

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
    "https://api.otari.ai/api/v1?workspace=other",
    "https://api.otari.ai/api/v1#fragment",
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

  it.each([
    "https://otari.example.com",
    "https://otari.example.com/",
    "http://localhost:8000",
    "https://api.otari.ai",
  ])("rejects origin-only URL %s", (baseUrl) => {
    const load = () => loadOtariConfig({ OTARI_BASE_URL: baseUrl });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/API prefix.*\/api\/v1$/);
  });

  it("detects hosted Otari by hostname", () => {
    expect(
      loadOtariConfig({ OTARI_BASE_URL: "https://api.otari.ai/api/v1/" }),
    ).toMatchObject({ baseUrl: hosted, officialHosted: true });
  });

  it("treats other hosts as custom whatever their prefix", () => {
    expect(
      loadOtariConfig({ OTARI_BASE_URL: "https://self.example/v1" }),
    ).toMatchObject({
      baseUrl: "https://self.example/v1",
      officialHosted: false,
    });
  });

  it.each(["https://api.otari.ai/v1", "https://api.otari.ai/api/v2"])(
    "rejects hosted URL %s that is not the current API root",
    (baseUrl) => {
      const load = () => loadOtariConfig({ OTARI_BASE_URL: baseUrl });
      expect(load).toThrow(ConfigError);
      expect(load).toThrow("https://api.otari.ai/api/v1");
    },
  );
});
