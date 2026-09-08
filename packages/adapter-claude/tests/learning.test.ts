import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLearnerEvent,
  buildQueueArgs,
  buildWorkerArgs,
  parseUserPromptSubmitInput,
  shouldQueuePrompt,
} from "../scripts/prefkit-learn.mjs";

const hookPath = join(process.cwd(), "packages/adapter-claude/scripts/prefkit-learn.mjs");

describe("Claude learning hook", () => {
  it("recognizes only preference-shaped prompts", () => {
    expect(shouldQueuePrompt("Remember that I prefer concise updates.")).toBe(true);
    expect(shouldQueuePrompt("Give me names for a food app.")).toBe(false);
  });

  it("builds a bounded learner event from Claude metadata", () => {
    const input = parseUserPromptSubmitInput({
      hook_event_name: "UserPromptSubmit",
      prompt: "Remember that I prefer concise updates.",
      cwd: "/repo",
      session_id: "session-123",
      agent_type: "claude-code",
    });

    expect(input).not.toBeNull();
    expect(buildLearnerEvent(input!)).toEqual({
      agent: "claude-code",
      cwd: "/repo",
      sessionId: "session-123",
      eventType: "explicit_memory",
      userPrompt: "Remember that I prefer concise updates.",
      assistantSummary: "Claude Code captured this user prompt before model dispatch.",
      repoContext: {},
      metadata: {
        source: "claude-user-prompt-submit-hook",
        queuedAtHook: "UserPromptSubmit",
      },
    });
  });

  it("supports an installed command, arguments, config, queue, and worker paths", () => {
    const env = {
      PREFKIT_COMMAND: "pnpm",
      PREFKIT_ARGS: '["--dir","/repo","--silent","prefkit"]',
      PREFKIT_CONFIG: "/config/prefkit.json",
      PREFKIT_QUEUE_DIR: "/queue",
    };

    expect(buildQueueArgs(env)).toEqual([
      "--dir",
      "/repo",
      "--silent",
      "prefkit",
      "--config",
      "/config/prefkit.json",
      "queue",
      "--stdin-json",
      "--queue-dir",
      "/queue",
    ]);
    expect(buildWorkerArgs(env)).toEqual([
      "--dir",
      "/repo",
      "--silent",
      "prefkit",
      "--config",
      "/config/prefkit.json",
      "worker",
      "--queue-dir",
      "/queue",
    ]);
  });

  it("queues a strong prompt and starts the worker without producing hook output", async () => {
    const root = mkdtempSync(join(tmpdir(), "prefkit-claude-learning-"));
    const command = join(root, "prefkit");
    const eventPath = join(root, "event.json");
    const workerMarker = join(root, "worker-started");
    writeFileSync(
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("queue")) {
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    fs.writeFileSync(process.env.PREFKIT_TEST_EVENT, input);
    process.stdout.write("queued=true");
  });
} else {
  fs.writeFileSync(process.env.PREFKIT_TEST_WORKER, "started");
}
`,
      { mode: 0o755 },
    );
    chmodSync(command, 0o755);

    const result = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Remember that I prefer concise updates.",
        cwd: root,
        session_id: "session-123",
      },
      {
        PREFKIT_COMMAND: command,
        PREFKIT_TEST_EVENT: eventPath,
        PREFKIT_TEST_WORKER: workerMarker,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(readFileSync(eventPath, "utf8"))).toMatchObject({
      agent: "claude",
      cwd: root,
      sessionId: "session-123",
      eventType: "explicit_memory",
      userPrompt: "Remember that I prefer concise updates.",
    });
    await waitForFile(workerMarker);
    expect(readFileSync(workerMarker, "utf8")).toBe("started");
  });
});

function runHook(input: unknown, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
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
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
