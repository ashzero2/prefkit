import type { PreferenceSearchOptions, PreferenceSearchResult } from "../retrieval/types.js";

export type PreferenceStatus = "candidate" | "active" | "pinned" | "suppressed" | "superseded" | "rejected";
export type PreferenceReviewDecision = "accept" | "reject";
export type ScopeType = "global" | "repository" | "path" | "task" | "agent";
export type EvidencePolarity = "positive" | "negative" | "neutral";
export type EvidenceSourceType = "USER_EXPLICIT" | "MODEL_EXTRACTED" | "AGENT_EVENT" | "IMPORT";

export interface PreferenceRecord {
  id: string;
  statement: string;
  normalizedStatement: string;
  scopeType: ScopeType;
  scopeValue: string | null;
  category: string;
  tags: string[];
  confidence: number;
  status: PreferenceStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  supersedesId: string | null;
  metadata: Record<string, unknown>;
}

export interface EvidenceRecord {
  id: string;
  preferenceId: string;
  sessionId: string | null;
  agent: string | null;
  sourceType: EvidenceSourceType;
  polarity: EvidencePolarity;
  weight: number;
  summary: string;
  evidenceHash: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface PreferenceWithEvidence {
  preference: PreferenceRecord;
  evidence: EvidenceRecord[];
}

export interface ImportReport {
  preferencesImported: number;
  preferencesSkipped: number;
  evidenceImported: number;
  conflicts: number;
}

export interface EvidenceStats {
  positiveCount: number;
  distinctCwds: number;
}

export interface PreferenceStats {
  preferences: {
    total: number;
    byStatus: Record<PreferenceStatus, number>;
  };
  evidence: {
    total: number;
    bySourceType: Record<EvidenceSourceType, number>;
    byPolarity: Record<EvidencePolarity, number>;
  };
  metrics: {
    contextRequests: number;
    contextMatches: number;
    contextHits: number;
    contextInjectedRules: number;
    contextInjectedTokens: number;
    contextHitRate: number;
    correctionsAfterContext: number;
    correctionsWithoutContext: number;
  };
}

export interface ContextMetricInput {
  matchedRules: number;
  injectedRules: number;
  tokenEstimate: number;
  sessionId?: string | null;
  injectedPreferenceIds?: string[];
}

export interface CorrectionMetricInput {
  sessionId?: string | null;
}

export interface EvaluationOutcomeInput {
  sessionId: string;
  correctionObserved: boolean;
  /** Required only when no context exposure was recorded for the session. */
  contextInjected?: boolean;
}

export interface EvaluationGroup {
  sessions: number;
  corrections: number;
  correctionRate: number | null;
}

export interface OutcomeEvaluation {
  status: "ready" | "insufficient_data";
  completedSessions: number;
  openSessions: number;
  withContext: EvaluationGroup;
  withoutContext: EvaluationGroup;
  absoluteRateDifference: number | null;
  relativeRateDifference: number | null;
}

export interface RememberPreferenceInput {
  statement: string;
  scopeType?: ScopeType;
  scopeValue?: string | null;
  category?: string;
  tags?: string[];
  confidence?: number;
  status?: PreferenceStatus;
  source?: string;
  /** Revives an existing suppressed or rejected rule instead of leaving it inactive. */
  reactivate?: boolean;
  /** Proposed predecessor; applied only when this candidate is accepted. */
  supersedesId?: string | null;
  evidence?: {
    sessionId?: string | null;
    agent?: string | null;
    summary?: string;
    sourceType?: EvidenceSourceType;
    polarity?: EvidencePolarity;
    weight?: number;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface ListPreferencesOptions {
  includeInactive?: boolean;
  status?: PreferenceStatus;
  scope?: ScopeType;
  scopeValue?: string;
  limit?: number;
  offset?: number;
}

export interface PreferenceStore {
  init(): void;
  close(): void;
  backup(destination: string): Promise<void>;
  remember(input: RememberPreferenceInput): PreferenceWithEvidence;
  list(options?: ListPreferencesOptions): PreferenceRecord[];
  count(options?: ListPreferencesOptions): number;
  search(options: PreferenceSearchOptions): PreferenceSearchResult[];
  get(id: string): PreferenceWithEvidence | null;
  findByStatement(
    normalizedStatement: string,
    scopeType: ScopeType,
    scopeValue?: string | null,
  ): PreferenceWithEvidence | null;
  countPositiveEvidence(preferenceId: string): number;
  getEvidenceStats(preferenceId: string): EvidenceStats;
  recordContext(input: ContextMetricInput): void;
  recordCorrection(input: CorrectionMetricInput): boolean;
  recordEvaluationOutcome(input: EvaluationOutcomeInput): void;
  evaluateOutcomes(): OutcomeEvaluation;
  stats(): PreferenceStats;
  pin(id: string): PreferenceRecord | null;
  forget(id: string): PreferenceRecord | null;
  review(id: string, decision: PreferenceReviewDecision): PreferenceRecord | null;
  exportMarkdown(): string;
  exportJson(): string;
  importJson(input: string): ImportReport;
}
