export type PreferenceStatus = "candidate" | "active" | "pinned" | "suppressed" | "superseded" | "rejected";
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

export interface RememberPreferenceInput {
  statement: string;
  scopeType?: ScopeType;
  scopeValue?: string | null;
  category?: string;
  tags?: string[];
  confidence?: number;
  status?: PreferenceStatus;
  source?: string;
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
  limit?: number;
}

export interface PreferenceStore {
  init(): void;
  close(): void;
  remember(input: RememberPreferenceInput): PreferenceWithEvidence;
  list(options?: ListPreferencesOptions): PreferenceRecord[];
  get(id: string): PreferenceWithEvidence | null;
  pin(id: string): PreferenceRecord | null;
  forget(id: string): PreferenceRecord | null;
  exportMarkdown(): string;
}
