#!/usr/bin/env node
import { loadConfig, runDoctor } from "@prefkit/core";

interface ParsedArgs {
  command: string | undefined;
  configPath: string | undefined;
  help: boolean;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || args.command === undefined) {
    printHelp();
    return 0;
  }

  if (args.command === "doctor") {
    const loadResult = loadConfig(args.configPath === undefined ? {} : { configPath: args.configPath });
    const report = await runDoctor(loadResult);
    printDoctor(report);
    return report.ok ? 0 : 1;
  }

  console.error("Unknown command: " + args.command);
  printHelp();
  return 1;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let configPath: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--config requires a path");
      }
      configPath = value;
      index += 1;
      continue;
    }

    if (command === undefined) {
      command = arg;
      continue;
    }
  }

  return { command, configPath, help };
}

function printDoctor(report: Awaited<ReturnType<typeof runDoctor>>): void {
  console.log("PrefKit doctor: " + (report.ok ? "ok" : "needs attention"));
  for (const check of report.checks) {
    console.log((check.ok ? "✓" : "✗") + " " + check.name + ": " + check.message);
  }
}

function printHelp(): void {
  console.log(`PrefKit

Usage:
  prefkit doctor [--config .prefkit.json]

Phase 0 commands:
  doctor    Check config, storage path, and local model reachability.
`);
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
