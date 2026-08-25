#!/usr/bin/env node
import {
  createPreferenceStore,
  loadConfig,
  renderPreferenceContext,
  runDoctor,
  type ListPreferencesOptions,
  type PreferenceRecord,
  type PreferenceSearchOptions,
  type PreferenceStatus,
  type RememberPreferenceInput,
  type ScopeType,
} from "@prefkit/core";

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
  configPath: string | undefined;
  help: boolean;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || args.command === undefined) {
    printHelp();
    return 0;
  }

  const loadResult = loadConfig(args.configPath === undefined ? {} : { configPath: args.configPath });

  if (args.command === "doctor") {
    const report = await runDoctor(loadResult);
    printDoctor(report);
    return report.ok ? 0 : 1;
  }

  const store = createPreferenceStore(loadResult.config.store);
  try {
    switch (args.command) {
      case "init":
        store.init();
        console.log(`Initialized PrefKit store: ${loadResult.config.store.path}`);
        return 0;
      case "remember": {
        const statement = args.positionals.join(" ").trim();
        if (statement.length === 0) {
          throw new Error("remember requires a preference statement.");
        }
        const rememberInput: RememberPreferenceInput = {
          statement,
          scopeType: parseScope(flagOne(args, "scope") ?? "global"),
          category: flagOne(args, "category") ?? "general",
          tags: flags(args, "tag"),
          confidence: parseNumberFlag(flagOne(args, "confidence"), 1),
          evidence: {
            summary: flagOne(args, "evidence") ?? statement,
            sourceType: "USER_EXPLICIT",
          },
        };
        const scopeValue = flagOne(args, "scope-value");
        if (scopeValue !== undefined) {
          rememberInput.scopeValue = scopeValue;
        }
        const agent = flagOne(args, "agent");
        if (agent !== undefined) {
          rememberInput.evidence = { ...rememberInput.evidence, agent };
        }
        const sessionId = flagOne(args, "session");
        if (sessionId !== undefined) {
          rememberInput.evidence = { ...rememberInput.evidence, sessionId };
        }

        const result = store.remember(rememberInput);
        console.log(`Remembered ${result.preference.id}: ${result.preference.statement}`);
        return 0;
      }
      case "list": {
        const listOptions: ListPreferencesOptions = {
          includeInactive: args.flags.has("all"),
          limit: parseNumberFlag(flagOne(args, "limit"), 100),
        };
        const status = optionalStatus(flagOne(args, "status"));
        if (status !== undefined) {
          listOptions.status = status;
        }
        const preferences = store.list(listOptions);
        printList(preferences);
        return 0;
      }
      case "why": {
        const id = requiredId(args);
        const record = store.get(id);
        if (record === null) {
          console.error(`Preference not found: ${id}`);
          return 1;
        }
        printWhy(record);
        return 0;
      }
      case "pin": {
        const updated = store.pin(requiredId(args));
        return printMutation("Pinned", updated);
      }
      case "forget": {
        const updated = store.forget(requiredId(args));
        return printMutation("Suppressed", updated);
      }
      case "export": {
        const format = flagOne(args, "format") ?? "markdown";
        if (format !== "markdown") {
          throw new Error("Only markdown export is supported in Phase 1.");
        }
        process.stdout.write(store.exportMarkdown());
        return 0;
      }
      case "context": {
        const prompt = flagOne(args, "prompt") ?? args.positionals.join(" ");
        const trimmedPrompt = prompt.trim();
        if (trimmedPrompt.length === 0) {
          throw new Error("context requires --prompt or prompt text.");
        }
        const searchOptions: PreferenceSearchOptions = {
          prompt: trimmedPrompt,
          cwd: flagOne(args, "cwd") ?? process.cwd(),
          limit: parseNumberFlag(flagOne(args, "limit"), loadResult.config.injection.maxRules),
          minConfidence: parseNumberFlag(flagOne(args, "min-confidence"), loadResult.config.injection.minConfidence),
        };
        const searchPath = flagOne(args, "path");
        if (searchPath !== undefined) {
          searchOptions.path = searchPath;
        }
        const searchAgent = flagOne(args, "agent");
        if (searchAgent !== undefined) {
          searchOptions.agent = searchAgent;
        }
        const searchSession = flagOne(args, "session");
        if (searchSession !== undefined) {
          searchOptions.sessionId = searchSession;
        }
        const results = store.search(searchOptions);
        const rendered = renderPreferenceContext(results, {
          injection: loadResult.config.injection,
          includeWhy: args.flags.has("why"),
        });
        process.stdout.write(rendered.text);
        return 0;
      }
      default:
        console.error(`Unknown command: ${args.command}`);
        printHelp();
        return 1;
    }
  } finally {
    store.close();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let configPath: string | undefined;
  let help = false;
  const positionals: string[] = [];
  const flagsByName = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      const takesValue = next !== undefined && !next.startsWith("--");
      const value = takesValue ? next : "true";
      if (takesValue) {
        index += 1;
      }
      if (name === "config") {
        configPath = value;
      } else {
        flagsByName.set(name, [...(flagsByName.get(name) ?? []), value]);
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

function flags(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function flagOne(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function requiredId(args: ParsedArgs): string {
  const id = args.positionals[0];
  if (id === undefined) {
    throw new Error(`${args.command ?? "command"} requires a preference id.`);
  }
  return id;
}

function parseScope(value: string): ScopeType {
  if (value === "global" || value === "repository" || value === "path" || value === "task" || value === "agent") {
    return value;
  }
  throw new Error(`Unsupported scope: ${value}`);
}

function optionalStatus(value: string | undefined): PreferenceStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "candidate" ||
    value === "active" ||
    value === "pinned" ||
    value === "suppressed" ||
    value === "superseded" ||
    value === "rejected"
  ) {
    return value;
  }
  throw new Error(`Unsupported status: ${value}`);
}

function parseNumberFlag(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got: ${value}`);
  }
  return parsed;
}

function printDoctor(report: Awaited<ReturnType<typeof runDoctor>>): void {
  console.log(`PrefKit doctor: ${report.ok ? "ok" : "needs attention"}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`);
  }
}

function printList(preferences: PreferenceRecord[]): void {
  if (preferences.length === 0) {
    console.log("No preferences found.");
    return;
  }

  for (const pref of preferences) {
    console.log(
      `${pref.id}  ${pref.status.padEnd(10)}  ${pref.confidence.toFixed(2)}  ${pref.scopeType.padEnd(10)}  ${
        pref.statement
      }`,
    );
  }
}

function printWhy(record: NonNullable<ReturnType<ReturnType<typeof createPreferenceStore>["get"]>>): void {
  console.log(`${record.preference.id}: ${record.preference.statement}`);
  console.log(`status=${record.preference.status} confidence=${record.preference.confidence.toFixed(2)}`);
  console.log(`scope=${record.preference.scopeType}${record.preference.scopeValue === null ? "" : `:${record.preference.scopeValue}`}`);
  console.log(`category=${record.preference.category} tags=${record.preference.tags.join(", ") || "none"}`);
  console.log("");
  console.log("Evidence:");
  for (const evidence of record.evidence) {
    console.log(`- ${evidence.sourceType} ${evidence.polarity} weight=${evidence.weight}: ${evidence.summary}`);
  }
}

function printMutation(label: string, preference: PreferenceRecord | null): number {
  if (preference === null) {
    console.error("Preference not found.");
    return 1;
  }
  console.log(`${label} ${preference.id}: ${preference.statement}`);
  return 0;
}

function printHelp(): void {
  console.log(`PrefKit

Usage:
  prefkit init [--config .prefkit.json]
  prefkit remember "Prefer concise status updates" [--category communication] [--tag style]
  prefkit list [--all] [--status active] [--limit 20]
  prefkit why <id>
  prefkit pin <id>
  prefkit forget <id>
  prefkit export --format markdown
  prefkit context --prompt "I need to name an app"
  prefkit doctor [--config .prefkit.json]
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
