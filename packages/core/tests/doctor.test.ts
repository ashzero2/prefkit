import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPreferenceStore, defaultConfig, runDoctor, type ConfigLoadResult } from "../src/index.js";

function loadResult(
  storePath: string,
  learning: { enabled: boolean; mode: "local" | "off" | "manual" },
): ConfigLoadResult {
  return {
    sources: [],
    warnings: [],
    config: {
      ...defaultConfig,
      store: { ...defaultConfig.store, path: storePath },
      learning: { ...defaultConfig.learning, ...learning },
      localModel: { ...defaultConfig.localModel, baseUrl: "http://127.0.0.1:1", timeoutMs: 300 },
    },
  };
}

function seededStorePath(): string {
  const storePath = join(mkdtempSync(join(tmpdir(), "prefkit-doctor-")), "prefs.db");
  const store = createPreferenceStore({ ...defaultConfig.store, path: storePath });
  store.close();
  return storePath;
}

describe("runDoctor", () => {
  it("does not fail on an unreachable model when learning is disabled", async () => {
    const report = await runDoctor(loadResult(seededStorePath(), { enabled: false, mode: "off" }));

    expect(report.checks.some((check) => check.name === "local-model")).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("fails on an unreachable model when learning is enabled", async () => {
    const report = await runDoctor(loadResult(seededStorePath(), { enabled: true, mode: "local" }));

    expect(report.ok).toBe(false);
  });
});
