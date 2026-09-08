import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export function queueFiles(queueDir: string, limit: number): string[] {
  const boundedLimit = Math.max(0, Math.min(Math.floor(limit), 500));
  if (boundedLimit === 0 || !existsSync(queueDir)) {
    return [];
  }

  return readdirSync(queueDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(queueDir, entry))
    .filter((path) => statSync(path).isFile())
    .sort()
    .slice(0, boundedLimit);
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
