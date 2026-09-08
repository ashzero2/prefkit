#!/usr/bin/env node
import { runStdioServer } from "./server.js";

function configPath(argv: string[]): string | undefined {
  const index = argv.indexOf("--config");
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

runStdioServer({ configPath: configPath(process.argv.slice(2)) }).catch((error: unknown) => {
  console.error(`[prefkit-mcp] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
