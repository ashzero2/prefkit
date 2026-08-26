import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, type ConfigLoadResult } from "@prefkit/core";
import { discoverOpenCodeConfigPaths, runOpenCodeDoctor } from "../src/opencode.js";

describe("OpenCode doctor", () => {
  it("discovers explicit config paths only when provided", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-doctor-"));
    const explicit = join(cwd, "custom.jsonc");

    expect(discoverOpenCodeConfigPaths(cwd, explicit, {})).toEqual([explicit]);
  });

  it("accepts JSONC plugin config with local adapter path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-doctor-"));
    const adapterPath = join(cwd, "prefkit-adapter.ts");
    const configPath = join(cwd, "opencode.jsonc");
    writeFileSync(adapterPath, "export default {}\n");
    writeFileSync(
      configPath,
      `{
        // OpenCode supports JSONC config.
        "plugins": [
          {
            "package": "./prefkit-adapter.ts",
            "options": {
              "enabled": true,
              "queueEvents": true,
            },
          },
        ],
      }\n`,
    );

    const report = runOpenCodeDoctor(loadResult(cwd), {
      cwd,
      opencodeConfigPath: configPath,
      adapterPackage: "./prefkit-adapter.ts",
      env: {},
    });

    expect(report.ok).toBe(true);
    expect(check(report, "plugin-entry")?.ok).toBe(true);
    expect(check(report, "adapter-package")?.message).toContain(adapterPath);
  });

  it("fails when the prefkit plugin is disabled by options", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-doctor-"));
    const adapterPath = join(cwd, "adapter-opencode.ts");
    const configPath = join(cwd, "opencode.jsonc");
    writeFileSync(adapterPath, "export default {}\n");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [
          {
            package: "./adapter-opencode.ts",
            options: { enabled: false },
          },
        ],
      }),
    );

    const report = runOpenCodeDoctor(loadResult(cwd), {
      cwd,
      opencodeConfigPath: configPath,
      env: {},
    });

    expect(report.ok).toBe(false);
    expect(check(report, "plugin-options")?.message).toContain("enabled=false");
  });

  it("fails when no opencode config is present", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-doctor-"));
    const report = runOpenCodeDoctor(loadResult(cwd), {
      cwd,
      opencodeConfigPath: join(cwd, "missing.jsonc"),
      env: {},
    });

    expect(report.ok).toBe(false);
    expect(check(report, "opencode-config")?.ok).toBe(false);
    expect(check(report, "plugin-entry")?.ok).toBe(false);
  });

  it("accepts a locally discovered .opencode plugin", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-doctor-"));
    const pluginDir = join(cwd, ".opencode", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "prefkit.ts"), "export default {}\n");

    const report = runOpenCodeDoctor(loadResult(cwd), { cwd, env: {} });

    expect(report.ok).toBe(true);
    expect(check(report, "opencode-config")?.ok).toBe(true);
    expect(check(report, "plugin-entry")?.message).toContain("prefkit.ts");
  });
});

function loadResult(queueParent: string): ConfigLoadResult {
  const queuePath = join(queueParent, "queue");
  mkdirSync(queueParent, { recursive: true });
  return {
    sources: [],
    warnings: [],
    config: {
      ...defaultConfig,
      learning: {
        ...defaultConfig.learning,
        queuePath,
      },
    },
  };
}

function check(report: ReturnType<typeof runOpenCodeDoctor>, name: string) {
  return report.checks.find((item) => item.name === name);
}
