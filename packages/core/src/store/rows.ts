import type {
  EvidencePolarity,
  EvidenceRecord,
  EvidenceSourceType,
  PreferenceRecord,
  PreferenceStatus,
  ScopeType,
} from "./types.js";

export type Row = Record<string, unknown>;

export function rowToPreference(row: Row): PreferenceRecord {
  return {
    id: stringField(row, "id"),
    statement: stringField(row, "statement"),
    normalizedStatement: stringField(row, "normalized_statement"),
    scopeType: stringField(row, "scope_type") as ScopeType,
    scopeValue: nullableStringField(row, "scope_value"),
    category: stringField(row, "category"),
    tags: jsonArrayField(row, "tags_json"),
    confidence: numberField(row, "confidence"),
    status: stringField(row, "status") as PreferenceStatus,
    source: stringField(row, "source"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
    lastSeenAt: nullableStringField(row, "last_seen_at"),
    supersedesId: nullableStringField(row, "supersedes_id"),
    metadata: jsonObjectField(row, "metadata_json"),
  };
}

export function rowToEvidence(row: Row): EvidenceRecord {
  return {
    id: stringField(row, "id"),
    preferenceId: stringField(row, "preference_id"),
    sessionId: nullableStringField(row, "session_id"),
    agent: nullableStringField(row, "agent"),
    sourceType: stringField(row, "source_type") as EvidenceSourceType,
    polarity: stringField(row, "polarity") as EvidencePolarity,
    weight: numberField(row, "weight"),
    summary: stringField(row, "summary"),
    evidenceHash: stringField(row, "evidence_hash"),
    createdAt: stringField(row, "created_at"),
    metadata: jsonObjectField(row, "metadata_json"),
  };
}

export function samePreference(left: PreferenceRecord, right: PreferenceRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 100, 500));
}

export function stringField(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Expected string field ${field}.`);
  }
  return value;
}

export function nullableStringField(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected nullable string field ${field}.`);
  }
  return value;
}

export function numberField(row: Row, field: string): number {
  const value = row[field];
  if (typeof value !== "number") {
    throw new Error(`Expected number field ${field}.`);
  }
  return value;
}

function jsonArrayField(row: Row, field: string): string[] {
  const value = JSON.parse(stringField(row, field)) as unknown;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected JSON string array field ${field}.`);
  }
  return value;
}

function jsonObjectField(row: Row, field: string): Record<string, unknown> {
  const value = JSON.parse(stringField(row, field)) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected JSON object field ${field}.`);
  }
  return value as Record<string, unknown>;
}
