export { defaultConfig } from "./config/defaults.js";
export { expandHome, loadConfig } from "./config/load.js";
export type {
  ApiModelConfig,
  ConfigLoadResult,
  InjectionConfig,
  LearningConfig,
  LocalModelConfig,
  LocalModelThinkMode,
  PrefKitConfig,
  PrivacyConfig,
  StoreConfig,
} from "./config/types.js";
export { runDoctor } from "./doctor.js";
export type { DoctorCheck, DoctorReport } from "./doctor.js";
export {
  contradictionActionSchema,
  contradictionKindSchema,
  extractorJsonSchema,
  extractorOutputSchema,
  learnerEventSchema,
  learnerEventTypeSchema,
  validateExtractorOutput,
  validateLearnerEvent,
} from "./learner/schemas.js";
export { scoreLearnerEvent } from "./learner/prefilter.js";
export { calculatePreferenceConfidence } from "./learner/confidence.js";
export { extractPreference } from "./learner/extractor.js";
export type {
  ContradictionAction,
  ContradictionKind,
  ExtractorOutput,
  LearnerEvent,
  LearnerEventType,
  ValidationFailure,
  ValidationResult,
  ValidationSuccess,
} from "./learner/schemas.js";
export type {
  LearningPrefilterDecision,
  LearningPrefilterOptions,
  LearningSignalReason,
  LearningSignalSource,
} from "./learner/prefilter.js";
export type {
  ConfidenceDecision,
  ConfidenceInput,
  ConfidenceOptions,
  ConfidenceReason,
} from "./learner/confidence.js";
export type {
  PreferenceExtractionOptions,
  PreferenceExtractionResult,
  PreferenceExtractionSkipped,
  PreferenceExtractionStatus,
  PreferenceExtractionSuccess,
} from "./learner/extractor.js";
export { OllamaModel } from "./model/ollama.js";
export type {
  ModelHealth,
  ModelJsonMessage,
  ModelJsonMessageRole,
  ModelJsonRequest,
  ModelJsonResult,
  ModelUsage,
  PrefKitJsonModel,
  PrefKitModel,
} from "./model/types.js";
export { redactLearnerEvent, redactText } from "./redaction/redact.js";
export type {
  RedactedLearnerEvent,
  RedactedText,
  RedactionFinding,
  RedactionKind,
  RedactionOptions,
} from "./redaction/types.js";
export { renderPreferenceContext, estimateTokens } from "./formatting/context.js";
export { ftsQuery, lexicalOverlap, queryTerms } from "./retrieval/query.js";
export type {
  ContextRenderOptions,
  PreferenceSearchOptions,
  PreferenceSearchResult,
  RenderedContext,
} from "./retrieval/types.js";
export { createPreferenceStore, SqlitePreferenceStore, storeExists } from "./store/sqlite.js";
export type {
  EvidencePolarity,
  EvidenceRecord,
  EvidenceSourceType,
  ListPreferencesOptions,
  PreferenceRecord,
  PreferenceReviewDecision,
  PreferenceStatus,
  PreferenceStore,
  PreferenceWithEvidence,
  RememberPreferenceInput,
  ScopeType,
} from "./store/types.js";
