import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigLoadResult } from "./config/types.js";
import { OllamaModel } from "./model/ollama.js";
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
  const { config } = loadResult;

  const critical: DoctorCheck[] = [
    {
      name: "config",
      ok: loadResult.warnings.length === 0,
      message:
        loadResult.warnings.length === 0 ? sourceMessage(loadResult.sources) : loadResult.warnings.join(" "),
    },
    storeDirectoryCheck(config),
    storeCheck(config.store),
  ];

  const modelCheck = await localModelCheck(config.localModel);
  const modelRequired = config.learning.enabled && config.learning.mode !== "off";

  return {
    ok: critical.every((check) => check.ok) && (!modelRequired || modelCheck.ok),
    checks: [...critical, modelCheck],
  };
}

function storeDirectoryCheck(config: ConfigLoadResult["config"]): DoctorCheck {
  const directory = dirname(config.store.path);
  const exists = existsSync(directory);
  return {
    name: "store-directory",
    ok: exists,
    message: exists
      ? `Store directory exists: ${directory}`
      : `Store directory does not exist yet: ${directory}. Run prefkit init.`,
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
  const health = await new OllamaModel(config).health();
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
