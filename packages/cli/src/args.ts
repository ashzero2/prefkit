import type { PreferenceStatus, ScopeType } from "@prefkit/core";

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

export function flags(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

export function flagOne(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

export function requiredId(args: ParsedArgs): string {
  const id = args.positionals[0];
  if (id === undefined) {
    throw new Error(`${args.command ?? "command"} requires a preference id.`);
  }
  return id;
}

export function parseScope(value: string): ScopeType {
  if (value === "global" || value === "repository" || value === "path" || value === "task" || value === "agent") {
    return value;
  }
  throw new Error(`Unsupported scope: ${value}`);
}

export function optionalScope(value: string | undefined): ScopeType | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseScope(value);
}

const statuses = ["candidate", "active", "pinned", "suppressed", "superseded", "rejected"] as const;

export function optionalStatus(value: string | undefined): PreferenceStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if ((statuses as readonly string[]).includes(value)) {
    return value as PreferenceStatus;
  }
  throw new Error(`Unsupported status: ${value}`);
}

export function parseNumberFlag(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got: ${value}`);
  }
  return parsed;
}

export function parsePositiveIntegerFlag(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}
