export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
  configPath: string | undefined;
  help: boolean;
}

const valueFlags = new Set([
  "prompt",
  "cwd",
  "path",
  "scope",
  "scope-value",
  "event-file",
  "queue-dir",
  "output",
  "input",
  "format",
  "config",
  "limit",
  "offset",
  "min-confidence",
  "confidence",
  "agent",
  "session",
  "category",
  "tag",
  "evidence",
  "interval-ms",
  "batch-size",
  "max-attempts",
  "opencode-config",
  "adapter-package",
  "prefkit-config",
  "codex-hooks",
]);

const booleanFlags = new Set([
  "help",
  "all",
  "persist",
  "once",
  "why",
  "write",
  "stdin-json",
  "queue-weak-events",
  "reactivate",
  "accept",
  "reject",
  "correction-observed",
  "no-correction",
  "with-context",
  "without-context",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let configPath: string | undefined;
  let help = false;
  let flagsDone = false;
  const positionals: string[] = [];
  const flagsByName = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (!flagsDone && arg === "--") {
      flagsDone = true;
      continue;
    }

    if (!flagsDone && (arg === "--help" || arg === "-h")) {
      help = true;
      continue;
    }

    if (!flagsDone && arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      const parsed =
        equals !== -1
          ? { value: body.slice(equals + 1), consumed: false }
          : takeValue(argv, index, name);

      if (parsed.consumed) {
        index += 1;
      }
      if (name === "config") {
        configPath = parsed.value;
      } else {
        flagsByName.set(name, [...(flagsByName.get(name) ?? []), parsed.value]);
      }
      continue;
    }

    if (command === undefined) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags: flagsByName, configPath, help };
}

function takeValue(argv: string[], index: number, name: string): { value: string; consumed: boolean } {
  if (booleanFlags.has(name)) {
    return { value: "true", consumed: false };
  }

  const next = argv[index + 1];
  if (next === undefined) {
    return { value: "true", consumed: false };
  }

  if (valueFlags.has(name) || !next.startsWith("--")) {
    return { value: next, consumed: true };
  }

  return { value: "true", consumed: false };
}
