import { describe, expect, it } from "vitest";
import type { RuntimeState } from "../src/types.js";

describe("package scaffold", () => {
  it("supports an empty initial runtime state", () => {
    const state: RuntimeState = {
      models: [],
      diagnostics: [],
      discoverySource: "none",
    };
    expect(state.models).toEqual([]);
  });
});
