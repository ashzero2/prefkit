#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createPreferenceStore,
  extractPreference,
  loadConfig,
  OllamaModel,
  redactLearnerEvent,
  renderPreferenceContext,
  runDoctor,
  scoreLearnerEvent,
  validateLearnerEvent,
  type ListPreferencesOptions,
  type PreferenceExtractionResult,
  type PreferenceRecord,
  type PreferenceSearchOptions,
  type PreferenceStatus,
  type PreferenceStore,
  type RememberPreferenceInput,
  type ScopeType,
} from "@prefkit/core";
import {
  installOpenCodeAdapter,
  runOpenCodeDoctor,
  type OpenCodeDoctorReport,
  type OpenCodeInstallReport,
} from "./opencode.js";
import { archiveReplayFile, queueFiles } from "./replay.js";
import { runBackgroundWorker } from "./worker.js";

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
  configPath: string | undefined;
  help: boolean;
}

interface ReplayInput {
  queueDir: string;
  limit: number;
  persist: boolean;
  store: PreferenceStore | null;
  config: ReturnType<typeof loadConfig>["config"];
}

interface ReplayFileResult {
  file: string;
  status: string;
  persisted: boolean;
  processed: boolean;
  preferenceId?: string;
  error?: string;
}

interface ReplayReport {
  queueDir: string;
  total: number;
  extracted: number;
  skipped: number;
  persisted: number;
  failed: number;
  files: ReplayFileResult[];
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

  if (args.command === "learn") {
    const eventFile = flagOne(args, "event-file");
    if (eventFile === undefined) {
      throw new Error("learn requires --event-file path.json.");
    }

    const result = await extractPreference(readJsonFile(eventFile), new OllamaModel(loadResult.config.localModel), {
      learning: loadResult.config.learning,
      privacy: loadResult.config.privacy,
      localModel: loadResult.config.localModel,
    });
    const persist = args.flags.has("persist");
    const store = persist ? createPreferenceStore(loadResult.config.store) : null;
    try {
      const persisted = persistLearnResult(result, store);
      printLearnResult(result, {
        persisted: persisted !== null,
        ...(persisted === null ? {} : { preferenceId: persisted.preference.id }),
      });
    } finally {
      store?.close();
    }
    return learnExitCode(result);
  }

  if (args.command === "replay") {
    const queueDir = flagOne(args, "queue-dir") ?? loadResult.config.learning.queuePath;
    const limit = parseNumberFlag(flagOne(args, "limit"), 100);
    const persist = args.flags.has("persist");
    const store = persist ? createPreferenceStore(loadResult.config.store) : null;
    try {
      const report = await replayEvents({
        queueDir,
        limit,
        persist,
        store,
        config: loadResult.config,
      });
      printReplayReport(report);
      return report.failed === 0 ? 0 : 1;
    } finally {
      store?.close();
    }
  }

