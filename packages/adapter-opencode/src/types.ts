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
}

export interface OpenCodePluginContext {
  app?: {
    version?: string;
  };
  directory?: string;
  worktree?: string;
  options?: Record<string, unknown>;
  session?: {
    hook?: (
      name: "context",
      callback: (event: OpenCodeContextEvent) => Promise<void> | void,
    ) => Promise<OpenCodeRegistration> | OpenCodeRegistration;
  };
}

export interface OpenCodeRegistration {
  dispose?: () => Promise<void> | void;
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
