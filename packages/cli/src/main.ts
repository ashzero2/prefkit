#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  createPreferenceStore,
  extractPreference,
  expandHome,
  loadConfig,
  OllamaModel,
  redactLearnerEvent,
  renderPreferenceContext,
  runDoctor,
  scoreLearnerEvent,
  storeExists,
  validateLearnerEvent,
  type CandidatePreferenceContext,
  type ListPreferencesOptions,
  type PreferenceExtractionResult,
  type PreferenceRecord,
  type PreferenceSearchOptions,
  type PreferenceStatus,
  type PreferenceStore,
  type RememberPreferenceInput,
  type ScopeType,
  type StoreConfig,
} from "@prefkit/core";
import {
  installOpenCodeAdapter,
  runOpenCodeDoctor,
  type OpenCodeDoctorReport,
  type OpenCodeInstallReport,
} from "./opencode.js";
import {
  codexAgentsMdSnippet,
  installCodexAdapter,
  runCodexDoctor,
  type CodexDoctorReport,
  type CodexInstallReport,
} from "./codex.js";
import { runStdioServer } from "@prefkit/mcp";
import { archiveReplayFile, queueFiles, recordQueueFailure, writeQueueFile } from "./replay.js";
import { runBackgroundWorker } from "./worker.js";
import { learnExitCode, persistLearnResult } from "./learn.js";
import { parseArgs, type ParsedArgs } from "./args.js";

interface ReplayInput {
  queueDir: string;
  limit: number;
  persist: boolean;
  store: PreferenceStore | null;
  config: ReturnType<typeof loadConfig>["config"];
  maxAttempts: number;
}

interface ReplayFileResult {
  file: string;
  status: string;
  persisted: boolean;
  processed: boolean;
  retryDisposition?: "retrying" | "dead-lettered";
  retryAttempts?: number;
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

    const eventData = readJsonFile(eventFile);
    const persist = args.flags.has("persist");
    const store = persist || storeExists(loadResult.config.store) ? createPreferenceStore(loadResult.config.store) : null;
    const existingPreferences = candidatePreferencesFromStore(store, eventData as Record<string, unknown>);

