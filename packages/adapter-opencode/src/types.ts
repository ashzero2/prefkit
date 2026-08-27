import type { ConfigLoadResult } from "@prefkit/core";

export interface OpenCodeAdapterOptions {
  enabled?: boolean;
  injectContext?: boolean;
  configPath?: string;
  includeWhy?: boolean;
  minConfidence?: number;
  limit?: number;
  queueEvents?: boolean;
  queueDir?: string;
  queueWeakEvents?: boolean;
  maxPromptChars?: number;
  prefkitCommand?: string;
  prefkitArgs?: string[];
  contextTimeoutMs?: number;
  notifyOnInjection?: OpenCodeNotificationMode;
  notificationDurationMs?: number;
}

export type OpenCodeNotificationMode = "off" | "once-per-session" | "always";

export interface OpenCodeTuiClient {
  tui?: {
    showToast(input: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
    }): Promise<unknown> | unknown;
  };
}

export interface OpenCodeServerPluginInput {
  directory: string;
  worktree: string;
  project?: unknown;
  client?: OpenCodeTuiClient;
}

export interface OpenCodeHooks {
  "chat.message"?: (
    input: OpenCodeChatMessageInput,
    output: OpenCodeChatMessageOutput,
  ) => Promise<void> | void;
  "experimental.chat.system.transform"?: (
    input: OpenCodeSystemTransformInput,
    output: OpenCodeSystemTransformOutput,
  ) => Promise<void> | void;
  "experimental.chat.messages.transform"?: (
    input: OpenCodeMessagesTransformInput,
    output: OpenCodeMessagesTransformOutput,
  ) => Promise<void> | void;
}

export interface OpenCodeChatMessageInput {
  sessionID: string;
  agent?: string;
  messageID?: string;
}

export interface OpenCodeChatMessageOutput {
  message: unknown;
  parts: unknown[];
}

export interface OpenCodeSystemTransformInput {
  sessionID?: string;
  model?: unknown;
}

export interface OpenCodeSystemTransformOutput {
  system: string[];
}

export interface OpenCodeMessagesTransformInput {}

export interface OpenCodeMessagesTransformOutput {
  messages: OpenCodeModelMessage[];
}

export interface OpenCodeModelMessage {
  info: Record<string, unknown>;
  parts: unknown[];
}

export interface OpenCodePluginModule {
  id: string;
  server: (
    input: OpenCodeServerPluginInput,
    options?: Record<string, unknown>,
  ) => Promise<OpenCodeHooks> | OpenCodeHooks;
}

export interface OpenCodeContextEvent {
  sessionID?: string;
  agent?: string;
  system?: unknown[];
  messages?: unknown[];
}

export interface OpenCodePreferenceContextInput {
  event: OpenCodeContextEvent;
  cwd: string;
  options: OpenCodeAdapterOptions;
  loadConfig?: (input: { cwd: string; configPath?: string }) => ConfigLoadResult;
}
