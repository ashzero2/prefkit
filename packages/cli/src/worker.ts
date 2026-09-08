import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkerBatchResult {
  total: number;
  failed: number;
}

export interface BackgroundWorkerInput {
  queueDir: string;
  intervalMs: number;
  batchSize: number;
  once: boolean;
  processBatch: () => Promise<WorkerBatchResult>;
  onBatch?: (result: WorkerBatchResult) => void;
  onError?: (error: unknown) => void;
}

export interface BackgroundWorkerResult {
  status: "stopped" | "already-running";
  batches: number;
  total: number;
  failed: number;
}

interface WorkerOwner {
  pid: number;
  startedAt: string;
}

const lockDirectoryName = ".worker.lock";
const ownerFileName = "owner.json";

/**
 * Runs one queue consumer per queue directory. Files are unique and replay is
 * idempotent, so holding one lock also keeps local-model work predictable.
 */
export async function runBackgroundWorker(input: BackgroundWorkerInput): Promise<BackgroundWorkerResult> {
  mkdirSync(input.queueDir, { recursive: true });
  const release = acquireWorkerLock(input.queueDir);
  if (release === null) {
    return { status: "already-running", batches: 0, total: 0, failed: 0 };
  }

  const stopController = new AbortController();
  const stop = (): void => stopController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const notifier = createQueueNotifier(input.queueDir, input.intervalMs, stopController.signal);
  let batches = 0;
  let total = 0;
  let failed = 0;

  try {
    while (!stopController.signal.aborted) {
      try {
        const result = await input.processBatch();
        batches += 1;
        total += result.total;
        failed += result.failed;
        input.onBatch?.(result);
      } catch (error) {
        failed += 1;
        input.onError?.(error);
      }

      if (input.once) {
        break;
      }

      await notifier.wait();
    }
  } finally {
    notifier.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    release();
  }

  return { status: "stopped", batches, total, failed };
}

function acquireWorkerLock(queueDir: string): (() => void) | null {
  const lockDir = join(queueDir, lockDirectoryName);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      const owner: WorkerOwner = { pid: process.pid, startedAt: new Date().toISOString() };
      try {
        writeFileSync(join(lockDir, ownerFileName), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      } catch {
        rmSync(lockDir, { recursive: true, force: true });
        return null;
      }
      return () => {
        rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error) || !canReclaimLock(lockDir)) {
        return null;
      }
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  return null;
}

function canReclaimLock(lockDir: string): boolean {
  const ownerPath = join(lockDir, ownerFileName);
  if (!existsSync(ownerPath)) {
    return false;
  }

  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<WorkerOwner>;
    const pid = owner.pid;
    return typeof pid === "number" && Number.isInteger(pid) && !isProcessAlive(pid);
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createQueueNotifier(queueDir: string, intervalMs: number, signal: AbortSignal): {
  wait: () => Promise<void>;
  close: () => void;
} {
  let pending = false;
  let closed = false;
  const waiters = new Set<() => void>();
  const wake = (): void => {
    if (closed) {
      return;
    }
    if (waiters.size === 0) {
      pending = true;
      return;
    }
    for (const resolve of waiters) {
      resolve();
    }
    waiters.clear();
  };

  const watcher = createWatcher(queueDir, wake);
  const timer = setInterval(wake, Math.max(250, Math.floor(intervalMs)));
  const abortListener = (): void => wake();
  signal.addEventListener("abort", abortListener);

  return {
    wait: async (): Promise<void> => {
      if (signal.aborted || pending) {
        pending = false;
        return;
      }
      await new Promise<void>((resolve) => waiters.add(resolve));
    },
    close: (): void => {
      closed = true;
      watcher?.close();
      clearInterval(timer);
      signal.removeEventListener("abort", abortListener);
      for (const resolve of waiters) {
        resolve();
      }
      waiters.clear();
    },
  };
}

function createWatcher(queueDir: string, wake: () => void): ReturnType<typeof watch> | null {
  try {
    const watcher = watch(queueDir, { persistent: true }, () => wake());
    watcher.on("error", () => wake());
    return watcher;
  } catch {
    return null;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
