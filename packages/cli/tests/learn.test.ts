import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculatePreferenceConfidence,
  createPreferenceStore,
  validateExtractorOutput,
  validateLearnerEvent,
  type ExtractorOutput,
  type LearnerEvent,
  type PreferenceExtractionResult,
} from "@prefkit/core";
import { persistLearnResult } from "../src/learn.js";

const statement = "Prefer focused tests in this repository.";

function must<T>(result: { ok: true; value: T } | { ok: false; errors: string[] }): T {
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.value;
}

function fixture(): { event: LearnerEvent; extraction: ExtractorOutput } {
  const event = must(
    validateLearnerEvent({
      agent: "test",
      eventType: "explicit_memory",
      userPrompt: "Remember: prefer focused tests in this repository",
    }),
  );
  const extraction = must(
    validateExtractorOutput({
      shouldLearn: true,
      statement,
      scopeType: "repository",
      scopeValue: "/repo",
      category: "testing",
      tags: [],
      evidenceType: "USER_EXPLICIT",
      polarity: "positive",
      rationale: "The user asked to remember this preference.",
    }),
  );
  return { event, extraction };
}

describe("persistLearnResult", () => {
  it("uses the configured confidence options when merging onto an existing preference", () => {
    const { event, extraction } = fixture();
    const store = createPreferenceStore({
      path: join(mkdtempSync(join(tmpdir(), "prefkit-learn-")), "prefs.db"),
      wal: false,
      busyTimeoutMs: 1000,
    });

    try {
      store.remember({
        statement,
        scopeType: "repository",
        scopeValue: "/repo",
        confidence: 0,
      });

      const confidence = calculatePreferenceConfidence({ event, extraction });
      const result: PreferenceExtractionResult = {
        ok: true,
        status: "extracted",
        model: "test",
        event,
        redactions: [],
        prefilter: { shouldExtract: true, score: 6, threshold: 3, reasons: [] },
        extraction,
        confidence,
        promptTokenEstimate: 10,
      };

      const learning = { globalPromotionThreshold: 100, requireConfirmationForGlobal: true };
      const persisted = persistLearnResult(result, store, learning);

      const expected = calculatePreferenceConfidence({
        event,
        extraction,
        existingPositiveEvidence: 1,
        repeatedAcrossRepositories: false,
        options: learning,
      });

      expect(persisted?.preference.confidence).toBeCloseTo(expected.confidence, 10);
      expect(persisted?.preference.confidence).toBeLessThan(0.5);
    } finally {
      store.close();
    }
  });
});
