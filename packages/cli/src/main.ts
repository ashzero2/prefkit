#!/usr/bin/env node
import { loadConfig, runDoctor } from "@prefkit/core";
import { runStdioServer } from "@prefkit/mcp";
import { runCodexCommand, runOpenCodeCommand } from "./adapter-commands.js";
import { parseArgs } from "./args.js";
import { runContextCommand } from "./context.js";
import { runLearnCommand, runQueueCommand, runReplayCommand, runWorkerCommand } from "./learn.js";
import { printDoctor, printHelp } from "./output.js";
import { runBackupCommand, runPreferencesCommand } from "./preferences.js";

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || args.command === undefined) {
    printHelp();
    return 0;
  }

  const loadResult = loadConfig(args.configPath === undefined ? {} : { configPath: args.configPath });

  switch (args.command) {
    case "doctor": {
      const report = await runDoctor(loadResult);
      printDoctor(report);
      return report.ok ? 0 : 1;
    }
    case "learn":
      return runLearnCommand(args, loadResult);
    case "replay":
      return runReplayCommand(args, loadResult);
    case "worker":
      return runWorkerCommand(args, loadResult);
    case "queue":
      return runQueueCommand(args, loadResult);
    case "opencode":
      return runOpenCodeCommand(args, loadResult);
    case "codex":
      return runCodexCommand(args, loadResult);
    case "backup":
      return runBackupCommand(args, loadResult);
    case "context":
      return runContextCommand(args, loadResult);
    case "mcp":
      await runStdioServer(args.configPath === undefined ? {} : { configPath: args.configPath });
      return 0;
    default:
      return runPreferencesCommand(args, loadResult);
  }
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
