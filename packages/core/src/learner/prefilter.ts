import type { LearningMode } from "../config/types.js";
import type { LearnerEvent } from "./schemas.js";

export type LearningSignalSource = "eventType" | "userPrompt" | "metadata";

export interface LearningSignalReason {
  code: string;
  description: string;
  source: LearningSignalSource;
  weight: number;
}

export interface LearningPrefilterOptions {
  enabled?: boolean;
  mode?: LearningMode;
  minSignalScore?: number;
}

export interface LearningPrefilterDecision {
  shouldExtract: boolean;
  score: number;
  threshold: number;
  reasons: LearningSignalReason[];
  skippedReason?: string;
}

interface PhraseSignal {
  code: string;
  description: string;
  weight: number;
  pattern: RegExp;
}

const defaultThreshold = 3;

const phraseSignals: PhraseSignal[] = [
  {
    code: "remember-request",
    description: "The user explicitly asked the agent to remember or store guidance.",
    weight: 5,
    pattern: /\b(?:remember|save this|store this|note that)\b/i,
  },
  {
    code: "stable-preference",
    description: "The user used stable preference language.",
    weight: 4,
    pattern: /\b(?:i prefer|i like|i usually|i generally|my preference|i(?:'|’)d rather|i would rather)\b/i,
  },
  {
    code: "future-guidance",
    description: "The user framed guidance as applying to future turns.",
    weight: 4,
    pattern: /\b(?:from now on|going forward|in future|next time)\b/i,
  },
  {
    code: "absolute-guidance",
    description: "The user used always/never style guidance.",
    weight: 4,
    pattern: /\b(?:always|never)\b/i,
  },
  {
    code: "direct-correction",
    description: "The user directly corrected a prior choice.",
    weight: 3,
    pattern:
      /(?:^|\b)(?:no(?:[,.\s]|$)|not that\b|instead\b|rather than\b|use .{1,50} instead\b|don'?t\b|do not\b|stop doing\b)/i,
  },
  {
    code: "prior-guidance-reference",
    description: "The user referred to a previous instruction being missed.",
    weight: 3,
    pattern: /\b(?:i told you|as i said|like i said|why did you)\b/i,
  },
];

export function scoreLearnerEvent(
  event: LearnerEvent,
  options: LearningPrefilterOptions = {},
): LearningPrefilterDecision {
  const mode = options.mode ?? "local";
  const threshold = Math.max(0, options.minSignalScore ?? defaultThreshold);

  if (options.enabled === false || mode === "off") {
    return {
      shouldExtract: false,
      score: 0,
      threshold,
      reasons: [],
      skippedReason: "learning-disabled",
    };
  }

  if (mode === "manual" && event.eventType !== "explicit_memory" && event.eventType !== "manual_replay") {
    return {
      shouldExtract: false,
      score: 0,
      threshold,
      reasons: [],
      skippedReason: "manual-mode",
    };
  }

  const reasons = [...eventTypeReasons(event), ...phraseReasons(event.userPrompt), ...metadataReasons(event.metadata)];
  const score = reasons.reduce((total, reason) => total + reason.weight, 0);

  return {
    shouldExtract: score >= threshold,
    score,
    threshold,
    reasons,
  };
}

function eventTypeReasons(event: LearnerEvent): LearningSignalReason[] {
  switch (event.eventType) {
    case "explicit_memory":
      return [
        {
          code: "explicit-memory-event",
          description: "The event is an explicit memory request.",
          source: "eventType",
          weight: 6,
        },
      ];
    case "explicit_correction":
      return [
        {
          code: "explicit-correction-event",
          description: "The event is a direct user correction.",
          source: "eventType",
          weight: 3,
        },
      ];
    case "repeated_choice":
      return [
        {
          code: "repeated-choice-event",
          description: "The event records a repeated user choice.",
          source: "eventType",
          weight: 3,
        },
      ];
    case "manual_replay":
      return [
        {
          code: "manual-replay-event",
          description: "The event was replayed intentionally for learning.",
          source: "eventType",
          weight: 4,
        },
      ];
    case "user_prompt":
      return [];
  }
}

function phraseReasons(prompt: string): LearningSignalReason[] {
  return phraseSignals
    .filter((signal) => signal.pattern.test(prompt))
    .map((signal) => ({
      code: signal.code,
      description: signal.description,
      source: "userPrompt" as const,
      weight: signal.weight,
    }));
}

function metadataReasons(metadata: Record<string, unknown>): LearningSignalReason[] {
  const reasons: LearningSignalReason[] = [];

  if (booleanMetadata(metadata, "explicitPreference")) {
    reasons.push({
      code: "metadata-explicit-preference",
      description: "Adapter metadata marked the event as an explicit preference.",
      source: "metadata",
      weight: 5,
    });
  }

  if (booleanMetadata(metadata, "repeatedChoice")) {
    reasons.push({
      code: "metadata-repeated-choice",
      description: "Adapter metadata marked a repeated user choice.",
      source: "metadata",
      weight: 3,
    });
  }

  if (booleanMetadata(metadata, "userEditedGeneratedOutput")) {
    reasons.push({
      code: "metadata-user-edit",
      description: "Adapter metadata marked a user edit to generated output.",
      source: "metadata",
      weight: 2,
    });
  }

  if (booleanMetadata(metadata, "rejectedAction")) {
    reasons.push({
      code: "metadata-rejected-action",
      description: "Adapter metadata marked a rejected agent action.",
      source: "metadata",
      weight: 2,
    });
  }

  return reasons;
}

function booleanMetadata(metadata: Record<string, unknown>, key: string): boolean {
  return metadata[key] === true;
}
