import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBackgroundWorker } from "../src/worker.js";

describe("background worker", () => {
  it("processes one batch and exits in once mode", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-worker-"));
    const batches: number[] = [];

    const result = await runBackgroundWorker({
      queueDir,
      intervalMs: 250,
      batchSize: 1,
      once: true,
      processBatch: async () => {
        batches.push(1);
        return { total: 1, failed: 0 };
      },
    });

    expect(result.status).toBe("stopped");
    expect(result.batches).toBe(1);
    expect(result.total).toBe(1);
    expect(batches).toHaveLength(1);
  });

  it("does not start while another worker owns the queue lock", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-worker-"));
    const lockDir = join(queueDir, ".worker.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );

    const result = await runBackgroundWorker({
      queueDir,
      intervalMs: 250,
      batchSize: 1,
      once: true,
      processBatch: async () => ({ total: 0, failed: 0 }),
    });

    expect(result.status).toBe("already-running");
  });
});
