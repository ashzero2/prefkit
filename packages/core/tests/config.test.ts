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
      },
    });

    expect(result.sources).toEqual([join(cwd, ".prefkit.json")]);
    expect(result.config.injection.maxTokens).toBe(300);
    expect(result.config.localModel.model).toBe("qwen3:4b");
    expect(result.config.localModel.timeoutMs).toBe(1000);
    expect(result.config.localModel.think).toBe("low");
  });

  it("expands home directory paths", () => {
    expect(expandHome("~/prefs.db")).toContain("/prefs.db");
    expect(expandHome("/tmp/prefs.db")).toBe("/tmp/prefs.db");
  });
});
