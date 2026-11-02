import type {
  CustomMessageEntryDraft,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createGuardrails,
  GUARDED_TOOLS,
  GUARDRAILS_ENTRY,
  type GuardrailsDependencies,
} from "./guardrails-core.js";

export {
  type GuardrailsDependencies,
  guardrailsExist,
} from "./guardrails-core.js";

const guardrailsMessage = (content: string): CustomMessageEntryDraft => ({
  type: "custom_message",
  customType: GUARDRAILS_ENTRY,
  content,
  display: true,
});

/** Pi wiring for the guardrails in guardrails-core.ts. */
export function registerGuardrails(
  pi: ExtensionAPI,
  dependencies: GuardrailsDependencies = {},
): void {
  const guardrails = createGuardrails(dependencies);
  let continued = false;

  pi.on("session_start", () => {
    guardrails.reset();
    continued = false;
  });

  // A forced continuation happens before the run settles, so a settled run
  // is the point where the next run may be continued again.
  pi.on("agent_settled", () => {
    continued = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;
    const outcome = await guardrails.invoke(ctx, "PreToolUse", {
      toolName: event.toolName,
      input,
    });
    if (outcome.kind === "block") {
      return { block: true, reason: outcome.reason };
    }
    if (outcome.kind === "allow" && outcome.systemMessage) {
      guardrails.notify(ctx, outcome.systemMessage);
    }
    if (event.toolName === "bash" && typeof input.command === "string") {
      guardrails.recordBash(input.command);
    }
    return undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    // A run the user aborted or that errored is not a finished turn to
    // check, and must never be resumed by a forced continuation.
    if (event.outcome !== "completed") return undefined;
    const outcome = await guardrails.invoke(ctx, "Stop", {
      stopHookActive: continued,
    });
    if (outcome.kind === "allow") {
      if (outcome.systemMessage) guardrails.notify(ctx, outcome.systemMessage);
      if (!outcome.additionalContext) return undefined;
      // Advisory feedback for the model (a failed judge gate): recorded for
      // the next turn without forcing one.
      return {
        entries: [
          ...event.entries,
          guardrailsMessage(outcome.additionalContext),
        ],
      };
    }
    if (outcome.kind !== "block" || continued) return undefined;
    continued = true;
    // event.context.canContinue is not checked: it describes the context
    // before this message, which ends on the assistant reply and so is always
    // false here. The message is a user turn, and pi checks the final context.
    // Earlier handlers' proposed entries are chained, never replaced.
    return {
      entries: [...event.entries, guardrailsMessage(outcome.reason)],
      continue: true,
    };
  });
}
