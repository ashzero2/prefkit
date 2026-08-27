import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadConfig as loadPrefKitConfig,
  redactLearnerEvent,
  scoreLearnerEvent,
  validateLearnerEvent,
} from "@prefkit/core";
import type { ConfigLoadResult, LearnerEvent, LearnerEventType } from "@prefkit/core";
import { extractLatestUserPrompt } from "./context.js";
import type { OpenCodeAdapterOptions, OpenCodeContextEvent } from "./types.js";

export interface OpenCodeQueueInput {
  event: OpenCodeContextEvent;
  cwd: string;
  options: OpenCodeAdapterOptions;
  loadConfig?: (input: { cwd: string; configPath?: string }) => ConfigLoadResult;
  now?: () => Date;
  id?: () => string;
}

export interface OpenCodeQueueResult {
  queued: boolean;
  path?: string;
  skippedReason?: string;
  signalScore?: number;
}

const defaultMaxPromptChars = 4000;

export function queueOpenCodeLearnerEvent(input: OpenCodeQueueInput): OpenCodeQueueResult {
  if (input.options.enabled === false || input.options.queueEvents === false) {
    return { queued: false, skippedReason: "disabled" };
  }

  const prompt = extractLatestUserPrompt(input.event).trim();
  if (prompt.length === 0) {
    return { queued: false, skippedReason: "empty-prompt" };
  }

  const loadConfig = input.loadConfig ?? loadPrefKitConfig;
  const loadResult = loadConfig(
    input.options.configPath === undefined
      ? { cwd: input.cwd }
      : { cwd: input.cwd, configPath: input.options.configPath },
  );
  const eventResult = validateLearnerEvent(
    learnerEventFromOpenCodeContext({
      event: input.event,
      cwd: input.cwd,
      prompt,
      maxPromptChars: input.options.maxPromptChars ?? defaultMaxPromptChars,
    }),
  );

  if (!eventResult.ok) {
    return { queued: false, skippedReason: "invalid-event" };
  }

  const redacted = redactLearnerEvent(eventResult.value, loadResult.config.privacy);
  const signal = scoreLearnerEvent(redacted.event, {
    enabled: loadResult.config.learning.enabled,
    mode: loadResult.config.learning.mode,
    minSignalScore: loadResult.config.learning.minSignalScore,
  });

  if (!signal.shouldExtract && input.options.queueWeakEvents !== true) {
    return {
      queued: false,
      skippedReason: signal.skippedReason ?? "signal-below-threshold",
      signalScore: signal.score,
    };
  }

  const queueDir = input.options.queueDir ?? loadResult.config.learning.queuePath;
  mkdirSync(queueDir, { recursive: true });
  const path = join(queueDir, eventFileName(input.now?.() ?? new Date(), input.id?.() ?? randomUUID()));
  writeFileSync(path, `${JSON.stringify(redacted.event, null, 2)}\n`, { mode: 0o600 });

  return {
    queued: true,
    path,
    signalScore: signal.score,
  };
}

export function learnerEventFromOpenCodeContext(input: {
  event: OpenCodeContextEvent;
  cwd: string;
  prompt: string;
  maxPromptChars: number;
}): LearnerEvent {
  return {
    agent: input.event.agent ?? "opencode",
    cwd: input.cwd,
    ...(input.event.sessionID === undefined ? {} : { sessionId: input.event.sessionID }),
    eventType: classifyEventType(input.prompt),
    userPrompt: truncatePrompt(input.prompt, input.maxPromptChars),
    assistantSummary: "OpenCode captured this user prompt before model dispatch.",
    repoContext: {},
    metadata: {
      source: "opencode-chat-message-hook",
      queuedAtHook: "chat.message",
    },
  };
}

function classifyEventType(prompt: string): LearnerEventType {
  if (/\b(?:remember|save this|store this|note that)\b/i.test(prompt)) {
    return "explicit_memory";
  }
  if (
    /(?:^|\b)(?:no(?:[,.\s]|$)|not that\b|instead\b|rather than\b|use .{1,50} instead\b|don'?t\b|do not\b|stop doing\b)/i.test(
      prompt,
    )
  ) {
    return "explicit_correction";
  }
  return "user_prompt";
}

function truncatePrompt(prompt: string, maxPromptChars: number): string {
  const limit = Math.max(1, Math.floor(maxPromptChars));
  if (prompt.length <= limit) {
    return prompt;
  }
  return `${prompt.slice(0, limit)}[TRUNCATED]`;
}

function eventFileName(date: Date, id: string): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}-${id}.json`;
}
