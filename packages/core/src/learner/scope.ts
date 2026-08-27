import type { ExtractorOutput, LearnerEvent } from "./schemas.js";

const reusableGuidancePattern =
  /\b(?:always|never|from now on|going forward|in future|for all|across projects|i usually|i generally|i prefer|my preference)\b/i;

const reusableTaskPattern = /\bfor\s+(?!this\b|the\b|current\b)[a-z0-9][a-z0-9 _-]{1,48}\s+tasks?\b/i;

export function hasReusableGuidanceWording(prompt: string): boolean {
  if (
    /\b(?:for\s+this\s+task|for\s+the\s+current\s+task|for\s+this\s+current\s+task)\b/i.test(prompt) &&
    !/\b(?:from now on|going forward|in future|for all|across projects)\b/i.test(prompt)
  ) {
    return false;
  }

  return reusableGuidancePattern.test(prompt) || reusableTaskPattern.test(prompt);
}

export function normalizePreferenceScope(extraction: ExtractorOutput, event: LearnerEvent): ExtractorOutput {
  if (extraction.scopeType !== "task") {
    return extraction;
  }

  if (hasReusableGuidanceWording(event.userPrompt)) {
    return {
      ...extraction,
      scopeType: "global",
      scopeValue: null,
    };
  }

  return extraction;
}
