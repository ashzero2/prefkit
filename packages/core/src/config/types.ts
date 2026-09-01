export type LearningMode = "local" | "api" | "off" | "manual";
export type LocalModelProvider = "ollama" | "openai-compatible" | "mock";
export type LocalModelThinkMode = "omit" | "false" | "true" | "low" | "medium" | "high" | "max";
export type RemoteModelProvider = "openai-compatible";
export type RedactFileContentsMode = "never" | "large" | "always";

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

export interface ApiModelConfig {
  enabled: boolean;
  provider: RemoteModelProvider;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
}

export interface PrivacyConfig {
  redactSecrets: boolean;
  redactFileContents: RedactFileContentsMode;
  maxEvidenceChars: number;
  allowRemoteLearning: boolean;
}

export interface InjectionConfig {
  maxRules: number;
  maxTokens: number;
  includeWhy: boolean;
  minConfidence: number;
  failOpen: boolean;
}

export interface PrefKitConfig {
  store: StoreConfig;
  learning: LearningConfig;
  localModel: LocalModelConfig;
  apiModel: ApiModelConfig;
  privacy: PrivacyConfig;
  injection: InjectionConfig;
}

export interface ConfigLoadResult {
  config: PrefKitConfig;
  sources: string[];
  warnings: string[];
}
