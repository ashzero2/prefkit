import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { StoreConfig } from "../config/types.js";
import type { PreferenceSearchOptions, PreferenceSearchResult } from "../retrieval/types.js";
import type { StoreContext } from "./context.js";
import {
  evaluateOutcomes as evaluateOutcomesReport,
  preferenceStats,
  recordContext as recordContextMetric,
  recordCorrection as recordCorrectionMetric,
  recordEvaluationOutcome as recordEvaluationOutcomeMetric,
} from "./metrics.js";
import { migrations } from "./migrations.js";
import {
  countDistinctSessions as countDistinctSessionsFor,
  countPositiveEvidence as countPositiveEvidenceFor,
  countPreferences,
  findPreferenceByStatement,
  forgetPreference,
  getEvidenceStats,
  getPreference,
  listPreferences,
  pinPreference,
  rememberPreference,
  reviewPreference,
} from "./preferences.js";
import { searchPreferences } from "./search.js";
import { exportJson, exportMarkdown, importJson } from "./transfer.js";
import type {
  ContextMetricInput,
  CorrectionMetricInput,
  EvaluationOutcomeInput,
  EvidenceStats,
  ImportReport,
  ListPreferencesOptions,
  OutcomeEvaluation,
  PreferenceRecord,
  PreferenceReviewDecision,
  PreferenceStats,
  PreferenceStore,
  PreferenceWithEvidence,
  RememberPreferenceInput,
  ScopeType,
} from "./types.js";

export class SqlitePreferenceStore implements PreferenceStore {
  private readonly db: DatabaseHandle;
  private readonly ctx: StoreContext;

  constructor(private readonly config: StoreConfig) {
    mkdirSync(dirname(config.path), { recursive: true });
    this.db = new Database(config.path);
    this.configure();
    this.ctx = { db: this.db, config: this.config, ensureSchema: () => this.init() };
  }

  init(): void {
    this.applyMigrations();
  }

  close(): void {
    this.db.close();
  }

  async backup(destination: string): Promise<void> {
    this.init();
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
  }

  remember(input: RememberPreferenceInput): PreferenceWithEvidence {
    return rememberPreference(this.ctx, input);
  }

  list(options: ListPreferencesOptions = {}): PreferenceRecord[] {
    return listPreferences(this.ctx, options);
  }

  count(options: ListPreferencesOptions = {}): number {
    return countPreferences(this.ctx, options);
  }

  search(options: PreferenceSearchOptions): PreferenceSearchResult[] {
    return searchPreferences(this.ctx, options);
  }

  get(id: string): PreferenceWithEvidence | null {
    return getPreference(this.ctx, id);
  }

  findByStatement(
    normalizedStatement: string,
    scopeType: ScopeType,
    scopeValue?: string | null,
  ): PreferenceWithEvidence | null {
    return findPreferenceByStatement(this.ctx, normalizedStatement, scopeType, scopeValue);
  }

  countPositiveEvidence(preferenceId: string): number {
    return countPositiveEvidenceFor(this.ctx, preferenceId);
  }

  countDistinctSessions(preferenceId: string): number {
    return countDistinctSessionsFor(this.ctx, preferenceId);
  }

  getEvidenceStats(preferenceId: string): EvidenceStats {
    return getEvidenceStats(this.ctx, preferenceId);
  }

  stats(): PreferenceStats {
    return preferenceStats(this.ctx);
  }

  recordContext(input: ContextMetricInput): void {
    recordContextMetric(this.ctx, input);
  }

  recordCorrection(input: CorrectionMetricInput): boolean {
    return recordCorrectionMetric(this.ctx, input);
  }

  recordEvaluationOutcome(input: EvaluationOutcomeInput): void {
    recordEvaluationOutcomeMetric(this.ctx, input);
  }

  evaluateOutcomes(): OutcomeEvaluation {
    return evaluateOutcomesReport(this.ctx);
  }

  pin(id: string): PreferenceRecord | null {
    return pinPreference(this.ctx, id);
  }

  forget(id: string): PreferenceRecord | null {
    return forgetPreference(this.ctx, id);
  }

  review(id: string, decision: PreferenceReviewDecision): PreferenceRecord | null {
    return reviewPreference(this.ctx, id, decision);
  }

  exportMarkdown(): string {
    return exportMarkdown(this.ctx);
  }

  exportJson(): string {
    return exportJson(this.ctx);
  }

  importJson(input: string): ImportReport {
    return importJson(this.ctx, input);
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
      const apply = this.db.transaction(() => {
        const existing = this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migration.id);
        if (existing !== undefined) {
          return;
        }

        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.id, migration.name, new Date().toISOString());
      });
      apply.immediate();
    }
  }
}

export function createPreferenceStore(config: StoreConfig): PreferenceStore {
  return new SqlitePreferenceStore(config);
}

export function storeExists(config: StoreConfig): boolean {
  return existsSync(config.path);
}
