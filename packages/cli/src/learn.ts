import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  calculatePreferenceConfidence,
  createPreferenceStore,
  extractPreference,
  OllamaModel,
  redactLearnerEvent,
  scoreLearnerEvent,
  storeExists,
  validateLearnerEvent,
  type CandidatePreferenceContext,
  type ConfigLoadResult,
  type LearningConfig,
  type PreferenceExtractionResult,
  type PreferenceSearchOptions,
  type PreferenceStore,
  type RememberPreferenceInput,
  type StoreConfig,
} from "@prefkit/core";
import { flagOne, parseNumberFlag, parsePositiveIntegerFlag, type ParsedArgs } from "./args.js";
import { archiveReplayFile, queueFiles, recordQueueFailure, writeQueueFile } from "./replay.js";
import { runBackgroundWorker, workerStatus } from "./worker.js";

type ConfidenceOptions = Pick<LearningConfig, "globalPromotionThreshold" | "requireConfirmationForGlobal">;

interface ReplayInput {
  queueDir: string;
  limit: number;
  persist: boolean;
  store: PreferenceStore | null;
  config: ConfigLoadResult["config"];
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

export function learnExitCode(result: PreferenceExtractionResult): number {
  if (result.ok) {
    return 0;
  }
  return result.status === "learning_skipped" || result.status === "input_too_large" ? 0 : 1;
}

export function persistLearnResult(
  result: PreferenceExtractionResult,
  store: PreferenceStore | null,
  learning: ConfidenceOptions,
  existingPreferences: CandidatePreferenceContext[] = [],
): ReturnType<PreferenceStore["remember"]> | null {
  if (store === null) {
    return null;
  }

  if (!result.ok || !result.confidence.shouldStore || result.extraction.statement === null) {
    return null;
  }

  const candidateIds = new Set(existingPreferences.map((preference) => preference.id));
  const supersedingContradiction = result.extraction.contradictions.find(
    (contradiction) => contradiction.action === "supersede_existing" && candidateIds.has(contradiction.preferenceId),
  );
  const unresolvedContradiction =
    result.extraction.contradictions.length > 0 && supersedingContradiction === undefined;

  const existing = store.findByStatement(
    result.extraction.statement,
    result.extraction.scopeType,
    result.extraction.scopeValue,
  );

  let confidence = result.confidence;
  let priorDistinctSessions: number | undefined;
  if (existing !== null) {
    const evidenceStats = store.getEvidenceStats(existing.preference.id);
    priorDistinctSessions = store.countDistinctSessions(existing.preference.id);
    confidence = calculatePreferenceConfidence({
      event: result.event,
      extraction: result.extraction,
      existingPositiveEvidence: evidenceStats.positiveCount,
      repeatedAcrossRepositories: evidenceStats.distinctCwds > 1,
      repeatedAcrossSessions: priorDistinctSessions >= 2,
      options: {
        globalPromotionThreshold: learning.globalPromotionThreshold,
        requireConfirmationForGlobal: learning.requireConfirmationForGlobal,
      },
    });
  }

  const rememberInput: RememberPreferenceInput = {
    statement: result.extraction.statement,
    scopeType: result.extraction.scopeType,
    category: result.extraction.category,
    tags: result.extraction.tags,
    confidence: confidence.confidence,
    status: confidence.status,
    source: "prefkit-learn",
    evidence: {
      sessionId: result.event.sessionId ?? null,
      agent: result.event.agent,
      summary: result.extraction.rationale,
      sourceType: result.extraction.evidenceType,
      polarity: result.extraction.polarity,
      weight: confidence.evidenceWeight,
      metadata: {
        cwd: result.event.cwd ?? null,
        model: result.model,
        eventType: result.event.eventType,
        promptTokenEstimate: result.promptTokenEstimate,
        redactions: result.redactions.map((finding) => finding.kind),
        usage: result.usage ?? {},
      },
    },
    metadata: {
      needsConfirmation: confidence.needsConfirmation,
      contradictions: result.extraction.contradictions,
      confidenceReasons: confidence.reasons.map((reason) => reason.code),
      signalReasons: result.prefilter.reasons.map((reason) => reason.code),
      ...(priorDistinctSessions === undefined
        ? {}
        : { priorDistinctSessions, repeatedAcrossSessions: priorDistinctSessions >= 2 }),
      ...(unresolvedContradiction ? { needsReviewReason: "unresolved-contradiction" } : {}),
    },
    ...(supersedingContradiction === undefined ? {} : { supersedesId: supersedingContradiction.preferenceId }),
  };

  if (result.extraction.scopeValue !== null) {
    rememberInput.scopeValue = result.extraction.scopeValue;
  }

  return store.remember(rememberInput);
}

export async function runLearnCommand(args: ParsedArgs, loadResult: ConfigLoadResult): Promise<number> {
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
    const persisted = persistLearnResult(result, persist ? store : null, loadResult.config.learning, existingPreferences);
    printLearnResult(result, {
      persisted: persisted !== null,
      ...(persisted === null ? {} : { preferenceId: persisted.preference.id }),
    });
  } finally {
    store?.close();
  }
  return learnExitCode(result);
}

