import { describe, expect, it } from "vitest";
import {
  learnerEventFromOpenCodeContext,
  shouldQueueOpenCodeLearnerEvent,
} from "../src/queue.js";

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

  it("avoids starting the CLI for weak prompts by default", () => {
    expect(shouldQueueOpenCodeLearnerEvent("Can you add a test?", {})).toBe(false);
  });

  it("starts the CLI for stable preference language", () => {
    expect(shouldQueueOpenCodeLearnerEvent("I prefer pnpm for this project.", {})).toBe(true);
  });

  it("can opt into starting the CLI for weak prompts", () => {
    expect(shouldQueueOpenCodeLearnerEvent("Can you add a test?", { queueWeakEvents: true })).toBe(true);
  });
});
