export type LearningMode = "local" | "off" | "manual";
export type LocalModelProvider = "ollama";
export type LocalModelThinkMode = "omit" | "false" | "true" | "low" | "medium" | "high" | "max";

export interface StoreConfig {
  path: string;
  wal: boolean;
  busyTimeoutMs: number;
}

export interface LearningConfig {
  enabled: boolean;
  mode: LearningMode;
  minSignalScore: number;
  globalPromotionThreshold: number;
  requireConfirmationForGlobal: boolean;
  queuePath: string;
  workerPollMs: number;
  workerBatchSize: number;
  queueMaxAttempts: number;
}

export interface LocalModelConfig {
  provider: LocalModelProvider;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  think: LocalModelThinkMode;
}

export interface PrivacyConfig {
  redactSecrets: boolean;
  maxEvidenceChars: number;
}

export interface InjectionConfig {
  maxRules: number;
  maxTokens: number;
  includeWhy: boolean;
  minConfidence: number;
  /** Prepend a "apply these preferences" reminder before the rule list. */
  includeHeader: boolean;
  /** Half-life in days for the retrieval usage boost. 0 disables it. */
  usageHalfLifeDays: number;
}

export interface MetricsConfig {
  enabled: boolean;
}

export interface PrefKitConfig {
  store: StoreConfig;
  learning: LearningConfig;
  localModel: LocalModelConfig;
  privacy: PrivacyConfig;
  injection: InjectionConfig;
  metrics: MetricsConfig;
}

export interface ConfigLoadResult {
  config: PrefKitConfig;
  sources: string[];
  warnings: string[];
}
