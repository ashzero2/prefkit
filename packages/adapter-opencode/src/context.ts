import {
  createPreferenceStore,
  loadConfig as loadPrefKitConfig,
  renderPreferenceContext,
} from "@prefkit/core";
import type { PreferenceSearchOptions } from "@prefkit/core";
import type {
  OpenCodeAdapterOptions,
  OpenCodeContextEvent,
  OpenCodePreferenceContextInput,
} from "./types.js";

const adapterAgent = "opencode";

export function injectOpenCodePreferenceContext(input: OpenCodePreferenceContextInput): void {
  const options = normalizeOptions(input.options);
  if (!options.enabled) {
    return;
  }

  const loadConfig = input.loadConfig ?? loadPrefKitConfig;
  const loadResult = loadConfig(
    options.configPath === undefined ? { cwd: input.cwd } : { cwd: input.cwd, configPath: options.configPath },
  );
  const prompt = extractLatestUserPrompt(input.event);
  if (prompt.trim().length === 0) {
    return;
  }

  const store = createPreferenceStore(loadResult.config.store);
  try {
    const searchOptions: PreferenceSearchOptions = {
      prompt,
      cwd: input.cwd,
      agent: input.event.agent ?? adapterAgent,
      limit: options.limit ?? loadResult.config.injection.maxRules,
      minConfidence: options.minConfidence ?? loadResult.config.injection.minConfidence,
    };
    if (input.event.sessionID !== undefined) {
      searchOptions.sessionId = input.event.sessionID;
    }

    const rendered = renderPreferenceContext(store.search(searchOptions), {
      injection: loadResult.config.injection,
      includeWhy: options.includeWhy ?? loadResult.config.injection.includeWhy,
    });
    appendSystemContext(input.event, rendered.text);
  } finally {
    store.close();
  }
}

export function extractLatestUserPrompt(event: OpenCodeContextEvent): string {
  const messages = event.messages ?? [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageRole(message) !== "user") {
      continue;
    }

    const text = textFromUnknown(message);
    if (text.trim().length > 0) {
      return text;
    }
  }

  return "";
}

export function appendSystemContext(event: OpenCodeContextEvent, text: string): void {
  if (text.trim().length === 0) {
    return;
  }

  if (event.system === undefined) {
    event.system = [];
  }

  const first = event.system[0];
  if (isRecord(first) && "text" in first) {
    event.system.push({ text });
    return;
  }

  event.system.push(text);
}

function normalizeOptions(options: OpenCodeAdapterOptions): Required<Pick<OpenCodeAdapterOptions, "enabled">> &
  Omit<OpenCodeAdapterOptions, "enabled"> {
  return {
    enabled: options.enabled !== false,
    ...options,
  };
}

function messageRole(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const role = message.role;
  return typeof role === "string" ? role : undefined;
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

  const content = value.content;
  if (typeof content === "string" || Array.isArray(content)) {
    return textFromUnknown(content);
  }

  const text = value.text;
  if (typeof text === "string") {
    return text;
  }

  const parts = value.parts;
  if (Array.isArray(parts)) {
    return textFromUnknown(parts);
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
