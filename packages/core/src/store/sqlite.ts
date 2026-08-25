import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { StoreConfig } from "../config/types.js";
import { migrations } from "./migrations.js";
import type {
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
} from "./types.js";

type Row = Record<string, unknown>;

const activeStatuses = new Set<PreferenceStatus>(["candidate", "active", "pinned"]);

export class SqlitePreferenceStore implements PreferenceStore {
  private readonly db: DatabaseHandle;

  constructor(private readonly config: StoreConfig) {
    mkdirSync(dirname(config.path), { recursive: true });
    this.db = new Database(config.path);
    this.configure();
  }

  init(): void {
    this.applyMigrations();
  }

  close(): void {
    this.db.close();
  }

  remember(input: RememberPreferenceInput): PreferenceWithEvidence {
    this.init();

    const now = new Date().toISOString();
    const statement = normalizeWhitespace(input.statement);
    if (statement.length === 0) {
      throw new Error("Preference statement cannot be empty.");
    }

    const preference: PreferenceRecord = {
      id: randomId("pref"),
      statement,
      normalizedStatement: normalizeStatement(statement),
      scopeType: input.scopeType ?? "global",
      scopeValue: input.scopeValue ?? null,
      category: normalizeToken(input.category ?? "general"),
      tags: normalizeTags(input.tags ?? []),
      confidence: clampConfidence(input.confidence ?? 1),
      status: input.status ?? "active",
      source: input.source ?? "user",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      supersedesId: null,
      metadata: input.metadata ?? {},
    };

    const evidenceSummary = normalizeWhitespace(input.evidence?.summary ?? statement);
    const evidence: EvidenceRecord = {
      id: randomId("ev"),
      preferenceId: preference.id,
      sessionId: input.evidence?.sessionId ?? null,
      agent: input.evidence?.agent ?? null,
      sourceType: input.evidence?.sourceType ?? "USER_EXPLICIT",
      polarity: input.evidence?.polarity ?? "positive",
      weight: input.evidence?.weight ?? 1,
      summary: evidenceSummary,
      evidenceHash: evidenceHash(preference, evidenceSummary),
      createdAt: now,
      metadata: input.evidence?.metadata ?? {},
    };

    const write = this.db.transaction(() => {
      this.insertPreference(preference);
      this.insertEvidence(evidence);
    });
    write();

    return { preference, evidence: [evidence] };
  }

  list(options: ListPreferencesOptions = {}): PreferenceRecord[] {
    this.init();

    const limit = boundedLimit(options.limit);
    const rows =
      options.status === undefined
        ? (this.db
            .prepare(
              `SELECT * FROM preferences
               ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
                        updated_at DESC
               LIMIT ?`,
            )
            .all(limit) as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM preferences
               WHERE status = ?
               ORDER BY updated_at DESC
               LIMIT ?`,
            )
            .all(options.status, limit) as Row[]);

    const preferences = rows.map(rowToPreference);
    return options.includeInactive === true ? preferences : preferences.filter((pref) => activeStatuses.has(pref.status));
  }

  get(id: string): PreferenceWithEvidence | null {
    this.init();

    const row = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) {
      return null;
    }

    return {
      preference: rowToPreference(row),
      evidence: this.evidenceFor(id),
    };
  }

  pin(id: string): PreferenceRecord | null {
    return this.updateStatus(id, "pinned");
  }

  forget(id: string): PreferenceRecord | null {
    return this.updateStatus(id, "suppressed");
  }

  exportMarkdown(): string {
    const preferences = this.list({ includeInactive: true, limit: 500 });
    const lines = ["# PrefKit Preferences", "", `Exported: ${new Date().toISOString()}`, ""];

    for (const pref of preferences) {
      lines.push(`## ${pref.statement}`);
      lines.push("");
      lines.push(`- id: ${pref.id}`);
      lines.push(`- status: ${pref.status}`);
      lines.push(`- confidence: ${pref.confidence.toFixed(2)}`);
      lines.push(`- scope: ${pref.scopeType}${pref.scopeValue === null ? "" : `:${pref.scopeValue}`}`);
      lines.push(`- category: ${pref.category}`);
      lines.push(`- tags: ${pref.tags.length === 0 ? "none" : pref.tags.join(", ")}`);
      lines.push(`- source: ${pref.source}`);
      lines.push(`- updated: ${pref.updatedAt}`);
      lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  private configure(): void {
    this.db.pragma("foreign_keys = ON");
    this.db.pragma(`busy_timeout = ${Math.max(0, this.config.busyTimeoutMs)}`);
    if (this.config.wal && this.config.path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    for (const migration of migrations) {
      const existing = this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migration.id);
      if (existing !== undefined) {
        continue;
      }

      const apply = this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.id, migration.name, new Date().toISOString());
      });
      apply();
    }
  }

  private insertPreference(preference: PreferenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO preferences (
          id, statement, normalized_statement, scope_type, scope_value, category, tags_json,
          confidence, status, source, created_at, updated_at, last_seen_at, supersedes_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        preference.id,
        preference.statement,
        preference.normalizedStatement,
        preference.scopeType,
        preference.scopeValue,
        preference.category,
        JSON.stringify(preference.tags),
        preference.confidence,
        preference.status,
        preference.source,
        preference.createdAt,
        preference.updatedAt,
        preference.lastSeenAt,
        preference.supersedesId,
        JSON.stringify(preference.metadata),
      );
  }

  private insertEvidence(evidence: EvidenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO evidence (
          id, preference_id, session_id, agent, source_type, polarity, weight,
          summary, evidence_hash, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.id,
        evidence.preferenceId,
        evidence.sessionId,
        evidence.agent,
        evidence.sourceType,
        evidence.polarity,
        evidence.weight,
        evidence.summary,
        evidence.evidenceHash,
        evidence.createdAt,
        JSON.stringify(evidence.metadata),
      );
  }

  private evidenceFor(preferenceId: string): EvidenceRecord[] {
    return (this.db
      .prepare("SELECT * FROM evidence WHERE preference_id = ? ORDER BY created_at DESC")
      .all(preferenceId) as Row[]).map(rowToEvidence);
  }

  private updateStatus(id: string, status: PreferenceStatus): PreferenceRecord | null {
    this.init();

    const now = new Date().toISOString();
    this.db.prepare("UPDATE preferences SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    const row = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : rowToPreference(row);
  }
}

export function createPreferenceStore(config: StoreConfig): PreferenceStore {
  return new SqlitePreferenceStore(config);
}

export function storeExists(config: StoreConfig): boolean {
  return existsSync(config.path);
}

function rowToPreference(row: Row): PreferenceRecord {
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

function rowToEvidence(row: Row): EvidenceRecord {
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

function stringField(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Expected string field ${field}.`);
  }
  return value;
}

function nullableStringField(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected nullable string field ${field}.`);
  }
  return value;
}

function numberField(row: Row, field: string): number {
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

function randomId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function evidenceHash(preference: PreferenceRecord, summary: string): string {
  return createHash("sha256")
    .update([preference.normalizedStatement, preference.scopeType, preference.scopeValue ?? "", summary].join("\0"))
    .digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeStatement(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeToken(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "general";
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeToken).filter((tag) => tag.length > 0))];
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 100, 500));
}
