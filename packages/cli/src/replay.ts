import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const retryCountKey = "prefkitRetryCount";

export interface QueueFailureResult {
  disposition: "retrying" | "dead-lettered";
  attempts: number;
  archivedPath?: string;
}

export function queueFiles(queueDir: string, limit: number): string[] {
  const boundedLimit = Math.max(0, Math.min(Math.floor(limit), 500));
  if (boundedLimit === 0 || !existsSync(queueDir)) {
    return [];
  }

  return readdirSync(queueDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(queueDir, entry))
    .filter(isRegularFile)
    .sort()
    .slice(0, boundedLimit);
}

export function writeQueueFile(queueDir: string, fileName: string, contents: string): string {
  if (basename(fileName) !== fileName || !fileName.endsWith(".json")) {
    throw new Error(`Queue file name must be a JSON basename: ${fileName}`);
  }

  mkdirSync(queueDir, { recursive: true });
  const destination = join(queueDir, fileName);
  const temporary = join(queueDir, `.${fileName}.${randomUUID()}.tmp`);

  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameSync(temporary, destination);
    return destination;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function recordQueueFailure(
  file: string,
  queueDir: string,
  maxAttempts: number,
  permanent = false,
): QueueFailureResult {
  const attempts = readRetryCount(file) + 1;
  const event = readQueueJson(file);
  const limit = Math.max(1, Math.floor(maxAttempts));

  if (permanent || event === null || !isRecord(event) || (event.metadata !== undefined && !isRecord(event.metadata))) {
    return deadLetter(file, queueDir, attempts);
  }

  if (attempts >= limit) {
    return deadLetter(file, queueDir, attempts);
  }

  const metadata = isRecord(event.metadata) ? event.metadata : {};
  writeQueueFile(
    queueDir,
    basename(file),
    `${JSON.stringify({ ...event, metadata: { ...metadata, [retryCountKey]: attempts } }, null, 2)}\n`,
  );
  return { disposition: "retrying", attempts };
}

export function archiveReplayFile(
  file: string,
  queueDir: string,
  destinationDirectory: "processed" | "failed" = "processed",
): string {
  const processedDir = join(queueDir, destinationDirectory);
  mkdirSync(processedDir, { recursive: true });
  const destination = join(processedDir, basename(file));
  const finalDestination = existsSync(destination)
    ? join(processedDir, `${basename(file, ".json")}-${randomUUID()}.json`)
    : destination;
  renameSync(file, finalDestination);
  return finalDestination;
}

function readRetryCount(file: string): number {
  const event = readQueueJson(file);
  if (!isRecord(event) || !isRecord(event.metadata)) {
    return 0;
  }

  const value = event.metadata[retryCountKey];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readQueueJson(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function deadLetter(file: string, queueDir: string, attempts: number): QueueFailureResult {
  return {
    disposition: "dead-lettered",
    attempts,
    archivedPath: archiveReplayFile(file, queueDir, "failed"),
  };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
