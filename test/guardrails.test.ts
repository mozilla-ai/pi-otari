import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGuardrails } from "../src/guardrails.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const PI_HELP = "  --harness [claude-code|codex|pi]  Agent harness.\n";
const OLD_HELP = "  --harness [claude-code|codex]  Agent harness.\n";

let root: string;
let repo: string;
let home: string;
let bin: string;
let handlers: Record<string, Handler>;
let notify: ReturnType<typeof vi.fn>;

async function scenario(options: {
  code?: number;
  stdout?: string;
  stderr?: string;
  help?: string;
}) {
  await writeFile(join(root, "code"), String(options.code ?? 0));
  await writeFile(join(root, "out"), options.stdout ?? "");
  await writeFile(join(root, "err"), options.stderr ?? "");
  await writeFile(join(root, "help"), options.help ?? PI_HELP);
}

async function calls(): Promise<
  { args: string[]; payload: Record<string, unknown> }[]
> {
  const args = (await readFile(join(root, "args.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  const stdin = (
    await readFile(join(root, "stdin.log"), "utf8").catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  return stdin.map((line, index) => ({
    args: args[index].split(" "),
    payload: JSON.parse(line),
  }));
}

function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: repo,
    hasUI: true,
    ui: { notify },
    ...overrides,
  } as unknown as ExtensionContext;
}

function register(env: Record<string, string> = {}, timeoutMs?: number) {
  handlers = {};
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers[name] = handler;
    },
  } as unknown as ExtensionAPI;
  registerGuardrails(pi, {
    env: { OTARI_HOOK_BIN: bin, PATH: "", ...env },
    home,
    timeoutMs,
  });
}

const toolCall = (toolName: string, input: Record<string, unknown>) =>
  handlers.tool_call(
    { type: "tool_call", toolCallId: "1", toolName, input },
    ctx(),
  );
const settle = (
  overrides: {
    outcome?: string;
    canContinue?: boolean;
    entries?: unknown[];
    signal?: AbortSignal;
  } = {},
) =>
  handlers.agent_before_settle(
    {
      type: "agent_before_settle",
      entries: overrides.entries ?? [],
      continue: false,
      outcome: overrides.outcome ?? "completed",
      context: { canContinue: overrides.canContinue ?? true },
    },
    ctx(overrides.signal ? { signal: overrides.signal } : {}),
  ) as Promise<{ entries?: unknown[]; continue?: boolean } | undefined>;

