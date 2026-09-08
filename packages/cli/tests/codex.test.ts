import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, type ConfigLoadResult, type DoctorCheck } from "@prefkit/core";
import { codexAgentsMdSnippet, discoverCodexHooksPaths, installCodexAdapter, runCodexDoctor } from "../src/codex.js";

describe("Codex doctor", () => {
  it("discovers explicit hooks paths only when provided", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-codex-doctor-"));
    const explicit = join(cwd, "custom-hooks.json");

    expect(discoverCodexHooksPaths(cwd, explicit, {})).toEqual([explicit]);
  });

  it("resolves the default hooks path under CODEX_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "prefkit-codex-home-"));

    expect(discoverCodexHooksPaths(home, undefined, { HOME: home })).toEqual([join(home, ".codex", "hooks.json")]);
  });

  it("reports missing hooks before install", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-codex-doctor-"));
    const home = mkdtempSync(join(tmpdir(), "prefkit-codex-home-"));

    const report = runCodexDoctor(loadResult(cwd), { cwd, env: { HOME: home } });

    expect(report.ok).toBe(false);
    expect(check(report, "codex-hooks")?.ok).toBe(false);
  });

  it("passes after install --write and stays idempotent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-codex-doctor-"));
    const home = mkdtempSync(join(tmpdir(), "prefkit-codex-home-"));
    const env = { HOME: home };

    const first = installCodexAdapter({ cwd, write: true, env });
    expect(first.ok).toBe(true);
    expect(first.wrote).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);

    const doctor = runCodexDoctor(loadResult(cwd), { cwd, env });
    expect(doctor.ok).toBe(true);
    expect(check(doctor, "codex-hooks")?.ok).toBe(true);

    const second = installCodexAdapter({ cwd, write: true, env });
    expect(second.ok).toBe(true);
    expect(second.wrote).toBe(false);
    expect(second.message).toContain("already contain");
  });

  it("preserves unrelated user hooks when merging", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-codex-doctor-"));
    const home = mkdtempSync(join(tmpdir(), "prefkit-codex-home-"));
    const env = { HOME: home };
    const target = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }),
    );

    const report = installCodexAdapter({ cwd, write: true, env });

    expect(report.ok).toBe(true);
    expect(report.wrote).toBe(true);
    const merged = JSON.parse(readFileSync(target, "utf8")) as { hooks: Record<string, unknown[]> };
    expect(merged.hooks.Stop).toHaveLength(1);
    expect(merged.hooks.UserPromptSubmit).toHaveLength(2);
  });

  it("refuses to modify unparseable hooks files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-codex-doctor-"));
    const home = mkdtempSync(join(tmpdir(), "prefkit-codex-home-"));
    const env = { HOME: home };
    const target = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(target, "not json");

    const report = installCodexAdapter({ cwd, write: true, env });

    expect(report.ok).toBe(false);
    expect(report.wrote).toBe(false);
  });

  it("prints a snippet without writing by default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-codex-doctor-"));
    const home = mkdtempSync(join(tmpdir(), "prefkit-codex-home-"));

    const report = installCodexAdapter({ cwd, env: { HOME: home } });

    expect(report.ok).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.snippet).toContain("prefkit-context.mjs");
    expect(report.snippet).toContain("prefkit-learn.mjs");
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  });

  it("provides a static AGENTS.md fallback snippet", () => {
    expect(codexAgentsMdSnippet()).toContain("prefkit context");
    expect(codexAgentsMdSnippet()).toContain("prefkit:managed");
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
