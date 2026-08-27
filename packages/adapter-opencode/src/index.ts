import { loadOpenCodePreferenceContextViaCli } from "./bridge.js";
import { queueOpenCodeLearnerEvent } from "./queue.js";
import type {
  OpenCodeAdapterOptions,
  OpenCodeChatMessageInput,
  OpenCodeChatMessageOutput,
  OpenCodeContextEvent,
  OpenCodeHooks,
  OpenCodeModelMessage,
  OpenCodeNotificationMode,
  OpenCodePluginModule,
  OpenCodeServerPluginInput,
} from "./types.js";

const plugin: OpenCodePluginModule = {
  id: "prefkit.opencode",
  async server(ctx: OpenCodeServerPluginInput, rawOptions) {
    const options = adapterOptions(rawOptions);
    const cwd = ctx.directory || ctx.worktree || process.cwd();
    const prompts = new SessionPromptCache();
    const notifiedSessions = new Set<string>();

    const hooks: OpenCodeHooks = {
      "chat.message": async (input, output) => {
        const prompt = extractChatPrompt(output);
        if (prompt.length === 0) {
          return;
        }

        if (options.injectContext !== false) {
          prompts.set(input.sessionID, prompt, input.agent);
        }

        try {
          queueOpenCodeLearnerEvent({
            event: chatEvent(input, output, prompt),
            cwd,
            options,
          });
        } catch (error) {
          console.warn(`[prefkit] learner event queue skipped: ${errorMessage(error)}`);
        }
      },
      "experimental.chat.system.transform": async (input, output) => {
        if (input.sessionID === undefined) {
          return;
        }

        if (prompts.isCompleted(input.sessionID)) {
          return;
        }

        const cached = prompts.peek(input.sessionID);
        if (cached === undefined) {
          return;
        }

        try {
          const context = await loadOpenCodePreferenceContextViaCli({
            event: {
              sessionID: input.sessionID,
              ...(cached.agent === undefined ? {} : { agent: cached.agent }),
              system: output.system,
              messages: [{ role: "user", content: cached.prompt }],
            },
            cwd,
            options,
          });
          if (context.length > 0) {
            appendSystemContext(output.system, context);
            prompts.markCompleted(input.sessionID);
            notifyInjection(
              ctx.client,
              options.notifyOnInjection,
              options.notificationDurationMs,
              input.sessionID,
              notifiedSessions,
            );
          }
          prompts.take(input.sessionID);
        } catch (error) {
          console.warn(`[prefkit] context injection skipped: ${errorMessage(error)}`);
        }
      },
      "experimental.chat.messages.transform": async (_input, output) => {
        const message = latestUserMessage(output.messages);
        if (message === undefined) {
          return;
        }

        const sessionID = stringField(message.info, "sessionID");
        if (sessionID === undefined) {
          return;
        }

        if (prompts.isCompleted(sessionID)) {
          return;
        }

        const cached = prompts.peek(sessionID);
        const prompt = cached?.prompt ?? textFromUnknown(message.parts).trim();
        if (prompt.length === 0) {
          return;
        }

        try {
          const context = await loadOpenCodePreferenceContextViaCli({
            event: {
              sessionID,
              ...(cached?.agent === undefined ? {} : { agent: cached.agent }),
              messages: [{ role: "user", content: prompt }],
            },
            cwd,
            options,
          });
          if (context.length > 0) {
            appendMessageContext(message.parts, context);
            prompts.markCompleted(sessionID);
            prompts.take(sessionID);
            notifyInjection(
              ctx.client,
              options.notifyOnInjection,
              options.notificationDurationMs,
              sessionID,
              notifiedSessions,
            );
          }
        } catch (error) {
          console.warn(`[prefkit] message context injection skipped: ${errorMessage(error)}`);
        }
      },
    };

    return hooks;
  },
};

export default plugin;
export { injectOpenCodePreferenceContextViaCli } from "./bridge.js";
export { learnerEventFromOpenCodeContext, queueOpenCodeLearnerEvent } from "./queue.js";
export type {
  OpenCodeAdapterOptions,
  OpenCodeContextEvent,
  OpenCodeHooks,
  OpenCodePluginModule,
  OpenCodeServerPluginInput,
} from "./types.js";

function adapterOptions(input: Record<string, unknown> | undefined): OpenCodeAdapterOptions {
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
    ...(isNotificationMode(input.notifyOnInjection) ? { notifyOnInjection: input.notifyOnInjection } : {}),
    ...(typeof input.notificationDurationMs === "number"
      ? { notificationDurationMs: input.notificationDurationMs }
      : {}),
  };
}

