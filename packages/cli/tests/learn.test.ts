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

  it("ignores a supersession that does not reference a known candidate", () => {
    const { event, extraction } = fixture();
    const store = createPreferenceStore({
      path: join(mkdtempSync(join(tmpdir(), "prefkit-learn-")), "prefs.db"),
      wal: false,
      busyTimeoutMs: 1000,
    });

    try {
      const contradicted = {
        ...extraction,
        contradictions: [
          {
            preferenceId: "pref_invented",
            kind: "same_scope" as const,
            action: "supersede_existing" as const,
            rationale: "The model claimed an existing rule conflicts.",
          },
        ],
      };
      const result: PreferenceExtractionResult = {
        ok: true,
        status: "extracted",
        model: "test",
        event,
        redactions: [],
        prefilter: { shouldExtract: true, score: 6, threshold: 3, reasons: [] },
        extraction: contradicted,
        confidence: calculatePreferenceConfidence({ event, extraction: contradicted }),
        promptTokenEstimate: 10,
      };

      const persisted = persistLearnResult(
        result,
        store,
        { globalPromotionThreshold: 8, requireConfirmationForGlobal: true },
        [],
      );

      expect(persisted?.preference.supersedesId).toBeNull();
      expect((persisted?.preference.metadata as Record<string, unknown>).needsReviewReason).toBe(
        "unresolved-contradiction",
      );
    } finally {
      store.close();
    }
  });

  it("marks a preference repeated across earlier sessions", () => {
    const { event, extraction } = fixture();
    const store = createPreferenceStore({
      path: join(mkdtempSync(join(tmpdir(), "prefkit-learn-")), "prefs.db"),
      wal: false,
      busyTimeoutMs: 1000,
    });

    try {
      for (const sessionId of ["session-a", "session-b"]) {
        store.remember({
          statement,
          scopeType: "repository",
          scopeValue: "/repo",
          evidence: { sessionId, summary: `Observation in ${sessionId}.` },
        });
      }

      const result: PreferenceExtractionResult = {
        ok: true,
        status: "extracted",
        model: "test",
        event,
        redactions: [],
        prefilter: { shouldExtract: true, score: 6, threshold: 3, reasons: [] },
        extraction,
        confidence: calculatePreferenceConfidence({ event, extraction }),
        promptTokenEstimate: 10,
      };

      const persisted = persistLearnResult(result, store, {
        globalPromotionThreshold: 8,
        requireConfirmationForGlobal: true,
      });
      const metadata = persisted?.preference.metadata as Record<string, unknown>;

      expect(metadata.priorDistinctSessions).toBe(2);
      expect(metadata.repeatedAcrossSessions).toBe(true);
    } finally {
      store.close();
    }
  });
});
