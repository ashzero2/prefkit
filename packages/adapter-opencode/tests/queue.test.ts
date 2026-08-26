import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@prefkit/core";
import { learnerEventFromOpenCodeContext, queueOpenCodeLearnerEvent } from "../src/queue.js";

describe("OpenCode learner queue", () => {
  it("classifies explicit memory prompts", () => {
    const event = learnerEventFromOpenCodeContext({
      event: { sessionID: "session_test", agent: "build" },
      cwd: "/repo",
      prompt: "Remember that I prefer pnpm.",
      maxPromptChars: 4000,
    });

    expect(event.eventType).toBe("explicit_memory");
    expect(event.agent).toBe("build");
    expect(event.sessionId).toBe("session_test");
  });

  it("classifies direct corrections", () => {
    const event = learnerEventFromOpenCodeContext({
      event: {},
      cwd: "/repo",
      prompt: "No, use npm for this repository instead.",
      maxPromptChars: 4000,
    });

    expect(event.eventType).toBe("explicit_correction");
  });

  it("skips weak prompts by default", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-queue-"));
    const result = queueOpenCodeLearnerEvent({
      event: {
        messages: [{ role: "user", content: "Can you add a test?" }],
      },
      cwd: "/repo",
      options: { queueDir },
      loadConfig: () => config(queueDir),
    });

    expect(result).toEqual({ queued: false, skippedReason: "signal-below-threshold", signalScore: 0 });
  });

  it("writes redacted strong learner events", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-queue-"));
    const result = queueOpenCodeLearnerEvent({
      event: {
        sessionID: "session_test",
        messages: [{ role: "user", content: "No, use pnpm here. token=secret-token-value-123456" }],
      },
      cwd: "/repo",
      options: { queueDir },
      loadConfig: () => config(queueDir),
      now: () => new Date("2026-08-26T07:00:00.000Z"),
      id: () => "event-id",
    });

    expect(result.queued).toBe(true);
    expect(result.path).toBe(join(queueDir, "2026-08-26T07-00-00-000Z-event-id.json"));
    expect(existsSync(result.path ?? "")).toBe(true);
    const queued = JSON.parse(readFileSync(result.path ?? "", "utf8")) as Record<string, unknown>;
    expect(queued.userPrompt).toBe("No, use pnpm here. token=[REDACTED:secret-assignment]");
    expect(queued.eventType).toBe("explicit_correction");
    expect(queued.sessionId).toBe("session_test");
  });

  it("can queue weak events when explicitly enabled", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-queue-"));
    const result = queueOpenCodeLearnerEvent({
      event: {
        messages: [{ role: "user", content: "Can you add a test?" }],
      },
      cwd: "/repo",
      options: { queueDir, queueWeakEvents: true },
      loadConfig: () => config(queueDir),
      now: () => new Date("2026-08-26T07:00:00.000Z"),
      id: () => "weak-id",
    });

    expect(result.queued).toBe(true);
  });
});

function config(queuePath: string) {
  return {
    sources: [],
    warnings: [],
    config: {
      ...defaultConfig,
      learning: {
        ...defaultConfig.learning,
        queuePath,
      },
    },
  };
}
