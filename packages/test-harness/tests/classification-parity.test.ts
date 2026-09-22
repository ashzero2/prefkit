import { describe, expect, it } from "vitest";
import {
  buildLearnerEvent as claudeEvent,
  shouldQueuePrompt as claudeQueue,
} from "../../adapter-claude/scripts/prefkit-learn.mjs";
import {
  buildLearnerEvent as codexEvent,
  shouldQueuePrompt as codexQueue,
} from "../../adapter-codex/scripts/prefkit-learn.mjs";
import {
  learnerEventFromOpenCodeContext,
  shouldQueueOpenCodeLearnerEvent,
} from "../../adapter-opencode/src/queue.js";

interface ClassificationCase {
  prompt: string;
  queue: boolean;
  eventType: string;
}

const cases: ClassificationCase[] = [
  { prompt: "Remember that I prefer pnpm.", queue: true, eventType: "explicit_memory" },
  { prompt: "No, use pnpm instead.", queue: true, eventType: "explicit_correction" },
  { prompt: "Always use pnpm.", queue: true, eventType: "user_prompt" },
  { prompt: "No worries, take your time.", queue: false, eventType: "user_prompt" },
  { prompt: "I never knew that.", queue: false, eventType: "user_prompt" },
  { prompt: "always run the tests this once", queue: false, eventType: "user_prompt" },
  { prompt: "no", queue: false, eventType: "user_prompt" },
  { prompt: "What is the project status?", queue: false, eventType: "user_prompt" },
  { prompt: "Please refactor this function.", queue: false, eventType: "user_prompt" },
];

function openCodeEventType(prompt: string): string {
  return learnerEventFromOpenCodeContext({
    event: { sessionID: "session" },
    cwd: "/repo",
    prompt,
    maxPromptChars: 4000,
  }).eventType;
}

describe("adapter classification parity", () => {
  it.each(cases)("agrees across adapters for $prompt", (testCase) => {
    const expected = { queue: testCase.queue, eventType: testCase.eventType };

    expect({
      claude: {
        queue: claudeQueue(testCase.prompt),
        eventType: claudeEvent({ prompt: testCase.prompt, cwd: "/repo" }, {}).eventType,
      },
      codex: {
        queue: codexQueue(testCase.prompt),
        eventType: codexEvent({ prompt: testCase.prompt, cwd: "/repo" }, {}).eventType,
      },
      opencode: {
        queue: shouldQueueOpenCodeLearnerEvent(testCase.prompt, {}),
        eventType: openCodeEventType(testCase.prompt),
      },
    }).toEqual({ claude: expected, codex: expected, opencode: expected });
  });
});
