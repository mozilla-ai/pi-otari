import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const HOOK_TIMEOUT_MS = 20_000;
const GUARDRAILS_ENTRY = "otari-guardrails";
const GUARDED_TOOLS = new Set(["bash", "read", "edit", "write"]);
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
};

export interface GuardrailsDependencies {
  env?: NodeJS.ProcessEnv;
  /** Home directory holding user-level `~/.otari` rules. */
  home?: string;
  timeoutMs?: number;
}

type Harness = "pi" | "claude-code";

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBinary(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.OTARI_HOOK_BIN?.trim();
  if (override) return override;
  const names =
    process.platform === "win32"
      ? ["otari.exe", "otari.cmd", "otari.bat"]
      : ["otari"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function hasRules(dir: string): boolean {
  return (
    existsSync(join(dir, ".otari", "guardrails.yml")) ||
    isDirectory(join(dir, ".otari", "guardrails"))
  );
}

/** Repo rules (cwd up to the git root) or user rules in the home directory. */
export function guardrailsExist(cwd: string, home: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    if (hasRules(dir)) return true;
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return hasRules(home);
}

function runProcess(
  bin: string,
  args: string[],
  input: string | undefined,
  cwd: string,
  signal: AbortSignal,
): Promise<HookResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd, signal, stdio: "pipe" });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
    // A hook that exits without reading stdin raises EPIPE; the exit code
    // still carries the verdict.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function systemMessageOf(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { systemMessage?: unknown };
    const message = parsed.systemMessage;
    return typeof message === "string" && message.trim() ? message : undefined;
  } catch {
    return undefined;
  }
}

type Outcome =
  | { kind: "allow"; systemMessage?: string }
  | { kind: "block"; reason: string }
  | { kind: "skip" };

/**
 * Enforce Otari agent guardrails (`.otari/guardrails*`) by delegating each
 * decision to the local `otari hook` CLI, as Claude Code and Codex do.
 */
export function registerGuardrails(
  pi: ExtensionAPI,
  dependencies: GuardrailsDependencies = {},
): void {
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const timeoutMs = dependencies.timeoutMs ?? HOOK_TIMEOUT_MS;

  let bashCommands: string[] = [];
  let continued = false;
  let skipNextAgentStart = false;
  let warnedFailure = false;
  const harnessCache = new Map<string, Promise<Harness>>();

  const notify = (
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" = "info",
  ) => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  const failOpen = (ctx: ExtensionContext, reason: string) => {
    if (warnedFailure) return;
    warnedFailure = true;
    notify(
      ctx,
      `Otari guardrails are not being enforced: ${reason}. Allowing the action.`,
      "warning",
    );
  };

  // `--harness pi` is a click choice; an older otari rejects it with a usage
  // error that also exits 2, which must never be mistaken for a block.
  const detectHarness = (
    bin: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<Harness> => {
    let cached = harnessCache.get(bin);
    if (!cached) {
      cached = runProcess(bin, ["hook", "--help"], undefined, cwd, signal)
        .then((result): Harness => {
          const text = `${result.stdout}\n${result.stderr}`.replace(
            /\s+/g,
            " ",
          );
          const list = /--harness[^[]*\[([^\]]*)\]/.exec(text)?.[1] ?? "";
          return list.split(/[|,\s]+/).includes("pi") ? "pi" : "claude-code";
        })
        .catch((error) => {
          harnessCache.delete(bin);
          throw error;
        });
      harnessCache.set(bin, cached);
    }
    return cached;
  };

  const invoke = async (
    ctx: ExtensionContext,
    event: "PreToolUse" | "Stop",
    pick: {
      toolName?: string;
      input?: Record<string, unknown>;
      stopHookActive?: boolean;
    },
  ): Promise<Outcome> => {
    if (env.OTARI_GUARDRAILS?.trim().toLowerCase() === "off") {
      return { kind: "skip" };
    }
    const bin = resolveBinary(env);
    if (!bin || !guardrailsExist(ctx.cwd, home)) return { kind: "skip" };

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeout])
      : timeout;
    try {
      const harness = await detectHarness(bin, ctx.cwd, signal);
      const payload: Record<string, unknown> = {
        hook_event_name: event,
        cwd: ctx.cwd,
      };
      if (pick.toolName) {
        const input = pick.input ?? {};
        if (harness === "pi") {
          payload.tool_name = pick.toolName;
          payload.tool_input = input;
        } else {
          payload.tool_name = CLAUDE_TOOL_NAMES[pick.toolName];
          if (pick.toolName === "bash") {
            payload.tool_input = { command: input.command };
          } else {
            const path = input.path;
            payload.tool_input = {
              file_path:
                typeof path === "string" && !isAbsolute(path)
                  ? resolve(ctx.cwd, path)
                  : path,
            };
          }
        }
      }
      if (event === "Stop") {
        payload.stop_hook_active = pick.stopHookActive ?? false;
        if (harness === "pi") payload.bash_commands = [...bashCommands];
      }
      const result = await runProcess(
        bin,
        ["hook", "--harness", harness],
        JSON.stringify(payload),
        ctx.cwd,
        signal,
      );
      if (result.code === 0) {
        return { kind: "allow", systemMessage: systemMessageOf(result.stdout) };
      }
      if (result.code === 2) {
        return {
          kind: "block",
          reason:
            result.stderr.trim() || "Blocked by Otari guardrails (no reason).",
        };
      }
      failOpen(ctx, `otari hook exited with code ${result.code}`);
      return { kind: "skip" };
    } catch (error) {
      failOpen(
        ctx,
        timeout.aborted
          ? "otari hook timed out"
          : `could not run otari hook (${error instanceof Error ? error.message : String(error)})`,
      );
      return { kind: "skip" };
    }
  };

  pi.on("session_start", () => {
    bashCommands = [];
    continued = false;
    skipNextAgentStart = false;
  });

  pi.on("input", () => {
    continued = false;
    skipNextAgentStart = false;
    return undefined;
  });

  pi.on("agent_start", () => {
    // A forced continuation may announce itself as another agent_start; it
    // must not re-arm the loop guard.
    if (skipNextAgentStart) {
      skipNextAgentStart = false;
      return;
    }
    continued = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;
    const outcome = await invoke(ctx, "PreToolUse", {
      toolName: event.toolName,
      input,
    });
    if (outcome.kind === "block") {
      return { block: true, reason: outcome.reason };
    }
    if (outcome.kind === "allow" && outcome.systemMessage) {
      notify(ctx, outcome.systemMessage);
    }
    if (event.toolName === "bash" && typeof input.command === "string") {
      bashCommands.push(input.command);
    }
    return undefined;
  });

  pi.on("agent_before_settle", async (_event, ctx) => {
    const outcome = await invoke(ctx, "Stop", { stopHookActive: continued });
    if (outcome.kind === "allow" && outcome.systemMessage) {
      notify(ctx, outcome.systemMessage);
    }
    if (outcome.kind !== "block" || continued) return undefined;
    continued = true;
    skipNextAgentStart = true;
    return {
      entries: [
        {
          type: "custom_message" as const,
          customType: GUARDRAILS_ENTRY,
          content: outcome.reason,
          display: true,
        },
      ],
      continue: true,
    };
  });
}
