import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractorJsonSchema, validateExtractorOutput, validateLearnerEvent } from "../../src/index.js";

describe("learner schemas", () => {
  it("validates learner events", () => {
    const result = validateLearnerEvent(readFixture("explicit-correction-event.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventType).toBe("explicit_correction");
      expect(result.value.repoContext.packageManager).toBe("unknown");
    }
  });

  it("validates extractor output with conservative status normalization", () => {
    const result = validateExtractorOutput(readFixture("valid-extractor-output.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.shouldLearn).toBe(true);
      expect(result.value.proposedStatus).toBe("candidate");
      expect(result.value.needsConfirmation).toBe(true);
      expect(result.value.tags).toEqual(["javascript", "package-manager", "pnpm"]);
    }
  });

  it("rejects malformed extractor output", () => {
    const result = validateExtractorOutput(readFixture("invalid-extractor-output.json"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("statement is required");
    }
  });

  it("rejects unrecognized extractor fields", () => {
    const result = validateExtractorOutput(readFixture("strict-extractor-output.json"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("Unrecognized key");
    }
  });

  it("exports a JSON schema for local model structured output", () => {
    expect(extractorJsonSchema).toMatchObject({
      type: "object",
      properties: {
        shouldLearn: { type: "boolean" },
        statement: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
  });
});

function readFixture(name: string): unknown {
  const path = join(import.meta.dirname, "fixtures", name);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
