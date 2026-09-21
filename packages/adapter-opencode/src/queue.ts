import type { OpenCodeAdapterOptions, OpenCodeContextEvent } from "./types.js";

export interface OpenCodeLearnerEvent {
  agent: string;
  cwd: string;
  sessionId?: string;
  eventType: OpenCodeLearnerEventType;
  userPrompt: string;
  assistantSummary: string;
  repoContext: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export type OpenCodeLearnerEventType =
  | "explicit_memory"
  | "explicit_correction"
  | "user_prompt"
  | "repeated_choice"
  | "manual_replay";

const preferencePattern =
  /\b(?:remember|save this|store this|note that|i prefer|i like|i usually|i generally|my preference|from now on|going forward|in future|next time|i(?:'|’)d rather|i would rather|i told you|as i said|like i said|why did you)\b/i;
const instructionVerbs =
  "use|prefer|do|write|add|include|avoid|format|name|test|run|commit|install|import|sort|order|keep|set|call|return|document|answer|respond|give|provide|show|explain|summarize|produce|list|pick|choose|start|stop|skip|follow|mention";
const absolutePattern = new RegExp(`\\b(?:always|never)\\s+(?:${instructionVerbs})\\b`, "i");
const correctionPattern = new RegExp(
  `(?:^|\\b)(?:no[,.!\\s]+(?:use|do|don'?t|please|that|i meant|we should|not that)|not that\\b|instead\\b|rather than\\b|use .{1,50} instead\\b|don'?t\\s+(?:${instructionVerbs})\\b|do not\\s+(?:${instructionVerbs})\\b|stop doing\\b)`,
  "i",
);
const hedgedPattern = /\b(?:this once|just this once|only this time|just for now|for now|today only)\b/i;

export function learnerEventFromOpenCodeContext(input: {
  event: OpenCodeContextEvent;
  cwd: string;
  prompt: string;
  maxPromptChars: number;
  assistantSummary?: string;
  queuedAtHook?: string;
}): OpenCodeLearnerEvent {
  return {
    agent: input.event.agent ?? "opencode",
    cwd: input.cwd,
    ...(input.event.sessionID === undefined ? {} : { sessionId: input.event.sessionID }),
    eventType: classifyEventType(input.prompt),
    userPrompt: truncatePrompt(input.prompt, input.maxPromptChars),
    assistantSummary: (input.assistantSummary ?? "").trim(),
    repoContext: {},
    metadata: {
      source: "opencode-chat-message-hook",
      queuedAtHook: input.queuedAtHook ?? "chat.message",
    },
  };
}

export function shouldQueueOpenCodeLearnerEvent(prompt: string, options: OpenCodeAdapterOptions): boolean {
  if (options.enabled === false || options.queueEvents === false) {
    return false;
  }

  if (options.queueWeakEvents === true) {
    return prompt.trim().length > 0;
  }

  if (hedgedPattern.test(prompt)) {
    return false;
  }

  return preferencePattern.test(prompt) || absolutePattern.test(prompt) || correctionPattern.test(prompt);
}

export function extractLatestUserPrompt(event: OpenCodeContextEvent): string {
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

function classifyEventType(prompt: string): OpenCodeLearnerEventType {
  if (/\b(?:remember|save this|store this|note that)\b/i.test(prompt)) {
    return "explicit_memory";
  }
  if (correctionPattern.test(prompt)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
