import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, type ConfigLoadResult, type DoctorCheck } from "@prefkit/core";
import { discoverOpenCodeConfigPaths, installOpenCodeAdapter, runOpenCodeDoctor } from "../src/opencode.js";

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
        "plugin": [
          [
            "./prefkit-adapter.ts",
            {
              "enabled": true,
              "queueEvents": true,
            },
          ],
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
        plugin: [
          [
            "./adapter-opencode.ts",
            {
              enabled: false,
            },
          ],
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

  it("still accepts beta plugins object entries", () => {
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
            options: { enabled: true },
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
    expect(check(report, "plugin-entry")?.ok).toBe(true);
    expect(check(report, "opencode-config-style")?.ok).toBe(false);
  });

  it("flags object entries under the current plugin key", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-doctor-"));
    const adapterPath = join(cwd, "adapter-opencode.ts");
    const configPath = join(cwd, "opencode.jsonc");
    writeFileSync(adapterPath, "export default {}\n");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: [
          {
            package: "./adapter-opencode.ts",
            options: { enabled: true },
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
    expect(check(report, "plugin-entry")?.ok).toBe(false);
    expect(check(report, "opencode-config-style")?.message).toContain("plugin.0 is an object");
  });
});

describe("OpenCode install", () => {
  it("accepts the publishable OpenCode package", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-install-"));
    const report = installOpenCodeAdapter({ cwd, adapterPackage: "@prefkit/opencode" });

    expect(report.snippet).toContain('"@prefkit/opencode"');
  });

  it("generates a config snippet without writing by default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-install-"));
    const targetPath = join(cwd, ".opencode", "opencode.jsonc");

    const report = installOpenCodeAdapter({
      cwd,
      adapterPackage: "./prefkit.ts",
      prefkitConfigPath: "./.prefkit.json",
      queueDir: "./.prefkit/queue",
    });

    expect(report.ok).toBe(false);
    expect(report.wrote).toBe(false);
    expect(report.targetPath).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(false);
    expect(report.snippet).toContain("\"plugin\": [");
    expect(report.snippet).toContain("\"./prefkit.ts\"");
    expect(report.snippet).toContain("\"configPath\": \"./.prefkit.json\"");
    expect(report.snippet).toContain("\"queueDir\": \"./.prefkit/queue\"");
  });

  it("writes a missing project-local config when requested", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-install-"));
    const adapterPath = join(cwd, "prefkit.ts");
    writeFileSync(adapterPath, "export default {}\n");

    const report = installOpenCodeAdapter({
      cwd,
      adapterPackage: "../prefkit.ts",
      write: true,
    });

    expect(report.ok).toBe(true);
    expect(report.wrote).toBe(true);
    expect(existsSync(report.targetPath)).toBe(true);
    const config = readFileSync(report.targetPath, "utf8");
    expect(config).toContain("\"$schema\": \"https://opencode.ai/config.json\"");
    expect(config).toContain("\"plugin\": [");
    expect(config).toContain("\"../prefkit.ts\"");
  });

  it("does not write when a local adapter path is missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-install-"));
    const report = installOpenCodeAdapter({
      cwd,
      adapterPackage: "../missing-prefkit.ts",
      write: true,
    });

    expect(report.ok).toBe(false);
    expect(report.wrote).toBe(false);
    expect(existsSync(report.targetPath)).toBe(false);
    expect(check(report, "adapter-package")?.ok).toBe(false);
  });

  it("does not rewrite existing OpenCode config files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-install-"));
    const configPath = join(cwd, "opencode.jsonc");
    writeFileSync(configPath, "{\n  \"model\": \"openai/test\"\n}\n");

    const report = installOpenCodeAdapter({
      cwd,
      adapterPackage: "@prefkit/adapter-opencode",
      write: true,
    });

    expect(report.ok).toBe(false);
    expect(report.wrote).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("{\n  \"model\": \"openai/test\"\n}\n");
    expect(report.message).toContain("already exists");
  });

  it("does not rewrite an existing config with an active prefkit entry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-install-"));
    const configPath = join(cwd, "opencode.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ["@prefkit/adapter-opencode"],
      }),
    );

    const report = installOpenCodeAdapter({
      cwd,
      adapterPackage: "@prefkit/adapter-opencode",
      write: true,
    });

    expect(report.ok).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.message).toContain("already contains");
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

function check(report: { checks: DoctorCheck[] }, name: string) {
  return report.checks.find((item) => item.name === name);
}
