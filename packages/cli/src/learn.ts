import {
  calculatePreferenceConfidence,
  type LearningConfig,
  type PreferenceExtractionResult,
  type PreferenceStore,
  type RememberPreferenceInput,
} from "@prefkit/core";

type ConfidenceOptions = Pick<LearningConfig, "globalPromotionThreshold" | "requireConfirmationForGlobal">;

export function learnExitCode(result: PreferenceExtractionResult): number {
  if (result.ok) {
    return 0;
  }
  return result.status === "learning_skipped" || result.status === "input_too_large" ? 0 : 1;
}

export function persistLearnResult(
  result: PreferenceExtractionResult,
  store: PreferenceStore | null,
  learning: ConfidenceOptions,
): ReturnType<PreferenceStore["remember"]> | null {
  if (store === null) {
    return null;
  }

  if (!result.ok || !result.confidence.shouldStore || result.extraction.statement === null) {
    return null;
  }

  const supersedingContradiction = result.extraction.contradictions.find(
    (contradiction) => contradiction.action === "supersede_existing" && store.get(contradiction.preferenceId) !== null,
  );

  const existing = store.findByStatement(
    result.extraction.statement,
    result.extraction.scopeType,
    result.extraction.scopeValue,
  );

  let confidence = result.confidence;
  if (existing !== null) {
    const evidenceStats = store.getEvidenceStats(existing.preference.id);
    confidence = calculatePreferenceConfidence({
      event: result.event,
      extraction: result.extraction,
      existingPositiveEvidence: evidenceStats.positiveCount,
      repeatedAcrossRepositories: evidenceStats.distinctCwds > 1,
      options: {
        globalPromotionThreshold: learning.globalPromotionThreshold,
        requireConfirmationForGlobal: learning.requireConfirmationForGlobal,
      },
    });
  }

  const rememberInput: RememberPreferenceInput = {
    statement: result.extraction.statement,
    scopeType: result.extraction.scopeType,
    category: result.extraction.category,
    tags: result.extraction.tags,
    confidence: confidence.confidence,
    status: confidence.status,
    source: "prefkit-learn",
    evidence: {
      sessionId: result.event.sessionId ?? null,
      agent: result.event.agent,
      summary: result.extraction.rationale,
      sourceType: result.extraction.evidenceType,
      polarity: result.extraction.polarity,
      weight: confidence.evidenceWeight,
      metadata: {
        cwd: result.event.cwd ?? null,
        model: result.model,
        eventType: result.event.eventType,
        promptTokenEstimate: result.promptTokenEstimate,
        redactions: result.redactions.map((finding) => finding.kind),
        usage: result.usage ?? {},
      },
    },
    metadata: {
      needsConfirmation: confidence.needsConfirmation,
      contradictions: result.extraction.contradictions,
      confidenceReasons: confidence.reasons.map((reason) => reason.code),
      signalReasons: result.prefilter.reasons.map((reason) => reason.code),
    },
    ...(supersedingContradiction === undefined ? {} : { supersedesId: supersedingContradiction.preferenceId }),
  };

  if (result.extraction.scopeValue !== null) {
    rememberInput.scopeValue = result.extraction.scopeValue;
  }

  return store.remember(rememberInput);
}
