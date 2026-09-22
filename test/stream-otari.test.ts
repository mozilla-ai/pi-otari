import { describe, expect, it } from "vitest";
import { explainGatewayError } from "../src/stream-otari.js";

const baseUrl = "https://api.otari.ai/api/v1";

describe("explainGatewayError", () => {
  it("describes a selector missing from the discovered list and keeps the gateway text", () => {
    const explanation = explainGatewayError(
      "mzai:openai/gpt-oss-120b",
      "400 status code (no body)",
      new Set(["nebius:openai/gpt-oss-120b"]),
      baseUrl,
    );
    expect(explanation).toContain('does not list "mzai:openai/gpt-oss-120b"');
    expect(explanation).toContain('listed as "nebius:openai/gpt-oss-120b"');
    expect(explanation?.endsWith("\n\n400 status code (no body)")).toBe(true);
  });

  it("leaves errors for listed selectors, and any error before discovery, alone", () => {
    const catalog = new Set(["nebius:openai/gpt-oss-120b"]);
    expect(
      explainGatewayError(
        "nebius:openai/gpt-oss-120b",
        "429 rate limited",
        catalog,
        baseUrl,
      ),
    ).toBeUndefined();
    expect(
      explainGatewayError(
        "mzai:openai/gpt-oss-120b",
        "400 status code (no body)",
        new Set(),
        baseUrl,
      ),
    ).toBeUndefined();
  });
});
