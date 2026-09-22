import type { ConfigLoadResult } from "@prefkit/core";
import { flagOne, type ParsedArgs } from "./args.js";
import {
  codexAgentsMdSnippet,
  installCodexAdapter,
  runCodexDoctor,
  type CodexDoctorReport,
  type CodexInstallReport,
} from "./codex.js";
import {
  installOpenCodeAdapter,
  runOpenCodeDoctor,
  type OpenCodeDoctorReport,
  type OpenCodeInstallReport,
} from "./opencode.js";

export function runOpenCodeCommand(args: ParsedArgs, loadResult: ConfigLoadResult): number {
  const subcommand = args.positionals[0];
  if (subcommand === "install") {
    const opencodeConfigPath = flagOne(args, "opencode-config");
    const adapterPackage = flagOne(args, "adapter-package");
    const prefkitConfigPath = flagOne(args, "prefkit-config") ?? args.configPath;
    const queueDir = flagOne(args, "queue-dir");
    const report = installOpenCodeAdapter({
      cwd: flagOne(args, "cwd") ?? process.cwd(),
      ...(opencodeConfigPath === undefined ? {} : { opencodeConfigPath }),
      ...(adapterPackage === undefined ? {} : { adapterPackage }),
      ...(prefkitConfigPath === undefined ? {} : { prefkitConfigPath }),
      ...(queueDir === undefined ? {} : { queueDir }),
      write: args.flags.has("write"),
    });
    printOpenCodeInstall(report);
    return report.ok ? 0 : 1;
  }

  if (subcommand !== "doctor") {
    console.error(`Unknown OpenCode command: ${subcommand ?? ""}`);
    console.error("Usage: prefkit opencode <doctor|install>");
    return 1;
  }

  const opencodeConfigPath = flagOne(args, "opencode-config");
  const adapterPackage = flagOne(args, "adapter-package");
  const report = runOpenCodeDoctor(loadResult, {
    cwd: flagOne(args, "cwd") ?? process.cwd(),
    ...(opencodeConfigPath === undefined ? {} : { opencodeConfigPath }),
    ...(adapterPackage === undefined ? {} : { adapterPackage }),
  });
  printOpenCodeDoctor(report);
  return report.ok ? 0 : 1;
}

export function runCodexCommand(args: ParsedArgs, loadResult: ConfigLoadResult): number {
  const subcommand = args.positionals[0];
  if (subcommand === "install") {
    const codexHooksPath = flagOne(args, "codex-hooks");
    const report = installCodexAdapter({
      cwd: flagOne(args, "cwd") ?? process.cwd(),
      ...(codexHooksPath === undefined ? {} : { codexHooksPath }),
      write: args.flags.has("write"),
    });
    printCodexInstall(report);
    return report.ok ? 0 : 1;
  }

  if (subcommand !== "doctor") {
    console.error(`Unknown Codex command: ${subcommand ?? ""}`);
    console.error("Usage: prefkit codex <doctor|install>");
    return 1;
  }

  const codexHooksPath = flagOne(args, "codex-hooks");
  const report = runCodexDoctor(loadResult, {
    cwd: flagOne(args, "cwd") ?? process.cwd(),
    ...(codexHooksPath === undefined ? {} : { codexHooksPath }),
  });
  printCodexDoctor(report);
  return report.ok ? 0 : 1;
}

function printOpenCodeInstall(report: OpenCodeInstallReport): void {
  console.log(`PrefKit OpenCode install: ${report.ok ? "ok" : "needs attention"}`);
  console.log(report.message);
  for (const check of report.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`);
  }
  if (!report.wrote) {
    console.log("");
    console.log(report.snippet);
  }
}

function printOpenCodeDoctor(report: OpenCodeDoctorReport): void {
  console.log(`PrefKit OpenCode doctor: ${report.ok ? "ok" : "needs attention"}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`);
  }
}

function printCodexInstall(report: CodexInstallReport): void {
  console.log(`PrefKit Codex install: ${report.ok ? "ok" : "needs attention"}`);
  console.log(report.message);
  for (const check of report.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`);
  }
  if (!report.wrote) {
    console.log("");
    console.log(report.snippet);
    console.log("");
    console.log("Static AGENTS.md fallback (optional, manual):");
    console.log("");
    console.log(codexAgentsMdSnippet());
  }
}

function printCodexDoctor(report: CodexDoctorReport): void {
  console.log(`PrefKit Codex doctor: ${report.ok ? "ok" : "needs attention"}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`);
  }
}
