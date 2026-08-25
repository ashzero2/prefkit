import type { LearningConfig } from "../config/types.js";
import type { PreferenceStatus } from "../store/types.js";
import type { ExtractorOutput, LearnerEvent } from "./schemas.js";

export interface ConfidenceReason {
  code: string;
  description: string;
  weight: number;
}

export interface ConfidenceOptions
  extends Pick<LearningConfig, "globalPromotionThreshold" | "requireConfirmationForGlobal"> {
  activationWeight: number;
}

export interface ConfidenceInput {
  event: LearnerEvent;
  extraction: ExtractorOutput;
  existingPositiveEvidence?: number;
  repeatedAcrossRepositories?: boolean;
  userPinned?: boolean;
  options?: Partial<ConfidenceOptions>;
}

export interface ConfidenceDecision {
  shouldStore: boolean;
  confidence: number;
  evidenceWeight: number;
  status: PreferenceStatus;
  needsConfirmation: boolean;
  reasons: ConfidenceReason[];
}

const defaultOptions: ConfidenceOptions = {
  activationWeight: 5,
  globalPromotionThreshold: 8,
  requireConfirmationForGlobal: true,
};

export function calculatePreferenceConfidence(input: ConfidenceInput): ConfidenceDecision {
  const options = { ...defaultOptions, ...input.options };

  if (!input.extraction.shouldLearn) {
    return {
      shouldStore: false,
      confidence: 0,
      evidenceWeight: 0,
      status: "rejected",
      needsConfirmation: false,
      reasons: [
        {
          code: "extractor-declined",
          description: "The extractor did not identify a persistent preference.",
          weight: 0,
        },
      ],
    };
  }

  if (input.userPinned) {
    return {
      shouldStore: true,
      confidence: 1,
      evidenceWeight: options.globalPromotionThreshold,
      status: "pinned",
      needsConfirmation: false,
      reasons: [
        {
          code: "user-pinned",
          description: "The user explicitly pinned the preference.",
          weight: options.globalPromotionThreshold,
        },
      ],
    };
  }

  const reasons = [
    ...eventReasons(input.event),
    ...extractorReasons(input.extraction),
    ...scopeReasons(input.extraction, input.event, input.repeatedAcrossRepositories),
    ...repeatReasons(input.existingPositiveEvidence),
    ...contradictionReasons(input.extraction),
  ];
  const evidenceWeight = clampWeight(reasons.reduce((total, reason) => total + reason.weight, 0));
  const confidence = clamp01(evidenceWeight / Math.max(1, options.globalPromotionThreshold));
  const needsConfirmation = needsUserConfirmation(input, evidenceWeight, options);

  return {
    shouldStore: true,
    confidence,
    evidenceWeight,
    status: needsConfirmation ? "candidate" : "active",
    needsConfirmation,
    reasons,
  };
}

function eventReasons(event: LearnerEvent): ConfidenceReason[] {
  switch (event.eventType) {
    case "explicit_memory":
      return [
        {
          code: "explicit-memory",
          description: "The user explicitly asked to remember guidance.",
          weight: 5,
        },
      ];
    case "explicit_correction":
      return [
        {
          code: "explicit-correction",
          description: "The user directly corrected the agent.",
          weight: 3,
        },
      ];
    case "repeated_choice":
      return [
        {
          code: "repeated-choice",
          description: "The event captures a repeated user choice.",
          weight: 2,
        },
      ];
    case "manual_replay":
      return [
        {
          code: "manual-replay",
          description: "The event was intentionally replayed for learning.",
          weight: 1,
        },
      ];
    case "user_prompt":
      return [];
  }
}

function extractorReasons(extraction: ExtractorOutput): ConfidenceReason[] {
  const reasons: ConfidenceReason[] = [];

  switch (extraction.evidenceType) {
    case "USER_EXPLICIT":
      reasons.push({
        code: "user-explicit-evidence",
        description: "The extractor classified the evidence as user-explicit.",
        weight: 2,
      });
      break;
    case "IMPORT":
      reasons.push({
        code: "import-evidence",
        description: "The preference came from an imported source.",
        weight: 1,
      });
      break;
    case "MODEL_EXTRACTED":
    case "AGENT_EVENT":
      reasons.push({
        code: "weak-extractor-evidence",
        description: "The evidence is inferred or agent-originated, so it should not strengthen confidence.",
        weight: 0,
      });
      break;
  }

  if (extraction.polarity === "neutral") {
    reasons.push({
      code: "neutral-polarity",
      description: "Neutral evidence is less useful for a durable preference.",
      weight: -1,
    });
  }

  return reasons;
}

function scopeReasons(
  extraction: ExtractorOutput,
  event: LearnerEvent,
  repeatedAcrossRepositories: boolean | undefined,
): ConfidenceReason[] {
  if (extraction.scopeType !== "global") {
    return [
      {
        code: "bounded-scope",
        description: "The preference is scoped below global, reducing blast radius.",
        weight: 1,
      },
    ];
  }

  const reasons: ConfidenceReason[] = [];
  if (hasGlobalWording(event.userPrompt)) {
    reasons.push({
      code: "global-wording",
      description: "The user used wording that suggests the preference may apply globally.",
      weight: 1,
    });
  }

  if (repeatedAcrossRepositories) {
    reasons.push({
      code: "repeated-across-repositories",
      description: "The same preference has evidence across repositories.",
      weight: 2,
    });
  }

  return reasons;
}

function repeatReasons(existingPositiveEvidence: number | undefined): ConfidenceReason[] {
  const count = Math.max(0, Math.floor(existingPositiveEvidence ?? 0));
  if (count === 0) {
    return [];
  }

  return [
    {
      code: "existing-positive-evidence",
      description: "Prior positive evidence exists for this preference.",
      weight: Math.min(3, count),
    },
  ];
}

function contradictionReasons(extraction: ExtractorOutput): ConfidenceReason[] {
  if (extraction.contradictions.length === 0) {
    return [];
  }

  return [
    {
      code: "contradiction-penalty",
      description: "The extractor reported possible contradictions that need review.",
      weight: -2,
    },
  ];
}

function needsUserConfirmation(
  input: ConfidenceInput,
  evidenceWeight: number,
  options: ConfidenceOptions,
): boolean {
  if (input.extraction.contradictions.length > 0) {
    return true;
  }

  if (input.extraction.scopeType === "global") {
    if (options.requireConfirmationForGlobal) {
      return true;
    }

    const hasPromotionEvidence =
      hasGlobalWording(input.event.userPrompt) || input.repeatedAcrossRepositories === true;
    return !hasPromotionEvidence || evidenceWeight < options.globalPromotionThreshold;
  }

  return evidenceWeight < options.activationWeight;
}

function hasGlobalWording(prompt: string): boolean {
  return /\b(?:always|never|from now on|going forward|in future|for all|across projects|for these projects|i usually|i generally|i prefer)\b/i.test(
    prompt,
  );
}

function clampWeight(value: number): number {
  return Math.max(0, value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
