import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  OpenCodeAdapterOptions,
  OpenCodeContextEvent,
  OpenCodeSystemTransformOutput,
} from "./types.js";
import {
  learnerEventFromOpenCodeContext,
  shouldQueueOpenCodeLearnerEvent,
  type OpenCodeLearnerEvent,
} from "./queue.js";

const execFileAsync = promisify(execFile);
const defaultCommand = "prefkit";
const defaultTimeoutMs = 5000;
const maxOutputBytes = 64 * 1024;
const maxQueueOutputBytes = 16 * 1024;
const workerStartKeys = new Set<string>();

export interface OpenCodeContextBridgeInput {
  output: OpenCodeSystemTransformOutput;
  event: OpenCodeContextEvent;
  cwd: string;
  options: OpenCodeAdapterOptions;
}

export interface OpenCodeContextLookupInput {
  event: OpenCodeContextEvent;
  cwd: string;
  options: OpenCodeAdapterOptions;
}

export interface OpenCodeQueueBridgeInput {
  event: OpenCodeContextEvent;
  cwd: string;
  options: OpenCodeAdapterOptions;
}

export interface OpenCodeWorkerBridgeInput {
  cwd: string;
  options: OpenCodeAdapterOptions;
}

export async function injectOpenCodePreferenceContextViaCli(
  input: OpenCodeContextBridgeInput,
): Promise<void> {
  const text = await loadOpenCodePreferenceContextViaCli(input);
  if (text.length > 0) {
    appendSystemContext(input.output.system, text);
  }
}

export async function loadOpenCodePreferenceContextViaCli(
  input: OpenCodeContextLookupInput,
): Promise<string> {
  const prompt = latestPrompt(input.event);
  if (prompt.length === 0 || input.options.enabled === false || input.options.injectContext === false) {
    return "";
  }

  const args = [
    ...(input.options.prefkitArgs ?? []),
    ...(input.options.configPath === undefined ? [] : ["--config", input.options.configPath]),
    "context",
    "--prompt",
    prompt,
    "--cwd",
    input.cwd,
    "--limit",
    String(input.options.limit ?? 8),
    "--min-confidence",
    String(input.options.minConfidence ?? 0.45),
  ];
  if (input.event.agent !== undefined) {
    args.push("--agent", input.event.agent);
  }
  if (input.event.sessionID !== undefined) {
    args.push("--session", input.event.sessionID);
  }
  if (input.options.includeWhy === true) {
    args.push("--why");
  }

  try {
    const result = await execFileAsync(input.options.prefkitCommand ?? defaultCommand, args, {
      cwd: input.cwd,
      env: process.env,
      timeout: boundedTimeout(input.options.contextTimeoutMs),
      maxBuffer: maxOutputBytes,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`CLI context lookup failed: ${errorMessage(error)}`);
  }
}

export async function queueOpenCodeLearnerEventViaCli(
  input: OpenCodeQueueBridgeInput,
): Promise<boolean> {
  const prompt = latestPrompt(input.event);
  if (!shouldQueueOpenCodeLearnerEvent(prompt, input.options)) {
    return false;
  }

  const event = learnerEventFromOpenCodeContext({
    event: input.event,
    cwd: input.cwd,
    prompt,
    maxPromptChars: boundedPromptLength(input.options.maxPromptChars),
  });
  const args = [
    ...(input.options.prefkitArgs ?? []),
    ...(input.options.configPath === undefined ? [] : ["--config", input.options.configPath]),
    "queue",
    "--stdin-json",
  ];
  if (input.options.queueDir !== undefined) {
    args.push("--queue-dir", input.options.queueDir);
  }
  if (input.options.queueWeakEvents === true) {
    args.push("--queue-weak-events");
  }

  return runQueueCommand(
    input.options.prefkitCommand ?? defaultCommand,
    args,
    input.cwd,
    event,
    input.options.contextTimeoutMs,
  );
}

export function ensureOpenCodeWorkerViaCli(input: OpenCodeWorkerBridgeInput): void {
  if (input.options.enabled === false || input.options.queueEvents === false || input.options.autoStartWorker === false) {
    return;
  }

  const command = input.options.prefkitCommand ?? defaultCommand;
  const args = [
    ...(input.options.prefkitArgs ?? []),
    ...(input.options.configPath === undefined ? [] : ["--config", input.options.configPath]),
    "worker",
    ...(input.options.queueDir === undefined ? [] : ["--queue-dir", input.options.queueDir]),
  ];
  const key = JSON.stringify({ command, args, cwd: input.cwd });
  if (workerStartKeys.has(key)) {
    return;
  }
  workerStartKeys.add(key);

  try {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", () => workerStartKeys.delete(key));
    child.once("exit", () => workerStartKeys.delete(key));
    child.unref();
  } catch {
    workerStartKeys.delete(key);
  }
}

function appendSystemContext(system: string[], context: string): void {
  if (system.length === 0) {
    system.push(context);
    return;
  }

  const base = system[0]?.trimEnd() ?? "";
  system[0] = base.length === 0 ? context : `${base}\n\n${context}`;
}

function latestPrompt(event: OpenCodeContextEvent): string {
  const messages = event.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") {
      continue;
    }
    const content = message.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }
  }
  return "";
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultTimeoutMs;
  }
  return Math.max(100, Math.min(Math.floor(value), 10_000));
}

function boundedPromptLength(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 4000;
  }
  return Math.max(1, Math.min(Math.floor(value), 20_000));
}

async function runQueueCommand(
  command: string,
  args: string[],
  cwd: string,
  event: OpenCodeLearnerEvent,
  timeoutMs: number | undefined,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`CLI queue timed out after ${boundedTimeout(timeoutMs)} ms`));
    }, boundedTimeout(timeoutMs));

    const finish = (error?: Error, queued = false): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        resolve(queued);
      } else {
        reject(new Error(`CLI learner queue failed: ${error.message}${stderr.trim().length > 0 ? `; stderr: ${stderr.trim().slice(0, 1000)}` : ""}`));
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = boundedOutput(stdout, chunk, maxQueueOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = boundedOutput(stderr, chunk, maxQueueOutputBytes);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) {
        finish(undefined, stdout.trim().includes("queued=true"));
      } else {
        finish(new Error(`process exited with code ${code ?? "unknown"}${stdout.trim().length > 0 ? `; output: ${stdout.trim().slice(0, 1000)}` : ""}`));
      }
    });

    child.stdin.end(JSON.stringify(event));
  });
}

function boundedOutput(current: string, chunk: Buffer | string, maxBytes: number): string {
  const next = current + chunk.toString();
  return next.length <= maxBytes ? next : next.slice(0, maxBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : "";
    return stderr.length > 0 ? `${error.message}; stderr: ${stderr.slice(0, 1000)}` : error.message;
  }
  return String(error);
}
