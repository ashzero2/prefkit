import type { LearningConfig, LocalModelConfig, PrivacyConfig } from "../config/types.js";
import { estimateTokens } from "../formatting/context.js";
import type { ModelUsage, PrefKitJsonModel } from "../model/types.js";
import { redactLearnerEvent } from "../redaction/redact.js";
import type { RedactionFinding } from "../redaction/types.js";
import { calculatePreferenceConfidence } from "./confidence.js";
import type { ConfidenceDecision, ConfidenceOptions } from "./confidence.js";
import { scoreLearnerEvent } from "./prefilter.js";
import type { LearningPrefilterDecision } from "./prefilter.js";
import { extractorJsonSchema, validateExtractorOutput, validateLearnerEvent } from "./schemas.js";
import type { ExtractorOutput, LearnerEvent, ValidationFailure } from "./schemas.js";

export type PreferenceExtractionStatus =
  | "invalid_event"
  | "learning_skipped"
  | "input_too_large"
  | "model_error"
  | "invalid_model_output"
  | "extracted";

export interface PreferenceExtractionOptions {
  learning: Pick<
    LearningConfig,
    "enabled" | "mode" | "minSignalScore" | "globalPromotionThreshold" | "requireConfirmationForGlobal"
  >;
  privacy: Pick<PrivacyConfig, "redactSecrets" | "maxEvidenceChars">;
  localModel: Pick<LocalModelConfig, "temperature" | "maxInputTokens" | "maxOutputTokens">;
  confidence?: Partial<ConfidenceOptions>;
  existingPositiveEvidence?: number;
  repeatedAcrossRepositories?: boolean;
  userPinned?: boolean;
}

export interface PreferenceExtractionSuccess {
  ok: true;
  status: "extracted";
  model: string;
  event: LearnerEvent;
  redactions: RedactionFinding[];
  prefilter: LearningPrefilterDecision;
  extraction: ExtractorOutput;
  confidence: ConfidenceDecision;
  promptTokenEstimate: number;
  usage?: ModelUsage;
}

export interface PreferenceExtractionSkipped {
  ok: false;
  status: Exclude<PreferenceExtractionStatus, "extracted">;
  model?: string;
  event?: LearnerEvent;
  redactions?: RedactionFinding[];
  prefilter?: LearningPrefilterDecision;
  promptTokenEstimate?: number;
  errors: string[];
}

export type PreferenceExtractionResult = PreferenceExtractionSuccess | PreferenceExtractionSkipped;

interface PromptPacket {
  agent: string;
  cwd?: string;
  sessionId?: string;
  eventType: LearnerEvent["eventType"];
  userPrompt: string;
  assistantSummary: string;
  repoContext: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

const systemPrompt = [
  "You extract stable operational preferences for an AI coding agent.",
  "Return only JSON that matches the provided schema.",
  "Learn concrete working preferences, project conventions, or corrections.",
  "Do not infer personality traits, moods, intent, private attributes, or broad facts about the user.",
  "If the evidence is situational, ambiguous, or not user-originated, set shouldLearn to false.",
].join(" ");

export async function extractPreference(
  input: unknown,
  model: PrefKitJsonModel,
  options: PreferenceExtractionOptions,
): Promise<PreferenceExtractionResult> {
  const eventResult = validateLearnerEvent(input);
  if (!eventResult.ok) {
    return failure("invalid_event", eventResult);
  }

  const redacted = redactLearnerEvent(eventResult.value, options.privacy);
  const prefilter = scoreLearnerEvent(redacted.event, {
    enabled: options.learning.enabled,
    mode: options.learning.mode,
    minSignalScore: options.learning.minSignalScore,
  });

  if (!prefilter.shouldExtract) {
    return {
      ok: false,
      status: "learning_skipped",
      model: model.name(),
      event: redacted.event,
      redactions: redacted.findings,
      prefilter,
      errors: [prefilter.skippedReason ?? "signal-below-threshold"],
    };
  }

  const prompt = buildExtractorPrompt(redacted.event);
  const promptTokenEstimate = estimateTokens(prompt.messages.map((message) => message.content).join("\n"));
  if (promptTokenEstimate > options.localModel.maxInputTokens) {
    return {
      ok: false,
      status: "input_too_large",
      model: model.name(),
      event: redacted.event,
      redactions: redacted.findings,
      prefilter,
      promptTokenEstimate,
      errors: [
        `Prompt token estimate ${promptTokenEstimate} exceeds maxInputTokens ${options.localModel.maxInputTokens}.`,
      ],
    };
  }

  let rawOutput: unknown;
  let usage: ModelUsage | undefined;
  try {
    const result = await model.generateJson({
      messages: prompt.messages,
      schema: extractorJsonSchema,
      temperature: options.localModel.temperature,
      maxOutputTokens: options.localModel.maxOutputTokens,
    });
    rawOutput = result.json;
    usage = result.usage;
  } catch (error) {
    return {
      ok: false,
      status: "model_error",
      model: model.name(),
      event: redacted.event,
      redactions: redacted.findings,
      prefilter,
      promptTokenEstimate,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const extractionResult = validateExtractorOutput(rawOutput);
  if (!extractionResult.ok) {
    return {
      ok: false,
      status: "invalid_model_output",
      model: model.name(),
      event: redacted.event,
      redactions: redacted.findings,
      prefilter,
      promptTokenEstimate,
      errors: extractionResult.errors,
    };
  }

  const confidenceInput = {
    event: redacted.event,
    extraction: extractionResult.value,
    options: {
      globalPromotionThreshold: options.learning.globalPromotionThreshold,
      requireConfirmationForGlobal: options.learning.requireConfirmationForGlobal,
      ...options.confidence,
    },
  };

  const confidence = calculatePreferenceConfidence({
    ...confidenceInput,
    ...(options.existingPositiveEvidence === undefined
      ? {}
      : { existingPositiveEvidence: options.existingPositiveEvidence }),
    ...(options.repeatedAcrossRepositories === undefined
      ? {}
      : { repeatedAcrossRepositories: options.repeatedAcrossRepositories }),
    ...(options.userPinned === undefined ? {} : { userPinned: options.userPinned }),
  });

  return {
    ok: true,
    status: "extracted",
    model: model.name(),
    event: redacted.event,
    redactions: redacted.findings,
    prefilter,
    extraction: extractionResult.value,
    confidence,
    promptTokenEstimate,
    ...(usage === undefined ? {} : { usage }),
  };
}

function buildExtractorPrompt(event: LearnerEvent): { messages: Array<{ role: "system" | "user"; content: string }> } {
  const packet: PromptPacket = {
    agent: event.agent,
    eventType: event.eventType,
    userPrompt: event.userPrompt,
    assistantSummary: event.assistantSummary,
    repoContext: event.repoContext,
    metadata: event.metadata,
    ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
  };

  return {
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: [
          "Extract one durable preference from this redacted evidence packet.",
          "Use this JSON schema exactly:",
          JSON.stringify(extractorJsonSchema),
          "Evidence packet:",
          JSON.stringify(packet),
        ].join("\n"),
      },
    ],
  };
}

function failure(status: "invalid_event", result: ValidationFailure): PreferenceExtractionSkipped {
  return {
    ok: false,
    status,
    errors: result.errors,
  };
}
