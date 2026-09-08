import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveReplayFile, queueFiles, recordQueueFailure, writeQueueFile } from "../src/replay.js";

describe("replay queue files", () => {
  it("archives a processed file outside the active queue", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-replay-"));
    const file = join(queueDir, "event.json");
    writeFileSync(file, "{}\n");

    const archived = archiveReplayFile(file, queueDir);

    expect(existsSync(file)).toBe(false);
    expect(existsSync(archived)).toBe(true);
    expect(queueFiles(queueDir, 10)).toEqual([]);
    expect(readdirSync(join(queueDir, "processed"))).toHaveLength(1);
  });

  it("does not overwrite an existing archived file", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-replay-"));
    const file = join(queueDir, "event.json");
    writeFileSync(file, "new\n");
    const first = archiveReplayFile(file, queueDir);
    writeFileSync(join(queueDir, "event.json"), "another\n");

    const second = archiveReplayFile(join(queueDir, "event.json"), queueDir);

    expect(second).not.toBe(first);
    expect(readdirSync(join(queueDir, "processed"))).toHaveLength(2);
  });

  it("publishes queue files only after the complete payload is written", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-replay-"));

    const queued = writeQueueFile(queueDir, "event.json", '{"eventType":"explicit_memory"}\n');

    expect(queueFiles(queueDir, 10)).toEqual([queued]);
    expect(readdirSync(queueDir)).toEqual(["event.json"]);
  });

  it("rejects queue paths that could escape the queue directory", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-replay-"));

    expect(() => writeQueueFile(queueDir, "../event.json", "{}\n")).toThrow("JSON basename");
    expect(queueFiles(queueDir, 10)).toEqual([]);
  });

  it("retries a failure and dead-letters it after the attempt limit", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-replay-"));
    const file = writeQueueFile(queueDir, "event.json", '{"agent":"codex","metadata":{}}\n');

    expect(recordQueueFailure(file, queueDir, 3)).toEqual({ disposition: "retrying", attempts: 1 });
    expect(recordQueueFailure(file, queueDir, 3)).toEqual({ disposition: "retrying", attempts: 2 });
    const final = recordQueueFailure(file, queueDir, 3);

    expect(final.disposition).toBe("dead-lettered");
    expect(final.attempts).toBe(3);
    expect(final.archivedPath).toContain("/failed/");
    expect(queueFiles(queueDir, 10)).toEqual([]);
    expect(existsSync(final.archivedPath as string)).toBe(true);
  });

  it("dead-letters malformed queue JSON immediately", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-replay-"));
    const file = join(queueDir, "broken.json");
    writeFileSync(file, "not json\n");

    const result = recordQueueFailure(file, queueDir, 3);

    expect(result.disposition).toBe("dead-lettered");
    expect(queueFiles(queueDir, 10)).toEqual([]);
    expect(existsSync(result.archivedPath as string)).toBe(true);
  });
});
