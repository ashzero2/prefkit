import * as z from "zod";
import { defaultConfig } from "./defaults.js";
import type { PrefKitConfig } from "./types.js";

export const storeConfigSchema = z.object({
  path: z.string().trim().min(1),
  wal: z.boolean(),
  busyTimeoutMs: z.number().int().nonnegative(),
});

export const learningConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["local", "off", "manual"]),
  minSignalScore: z.number().int().nonnegative(),
  globalPromotionThreshold: z.number().int().positive(),
  requireConfirmationForGlobal: z.boolean(),
  queuePath: z.string().trim().min(1),
  workerPollMs: z.number().int().positive(),
  workerBatchSize: z.number().int().positive(),
  queueMaxAttempts: z.number().int().positive(),
});

export const localModelConfigSchema = z.object({
  provider: z.enum(["ollama"]),
  baseUrl: z.string().trim().min(1),
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2),
  timeoutMs: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  think: z.enum(["omit", "false", "true", "low", "medium", "high", "max"]),
});

export const privacyConfigSchema = z.object({
  redactSecrets: z.boolean(),
  maxEvidenceChars: z.number().int().positive(),
});

export const injectionConfigSchema = z.object({
  maxRules: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  includeWhy: z.boolean(),
  minConfidence: z.number().min(0).max(1),
  includeHeader: z.boolean(),
  usageHalfLifeDays: z.number().nonnegative(),
});

export const metricsConfigSchema = z.object({
  enabled: z.boolean(),
});

export const prefKitConfigSchema = z.object({
  store: storeConfigSchema,
  learning: learningConfigSchema,
  localModel: localModelConfigSchema,
  privacy: privacyConfigSchema,
  injection: injectionConfigSchema,
  metrics: metricsConfigSchema,
});

export interface ConfigValidationResult {
  config: PrefKitConfig;
  warnings: string[];
}

export function validateAndSanitizeConfig(input: unknown): ConfigValidationResult {
  const result = prefKitConfigSchema.safeParse(input);
  if (result.success) {
    return {
      config: result.data,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const sanitized = structuredClone(defaultConfig);
  const inputObj = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  // Walk through each section and field, keeping valid values and falling back to defaults for invalid ones
  for (const issue of result.error.issues) {
    warnings.push(`Config validation warning at ${issue.path.join(".")}: ${issue.message}`);
  }

  // Attempt section-by-section safe parse for maximum resilience
  const sections: Array<keyof PrefKitConfig> = [
    "store",
    "learning",
    "localModel",
    "privacy",
    "injection",
    "metrics",
  ];

  for (const section of sections) {
    const sectionSchema = prefKitConfigSchema.shape[section];
    const sectionData = inputObj[section];
    const sectionResult = sectionSchema.safeParse(sectionData);
    if (sectionResult.success) {
      (sanitized as unknown as Record<string, unknown>)[section] = sectionResult.data;
    } else if (typeof sectionData === "object" && sectionData !== null) {
      const secObj = sectionData as Record<string, unknown>;
      const targetSec = sanitized[section] as unknown as Record<string, unknown>;
      const shape = (sectionSchema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
      for (const [key, fieldSchema] of Object.entries(shape)) {
        if (key in secObj) {
          const val = secObj[key];
          const fieldResult = fieldSchema.safeParse(val);
          if (fieldResult.success) {
            targetSec[key] = fieldResult.data;
          }
        }
      }
    }
  }

  return {
    config: sanitized,
    warnings,
  };
}
