import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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

export function archiveReplayFile(file: string, queueDir: string): string {
  const processedDir = join(queueDir, "processed");
  mkdirSync(processedDir, { recursive: true });
  const destination = join(processedDir, basename(file));
  const finalDestination = existsSync(destination)
    ? join(processedDir, `${basename(file, ".json")}-${randomUUID()}.json`)
    : destination;
  renameSync(file, finalDestination);
  return finalDestination;
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
