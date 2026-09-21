import type { OpenCodeAdapterOptions, OpenCodeNotificationMode } from "./types.js";

export function adapterOptions(input: Record<string, unknown> | undefined): OpenCodeAdapterOptions {
  if (input === undefined) {
    return {};
  }

  return {
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    ...(typeof input.injectContext === "boolean" ? { injectContext: input.injectContext } : {}),
    ...(typeof input.configPath === "string" ? { configPath: input.configPath } : {}),
    ...(typeof input.includeWhy === "boolean" ? { includeWhy: input.includeWhy } : {}),
    ...(typeof input.minConfidence === "number" ? { minConfidence: input.minConfidence } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(typeof input.queueEvents === "boolean" ? { queueEvents: input.queueEvents } : {}),
    ...(typeof input.queueDir === "string" ? { queueDir: input.queueDir } : {}),
    ...(typeof input.queueWeakEvents === "boolean" ? { queueWeakEvents: input.queueWeakEvents } : {}),
    ...(typeof input.maxPromptChars === "number" ? { maxPromptChars: input.maxPromptChars } : {}),
    ...(typeof input.prefkitCommand === "string" ? { prefkitCommand: input.prefkitCommand } : {}),
    ...(Array.isArray(input.prefkitArgs) && input.prefkitArgs.every((value) => typeof value === "string")
      ? { prefkitArgs: input.prefkitArgs }
      : {}),
    ...(typeof input.contextTimeoutMs === "number" ? { contextTimeoutMs: input.contextTimeoutMs } : {}),
    ...(typeof input.autoStartWorker === "boolean" ? { autoStartWorker: input.autoStartWorker } : {}),
    ...(isNotificationMode(input.notifyOnInjection) ? { notifyOnInjection: input.notifyOnInjection } : {}),
    ...(typeof input.notificationDurationMs === "number"
      ? { notificationDurationMs: input.notificationDurationMs }
      : {}),
  };
}

export function isNotificationMode(value: unknown): value is OpenCodeNotificationMode {
  return value === "off" || value === "once-per-session" || value === "always";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
