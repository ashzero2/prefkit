import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const hookPath = resolve(process.cwd(), "packages/adapter-claude/scripts/prefkit-context.mjs");

describe("Claude context hook", () => {
  it("returns bounded context and passes Claude metadata to prefkit", async () => {
    const root = mkdtempSync(join(tmpdir(), "prefkit-claude-hook-"));
    const project = join(root, "project");
    const command = join(root, "prefkit");
    const argsFile = join(root, "args.json");
    writeFileSync(project, "project\n");
    writeFileSync(
      command,
      `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.PREFKIT_TEST_ARGS, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write("Relevant user preferences:\\n- Prefer concise names\\n");\n`,
      { mode: 0o755 },
    );
    chmodSync(command, 0o755);

    const result = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Give me names for an app",
        cwd: dirname(project),
        session_id: "session-123",
        agent_type: "claude-code",
      },
      { PREFKIT_COMMAND: command, PREFKIT_TEST_ARGS: argsFile },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Relevant user preferences:\n- Prefer concise names",
      },
    });
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
      "context",
      "--prompt",
      "Give me names for an app",
      "--cwd",
      dirname(project),
      "--limit",
      "8",
      "--min-confidence",
      "0.45",
      "--agent",
      "claude-code",
      "--session",
      "session-123",
    ]);
  });

  it("fails open when the prompt payload or command is invalid", async () => {
    const malformed = await runHook("not-json", {});
    expect(malformed.code).toBe(0);
    expect(malformed.stdout).toBe("");

    const missing = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "hello",
        cwd: process.cwd(),
      },
      { PREFKIT_COMMAND: "/missing/prefkit" },
    );
    expect(missing.code).toBe(0);
    expect(missing.stdout).toBe("");
  });

  it("can emit an optional user-visible system message", async () => {
    const root = mkdtempSync(join(tmpdir(), "prefkit-claude-hook-"));
    const command = join(root, "prefkit");
    writeFileSync(command, "#!/bin/sh\nprintf '%s' 'A preference was found'\n", { mode: 0o755 });
    chmodSync(command, 0o755);

    const result = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "hello", cwd: process.cwd() },
      { PREFKIT_COMMAND: command, PREFKIT_CLAUDE_NOTIFY: "true" },
    );

    expect(JSON.parse(result.stdout).systemMessage).toBe("PrefKit context applied");
  });
});

function runHook(input: unknown, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