  if (args.command === "worker") {
    const queueDir = flagOne(args, "queue-dir") ?? loadResult.config.learning.queuePath;
    const intervalMs = parsePositiveIntegerFlag(
      flagOne(args, "interval-ms"),
      loadResult.config.learning.workerPollMs,
    );
    const batchSize = parsePositiveIntegerFlag(
      flagOne(args, "batch-size"),
      loadResult.config.learning.workerBatchSize,
    );

    if (!loadResult.config.learning.enabled || loadResult.config.learning.mode === "off") {
      console.log("PrefKit worker: learning is disabled.");
      return 0;
    }
    if (loadResult.config.learning.mode === "manual") {
      console.log("PrefKit worker: learning mode is manual; use prefkit replay --persist.");
      return 0;
    }

    const store = createPreferenceStore(loadResult.config.store);
    try {
      const result = await runBackgroundWorker({
        queueDir,
        intervalMs,
        batchSize,
        once: args.flags.has("once"),
        processBatch: async () => {
          const report = await replayEvents({
            queueDir,
            limit: batchSize,
            persist: true,
            store,
            config: loadResult.config,
          });
          if (args.flags.has("once") || report.total > 0) {
            printReplayReport(report);
          }
          return report;
        },
        onError: (error) => {
          console.error(`PrefKit worker batch failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      });
      console.log(`PrefKit worker: ${result.status}`);
      if (result.status === "already-running") {
        console.log(`queueDir=${queueDir}`);
      }
      return 0;
    } finally {
      store.close();
    }
  }

  if (args.command === "queue") {
    return queueEventFromStdin(args, loadResult);
  }

  if (args.command === "opencode") {
    return runOpenCodeCommand(args, loadResult);
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

function parsePositiveIntegerFlag(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON event file ${path}: ${message}`);
  }
}

async function replayEvents(input: ReplayInput): Promise<ReplayReport> {
  const files = queueFiles(input.queueDir, input.limit);
  const report: ReplayReport = {
    queueDir: input.queueDir,
    total: files.length,
    extracted: 0,
    skipped: 0,
    persisted: 0,
    failed: 0,
    files: [],
  };
  const model = new OllamaModel(input.config.localModel);

  for (const file of files) {
    try {
      const result = await extractPreference(readJsonFile(file), model, {
        learning: input.config.learning,
        privacy: input.config.privacy,
        localModel: input.config.localModel,
      });
      const persisted = persistLearnResult(result, input.persist ? input.store : null);

      if (result.ok) {
        report.extracted += 1;
      } else if (learnExitCode(result) === 0) {
        report.skipped += 1;
      } else {
        report.failed += 1;
      }
      if (persisted !== null) {
        report.persisted += 1;
      }

      const processable =
        result.ok || result.status === "learning_skipped" || result.status === "input_too_large";
      const processed = input.persist && processable;
      if (processed) {
        archiveReplayFile(file, input.queueDir);
      }

      report.files.push({
        file,
        status: result.status,
        persisted: persisted !== null,
        processed,
        ...(persisted === null ? {} : { preferenceId: persisted.preference.id }),
        ...(result.ok || result.errors.length === 0 ? {} : { error: result.errors[0] }),
      });
    } catch (error) {
      report.failed += 1;
      report.files.push({
        file,
        status: "failed",
        persisted: false,
        processed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

async function queueEventFromStdin(
  args: ParsedArgs,
  loadResult: ReturnType<typeof loadConfig>,
): Promise<number> {
  if (!args.flags.has("stdin-json")) {
    throw new Error("queue requires --stdin-json.");
  }

  const input = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new Error(`queue received invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const validation = validateLearnerEvent(parsed);
  if (!validation.ok) {
    throw new Error(`queue received an invalid learner event: ${validation.errors.join(", ")}`);
  }

  const redacted = redactLearnerEvent(validation.value, loadResult.config.privacy);
  const signal = scoreLearnerEvent(redacted.event, {
    enabled: loadResult.config.learning.enabled,
    mode: loadResult.config.learning.mode,
    minSignalScore: loadResult.config.learning.minSignalScore,
  });
  if (!signal.shouldExtract && !args.flags.has("queue-weak-events")) {
    console.log(`queued=false reason=${signal.skippedReason ?? "signal-below-threshold"} signalScore=${signal.score}`);
    return 0;
  }

  const queueDir = flagOne(args, "queue-dir") ?? loadResult.config.learning.queuePath;
  mkdirSync(queueDir, { recursive: true });
  const path = join(queueDir, eventFileName(new Date(), randomUUID()));
  writeFileSync(path, `${JSON.stringify(redacted.event, null, 2)}\n`, { mode: 0o600 });
  console.log(`queued=true path=${path} signalScore=${signal.score}`);
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function eventFileName(date: Date, id: string): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}-${id}.json`;
}

function learnExitCode(result: PreferenceExtractionResult): number {
  if (result.ok) {
    return 0;
  }
  return result.status === "learning_skipped" || result.status === "input_too_large" ? 0 : 1;
}

function persistLearnResult(
  result: PreferenceExtractionResult,
  store: PreferenceStore | null,
): ReturnType<PreferenceStore["remember"]> | null {
  if (store === null) {
    return null;
  }

  if (!result.ok || !result.confidence.shouldStore || result.extraction.statement === null) {
    return null;
  }

  const supersedingContradiction = result.extraction.contradictions.find(
    (contradiction) => contradiction.action === "supersede_existing" && store.get(contradiction.preferenceId) !== null,
  );

  const rememberInput: RememberPreferenceInput = {
    statement: result.extraction.statement,
    scopeType: result.extraction.scopeType,
    category: result.extraction.category,
    tags: result.extraction.tags,
    confidence: result.confidence.confidence,
    status: result.confidence.status,
    source: "prefkit-learn",
    evidence: {
      sessionId: result.event.sessionId ?? null,
      agent: result.event.agent,
      summary: result.extraction.rationale,
      sourceType: result.extraction.evidenceType,
      polarity: result.extraction.polarity,
      weight: result.confidence.evidenceWeight,
      metadata: {
        model: result.model,
        eventType: result.event.eventType,
        promptTokenEstimate: result.promptTokenEstimate,
        redactions: result.redactions.map((finding) => finding.kind),
        usage: result.usage ?? {},
      },
    },
    metadata: {
      needsConfirmation: result.confidence.needsConfirmation,
      contradictions: result.extraction.contradictions,
      confidenceReasons: result.confidence.reasons.map((reason) => reason.code),
      signalReasons: result.prefilter.reasons.map((reason) => reason.code),
    },
    ...(supersedingContradiction === undefined ? {} : { supersedesId: supersedingContradiction.preferenceId }),
  };

  if (result.extraction.scopeValue !== null) {
    rememberInput.scopeValue = result.extraction.scopeValue;
  }

  return store.remember(rememberInput);
}

function printLearnResult(
  result: PreferenceExtractionResult,
  options: { persisted: boolean; preferenceId?: string },
): void {
  console.log(`PrefKit learn: ${result.status}`);
  if (result.model !== undefined) {
    console.log(`model=${result.model}`);
  }
  if (result.promptTokenEstimate !== undefined) {
    console.log(`promptTokens~=${result.promptTokenEstimate}`);
  }
  if (result.prefilter !== undefined) {
    console.log(
      `signalScore=${result.prefilter.score}/${result.prefilter.threshold} extract=${result.prefilter.shouldExtract}`,
    );
    for (const reason of result.prefilter.reasons) {
      console.log(`- signal ${reason.code} weight=${reason.weight}`);
    }
  }
  if ((result.redactions?.length ?? 0) > 0) {
    console.log(`redactions=${result.redactions?.map((finding) => finding.kind).join(", ")}`);
  }

  if (!result.ok) {
    for (const error of result.errors) {
      console.log(`error=${error}`);
    }
    return;
  }

  console.log(`statement=${result.extraction.statement ?? "none"}`);
  console.log(
    `scope=${result.extraction.scopeType}${result.extraction.scopeValue === null ? "" : `:${result.extraction.scopeValue}`}`,
  );
  console.log(`category=${result.extraction.category}`);
  console.log(`tags=${result.extraction.tags.length === 0 ? "none" : result.extraction.tags.join(", ")}`);
  console.log(`status=${result.confidence.status}`);
  console.log(`confidence=${result.confidence.confidence.toFixed(2)}`);
  console.log(`evidenceWeight=${result.confidence.evidenceWeight}`);
  console.log(`needsConfirmation=${result.confidence.needsConfirmation}`);
  console.log(`persisted=${options.persisted}`);
  if (options.preferenceId !== undefined) {
    console.log(`preferenceId=${options.preferenceId}`);
  }
  if (result.usage !== undefined) {
    console.log(
      `usage=input:${result.usage.inputTokens ?? "unknown"} output:${result.usage.outputTokens ?? "unknown"}`,
    );
  }
  for (const reason of result.confidence.reasons) {
    console.log(`- confidence ${reason.code} weight=${reason.weight}`);
  }
}

function printReplayReport(report: ReplayReport): void {
  console.log(`PrefKit replay: ${report.failed === 0 ? "ok" : "needs attention"}`);
  console.log(`queueDir=${report.queueDir}`);
  console.log(
    `total=${report.total} extracted=${report.extracted} skipped=${report.skipped} persisted=${report.persisted} failed=${report.failed}`,
  );
  for (const file of report.files) {
    const persisted = file.preferenceId === undefined ? String(file.persisted) : `${file.persisted}:${file.preferenceId}`;
    const error = file.error === undefined ? "" : ` error=${file.error}`;
    console.log(`- ${file.file} status=${file.status} persisted=${persisted} processed=${file.processed}${error}`);
  }
}

function runOpenCodeCommand(args: ParsedArgs, loadResult: ReturnType<typeof loadConfig>): number {
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
  if (record.preference.supersedesId !== null) {
    console.log(`supersedes=${record.preference.supersedesId}`);
  }
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
  prefkit review <id> --accept|--reject
  prefkit export --format markdown
  prefkit context --prompt "I need to name an app"
  prefkit learn --event-file event.json [--persist]
  prefkit queue --stdin-json [--queue-dir ~/.prefkit/queue]
  prefkit replay [--queue-dir ~/.prefkit/queue] [--persist] [--limit 100]
    Successful and skipped persisted events move to queue/processed; failures remain for retry.
  prefkit worker [--queue-dir ~/.prefkit/queue] [--interval-ms 5000] [--batch-size 1] [--once]
    Watches the queue and persists learning events in the background. One worker runs per queue.
  prefkit doctor [--config .prefkit.json]
  prefkit opencode install [--write] [--opencode-config opencode.jsonc]
  prefkit opencode doctor [--opencode-config opencode.jsonc]
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