export async function runReplayCommand(args: ParsedArgs, loadResult: ConfigLoadResult): Promise<number> {
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

export async function runWorkerCommand(args: ParsedArgs, loadResult: ConfigLoadResult): Promise<number> {
  const queueDir = flagOne(args, "queue-dir") ?? loadResult.config.learning.queuePath;
  const intervalMs = parsePositiveIntegerFlag(flagOne(args, "interval-ms"), loadResult.config.learning.workerPollMs);
  const batchSize = parsePositiveIntegerFlag(flagOne(args, "batch-size"), loadResult.config.learning.workerBatchSize);

  if (args.positionals[0] === "status") {
    return printWorkerStatus(queueDir, loadResult);
  }

  if (!loadResult.config.learning.enabled || loadResult.config.learning.mode === "off") {
    console.log("PrefKit worker: learning is disabled.");
    return 0;
  }
  if (loadResult.config.learning.mode === "manual") {
    console.log("PrefKit worker: learning mode is manual; use prefkit replay --persist.");
    return 0;
  }

  const logPath = workerLogPath(loadResult);
  const log = (message: string): void => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Worker logging must never break the worker.
    }
  };
  log(`worker starting queueDir=${queueDir} intervalMs=${intervalMs} batchSize=${batchSize}`);

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
        if (report.total > 0 || report.failed > 0) {
          log(`batch total=${report.total} extracted=${report.extracted} persisted=${report.persisted} failed=${report.failed}`);
        }
        if (args.flags.has("once") || report.total > 0) {
          printReplayReport(report);
        }
        return report;
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`batch error ${message}`);
        console.error(`PrefKit worker batch failed: ${message}`);
      },
    });
    log(`worker ${result.status} batches=${result.batches} total=${result.total} failed=${result.failed}`);
    console.log(`PrefKit worker: ${result.status}`);
    if (result.status === "already-running") {
      console.log(`queueDir=${queueDir}`);
    }
    console.log(`log=${logPath}`);
    return 0;
  } finally {
    store.close();
  }
}

function printWorkerStatus(queueDir: string, loadResult: ConfigLoadResult): number {
  const status = workerStatus(queueDir);
  console.log("PrefKit worker status");
  console.log(`queueDir=${queueDir}`);
  console.log(`running=${status.running}${status.ownerPid === null ? "" : ` pid=${status.ownerPid}`}`);
  if (status.ownerStartedAt !== null) {
    console.log(`ownerStartedAt=${status.ownerStartedAt}`);
  }
  console.log(`staleLock=${status.staleLock}`);
  console.log(
    `pending=${countJsonFiles(queueDir)} processed=${countJsonFiles(join(queueDir, "processed"))} failed=${countJsonFiles(join(queueDir, "failed"))}`,
  );
  console.log(`log=${workerLogPath(loadResult)}`);
  return 0;
}

function workerLogPath(loadResult: ConfigLoadResult): string {
  const override = process.env.PREFKIT_WORKER_LOG?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(dirname(loadResult.config.store.path), "worker.log");
}

function countJsonFiles(directory: string): number {
  try {
    return readdirSync(directory).filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function runQueueCommand(args: ParsedArgs, loadResult: ConfigLoadResult): Promise<number> {
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
      const persisted = persistLearnResult(
        result,
        input.persist ? input.store : null,
        input.config.learning,
        existingPreferences,
      );

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

      const processable = result.ok || result.status === "learning_skipped" || result.status === "input_too_large";
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

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON event file ${path}: ${message}`);
  }
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
    const persisted =
      file.preferenceId === undefined ? String(file.persisted) : `${file.persisted}:${file.preferenceId}`;
    const retry = file.retryDisposition === undefined ? "" : ` retry=${file.retryDisposition}:${file.retryAttempts}`;
    const error = file.error === undefined ? "" : ` error=${file.error}`;
    console.log(`- ${file.file} status=${file.status} persisted=${persisted} processed=${file.processed}${retry}${error}`);
  }
}
