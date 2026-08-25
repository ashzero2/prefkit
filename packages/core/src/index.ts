export { defaultConfig } from "./config/defaults.js";
export { expandHome, loadConfig } from "./config/load.js";
export type {
  ApiModelConfig,
  ConfigLoadResult,
  InjectionConfig,
  LearningConfig,
  LocalModelConfig,
  PrefKitConfig,
  PrivacyConfig,
  StoreConfig,
} from "./config/types.js";
export { runDoctor } from "./doctor.js";
export type { DoctorCheck, DoctorReport } from "./doctor.js";
export { OllamaModel } from "./model/ollama.js";
export type { ModelHealth, PrefKitModel } from "./model/types.js";
export { createPreferenceStore, SqlitePreferenceStore, storeExists } from "./store/sqlite.js";
export type {
  EvidencePolarity,
  EvidenceRecord,
  EvidenceSourceType,
  ListPreferencesOptions,
  PreferenceRecord,
  PreferenceStatus,
  PreferenceStore,
  PreferenceWithEvidence,
  RememberPreferenceInput,
  ScopeType,
} from "./store/types.js";