    const result = await extractPreference(eventData, new OllamaModel(loadResult.config.localModel), {
      learning: loadResult.config.learning,
      privacy: loadResult.config.privacy,
      localModel: loadResult.config.localModel,
      existingPreferences,
    });
    if (result.event?.eventType === "explicit_correction") {
      recordCorrectionMetric(loadResult.config.metrics.enabled, loadResult.config.store, result.event.sessionId);
    }
    try {
      const persisted = persistLearnResult(result, persist ? store : null, loadResult.config.learning);
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
        maxAttempts: parsePositiveIntegerFlag(
          flagOne(args, "max-attempts"),
          loadResult.config.learning.queueMaxAttempts,
        ),
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
            maxAttempts: loadResult.config.learning.queueMaxAttempts,
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

  if (args.command === "codex") {
    return runCodexCommand(args, loadResult);
  }

  if (args.command === "mcp") {
    await runStdioServer(args.configPath === undefined ? {} : { configPath: args.configPath });
    return 0;
  }

  if (args.command === "backup") {
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

  if (args.command === "context") {
    return runContextCommand(args, loadResult);
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
        if (args.flags.has("reactivate")) {
          rememberInput.reactivate = true;
        }

        const result = store.remember(rememberInput);
        const { status } = result.preference;
        if (status !== "active" && status !== "pinned") {
          console.log(
            `Stored as ${status} ${result.preference.id}: ${result.preference.statement}`,
          );
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

function runContextCommand(args: ParsedArgs, loadResult: ReturnType<typeof loadConfig>): number {
  const prompt = (flagOne(args, "prompt") ?? args.positionals.join(" ")).trim();
  if (prompt.length === 0) {
    throw new Error("context requires --prompt or prompt text.");
  }

  if (!storeExists(loadResult.config.store)) {
    return 0;
  }

  const store = createPreferenceStore(loadResult.config.store);
  try {
    const searchOptions: PreferenceSearchOptions = {
      prompt,
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
    if (loadResult.config.metrics.enabled) {
      store.recordContext({
        matchedRules: results.length,
        injectedRules: rendered.included.length,
        tokenEstimate: rendered.tokenEstimate,
        injectedPreferenceIds: rendered.included.map((result) => result.preference.id),
        ...(searchSession === undefined ? {} : { sessionId: searchSession }),
      });
    }
    process.stdout.write(rendered.text);
    return 0;
  } finally {
    store.close();
  }
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

function optionalScope(value: string | undefined): ScopeType | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseScope(value);
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
      const eventData = readJsonFile(file);
      const existingPreferences = candidatePreferencesFromStore(input.store, eventData as Record<string, unknown>);
      const result = await extractPreference(eventData, model, {
        learning: input.config.learning,
        privacy: input.config.privacy,
        localModel: input.config.localModel,
        existingPreferences,
      });
      const persisted = persistLearnResult(result, input.persist ? input.store : null, input.config.learning);

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
      let processed = input.persist && processable;
      let retryDisposition: "retrying" | "dead-lettered" | undefined;
      let retryAttempts: number | undefined;
      if (processed) {
        archiveReplayFile(file, input.queueDir);
      } else if (input.persist && !processable) {
        const retry = recordQueueFailure(file, input.queueDir, input.maxAttempts, result.status === "invalid_event");
        retryDisposition = retry.disposition;
        retryAttempts = retry.attempts;
        processed = retry.disposition === "dead-lettered";
      }

      report.files.push({
        file,
        status: result.status,
        persisted: persisted !== null,
        processed,
        ...(retryDisposition === undefined || retryAttempts === undefined ? {} : { retryDisposition, retryAttempts }),
        ...(persisted === null ? {} : { preferenceId: persisted.preference.id }),
        ...(result.ok || result.errors.length === 0 ? {} : { error: result.errors[0] }),
      });
    } catch (error) {
      report.failed += 1;
      let processed = false;
      let retryDisposition: "retrying" | "dead-lettered" | undefined;
      let retryAttempts: number | undefined;
      let recoveryError: string | undefined;
      if (input.persist) {
        try {
          const retry = recordQueueFailure(file, input.queueDir, input.maxAttempts);
          retryDisposition = retry.disposition;
          retryAttempts = retry.attempts;
          processed = retry.disposition === "dead-lettered";
        } catch (recoveryFailure) {
          recoveryError = `Queue retry handling failed: ${
            recoveryFailure instanceof Error ? recoveryFailure.message : String(recoveryFailure)
          }`;
        }
      }
      report.files.push({
        file,
        status: "failed",
        persisted: false,
        processed,
        ...(retryDisposition === undefined || retryAttempts === undefined ? {} : { retryDisposition, retryAttempts }),
        error: [error instanceof Error ? error.message : String(error), recoveryError].filter(Boolean).join("; "),
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
  if (redacted.event.eventType === "explicit_correction") {
    recordCorrectionMetric(loadResult.config.metrics.enabled, loadResult.config.store, redacted.event.sessionId);
  }
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
  const fileName = eventFileName(new Date(), randomUUID());
  const queuedPath = writeQueueFile(queueDir, fileName, `${JSON.stringify(redacted.event, null, 2)}\n`);
  console.log(`queued=true path=${queuedPath} signalScore=${signal.score}`);
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

function recordCorrectionMetric(metricsEnabled: boolean, storeConfig: StoreConfig, sessionId: string | undefined): void {
  if (!metricsEnabled) {
    return;
  }

  const metricStore = createPreferenceStore(storeConfig);
  try {
    metricStore.recordCorrection(sessionId === undefined ? {} : { sessionId });
  } finally {
    metricStore.close();
  }
}

function candidatePreferencesFromStore(
  store: PreferenceStore | null,
  event: Record<string, unknown>,
): CandidatePreferenceContext[] {
  if (store === null) {
    return [];
  }
  const prompt = typeof event.userPrompt === "string" ? event.userPrompt.trim() : "";
  if (prompt.length === 0) {
    return [];
  }
  try {
    const searchOptions: PreferenceSearchOptions = {
      prompt,
      limit: 5,
      ...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}),
      ...(typeof event.agent === "string" ? { agent: event.agent } : {}),
      ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
    };
    const results = store.search(searchOptions);
    return results.map((result) => ({
      id: result.preference.id,
      statement: result.preference.statement,
      scopeType: result.preference.scopeType,
      scopeValue: result.preference.scopeValue,
      confidence: result.preference.confidence,
    }));
  } catch {
    return [];
  }
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
    const retry = file.retryDisposition === undefined ? "" : ` retry=${file.retryDisposition}:${file.retryAttempts}`;
    const error = file.error === undefined ? "" : ` error=${file.error}`;
    console.log(`- ${file.file} status=${file.status} persisted=${persisted} processed=${file.processed}${retry}${error}`);
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

function runCodexCommand(args: ParsedArgs, loadResult: ReturnType<typeof loadConfig>): number {
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

function printStats(stats: ReturnType<ReturnType<typeof createPreferenceStore>["stats"]>): void {
  console.log("PrefKit stats");
  console.log(`preferences=${stats.preferences.total}`);
  for (const [status, count] of Object.entries(stats.preferences.byStatus)) {
    console.log(`preferences.${status}=${count}`);
  }
  console.log(`evidence=${stats.evidence.total}`);
  for (const [sourceType, count] of Object.entries(stats.evidence.bySourceType)) {
    console.log(`evidence.source.${sourceType}=${count}`);
  }
  for (const [polarity, count] of Object.entries(stats.evidence.byPolarity)) {
    console.log(`evidence.polarity.${polarity}=${count}`);
  }
  console.log(`metrics.contextRequests=${stats.metrics.contextRequests}`);
  console.log(`metrics.contextMatches=${stats.metrics.contextMatches}`);
  console.log(`metrics.contextHits=${stats.metrics.contextHits}`);
  console.log(`metrics.contextHitRate=${stats.metrics.contextHitRate.toFixed(4)}`);
  console.log(`metrics.contextInjectedRules=${stats.metrics.contextInjectedRules}`);
  console.log(`metrics.contextInjectedTokens=${stats.metrics.contextInjectedTokens}`);
  console.log(`metrics.correctionsAfterContext=${stats.metrics.correctionsAfterContext}`);
  console.log(`metrics.correctionsWithoutContext=${stats.metrics.correctionsWithoutContext}`);
}

function printOutcomeEvaluation(evaluation: ReturnType<ReturnType<typeof createPreferenceStore>["evaluateOutcomes"]>): void {
  console.log(`PrefKit outcome evaluation: ${evaluation.status}`);
  console.log(`completedSessions=${evaluation.completedSessions}`);
  console.log(`openSessions=${evaluation.openSessions}`);
  printEvaluationGroup("withContext", evaluation.withContext);
  printEvaluationGroup("withoutContext", evaluation.withoutContext);
  console.log(`absoluteRateDifference=${formatRate(evaluation.absoluteRateDifference)}`);
  console.log(`relativeRateDifference=${formatRate(evaluation.relativeRateDifference)}`);
  console.log("note=Rates use explicitly closed session outcomes; silence is not treated as prevention.");
}

function printEvaluationGroup(
  label: string,
  group: ReturnType<ReturnType<typeof createPreferenceStore>["evaluateOutcomes"]>["withContext"],
): void {
  console.log(`${label}.sessions=${group.sessions}`);
  console.log(`${label}.corrections=${group.corrections}`);
  console.log(`${label}.correctionRate=${formatRate(group.correctionRate)}`);
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
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
  prefkit remember "Prefer concise status updates" [--category communication] [--tag style] [--reactivate]
  prefkit list [--all] [--status active] [--scope repository] [--scope-value <val>] [--limit 20] [--offset 0]
  prefkit stats
  prefkit evaluate
  prefkit evaluate --session <id> --correction-observed|--no-correction [--with-context|--without-context]
  prefkit why <id>
  prefkit pin <id>
  prefkit forget <id>
  prefkit review <id> --accept|--reject
  prefkit export --format markdown|json
  prefkit import --input ./prefkit-export.json
  prefkit backup --output ./backups/prefs.db
  prefkit context --prompt "I need to name an app"
  prefkit learn --event-file event.json [--persist]
  prefkit queue --stdin-json [--queue-dir ~/.prefkit/queue]
  prefkit replay [--queue-dir ~/.prefkit/queue] [--persist] [--limit 100] [--max-attempts 3]
    Successful and skipped events move to queue/processed; exhausted failures move to queue/failed.
  prefkit worker [--queue-dir ~/.prefkit/queue] [--interval-ms 5000] [--batch-size 1] [--once]
    Watches the queue and persists learning events in the background. One worker runs per queue.
  prefkit doctor [--config .prefkit.json]
  prefkit opencode install [--write] [--opencode-config opencode.jsonc]
  prefkit opencode doctor [--opencode-config opencode.jsonc]
  prefkit codex install [--write] [--codex-hooks ~/.codex/hooks.json]
  prefkit codex doctor [--codex-hooks ~/.codex/hooks.json]
  prefkit mcp [--config .prefkit.json]
    Serve MCP preference tools over stdio.
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
