import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createPreferenceStore,
  expandHome,
  type ConfigLoadResult,
  type ListPreferencesOptions,
  type RememberPreferenceInput,
} from "@prefkit/core";
import {
  flagOne,
  flags,
  optionalScope,
  optionalStatus,
  parseNumberFlag,
  parseScope,
  requiredId,
  type ParsedArgs,
} from "./args.js";
import { printHelp, printList, printMutation, printOutcomeEvaluation, printStats, printWhy } from "./output.js";

export function runPreferencesCommand(args: ParsedArgs, loadResult: ConfigLoadResult): number {
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
        if (args.flags.has("reactivate")) {
          rememberInput.reactivate = true;
        }

        const result = store.remember(rememberInput);
        const { status } = result.preference;
        if (status !== "active" && status !== "pinned") {
          console.log(`Stored as ${status} ${result.preference.id}: ${result.preference.statement}`);
          console.log(
            status === "suppressed" || status === "rejected"
              ? "It will not be injected until revived; re-run with --reactivate to revive it."
              : "It will not be injected while it is not active.",
          );
          return 0;
        }
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
        const scope = optionalScope(flagOne(args, "scope"));
        if (scope !== undefined) {
          listOptions.scope = scope;
        }
        const scopeValue = flagOne(args, "scope-value");
        if (scopeValue !== undefined) {
          listOptions.scopeValue = scopeValue;
        }
        const offset = parseNumberFlag(flagOne(args, "offset"), 0);
        if (offset > 0) {
          listOptions.offset = offset;
        }
        printList(store.list(listOptions));
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
      case "stats": {
        printStats(store.stats());
        return 0;
      }
      case "evaluate": {
        const sessionId = flagOne(args, "session");
        if (sessionId !== undefined) {
          const correctionObserved = args.flags.has("correction-observed");
          const noCorrection = args.flags.has("no-correction");
          if (correctionObserved === noCorrection) {
            throw new Error("evaluate --session requires exactly one of --correction-observed or --no-correction.");
          }

          const withContext = args.flags.has("with-context");
          const withoutContext = args.flags.has("without-context");
          if (withContext && withoutContext) {
            throw new Error("evaluate accepts only one of --with-context or --without-context.");
          }

          store.recordEvaluationOutcome({
            sessionId,
            correctionObserved,
            ...(withContext ? { contextInjected: true } : {}),
            ...(withoutContext ? { contextInjected: false } : {}),
          });
          console.log(`Recorded explicit outcome for session ${sessionId}.`);
          return 0;
        }

        printOutcomeEvaluation(store.evaluateOutcomes());
        return 0;
      }
      case "pin":
        return printMutation("Pinned", store.pin(requiredId(args)));
      case "forget":
        return printMutation("Suppressed", store.forget(requiredId(args)));
      case "review": {
        const accepting = args.flags.has("accept");
        const rejecting = args.flags.has("reject");
        if (accepting === rejecting) {
          throw new Error("review requires exactly one of --accept or --reject.");
        }
        const updated = store.review(requiredId(args), accepting ? "accept" : "reject");
        return printMutation(accepting ? "Accepted" : "Rejected", updated);
      }
      case "export": {
        const format = flagOne(args, "format") ?? "markdown";
        if (format === "json") {
          process.stdout.write(store.exportJson());
          return 0;
        }
        if (format !== "markdown") {
          throw new Error("Supported export formats are markdown and json.");
        }
        process.stdout.write(store.exportMarkdown());
        return 0;
      }
      case "import": {
        const input = flagOne(args, "input");
        if (input === undefined || input.trim().length === 0) {
          throw new Error("import requires --input path.json.");
        }
        const expandedInput = expandHome(input);
        const inputPath = isAbsolute(expandedInput) ? expandedInput : resolve(process.cwd(), expandedInput);
        const report = store.importJson(readFileSync(inputPath, "utf8"));
        console.log(
          `Imported PrefKit JSON: preferences=${report.preferencesImported} skipped=${report.preferencesSkipped} evidence=${report.evidenceImported} conflicts=${report.conflicts}`,
        );
        return report.conflicts === 0 ? 0 : 1;
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

export async function runBackupCommand(args: ParsedArgs, loadResult: ConfigLoadResult): Promise<number> {
  const output = flagOne(args, "output");
  if (output === undefined || output.trim().length === 0) {
    throw new Error("backup requires --output path.");
  }
  const destination = isAbsolute(expandHome(output)) ? expandHome(output) : resolve(process.cwd(), output);
  if (existsSync(destination)) {
    throw new Error(`Backup destination already exists: ${destination}`);
  }
  if (resolve(loadResult.config.store.path) === resolve(destination)) {
    throw new Error("Backup destination must differ from the active store.");
  }

  const store = createPreferenceStore(loadResult.config.store);
  try {
    await store.backup(destination);
    console.log(`Created PrefKit backup: ${destination}`);
    return 0;
  } finally {
    store.close();
  }
}
