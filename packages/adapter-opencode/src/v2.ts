import { appendFileSync } from "node:fs";
import {
  ensureOpenCodeWorkerViaCli,
  loadOpenCodePreferenceContextViaCli,
  queueOpenCodeLearnerEventViaCli,
} from "./bridge.js";
import { adapterOptions, errorMessage } from "./shared.js";
import type {
  OpenCodeV2ContextEvent,
  OpenCodeV2PluginContext,
  OpenCodeV2PluginDefinition,
  OpenCodeV2SystemPart,
} from "./types.js";

export const openCodePluginId = "prefkit.opencode";

function debug(message: string, detail?: unknown): void {
  const target = process.env.PREFKIT_OPENCODE_DEBUG;
  if (target === undefined || target.trim().length === 0) {
    return;
  }
  try {
    appendFileSync(target, `${new Date().toISOString()} ${message} ${JSON.stringify(detail ?? {})}\n`);
  } catch {
    // Debug logging must never break the plugin.
  }
}

export function openCodeV2Plugin(): OpenCodeV2PluginDefinition {
  return {
    id: openCodePluginId,
    async setup(ctx) {
      const options = adapterOptions(ctx.options);
      const cwd = ctx.location?.directory ?? ctx.location?.worktree ?? process.cwd();
      const prompts = new Map<string, string>();
      const injected = new Set<string>();
      debug("setup", { cwd, options });

      await ctx.session.hook("prompt", async (event) => {
        const prompt = typeof event.prompt?.text === "string" ? event.prompt.text.trim() : "";
        debug("prompt-hook", { sessionID: event.sessionID, length: prompt.length });
        if (prompt.length === 0) {
          return;
        }
        const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined;
        if (options.injectContext !== false && sessionID !== undefined) {
          prompts.set(sessionID, prompt);
        }
        try {
          const queued = await queueOpenCodeLearnerEventViaCli({
            event: { ...(sessionID === undefined ? {} : { sessionID }), messages: [{ role: "user", content: prompt }] },
            cwd,
            options,
          });
          if (queued) {
            ensureOpenCodeWorkerViaCli({ cwd, options });
          }
        } catch (error) {
          debug("prompt-error", errorMessage(error));
          console.warn(`[prefkit] learner event queue skipped: ${errorMessage(error)}`);
        }
      });

      await ctx.session.hook("context", async (event) => {
        debug("context-hook", { sessionID: event.sessionID, hasSystem: Array.isArray(event.system), hasMessages: Array.isArray(event.messages) });
        if (options.enabled === false || options.injectContext === false) {
          return;
        }
        const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined;
        if (sessionID !== undefined && injected.has(sessionID)) {
          return;
        }
        const prompt = (sessionID === undefined ? undefined : prompts.get(sessionID)) ?? latestUserText(event.messages);
        debug("context-prompt", { prompt: prompt?.slice(0, 80) });
        if (prompt === undefined || prompt.length === 0) {
          return;
        }
        try {
          const context = await loadOpenCodePreferenceContextViaCli({
            event: {
              ...(sessionID === undefined ? {} : { sessionID }),
              messages: [{ role: "user", content: prompt }],
            },
            cwd,
            options,
          });
          debug("context-result", { length: context.length });
          if (context.length > 0) {
            appendSystemContext(event.system, context);
            if (sessionID !== undefined) {
              injected.add(sessionID);
              prompts.delete(sessionID);
            }
          }
        } catch (error) {
          debug("context-error", errorMessage(error));
          console.warn(`[prefkit] context injection skipped: ${errorMessage(error)}`);
        }
      });

      return () => {
        prompts.clear();
        injected.clear();
      };
    },
  };
}

function appendSystemContext(system: OpenCodeV2SystemPart[] | undefined, context: string): void {
  if (system === undefined) {
    return;
  }

  const target = system.find((part) => part.type === "text" && typeof part.text === "string");
  if (target !== undefined) {
    target.text = `${(target.text ?? "").trimEnd()}\n\n${context}`;
    return;
  }

  system.push({ type: "text", text: context });
}

function latestUserText(messages: unknown[] | undefined): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) {
      continue;
    }
    const role = message.role ?? (isRecord(message.info) ? message.info.role : undefined);
    if (role !== "user") {
      continue;
    }
    const text = textFromUnknown(message);
    if (text.trim().length > 0) {
      return text.trim();
    }
  }

  return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
