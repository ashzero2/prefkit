import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultConfig } from "./defaults.js";
import type { ConfigLoadResult, PrefKitConfig } from "./types.js";

type JsonObject = Record<string, unknown>;

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

export function loadConfig(options: LoadConfigOptions = {}): ConfigLoadResult {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const sources: string[] = [];

  let config = cloneConfig(defaultConfig);

  const candidates = configCandidates(cwd, options.configPath, env);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      if (!isJsonObject(parsed)) {
        warnings.push(`Ignored ${candidate}: expected a JSON object.`);
        continue;
      }

      config = mergeConfig(config, parsed);
      sources.push(candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Ignored ${candidate}: ${message}`);
    }
  }

  config = applyEnv(config, env);
  config.store.path = expandHome(config.store.path);
  config.learning.queuePath = expandHome(config.learning.queuePath);

  return {
    config,
    sources,
    warnings,
  };
}

function configCandidates(
  cwd: string,
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const explicit = explicitPath ?? env.PREFKIT_CONFIG;
  const candidates: string[] = [];

  if (explicit && explicit.trim().length > 0) {
    candidates.push(resolvePath(cwd, explicit));
  }

  candidates.push(resolve(cwd, ".prefkit.json"));
  candidates.push(join(homedir(), ".config", "prefkit", "config.json"));
  return dedupe(candidates);
}

function resolvePath(cwd: string, value: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function applyEnv(config: PrefKitConfig, env: NodeJS.ProcessEnv): PrefKitConfig {
  const next = cloneConfig(config);

  if (env.PREFKIT_STORE) {
    next.store.path = env.PREFKIT_STORE;
  }
  if (env.PREFKIT_LEARNER) {
    next.learning.mode = parseLearningMode(env.PREFKIT_LEARNER, next.learning.mode);
  }
  if (env.PREFKIT_OLLAMA_BASE_URL) {
    next.localModel.baseUrl = env.PREFKIT_OLLAMA_BASE_URL;
  }
  if (env.PREFKIT_OLLAMA_MODEL) {
    next.localModel.model = env.PREFKIT_OLLAMA_MODEL;
  }
  if (env.PREFKIT_MODEL_TEMPERATURE) {
    next.localModel.temperature = parseNumber(
      env.PREFKIT_MODEL_TEMPERATURE,
      next.localModel.temperature,
    );
  }
  if (env.PREFKIT_MODEL_TIMEOUT_MS) {
    next.localModel.timeoutMs = parseNumber(
      env.PREFKIT_MODEL_TIMEOUT_MS,
      next.localModel.timeoutMs,
    );
  }
  if (env.PREFKIT_MODEL_THINK) {
    next.localModel.think = parseLocalModelThinkMode(env.PREFKIT_MODEL_THINK, next.localModel.think);
  }
  if (env.PREFKIT_REDACT_SECRETS) {
    next.privacy.redactSecrets = parseBoolean(
      env.PREFKIT_REDACT_SECRETS,
      next.privacy.redactSecrets,
    );
  }
  if (env.PREFKIT_API_BASE_URL) {
    next.apiModel.baseUrl = env.PREFKIT_API_BASE_URL;
  }
  if (env.PREFKIT_API_MODEL) {
    next.apiModel.model = env.PREFKIT_API_MODEL;
  }

  return next;
}

function mergeConfig(base: PrefKitConfig, patch: JsonObject): PrefKitConfig {
  return {
    store: {
      ...base.store,
      ...objectPatch(patch.store),
    },
    learning: {
      ...base.learning,
      ...objectPatch(patch.learning),
    },
    localModel: {
      ...base.localModel,
      ...objectPatch(patch.localModel),
    },
    apiModel: {
      ...base.apiModel,
      ...objectPatch(patch.apiModel),
    },
    privacy: {
      ...base.privacy,
      ...objectPatch(patch.privacy),
    },
    injection: {
      ...base.injection,
      ...objectPatch(patch.injection),
    },
  };
}

function objectPatch(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLearningMode(
  value: string,
  fallback: PrefKitConfig["learning"]["mode"],
): PrefKitConfig["learning"]["mode"] {
  if (value === "local" || value === "api" || value === "off" || value === "manual") {
    return value;
  }

  return fallback;
}

function parseLocalModelThinkMode(
  value: string,
  fallback: PrefKitConfig["localModel"]["think"],
): PrefKitConfig["localModel"]["think"] {
  if (
    value === "omit" ||
    value === "false" ||
    value === "true" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  ) {
    return value;
  }

  return fallback;
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string, fallback: boolean): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function cloneConfig(config: PrefKitConfig): PrefKitConfig {
  return structuredClone(config);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