function extractChatPrompt(output: OpenCodeChatMessageOutput): string {
  const messageText = textFromUnknown(output.message);
  if (messageText.trim().length > 0) {
    return normalizePrompt(messageText);
  }

  return normalizePrompt(textFromUnknown(output.parts));
}

function normalizePrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed.trim();
      }
    } catch {
      // Keep the original text when it is not a JSON-quoted string.
    }
  }
  return trimmed;
}

function chatEvent(
  input: OpenCodeChatMessageInput,
  output: OpenCodeChatMessageOutput,
  prompt: string,
): OpenCodeContextEvent {
  return {
    sessionID: input.sessionID,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    messages: [{ ...recordOrEmpty(output.message), role: "user", content: prompt }],
  };
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join("\n");
  }

  if (!isRecord(value)) {
    return "";
  }

  for (const key of ["content", "text", "parts"]) {
    const nested = value[key];
    if (typeof nested === "string" || Array.isArray(nested) || isRecord(nested)) {
      const text = textFromUnknown(nested);
      if (text.trim().length > 0) {
        return text;
      }
    }
  }

  return "";
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CachedPrompt {
  prompt: string;
  agent?: string;
  touchedAt: number;
}

class SessionPromptCache {
  private readonly values = new Map<string, CachedPrompt>();
  private readonly completed = new Map<string, number>();
  private readonly maxEntries = 128;
  private readonly maxAgeMs = 5 * 60 * 1000;

  set(sessionID: string, prompt: string, agent: string | undefined): void {
    this.prune();
    this.completed.delete(sessionID);
    this.values.set(sessionID, {
      prompt,
      ...(agent === undefined ? {} : { agent }),
      touchedAt: Date.now(),
    });
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.values.delete(oldest);
    }
  }

  take(sessionID: string): CachedPrompt | undefined {
    this.prune();
    const value = this.values.get(sessionID);
    this.values.delete(sessionID);
    return value;
  }

  peek(sessionID: string): CachedPrompt | undefined {
    this.prune();
    return this.values.get(sessionID);
  }

  markCompleted(sessionID: string): void {
    this.completed.set(sessionID, Date.now());
    while (this.completed.size > this.maxEntries) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.completed.delete(oldest);
    }
  }

  isCompleted(sessionID: string): boolean {
    this.prune();
    return this.completed.has(sessionID);
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [sessionID, value] of this.values) {
      if (value.touchedAt < cutoff) {
        this.values.delete(sessionID);
      }
    }
    for (const [sessionID, touchedAt] of this.completed) {
      if (touchedAt < cutoff) {
        this.completed.delete(sessionID);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestUserMessage(messages: OpenCodeModelMessage[]): OpenCodeModelMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && stringField(message.info, "role") === "user") {
      return message;
    }
  }
  return undefined;
}

function appendMessageContext(parts: unknown[], context: string): void {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      continue;
    }
    part.text = `${part.text.trimEnd()}\n\n${context}`;
    return;
  }

  parts.push({ type: "text", text: context });
}

function appendSystemContext(system: string[], context: string): void {
  if (system.length === 0) {
    system.push(context);
    return;
  }

  const base = system[0]?.trimEnd() ?? "";
  system[0] = base.length === 0 ? context : `${base}\n\n${context}`;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isNotificationMode(value: unknown): value is OpenCodeNotificationMode {
  return value === "off" || value === "once-per-session" || value === "always";
}

function notifyInjection(
  client: OpenCodeServerPluginInput["client"],
  mode: OpenCodeNotificationMode | undefined,
  durationMs: number | undefined,
  sessionID: string,
  notifiedSessions: Set<string>,
): void {
  const resolvedMode = mode ?? "once-per-session";
  if (resolvedMode === "off" || client?.tui?.showToast === undefined) {
    return;
  }
  if (resolvedMode === "once-per-session" && notifiedSessions.has(sessionID)) {
    return;
  }

  if (resolvedMode === "once-per-session") {
    notifiedSessions.add(sessionID);
  }

  void Promise.resolve()
    .then(() =>
      client.tui?.showToast?.({
        body: {
          title: "PrefKit",
          message: "Applied saved preferences",
          variant: "info",
          duration: boundedNotificationDuration(durationMs),
        },
      }),
    )
    .catch((error: unknown) => {
      console.warn(`[prefkit] notification skipped: ${errorMessage(error)}`);
    });
}

function boundedNotificationDuration(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 5000;
  }
  return Math.max(1500, Math.min(Math.floor(value), 10_000));
}
