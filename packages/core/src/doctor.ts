import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigLoadResult } from "./config/types.js";
import { OllamaModel } from "./model/ollama.js";
import type { ModelHealth } from "./model/types.js";
import { createPreferenceStore, storeExists } from "./store/sqlite.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(loadResult: ConfigLoadResult): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const { config } = loadResult;

  checks.push({
    name: "config",
    ok: loadResult.warnings.length === 0,
    message:
      loadResult.warnings.length === 0
        ? sourceMessage(loadResult.sources)
        : loadResult.warnings.join(" "),
  });

  const storeDirectoryExists = existsSync(dirname(config.store.path));
  checks.push({
    name: "store-directory",
    ok: storeDirectoryExists,
    message: storeDirectoryExists
      ? `Store directory exists: ${dirname(config.store.path)}`
      : `Store directory does not exist yet: ${dirname(config.store.path)}. Run prefkit init.`,
  });

  checks.push(storeCheck(config.store));
  checks.push(await localModelCheck(config.localModel));

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function storeCheck(config: ConfigLoadResult["config"]["store"]): DoctorCheck {
  if (!storeExists(config)) {
    return {
      name: "store",
      ok: false,
      message: `Preference database does not exist yet: ${config.path}. Run prefkit init.`,
    };
  }

  const store = createPreferenceStore(config);
  try {
    store.init();
    return {
      name: "store",
      ok: true,
      message: `Preference database is readable: ${config.path}`,
    };
  } catch (error) {
    return {
      name: "store",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store.close();
  }
}

async function localModelCheck(config: ConfigLoadResult["config"]["localModel"]): Promise<DoctorCheck> {
  if (config.provider !== "ollama") {
    return {
      name: "local-model",
      ok: false,
      message: `Unsupported local model provider in Phase 0: ${config.provider}`,
    };
  }

  const health: ModelHealth = await new OllamaModel(config).health();
  return {
    name: "local-model",
    ok: health.ok,
    message: `${health.provider}:${health.model} - ${health.message}${
      health.latencyMs === undefined ? "" : ` (${health.latencyMs} ms)`
    }`,
  };
}

function sourceMessage(sources: string[]): string {
  if (sources.length === 0) {
    return "Using built-in defaults and environment variables.";
  }

  return `Loaded config from ${sources.join(", ")}`;
}
