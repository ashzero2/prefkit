import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandHome, loadConfig } from "../src/index.js";

describe("config loading", () => {
  it("uses defaults when no config file exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-config-"));
    const result = loadConfig({ cwd, env: {} });

    expect(result.sources).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config.localModel.provider).toBe("ollama");
    expect(result.config.injection.maxTokens).toBe(700);
    expect(result.config.learning.queueMaxAttempts).toBe(3);
    expect(result.config.metrics.enabled).toBe(false);
  });

  it("merges project config and environment overrides", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-config-"));
    writeFileSync(
      join(cwd, ".prefkit.json"),
      JSON.stringify({
        injection: { maxTokens: 300 },
        localModel: { model: "llama3.2:3b" },
      }),
    );

    const result = loadConfig({
      cwd,
      env: {
        PREFKIT_OLLAMA_MODEL: "qwen3:4b",
        PREFKIT_MODEL_TIMEOUT_MS: "1000",
        PREFKIT_MODEL_THINK: "low",
        PREFKIT_QUEUE_MAX_ATTEMPTS: "5",
        PREFKIT_METRICS_ENABLED: "true",
      },
    });

    expect(result.sources).toEqual([join(cwd, ".prefkit.json")]);
    expect(result.config.injection.maxTokens).toBe(300);
    expect(result.config.localModel.model).toBe("qwen3:4b");
    expect(result.config.localModel.timeoutMs).toBe(1000);
    expect(result.config.localModel.think).toBe("low");
    expect(result.config.learning.queueMaxAttempts).toBe(5);
    expect(result.config.metrics.enabled).toBe(true);
  });

  it("expands home directory paths", () => {
    expect(expandHome("~/prefs.db")).toContain("/prefs.db");
    expect(expandHome("/tmp/prefs.db")).toBe("/tmp/prefs.db");
  });

  it("prioritizes explicit config over project config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-config-"));
    writeFileSync(
      join(cwd, ".prefkit.json"),
      JSON.stringify({
        injection: { maxTokens: 300 },
      }),
    );

    const customPath = join(cwd, "custom-config.json");
    writeFileSync(
      customPath,
      JSON.stringify({
        injection: { maxTokens: 500 },
      }),
    );

    const result = loadConfig({
      cwd,
      configPath: customPath,
      env: {},
    });

    expect(result.sources).toEqual([join(cwd, ".prefkit.json"), customPath]);
    expect(result.config.injection.maxTokens).toBe(500);
  });

  it("validates and sanitizes invalid config types with actionable warnings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-config-"));
    writeFileSync(
      join(cwd, ".prefkit.json"),
      JSON.stringify({
        store: { wal: "not-a-boolean" },
        learning: { workerPollMs: -100 },
      }),
    );

    const result = loadConfig({ cwd, env: {} });

    expect(result.warnings.some((w) => w.includes("store.wal"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("learning.workerPollMs"))).toBe(true);
    // Falls back to safe defaults
    expect(typeof result.config.store.wal).toBe("boolean");
    expect(result.config.store.wal).toBe(true);
    expect(result.config.learning.workerPollMs).toBeGreaterThan(0);
  });

  it("warns when an explicitly specified config file does not exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-config-"));
    const result = loadConfig({
      cwd,
      configPath: join(cwd, "nonexistent.json"),
      env: {},
    });

    expect(result.warnings.some((w) => w.includes("Specified config file not found"))).toBe(true);
  });
});
