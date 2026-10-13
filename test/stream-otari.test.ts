import { describe, expect, it } from "vitest";
import {
  explainGatewayError,
  withConversationId,
} from "../src/stream-otari.js";

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

describe("withConversationId", () => {
  it("sends Pi's session id as Otari-Conversation-Id", () => {
    const options = withConversationId({
      sessionId: "s-1",
      headers: { a: "b" },
    });
    expect(options?.headers).toEqual({
      "Otari-Conversation-Id": "s-1",
      a: "b",
    });
  });

  it("lets a header the caller set win", () => {
    const options = withConversationId({
      sessionId: "s-1",
      headers: { "Otari-Conversation-Id": "mine" },
    });
    expect(options?.headers?.["Otari-Conversation-Id"]).toBe("mine");
  });

  it("does not add a second header when the caller's differs in case", () => {
    const options = {
      sessionId: "s-1",
      headers: { "otari-conversation-id": "mine" },
    };
    expect(withConversationId(options)).toBe(options);
  });

  it("leaves options without a session id untouched", () => {
    const options = { headers: { a: "b" } };
    expect(withConversationId(options)).toBe(options);
    expect(withConversationId(undefined)).toBeUndefined();
  });
});
