import { describe, expect, it } from "vitest";
import { explainGatewayError } from "../src/stream-otari.js";

describe("explainGatewayError", () => {
  it("describes a selector missing from the discovered list and keeps the gateway text", () => {
    const explanation = explainGatewayError(
      "mzai:openai/gpt-oss-120b",
      "400 status code (no body)",
      new Set(["nebius:openai/gpt-oss-120b"]),
    );
    expect(explanation).toContain('does not list "mzai:openai/gpt-oss-120b"');
    expect(explanation).toContain('listed as "nebius:openai/gpt-oss-120b"');
    expect(explanation?.endsWith("\n\n400 status code (no body)")).toBe(true);
  });

  it("names no URL, so Pi's retry check sees only the gateway's own status", () => {
    const explanation = explainGatewayError(
      "mzai:openai/gpt-oss-120b",
      "400 status code (no body)",
      new Set(["nebius:openai/gpt-oss-120b"]),
    );
    expect(explanation?.startsWith("Otari does not list")).toBe(true);
    expect(explanation).not.toMatch(/https?:/);
  });

  it("leaves errors for listed selectors, and any error before discovery, alone", () => {
    const catalog = new Set(["nebius:openai/gpt-oss-120b"]);
    expect(
      explainGatewayError(
        "nebius:openai/gpt-oss-120b",
        "429 rate limited",
        catalog,
      ),
    ).toBeUndefined();
    expect(
      explainGatewayError(
        "mzai:openai/gpt-oss-120b",
        "400 status code (no body)",
        new Set(),
      ),
    ).toBeUndefined();
  });
});
