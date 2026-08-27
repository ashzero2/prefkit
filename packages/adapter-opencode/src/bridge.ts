import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  OpenCodeAdapterOptions,
  OpenCodeContextEvent,
  OpenCodeSystemTransformOutput,
} from "./types.js";

const execFileAsync = promisify(execFile);
const defaultCommand = "prefkit";
const defaultTimeoutMs = 5000;
const maxOutputBytes = 64 * 1024;

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
