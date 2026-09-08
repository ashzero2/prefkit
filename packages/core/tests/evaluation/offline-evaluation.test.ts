import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import offlineCases from "./fixtures/offline-cases.json" with { type: "json" };
import {
  calculatePreferenceConfidence,
  createPreferenceStore,
  redactText,
  scoreLearnerEvent,
  validateExtractorOutput,
  validateLearnerEvent,
} from "../../src/index.js";
import type { ExtractorOutput, LearnerEvent } from "../../src/index.js";

type OfflineCase =
  | {
      name: string;
      kind: "redaction";
      input: string;
      secret: string;
      expectedFinding: string;
    }
  | {
      name: string;
      kind: "prefilter";
      event: unknown;
      expectedShouldExtract: boolean;
    }
  | {
      name: string;
      kind: "confidence";
      event: unknown;
      extraction: unknown;
      expectedStatus: string;
    }
  | {
      name: string;
      kind: "retrieval";
      prompt: string;
      limit: number;
      preferences: Array<{ statement: string; category: string; tags: string[] }>;
      relevantStatements: string[];
    };

const options = { redactSecrets: true, maxEvidenceChars: 1000 };

describe("offline evaluation corpus", () => {
  it.each(offlineCases as OfflineCase[])("keeps $name stable", (testCase) => {
    if (testCase.kind === "redaction") {
      const result = redactText(testCase.input, options);

      expect(result.value).not.toContain(testCase.secret);
      expect(result.findings.map((finding) => finding.kind)).toContain(testCase.expectedFinding);
      return;
    }

    if (testCase.kind === "retrieval") {
      const store = createPreferenceStore({
        path: join(mkdtempSync(join(tmpdir(), "prefkit-evaluation-")), "prefs.db"),
        wal: false,
        busyTimeoutMs: 1000,
      });
      try {
        for (const preference of testCase.preferences) {
          store.remember(preference);
        }

        const results = store.search({ prompt: testCase.prompt, limit: testCase.limit });
        const relevantRetrieved = results.filter((result) => testCase.relevantStatements.includes(result.preference.statement));
        const precisionAtK = relevantRetrieved.length / Math.max(1, results.length);
        const recallAtK = relevantRetrieved.length / Math.max(1, testCase.relevantStatements.length);

        expect(precisionAtK).toBe(1);
        expect(recallAtK).toBe(1);
        return;
      } finally {
        store.close();
      }
    }

    const event = validEvent(testCase.event);
    if (testCase.kind === "prefilter") {
      expect(scoreLearnerEvent(event).shouldExtract).toBe(testCase.expectedShouldExtract);
      return;
    }

    const extraction = validExtraction(testCase.extraction);
    expect(
      calculatePreferenceConfidence({
        event,
        extraction,
      }).status,
    ).toBe(testCase.expectedStatus);
  });
});

function validEvent(input: unknown): LearnerEvent {
  const result = validateLearnerEvent(input);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.value;
}

function validExtraction(input: unknown): ExtractorOutput {
  const result = validateExtractorOutput(input);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.value;
}
