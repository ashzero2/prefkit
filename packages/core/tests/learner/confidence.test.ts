import { describe, expect, it } from "vitest";
import {
  calculatePreferenceConfidence,
  validateExtractorOutput,
  validateLearnerEvent,
} from "../../src/index.js";
import type { ExtractorOutput, LearnerEvent } from "../../src/index.js";

describe("preference confidence", () => {
  it("does not store extractor outputs that declined learning", () => {
    const decision = calculatePreferenceConfidence({
      event: event(),
      extraction: extraction({
        shouldLearn: false,
        statement: null,
      }),
    });

    expect(decision.shouldStore).toBe(false);
    expect(decision.status).toBe("rejected");
    expect(decision.confidence).toBe(0);
    expect(decision.reasons).toContainEqual({
      code: "extractor-declined",
      description: "The extractor did not identify a persistent preference.",
      weight: 0,
    });
  });

  it("activates bounded explicit corrections when deterministic weight is high enough", () => {
    const decision = calculatePreferenceConfidence({
      event: event({
        eventType: "explicit_correction",
        userPrompt: "No, use pnpm here.",
        assistantSummary: "Suggested npm.",
      }),
      extraction: extraction({
        scopeType: "repository",
        evidenceType: "USER_EXPLICIT",
      }),
    });

    expect(decision.shouldStore).toBe(true);
    expect(decision.status).toBe("active");
    expect(decision.needsConfirmation).toBe(false);
    expect(decision.evidenceWeight).toBe(6);
    expect(decision.confidence).toBe(0.75);
  });

  it("keeps global preferences as candidates when confirmation is required", () => {
    const decision = calculatePreferenceConfidence({
      event: event({
        eventType: "explicit_memory",
        userPrompt: "Remember that I always prefer pnpm across projects.",
      }),
      extraction: extraction({
        scopeType: "global",
        evidenceType: "USER_EXPLICIT",
      }),
    });

    expect(decision.status).toBe("candidate");
    expect(decision.needsConfirmation).toBe(true);
    expect(decision.confidence).toBe(1);
    expect(decision.reasons.map((reason) => reason.code)).toContain("global-wording");
  });

  it("can activate global preferences only with explicit policy and repeated evidence", () => {
    const decision = calculatePreferenceConfidence({
      event: event({
        eventType: "explicit_memory",
        userPrompt: "I prefer pnpm for these projects.",
      }),
      extraction: extraction({
        scopeType: "global",
        evidenceType: "USER_EXPLICIT",
      }),
      repeatedAcrossRepositories: true,
      options: {
        requireConfirmationForGlobal: false,
      },
    });

    expect(decision.status).toBe("active");
    expect(decision.needsConfirmation).toBe(false);
    expect(decision.confidence).toBe(1);
    expect(decision.reasons.map((reason) => reason.code)).toContain("repeated-across-repositories");
  });

  it("keeps model-only evidence weak", () => {
    const decision = calculatePreferenceConfidence({
      event: event({
        eventType: "user_prompt",
        userPrompt: "Set up the project.",
      }),
      extraction: extraction({
        scopeType: "repository",
        evidenceType: "MODEL_EXTRACTED",
      }),
    });

    expect(decision.status).toBe("candidate");
    expect(decision.needsConfirmation).toBe(true);
    expect(decision.evidenceWeight).toBe(1);
    expect(decision.reasons.map((reason) => reason.code)).toContain("weak-extractor-evidence");
  });

  it("requires review when contradictions are present", () => {
    const decision = calculatePreferenceConfidence({
      event: event({
        eventType: "explicit_correction",
        userPrompt: "Use npm for this repository instead.",
      }),
      extraction: extraction({
        scopeType: "repository",
        contradictions: [
          {
            preferenceId: "pref_existing",
            kind: "same_scope",
            action: "needs_review",
            rationale: "Existing preference says to use pnpm in this repository.",
          },
        ],
      }),
    });

    expect(decision.status).toBe("candidate");
    expect(decision.needsConfirmation).toBe(true);
    expect(decision.evidenceWeight).toBe(4);
    expect(decision.reasons.map((reason) => reason.code)).toContain("contradiction-penalty");
  });
});

function event(input: Partial<LearnerEvent> = {}): LearnerEvent {
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

function extraction(input: Partial<ExtractorOutput> = {}): ExtractorOutput {
  const result = validateExtractorOutput({
    shouldLearn: true,
    statement: "Prefer pnpm for JavaScript package management.",
    scopeType: "repository",
    scopeValue: "/repo",
    category: "tooling",
    tags: ["javascript", "package-manager", "pnpm"],
    evidenceType: "USER_EXPLICIT",
    polarity: "positive",
    rationale: "The user explicitly corrected the package manager choice.",
    contradictions: [],
    ...input,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }

  return result.value;
}
