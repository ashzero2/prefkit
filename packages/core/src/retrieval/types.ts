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
}

export interface PreferenceSearchResult {
  preference: PreferenceRecord;
  score: number;
  reasons: string[];
}

export interface ContextRenderOptions {
  injection: InjectionConfig;
  includeWhy?: boolean;
}

export interface RenderedContext {
  text: string;
  tokenEstimate: number;
  included: PreferenceSearchResult[];
  omitted: PreferenceSearchResult[];
}
