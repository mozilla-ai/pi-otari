import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  createGuardrails,
  GUARDED_TOOLS,
  GUARDRAILS_ENTRY,
  type GuardrailsDependencies,
  type Outcome,
} from "../src/guardrails-core.js";

/**
 * Paths an omp tool call targets. omp's hashline `edit` has no `path`
 * parameter: omp derives `path` for a single-file patch and only `paths` for a
 * multi-file one, so each of those is checked on its own.
 */
function targets(input: Record<string, unknown>): Record<string, unknown>[] {
  if (typeof input.path === "string" || !Array.isArray(input.paths)) {
    return [input];
  }
  return input.paths
    .filter((path): path is string => typeof path === "string")
    .map((path) => ({ ...input, path }));
}

/**
 * omp wiring for the guardrails in src/guardrails-core.ts. omp's tool names
 * and inputs match Pi's, so `otari hook` runs with the Pi harness. The stop
 * check uses omp's `session_stop`, which already tracks `stop_hook_active`,
 * caps continuations and skips aborted runs and subagents.
 */
export function registerGuardrails(
  pi: ExtensionAPI,
  dependencies: GuardrailsDependencies = {},
): void {
  const guardrails = createGuardrails(dependencies);

  pi.on("session_start", () => guardrails.reset());
  pi.on("session_switch", () => guardrails.reset());

  pi.on("tool_call", async (event, ctx) => {
    if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;
    const outcomes = await Promise.all(
      targets(input).map((target) =>
        guardrails.invoke(ctx, "PreToolUse", {
          toolName: event.toolName,
          input: target,
        }),
      ),
    );
    const blocked = outcomes.find(
      (outcome): outcome is Extract<Outcome, { kind: "block" }> =>
        outcome.kind === "block",
    );
    if (blocked) return { block: true, reason: blocked.reason };
    const context: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind !== "allow") continue;
      if (outcome.systemMessage) {
        guardrails.notify(ctx, outcome.systemMessage);
      }
      if (outcome.additionalContext) context.push(outcome.additionalContext);
    }
    if (event.toolName === "bash" && typeof input.command === "string") {
      guardrails.recordBash(input.command);
    }
    return context.length > 0
      ? { additionalContext: [...new Set(context)].join("\n\n") }
      : undefined;
  });

  pi.on("session_stop", async (event, ctx) => {
    // omp also stops here after a turn that errored; that is not a finished
    // turn to check, and must never be resumed by a forced continuation.
    const stopReason = (
      event.last_assistant_message as { stopReason?: string } | undefined
    )?.stopReason;
    if (stopReason === "error" || stopReason === "aborted") return undefined;
    // omp's handler context is a prototype-scoped view; copy what is used.
    const outcome = await guardrails.invoke(
      { cwd: ctx.cwd, hasUI: ctx.hasUI, ui: ctx.ui, signal: event.signal },
      "Stop",
      { stopHookActive: event.stop_hook_active },
    );
    if (outcome.kind === "allow") {
      if (outcome.systemMessage) guardrails.notify(ctx, outcome.systemMessage);
      // Advisory feedback for the model (a failed judge gate): recorded for
      // the next turn without forcing one.
      if (outcome.additionalContext) {
        pi.sendMessage(
          {
            customType: GUARDRAILS_ENTRY,
            content: outcome.additionalContext,
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
      }
      return undefined;
    }
    // Continue once per run, as on Pi: omp sets stop_hook_active on the stop
    // that follows a continuation.
    if (outcome.kind !== "block" || event.stop_hook_active) return undefined;
    // omp's continuation message is hidden, so show the user why it continued.
    guardrails.notify(ctx, `Otari guardrails: ${outcome.reason}`, "warning");
    return { continue: true, additionalContext: outcome.reason };
  });
}
