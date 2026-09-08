#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { prefkitBaseArgs, prefkitCommand } from "./command.mjs";

const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_MAX_PROMPT_CHARS = 6000;
const MAX_INPUT_BYTES = 128 * 1024;

export function parseUserPromptSubmitInput(value) {
  if (!isRecord(value) || value.hook_event_name !== "UserPromptSubmit") {
    return null;
  }

  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) {
    return null;
  }

  if (typeof value.cwd !== "string" || value.cwd.trim().length === 0) {
    return null;
  }

  return {
    prompt: value.prompt,
    cwd: value.cwd,
    ...(typeof value.session_id === "string" && value.session_id.trim().length > 0
      ? { sessionId: value.session_id }
      : {}),
    ...(typeof value.agent_type === "string" && value.agent_type.trim().length > 0
      ? { agent: value.agent_type }
      : {}),
  };
}

export function shouldQueuePrompt(prompt) {
  return /\b(?:remember|save this|store this|note that|i prefer|i like|i usually|i generally|my preference|from now on|going forward|in future|next time|always|never|i(?:'|’)d rather|i would rather|i told you|as i said|like i said|why did you)\b/i.test(
    prompt,
  ) || /(?:^|\b)(?:no(?:[,\.\s]|$)|not that\b|instead\b|rather than\b|use .{1,50} instead\b|don'?t\b|do not\b|stop doing\b)/i.test(prompt);
}

export function buildLearnerEvent(input, env = process.env) {
  const prompt = truncate(input.prompt, positiveInteger(env.PREFKIT_CLAUDE_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_CHARS));
  return {
    agent: input.agent || "claude",
    cwd: input.cwd,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    eventType: classifyEventType(prompt),
    userPrompt: prompt,
    assistantSummary: "Claude Code captured this user prompt before model dispatch.",
    repoContext: {},
    metadata: {
      source: "claude-user-prompt-submit-hook",
      queuedAtHook: "UserPromptSubmit",
    },
  };
}

export function buildQueueArgs(env = process.env) {
  const args = [...prefkitBaseArgs(env), "queue", "--stdin-json"];
  const queueDir = env.PREFKIT_QUEUE_DIR?.trim();
  if (queueDir) {
    args.push("--queue-dir", queueDir);
  }
  return args;
}

export function buildWorkerArgs(env = process.env) {
  const args = [...prefkitBaseArgs(env), "worker"];
  const queueDir = env.PREFKIT_QUEUE_DIR?.trim();
  if (queueDir) {
    args.push("--queue-dir", queueDir);
  }
  return args;
}

async function main() {
  const rawInput = await readStdin();
  const input = parseUserPromptSubmitInput(parseJson(rawInput));
  if (input === null || !shouldQueuePrompt(input.prompt) || process.env.PREFKIT_CLAUDE_QUEUE_EVENTS === "false") {
    return;
  }

  const env = process.env;
  const command = prefkitCommand(env);
  try {
    const result = await runCommand(command, buildQueueArgs(env), input.cwd, JSON.stringify(buildLearnerEvent(input, env)), timeoutMs(env));
    if (result.code !== 0) {
      debug(`prefkit queue exited with code ${result.code}: ${result.stderr}`);
      return;
    }

    if (result.stdout.includes("queued=true") && env.PREFKIT_CLAUDE_AUTO_START_WORKER !== "false") {
      startWorker(command, buildWorkerArgs(env), input.cwd, env);
    }
  } catch (error) {
    debug(`learning queue skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function startWorker(command, args, cwd, env) {
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch (error) {
    debug(`worker start skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        reject(new Error("hook input is too large"));
        process.stdin.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function runCommand(command, args, cwd, input, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`prefkit command timed out after ${timeout} ms`));
    }, timeout);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
    child.stdin.end(input);

    function finish(error) {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      reject(error);
    }
  });
}

function classifyEventType(prompt) {
  if (/\b(?:remember|save this|store this|note that)\b/i.test(prompt)) {
    return "explicit_memory";
  }
  if (/(?:^|\b)(?:no[,\.\s]|not that\b|instead\b|rather than\b|use .{1,50} instead\b|don'?t\b|do not\b|stop doing\b)/i.test(prompt)) {
    return "explicit_correction";
  }
  return "user_prompt";
}

function timeoutMs(env) {
  const configured = Number(env.PREFKIT_CLAUDE_LEARN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 5000) : DEFAULT_TIMEOUT_MS;
}

function truncate(value, limit) {
  if (value.length <= limit) {
    return value;
  }
  const marker = "[TRUNCATED]";
  return limit <= marker.length ? marker.slice(0, limit) : `${value.slice(0, limit - marker.length)}${marker}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function debug(message) {
  if (process.env.PREFKIT_CLAUDE_DEBUG === "true") {
    process.stderr.write(`[prefkit] ${message}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => debug(error instanceof Error ? error.message : String(error)));
}
