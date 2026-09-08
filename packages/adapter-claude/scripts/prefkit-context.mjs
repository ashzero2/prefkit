#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { prefkitBaseArgs, prefkitCommand } from "./command.mjs";

const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_MAX_PROMPT_CHARS = 12000;
const DEFAULT_MAX_CONTEXT_CHARS = 4000;
const DEFAULT_LIMIT = 8;
const DEFAULT_MIN_CONFIDENCE = 0.45;
const MAX_INPUT_BYTES = 128 * 1024;

/**
 * Parse and validate the subset of Claude's UserPromptSubmit payload that the
 * adapter needs. Returning null keeps malformed hook input fail-open.
 */
export function parseUserPromptSubmitInput(value) {
  if (!isRecord(value)) {
    return null;
  }

  if (value.hook_event_name !== "UserPromptSubmit") {
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

export function buildContextArgs(input, env = process.env) {
  const prompt = truncate(input.prompt, positiveInteger(env.PREFKIT_CLAUDE_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_CHARS));
  const args = [
    ...prefkitBaseArgs(env),
    "context",
    "--prompt",
    prompt,
    "--cwd",
    input.cwd,
    "--limit",
    String(positiveInteger(env.PREFKIT_CLAUDE_CONTEXT_LIMIT, DEFAULT_LIMIT)),
    "--min-confidence",
    String(numberInRange(env.PREFKIT_CLAUDE_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE, 0, 1)),
  ];

  if (input.agent !== undefined) {
    args.push("--agent", input.agent);
  }
  if (input.sessionId !== undefined) {
    args.push("--session", input.sessionId);
  }

  return args;
}

export function buildHookOutput(context, env = process.env) {
  const boundedContext = truncate(
    context.trim(),
    positiveInteger(env.PREFKIT_CLAUDE_MAX_CONTEXT_CHARS, DEFAULT_MAX_CONTEXT_CHARS),
  );
  if (boundedContext.length === 0) {
    return null;
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: boundedContext,
    },
  };

  if (env.PREFKIT_CLAUDE_NOTIFY === "true") {
    output.systemMessage = "PrefKit context applied";
  }

  return output;
}

async function main() {
  const rawInput = await readStdin();
  const input = parseUserPromptSubmitInput(parseJson(rawInput));
  if (input === null) {
    return;
  }

  const command = prefkitCommand(process.env);
  try {
    const result = await runCommand(command, buildContextArgs(input), input.cwd, timeoutMs(process.env));
    if (result.code !== 0) {
      debug(`prefkit exited with code ${result.code}: ${result.stderr}`);
      return;
    }

    const output = buildHookOutput(result.stdout, process.env);
    if (output !== null) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch (error) {
    debug(`context lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function runCommand(command, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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

function timeoutMs(env) {
  const configured = Number(env.PREFKIT_CLAUDE_CONTEXT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 5000) : DEFAULT_TIMEOUT_MS;
}

function truncate(value, limit) {
  if (value.length <= limit) {
    return value;
  }
  const marker = "[TRUNCATED]";
  if (limit <= marker.length) {
    return marker.slice(0, limit);
  }
  return `${value.slice(0, limit - marker.length)}${marker}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
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
