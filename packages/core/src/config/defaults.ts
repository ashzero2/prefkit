import type { PrefKitConfig } from "./types.js";

export const defaultConfig: PrefKitConfig = {
  store: {
    path: "~/.prefkit/prefs.db",
    wal: true,
    busyTimeoutMs: 5000,
  },
  learning: {
    enabled: true,
    mode: "local",
    minSignalScore: 3,
    globalPromotionThreshold: 8,
    requireConfirmationForGlobal: true,
    queuePath: "~/.prefkit/queue",
    workerPollMs: 5000,
    workerBatchSize: 1,
  },
  localModel: {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:4b",
    temperature: 0,
    timeoutMs: 20000,
    maxInputTokens: 3500,
    maxOutputTokens: 700,
    think: "omit",
  },
  apiModel: {
    enabled: false,
    provider: "openai-compatible",
    baseUrl: "",
    apiKeyEnv: "PREFKIT_API_KEY",
    model: "",
  },
  privacy: {
    redactSecrets: true,
    redactFileContents: "large",
    maxEvidenceChars: 6000,
    allowRemoteLearning: false,
  },
  injection: {
    maxRules: 8,
    maxTokens: 700,
    includeWhy: false,
    minConfidence: 0.45,
    failOpen: true,
  },
};
