import { describe, expect, it } from "vitest";
import { scoreLearnerEvent, validateLearnerEvent } from "../../src/index.js";
import type { LearnerEvent } from "../../src/index.js";

describe("learner prefilter", () => {
  it("does not extract from ordinary prompts", () => {
    const decision = scoreLearnerEvent(event({ userPrompt: "Can you add a Vitest test for this helper?" }));

    expect(decision.shouldExtract).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.reasons).toEqual([]);
  });

  it("extracts direct correction events at the default threshold", () => {
    const decision = scoreLearnerEvent(
      event({
        eventType: "explicit_correction",
        userPrompt: "Use pnpm here.",
        assistantSummary: "Suggested npm install.",
      }),
    );

    expect(decision.shouldExtract).toBe(true);
    expect(decision.score).toBe(3);
    expect(decision.reasons).toContainEqual({
      code: "explicit-correction-event",
      description: "The event is a direct user correction.",
      source: "eventType",
      weight: 3,
    });
  });

  it("extracts stable preference language from a user prompt", () => {
    const decision = scoreLearnerEvent(
      event({
        userPrompt: "From now on, I prefer short candidate lists before deep validation.",
      }),
    );

    expect(decision.shouldExtract).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(4);
    expect(decision.reasons.map((reason) => reason.code)).toContain("stable-preference");
    expect(decision.reasons.map((reason) => reason.code)).toContain("future-guidance");
  });

  it("extracts no-prefixed corrections from a user prompt", () => {
    const decision = scoreLearnerEvent(
      event({
        userPrompt: "No, use pnpm here.",
      }),
    );

    expect(decision.shouldExtract).toBe(true);
    expect(decision.score).toBe(3);
    expect(decision.reasons.map((reason) => reason.code)).toContain("direct-correction");
  });

  it("uses adapter metadata for mechanical signals", () => {
    const decision = scoreLearnerEvent(
      event({
        metadata: {
          repeatedChoice: true,
          userEditedGeneratedOutput: true,
        },
      }),
    );

    expect(decision.shouldExtract).toBe(true);
    expect(decision.score).toBe(5);
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "metadata-repeated-choice",
      "metadata-user-edit",
    ]);
  });

  it("respects disabled learning", () => {
    const decision = scoreLearnerEvent(
      event({
        eventType: "explicit_memory",
        userPrompt: "Remember that I prefer pnpm.",
      }),
      { enabled: false },
    );

    expect(decision.shouldExtract).toBe(false);
    expect(decision.skippedReason).toBe("learning-disabled");
    expect(decision.reasons).toEqual([]);
  });

  it("keeps manual mode limited to explicit memory and replay events", () => {
    const automatic = scoreLearnerEvent(
      event({
        eventType: "explicit_correction",
        userPrompt: "No, use pnpm.",
      }),
      { mode: "manual" },
    );
    const manual = scoreLearnerEvent(
      event({
        eventType: "explicit_memory",
        userPrompt: "Remember that I prefer pnpm.",
      }),
      { mode: "manual" },
    );

    expect(automatic.shouldExtract).toBe(false);
    expect(automatic.skippedReason).toBe("manual-mode");
    expect(manual.shouldExtract).toBe(true);
  });

  it("uses the configured signal threshold", () => {
    const correction = event({
      eventType: "explicit_correction",
      userPrompt: "Use pnpm here.",
    });

    expect(scoreLearnerEvent(correction, { minSignalScore: 4 }).shouldExtract).toBe(false);
    expect(scoreLearnerEvent(correction, { minSignalScore: 3 }).shouldExtract).toBe(true);
  });
});

function event(input: Partial<LearnerEvent>): LearnerEvent {
  const result = validateLearnerEvent({
    agent: "test-agent",
    eventType: "user_prompt",
    userPrompt: "",
    assistantSummary: "",
    ...input,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }

  return result.value;
}
