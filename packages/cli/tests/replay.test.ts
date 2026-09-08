import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveReplayFile, queueFiles } from "../src/replay.js";

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
});