const guardrailsEntry = (content: string) => ({
  type: "custom_message",
  customType: "otari-guardrails",
  content,
  display: true,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "guardrails-"));
  repo = join(root, "repo");
  home = join(root, "home");
  await mkdir(join(repo, ".otari"), { recursive: true });
  await mkdir(join(repo, ".git"));
  await mkdir(home);
  await writeFile(join(repo, ".otari", "guardrails.yml"), "rules: []\n");
  bin = join(root, "otari");
  await writeFile(
    bin,
    `#!/bin/sh
D="${root}"
if [ "$2" = "--help" ]; then cat "$D/help"; exit 0; fi
echo "$*" >> "$D/args.log"
cat >> "$D/stdin.log"
echo >> "$D/stdin.log"
cat "$D/out"
cat "$D/err" >&2
exit "$(cat "$D/code")"
`,
  );
  chmodSync(bin, 0o755);
  notify = vi.fn();
  await scenario({});
  register();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("guardrails", () => {
  it("allows a tool call and sends the pi-native payload", async () => {
    expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
    const [call] = await calls();
    expect(call.args).toEqual(["hook", "--harness", "pi"]);
    expect(call.payload).toEqual({
      hook_event_name: "PreToolUse",
      cwd: repo,
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("blocks on exit 2 with the trimmed stderr reason", async () => {
    await scenario({ code: 2, stderr: "  no force pushes\n" });
    expect(await toolCall("write", { path: "a.txt" })).toEqual({
      block: true,
      reason: "no force pushes",
    });
  });

  it("ignores tools it does not guard", async () => {
    expect(await toolCall("grep", { pattern: "x" })).toBeUndefined();
    expect(await calls()).toHaveLength(0);
  });

  it("shows a systemMessage advisory without blocking", async () => {
    await scenario({ stdout: JSON.stringify({ systemMessage: "heads up" }) });
    expect(await toolCall("read", { path: "/x" })).toBeUndefined();
    expect(notify).toHaveBeenCalledWith("heads up", "info");
  });

  it("falls back to the claude-code payload when otari lacks pi support", async () => {
    await scenario({ help: OLD_HELP });
    await toolCall("read", { path: "src/a.ts" });
    await toolCall("bash", { command: "ls" });
    const [read, bash] = await calls();
    expect(read.args).toEqual(["hook", "--harness", "claude-code"]);
    expect(read.payload.tool_name).toBe("Read");
    expect(read.payload.tool_input).toEqual({
      file_path: join(repo, "src/a.ts"),
    });
    expect(bash.payload.tool_name).toBe("Bash");
    expect(bash.payload.tool_input).toEqual({ command: "ls" });
    await settle();
    const stop = (await calls()).at(-1);
    expect(stop?.payload.bash_commands).toBeUndefined();
  });

  it("forces one continuation on Stop and never a second", async () => {
    await toolCall("bash", { command: "npm test" });
    await scenario({ code: 2, stderr: "run the tests" });
    const first = await settle();
    expect(first).toEqual({
      entries: [guardrailsEntry("run the tests")],
      continue: true,
    });
    const second = await settle();
    expect(second).toBeUndefined();

    const stops = (await calls()).filter(
      (c) => c.payload.hook_event_name === "Stop",
    );
    expect(stops[0].payload.stop_hook_active).toBe(false);
    expect(stops[0].payload.bash_commands).toEqual(["npm test"]);
    expect(stops[1].payload.stop_hook_active).toBe(true);

    // Once the run settles, the next run may be continued again.
    handlers.agent_settled({ type: "agent_settled" }, ctx());
    expect((await settle())?.continue).toBe(true);
  });

  it("chains its entry after entries earlier handlers proposed", async () => {
    await scenario({ code: 2, stderr: "run the tests" });
    const earlier = guardrailsEntry("from another extension");
    expect(await settle({ entries: [earlier] })).toEqual({
      entries: [earlier, guardrailsEntry("run the tests")],
      continue: true,
    });
  });

  it("never checks or resumes an aborted or failed run", async () => {
    await scenario({ code: 2, stderr: "run the tests" });
    expect(await settle({ outcome: "aborted" })).toBeUndefined();
    expect(await settle({ outcome: "error" })).toBeUndefined();
    expect(await calls()).toHaveLength(0);
  });

  it("does not continue when pi cannot continue", async () => {
    await scenario({ code: 2, stderr: "run the tests" });
    expect(await settle({ canContinue: false })).toBeUndefined();
  });

  it("records a judge gate's additionalContext without continuing", async () => {
    await scenario({
      stdout: JSON.stringify({
        systemMessage: "judge: advisory",
        hookSpecificOutput: { additionalContext: "consider adding tests" },
      }),
    });
    const earlier = guardrailsEntry("from another extension");
    expect(await settle({ entries: [earlier] })).toEqual({
      entries: [earlier, guardrailsEntry("consider adding tests")],
    });
    expect(notify).toHaveBeenCalledWith("judge: advisory", "info");
  });

  it("detects pi support from the option list, not the help prose", async () => {
    await scenario({
      help: "  `--harness` picks the payload shape.\n  Options:\n  --url TEXT [env var: X]\n  --harness [claude-code|codex|pi]\n",
    });
    await toolCall("bash", { command: "ls" });
    const [call] = await calls();
    expect(call.args).toEqual(["hook", "--harness", "pi"]);
  });

  it("keeps a cancelled call from using up the failure warning", async () => {
    await writeFile(bin, "#!/bin/sh\nsleep 5\n");
    const controller = new AbortController();
    const pending = handlers.tool_call(
      {
        type: "tool_call",
        toolCallId: "1",
        toolName: "bash",
        input: { command: "ls" },
      },
      ctx({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("bounds the recorded bash commands", async () => {
    // Without rules no hook runs, but commands are still recorded.
    await rm(join(repo, ".otari"), { recursive: true });
    for (let i = 0; i < 205; i++) await toolCall("bash", { command: `c${i}` });
    await mkdir(join(repo, ".otari"));
    await writeFile(join(repo, ".otari", "guardrails.yml"), "rules: []\n");
    await settle();
    const commands = (await calls()).at(-1)?.payload.bash_commands as string[];
    expect(commands).toHaveLength(200);
    expect(commands[0]).toBe("c5");
  });

  it("resets the recorded bash commands on session_start", async () => {
    await toolCall("bash", { command: "one" });
    handlers.session_start({ type: "session_start" }, ctx());
    await settle();
    const stop = (await calls()).at(-1);
    expect(stop?.payload.bash_commands).toEqual([]);
  });

  it("fails open once on a spawn error", async () => {
    register({ OTARI_HOOK_BIN: join(root, "missing") });
    expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
    expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe("warning");
  });

  it("fails open on an unexpected exit code", async () => {
    await scenario({ code: 1, stderr: "boom" });
    expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await settle()).toBeUndefined();
  });

  it("fails open on timeout", async () => {
    await writeFile(bin, "#!/bin/sh\nsleep 5\n");
    register({}, 200);
    expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
    expect(notify.mock.calls[0][0]).toContain("timed out");
  });

  it("does nothing when no guardrails file exists", async () => {
    await rm(join(repo, ".otari"), { recursive: true });
    expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
    expect(await calls()).toHaveLength(0);
  });

  it("is active for user-level rules and off with OTARI_GUARDRAILS=off", async () => {
    await rm(join(repo, ".otari"), { recursive: true });
    await mkdir(join(home, ".otari", "guardrails"), { recursive: true });
    await scenario({ code: 2, stderr: "nope" });
    expect(await toolCall("bash", { command: "ls" })).toEqual({
      block: true,
      reason: "nope",
    });
    register({ OTARI_GUARDRAILS: "off" });
    expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
  });

  it("finds rules in a parent directory up to the git root", async () => {
    const nested = join(repo, "a", "b");
    await mkdir(nested, { recursive: true });
    await scenario({ code: 2, stderr: "nope" });
    const result = await handlers.tool_call(
      {
        type: "tool_call",
        toolCallId: "1",
        toolName: "bash",
        input: { command: "x" },
      },
      ctx({ cwd: nested }),
    );
    expect(result).toEqual({ block: true, reason: "nope" });
  });
});
