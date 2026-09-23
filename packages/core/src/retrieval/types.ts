import type { InjectionConfig } from "../config/types.js";
import type { PreferenceRecord, PreferenceStatus } from "../store/types.js";

export interface PreferenceSearchOptions {
  prompt: string;
  cwd?: string;
  path?: string;
  agent?: string;
  sessionId?: string;
  limit?: number;
  minConfidence?: number;
  statuses?: PreferenceStatus[];
  scopeAgnostic?: boolean;
  /** Half-life in days for the reuse boost; 0 disables it. */
  usageHalfLifeDays?: number;
}

export interface PreferenceSearchResult {
  preference: PreferenceRecord;
  score: number;
  reasons: string[];
}

export interface ContextRenderOptions {
  injection: InjectionConfig;
  includeWhy?: boolean;
  /** Replaces the default "Relevant user preferences:" header. */
  header?: string;
}

export interface RenderedContext {
  text: string;
  tokenEstimate: number;
  included: PreferenceSearchResult[];
  omitted: PreferenceSearchResult[];
}
