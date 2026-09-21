import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { StoreConfig } from "../config/types.js";
import { ftsQuery, lexicalOverlap } from "../retrieval/query.js";
import type { PreferenceSearchOptions, PreferenceSearchResult } from "../retrieval/types.js";
import { migrations } from "./migrations.js";
import type {
  EvidencePolarity,
  EvidenceRecord,
  EvidenceSourceType,
  ContextMetricInput,
  CorrectionMetricInput,
  ListPreferencesOptions,
  PreferenceRecord,
  PreferenceReviewDecision,
  PreferenceStatus,
  PreferenceStore,
  PreferenceWithEvidence,
  RememberPreferenceInput,
  ScopeType,
  ImportReport,
  PreferenceStats,
  EvidenceStats,
  EvaluationOutcomeInput,
  EvaluationGroup,
  OutcomeEvaluation,
} from "./types.js";
import { parsePreferenceExport } from "./transfer.js";

type Row = Record<string, unknown>;

const activeStatuses = new Set<PreferenceStatus>(["active", "pinned"]);
const preferenceStatuses = ["candidate", "active", "pinned", "suppressed", "superseded", "rejected"] as const;
const evidenceSourceTypes = ["USER_EXPLICIT", "MODEL_EXTRACTED", "AGENT_EVENT", "IMPORT"] as const;
const evidencePolarities = ["positive", "negative", "neutral"] as const;
const maxContextExposures = 1000;

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

  async backup(destination: string): Promise<void> {
    this.init();
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
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
      supersedesId: input.supersedesId ?? null,
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

    const existingByHash = this.findByEvidenceHash(evidence.evidenceHash);
    if (existingByHash !== null) {
      if (input.reactivate === true && isRevivableStatus(existingByHash.preference.status)) {
        const status = input.status ?? "active";
        this.db
          .prepare("UPDATE preferences SET status = ?, updated_at = ? WHERE id = ?")
          .run(status, now, existingByHash.preference.id);
        return this.get(existingByHash.preference.id) ?? existingByHash;
      }
      return existingByHash;
    }

    const duplicate = this.findByStatement(preference.normalizedStatement, preference.scopeType, preference.scopeValue);
    if (duplicate !== null) {
      const targetPref = duplicate.preference;
      const targetEvidence: EvidenceRecord = {
        ...evidence,
        preferenceId: targetPref.id,
        evidenceHash: evidenceHash(targetPref, evidenceSummary),
      };

      const existingEvidence = this.findByEvidenceHash(targetEvidence.evidenceHash);
      if (existingEvidence !== null) {
        return existingEvidence;
      }

      const newConfidence = clampConfidence(
        input.confidence !== undefined
          ? Math.max(targetPref.confidence, input.confidence)
          : targetPref.confidence,
      );
      const revivedStatus =
        input.reactivate === true && isRevivableStatus(targetPref.status) ? input.status ?? "active" : null;

      this.db.transaction(() => {
        this.insertEvidence(targetEvidence);
        this.db
          .prepare(
            `UPDATE preferences
             SET updated_at = ?,
                 last_seen_at = ?,
                 confidence = ?,
                 status = COALESCE(?, status)
             WHERE id = ?`,
          )
          .run(now, now, newConfidence, revivedStatus, targetPref.id);
      })();

      const updated = this.get(targetPref.id);
      return updated ?? { preference: targetPref, evidence: [targetEvidence] };
    }

    const write = this.db.transaction(() => {
      if (preference.supersedesId !== null && !this.preferenceExists(preference.supersedesId)) {
        throw new Error(`Preference to supersede was not found: ${preference.supersedesId}`);
      }
      this.insertPreference(preference);
      this.insertEvidence(evidence);
    });
    try {
      write();
    } catch (error) {
      if (!isEvidenceUniqueError(error)) {
        throw error;
      }
      const concurrent = this.findByEvidenceHash(evidence.evidenceHash);
      if (concurrent === null) {
        throw error;
      }
      return concurrent;
    }

    return { preference, evidence: [evidence] };
  }

  list(options: ListPreferencesOptions = {}): PreferenceRecord[] {
    this.init();

    const limit = boundedLimit(options.limit);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const { whereClause, params } = this.listConditions(options);
    const sql = `
      SELECT * FROM preferences
      ${whereClause}
      ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
               updated_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit, offset) as Row[];
    return rows.map(rowToPreference);
  }

  count(options: ListPreferencesOptions = {}): number {
    this.init();

    const { whereClause, params } = this.listConditions(options);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM preferences ${whereClause}`)
      .get(...params) as Row | undefined;
    return row === undefined ? 0 : numberField(row, "count");
  }

  search(options: PreferenceSearchOptions): PreferenceSearchResult[] {
    this.init();

    const statuses = options.statuses ?? ["active", "pinned"];
    if (statuses.length === 0) {
      return [];
    }

    const limit = boundedLimit(options.limit);
    const minConfidence = Math.max(0, Math.min(1, options.minConfidence ?? 0));
    const query = ftsQuery(options.prompt);
    const ftsRows = query === null ? [] : this.searchFts(query, minConfidence, limit * 3, statuses);

    if (ftsRows.length > 0) {
      const ranked = this.rankCandidates(ftsRows, options, false, limit);
      if (ranked.length > 0) {
        return ranked;
      }
    }

    return this.rankCandidates(this.searchLexicalCandidates(minConfidence, 500, statuses), options, true, limit);
  }

  private rankCandidates(
    rows: Row[],
    options: PreferenceSearchOptions,
    requireOverlap: boolean,
    limit: number,
  ): PreferenceSearchResult[] {
    const prompt = options.prompt;

    return rows
      .map((row) => {
        const preference = rowToPreference(row);
        const scope = scopeMatch(preference, options);
        if (!scope.matches) {
          return null;
        }

        const overlap = lexicalOverlap(prompt, searchableText(preference));
        if (requireOverlap && overlap === 0) {
          return null;
        }

        return {
          preference,
          score: scorePreference(preference, scope.weight, overlap, rankField(row)),
          reasons: resultReasons(preference, scope.reason, overlap, rankField(row)),
        };
      })
      .filter((result): result is PreferenceSearchResult => result !== null)
      .sort((left, right) => right.score - left.score || right.preference.updatedAt.localeCompare(left.preference.updatedAt))
      .slice(0, limit);
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

  findByStatement(
    normalizedStatement: string,
    scopeType: ScopeType,
    scopeValue?: string | null,
  ): PreferenceWithEvidence | null {
    this.init();

    const normalized = normalizeWhitespace(normalizedStatement).toLowerCase();
    const row =
      scopeValue === null || scopeValue === undefined
        ? (this.db
            .prepare(
              `SELECT * FROM preferences
               WHERE normalized_statement = ?
                 AND scope_type = ?
                 AND scope_value IS NULL
               LIMIT 1`,
            )
            .get(normalized, scopeType) as Row | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM preferences
               WHERE normalized_statement = ?
                 AND scope_type = ?
                 AND scope_value = ?
               LIMIT 1`,
            )
            .get(normalized, scopeType, scopeValue) as Row | undefined);

    if (row === undefined) {
      return null;
    }
    const preference = rowToPreference(row);
    return {
      preference,
      evidence: this.evidenceFor(preference.id),
    };
  }

  countPositiveEvidence(preferenceId: string): number {
    this.init();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM evidence
         WHERE preference_id = ? AND polarity = 'positive'`,
      )
      .get(preferenceId) as Row | undefined;
    return row === undefined ? 0 : numberField(row, "count");
  }

  getEvidenceStats(preferenceId: string): EvidenceStats {
    this.init();
    const positiveCount = this.countPositiveEvidence(preferenceId);
    const rows = this.db
      .prepare("SELECT metadata_json FROM evidence WHERE preference_id = ?")
      .all(preferenceId) as Row[];

    const cwds = new Set<string>();
    for (const row of rows) {
      try {
        const metadata = JSON.parse(stringField(row, "metadata_json")) as Record<string, unknown>;
        if (typeof metadata.cwd === "string" && metadata.cwd.length > 0) {
          cwds.add(metadata.cwd);
        }
      } catch {
        // ignore unparseable metadata
      }
    }

    return {
      positiveCount,
      distinctCwds: cwds.size,
    };
  }

  stats(): PreferenceStats {
    this.init();

    const byStatus = emptyCounts(preferenceStatuses);
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS count FROM preferences GROUP BY status").all() as Row[]) {
      const status = stringField(row, "status");
      if (isPreferenceStatus(status)) {
        byStatus[status] = numberField(row, "count");
      }
    }

    const bySourceType = emptyCounts(evidenceSourceTypes);
    const byPolarity = emptyCounts(evidencePolarities);
    for (const row of this.db
      .prepare("SELECT source_type, polarity, COUNT(*) AS count FROM evidence GROUP BY source_type, polarity")
      .all() as Row[]) {
      const count = numberField(row, "count");
      const sourceType = stringField(row, "source_type");
      const polarity = stringField(row, "polarity");
      if (isEvidenceSourceType(sourceType)) {
        bySourceType[sourceType] += count;
      }
      if (isEvidencePolarity(polarity)) {
        byPolarity[polarity] += count;
      }
    }

    const contextRequests = this.metricValue("context_requests");
    const contextMatches = this.metricValue("context_matches");
    const contextHits = this.metricValue("context_hits");
    const contextInjectedRules = this.metricValue("context_injected_rules");
    const contextInjectedTokens = this.metricValue("context_injected_tokens");
    const correctionsAfterContext = this.metricValue("corrections_after_context");
    const correctionsWithoutContext = this.metricValue("corrections_without_context");

    return {
      preferences: {
        total: Object.values(byStatus).reduce((total, count) => total + count, 0),
        byStatus,
      },
      evidence: {
        total: Object.values(byPolarity).reduce((total, count) => total + count, 0),
        bySourceType,
        byPolarity,
      },
      metrics: {
        contextRequests,
        contextMatches,
        contextHits,
        contextInjectedRules,
        contextInjectedTokens,
        contextHitRate: contextRequests === 0 ? 0 : contextHits / contextRequests,
        correctionsAfterContext,
        correctionsWithoutContext,
      },
    };
  }

  recordContext(input: ContextMetricInput): void {
    this.init();

    const matchedRules = nonNegativeInteger(input.matchedRules);
    const injectedRules = nonNegativeInteger(input.injectedRules);
    const tokenEstimate = nonNegativeInteger(input.tokenEstimate);
    const sessionHash = hashSessionId(input.sessionId);
    const preferenceIds = normalizePreferenceIds(input.injectedPreferenceIds);
    const increment = this.db.prepare(
      `INSERT INTO metrics (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = metrics.value + excluded.value`,
    );
    const record = this.db.transaction(() => {
      increment.run("context_requests", 1);
      increment.run("context_matches", matchedRules);
      increment.run("context_hits", injectedRules > 0 ? 1 : 0);
      increment.run("context_injected_rules", injectedRules);
      increment.run("context_injected_tokens", tokenEstimate);
      if (sessionHash !== null && injectedRules > 0) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO evaluation_sessions
              (session_hash, context_injected, correction_observed, status, created_at, updated_at, closed_at)
             VALUES (?, 1, 0, 'open', ?, ?, NULL)
             ON CONFLICT(session_hash) DO UPDATE SET
               context_injected = CASE
                 WHEN evaluation_sessions.status = 'closed' THEN evaluation_sessions.context_injected
                 ELSE 1
               END,
               updated_at = excluded.updated_at,
               status = CASE WHEN evaluation_sessions.status = 'closed' THEN 'closed' ELSE 'open' END`,
          )
          .run(sessionHash, now, now);
      }
      if (sessionHash !== null && preferenceIds.length > 0) {
        this.db
          .prepare(
            `INSERT INTO context_exposures (session_hash, preference_ids_json, created_at) VALUES (?, ?, ?)
             ON CONFLICT(session_hash) DO UPDATE SET preference_ids_json = excluded.preference_ids_json,
                                                     created_at = excluded.created_at`,
          )
          .run(sessionHash, JSON.stringify(preferenceIds), new Date().toISOString());
        this.db
          .prepare(
            `DELETE FROM context_exposures
             WHERE rowid NOT IN (
               SELECT rowid FROM context_exposures ORDER BY created_at DESC LIMIT ?
             )`,
          )
          .run(maxContextExposures);
      }
    });
    record();
  }

  recordCorrection(input: CorrectionMetricInput): boolean {
    this.init();

    const sessionHash = hashSessionId(input.sessionId);
    const increment = this.db.prepare(
      `INSERT INTO metrics (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = metrics.value + 1`,
    );
    const record = this.db.transaction(() => {
      const linked =
        sessionHash !== null &&
        this.db.prepare("SELECT 1 FROM context_exposures WHERE session_hash = ?").get(sessionHash) !== undefined;
      const existingEvaluation =
        sessionHash === null
          ? undefined
          : (this.db
              .prepare("SELECT context_injected, status FROM evaluation_sessions WHERE session_hash = ?")
              .get(sessionHash) as Row | undefined);
      const contextInjected =
        linked || (existingEvaluation !== undefined && numberField(existingEvaluation, "context_injected") === 1);
      if (sessionHash !== null && linked) {
        this.db.prepare("DELETE FROM context_exposures WHERE session_hash = ?").run(sessionHash);
      }
      if (sessionHash !== null && (existingEvaluation === undefined || stringField(existingEvaluation, "status") !== "closed")) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO evaluation_sessions
              (session_hash, context_injected, correction_observed, status, created_at, updated_at, closed_at)
             VALUES (?, ?, 1, 'open', ?, ?, NULL)
             ON CONFLICT(session_hash) DO UPDATE SET
               context_injected = CASE
                 WHEN evaluation_sessions.context_injected = 1 OR excluded.context_injected = 1 THEN 1
                 ELSE 0
               END,
               correction_observed = 1,
               updated_at = excluded.updated_at,
               status = CASE WHEN evaluation_sessions.status = 'closed' THEN 'closed' ELSE 'open' END`,
          )
          .run(sessionHash, contextInjected ? 1 : 0, now, now);
      }
      increment.run(linked ? "corrections_after_context" : "corrections_without_context");
      return linked;
    });
    return record();
  }

  recordEvaluationOutcome(input: EvaluationOutcomeInput): void {
    this.init();

    const sessionHash = hashSessionId(input.sessionId);
    if (sessionHash === null) {
      throw new Error("An evaluation outcome requires a non-empty sessionId.");
    }

    const record = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM evaluation_sessions WHERE session_hash = ?")
        .get(sessionHash) as Row | undefined;
      const existingContext = existing === undefined ? undefined : numberField(existing, "context_injected") === 1;
      const existingCorrection = existing === undefined ? false : numberField(existing, "correction_observed") === 1;
      const contextInjected = input.contextInjected ?? existingContext;
      if (contextInjected === undefined) {
        throw new Error(
          "This session has no recorded context exposure. Provide contextInjected explicitly when recording the outcome.",
        );
      }
      if (existingContext !== undefined && existingContext !== contextInjected) {
        throw new Error("The recorded context condition does not match this session's existing observation.");
      }
      if (!input.correctionObserved && existingCorrection) {
        throw new Error("This session already has an explicit correction recorded; it cannot be marked correction-free.");
      }

      const correctionObserved = existingCorrection || input.correctionObserved;
      const now = new Date().toISOString();
      if (existing?.status === "closed") {
        if (existingCorrection === correctionObserved) {
          return;
        }
        throw new Error("This session already has a conflicting closed outcome.");
      }

      this.db
        .prepare(
          `INSERT INTO evaluation_sessions
            (session_hash, context_injected, correction_observed, status, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, 'closed', ?, ?, ?)
           ON CONFLICT(session_hash) DO UPDATE SET
             correction_observed = excluded.correction_observed,
             status = 'closed',
             updated_at = excluded.updated_at,
             closed_at = excluded.closed_at`,
        )
        .run(
          sessionHash,
          contextInjected ? 1 : 0,
          correctionObserved ? 1 : 0,
          existing === undefined ? now : stringField(existing, "created_at"),
          now,
          now,
        );
    });
    record();
  }

  evaluateOutcomes(): OutcomeEvaluation {
    this.init();

    const groups = {
      withContext: { sessions: 0, corrections: 0 },
      withoutContext: { sessions: 0, corrections: 0 },
    };
    for (const row of this.db
      .prepare(
        `SELECT context_injected, correction_observed, COUNT(*) AS sessions
         FROM evaluation_sessions
         WHERE status = 'closed'
         GROUP BY context_injected, correction_observed`,
      )
      .all() as Row[]) {
      const group = numberField(row, "context_injected") === 1 ? groups.withContext : groups.withoutContext;
      const sessions = numberField(row, "sessions");
      group.sessions += sessions;
      group.corrections += sessions * numberField(row, "correction_observed");
    }

    const withContext = evaluationGroup(groups.withContext);
    const withoutContext = evaluationGroup(groups.withoutContext);
    const withRate = withContext.correctionRate;
    const withoutRate = withoutContext.correctionRate;
    const absoluteRateDifference = withRate === null || withoutRate === null ? null : withoutRate - withRate;
    const relativeRateDifference =
      absoluteRateDifference === null || withoutRate === null || withoutRate === 0
        ? null
        : absoluteRateDifference / withoutRate;

    return {
      status: withContext.sessions > 0 && withoutContext.sessions > 0 ? "ready" : "insufficient_data",
      completedSessions: withContext.sessions + withoutContext.sessions,
      openSessions: numberField(
        this.db.prepare("SELECT COUNT(*) AS count FROM evaluation_sessions WHERE status = 'open'").get() as Row,
        "count",
      ),
      withContext,
      withoutContext,
      absoluteRateDifference,
      relativeRateDifference,
    };
  }

  pin(id: string): PreferenceRecord | null {
    return this.updateStatus(id, "pinned");
  }

  forget(id: string): PreferenceRecord | null {
    return this.updateStatus(id, "suppressed");
  }

  review(id: string, decision: PreferenceReviewDecision): PreferenceRecord | null {
    this.init();

    const reviewed = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
      if (row === undefined) {
        return false;
      }

      const now = new Date().toISOString();
      const status = decision === "accept" ? "active" : "rejected";
      this.db.prepare("UPDATE preferences SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);

      if (decision === "accept") {
        const supersedesId = nullableStringField(row, "supersedes_id");
        if (supersedesId !== null) {
          this.db
            .prepare("UPDATE preferences SET status = 'superseded', updated_at = ? WHERE id = ?")
            .run(now, supersedesId);
        }
      }
      return true;
    })();

    if (!reviewed) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : rowToPreference(row);
  }

  exportMarkdown(): string {
    const preferences = this.allPreferences();
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
      if (pref.supersedesId !== null) {
        lines.push(`- supersedes: ${pref.supersedesId}`);
      }
      lines.push(`- updated: ${pref.updatedAt}`);
      lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  exportJson(): string {
    this.init();
    const preferences = this.allPreferences().map((preference) => ({
      preference,
      evidence: this.evidenceFor(preference.id),
    }));
    return `${JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), preferences }, null, 2)}\n`;
  }

  importJson(input: string): ImportReport {
    this.init();
    const transfer = parsePreferenceExport(input);

    return this.db.transaction(() => {
      const report: ImportReport = {
        preferencesImported: 0,
        preferencesSkipped: 0,
        evidenceImported: 0,
        conflicts: 0,
      };
      const pendingSupersessions: Array<{ id: string; supersedesId: string }> = [];

      for (const item of transfer.preferences) {
        const existing = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(item.preference.id) as Row | undefined;
        if (existing !== undefined) {
          if (!samePreference(rowToPreference(existing), item.preference)) {
            report.conflicts += 1;
            continue;
          }
          report.preferencesSkipped += 1;
        } else {
          this.insertPreference({ ...item.preference, supersedesId: null });
          report.preferencesImported += 1;
          if (item.preference.supersedesId !== null) {
            pendingSupersessions.push({ id: item.preference.id, supersedesId: item.preference.supersedesId });
          }
        }

        for (const evidence of item.evidence) {
          const byHash = this.db.prepare("SELECT preference_id FROM evidence WHERE evidence_hash = ?").get(evidence.evidenceHash) as
            | Row
            | undefined;
          if (byHash !== undefined) {
            if (byHash.preference_id !== item.preference.id) {
              report.conflicts += 1;
            }
            continue;
          }

          const byId = this.db.prepare("SELECT preference_id FROM evidence WHERE id = ?").get(evidence.id) as Row | undefined;
          if (byId !== undefined) {
            report.conflicts += 1;
            continue;
          }

          this.insertEvidence(evidence);
          report.evidenceImported += 1;
        }
      }

      for (const supersession of pendingSupersessions) {
        if (!this.preferenceExists(supersession.supersedesId)) {
          report.conflicts += 1;
          continue;
        }
        this.db
          .prepare("UPDATE preferences SET supersedes_id = ? WHERE id = ?")
          .run(supersession.supersedesId, supersession.id);
      }

      return report;
    })();
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

  private allPreferences(): PreferenceRecord[] {
    return (this.db.prepare("SELECT * FROM preferences ORDER BY updated_at DESC").all() as Row[]).map(rowToPreference);
  }

  private findByEvidenceHash(hash: string): PreferenceWithEvidence | null {
    const row = this.db.prepare("SELECT preference_id FROM evidence WHERE evidence_hash = ?").get(hash) as Row | undefined;
    if (row === undefined) {
      return null;
    }
    const preferenceId = stringField(row, "preference_id");
    const preferenceRow = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(preferenceId) as Row | undefined;
    if (preferenceRow === undefined) {
      return null;
    }
    return {
      preference: rowToPreference(preferenceRow),
      evidence: this.evidenceFor(preferenceId),
    };
  }

  private preferenceExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM preferences WHERE id = ?").get(id) !== undefined;
  }

  private metricValue(name: string): number {
    const row = this.db.prepare("SELECT value FROM metrics WHERE name = ?").get(name) as Row | undefined;
    return row === undefined ? 0 : numberField(row, "value");
  }

  private listConditions(options: ListPreferencesOptions): { whereClause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.status !== undefined) {
      conditions.push("status = ?");
      params.push(options.status);
    } else if (options.includeInactive !== true) {
      conditions.push("status IN ('active', 'pinned')");
    }

    if (options.scope !== undefined) {
      conditions.push("scope_type = ?");
      params.push(options.scope);
    }

    if (options.scopeValue !== undefined) {
      conditions.push("scope_value = ?");
      params.push(options.scopeValue);
    }

    return { whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
  }

  private searchFts(query: string, minConfidence: number, limit: number, statuses: PreferenceStatus[]): Row[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    try {
      return this.db
        .prepare(
          `SELECT p.*, preferences_fts.rank AS fts_rank
           FROM preferences_fts
           JOIN preferences p ON preferences_fts.rowid = p.rowid
           WHERE preferences_fts MATCH ?
             AND p.status IN (${placeholders})
             AND p.confidence >= ?
           ORDER BY preferences_fts.rank
           LIMIT ?`,
        )
        .all(query, ...statuses, minConfidence, limit) as Row[];
    } catch (error) {
      if (isMissingFtsError(error)) {
        return [];
      }
      throw error;
    }
  }

  private searchLexicalCandidates(minConfidence: number, limit: number, statuses: PreferenceStatus[]): Row[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT *
         FROM preferences
         WHERE status IN (${placeholders})
           AND confidence >= ?
         ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                  updated_at DESC
         LIMIT ?`,
      )
      .all(...statuses, minConfidence, limit) as Row[];
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

function emptyCounts<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function evaluationGroup(input: { sessions: number; corrections: number }): EvaluationGroup {
  return {
    sessions: input.sessions,
    corrections: input.corrections,
    correctionRate: input.sessions === 0 ? null : input.corrections / input.sessions,
  };
}

function isPreferenceStatus(value: string): value is PreferenceStatus {
  return (preferenceStatuses as readonly string[]).includes(value);
}

function isEvidenceSourceType(value: string): value is EvidenceSourceType {
  return (evidenceSourceTypes as readonly string[]).includes(value);
}

function isEvidencePolarity(value: string): value is EvidencePolarity {
  return (evidencePolarities as readonly string[]).includes(value);
}

function samePreference(left: PreferenceRecord, right: PreferenceRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function hashSessionId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim().length === 0) {
    return null;
  }
  return createHash("sha256").update(value).digest("hex");
}

function normalizePreferenceIds(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.trim().length > 0))].slice(0, 20);
}

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 100, 500));
}

interface ScopeMatch {
  matches: boolean;
  weight: number;
  reason: string;
}

function scopeMatch(preference: PreferenceRecord, options: PreferenceSearchOptions): ScopeMatch {
  const match = scopeSpecificMatch(preference, options);
  if (options.scopeAgnostic === true && !match.matches) {
    return { matches: true, weight: match.weight, reason: "scope-agnostic" };
  }
  return match;
}

function scopeSpecificMatch(preference: PreferenceRecord, options: PreferenceSearchOptions): ScopeMatch {
  switch (preference.scopeType) {
    case "global":
      return { matches: true, weight: 0.2, reason: "global" };
    case "agent":
      return {
        matches: preference.scopeValue === null || preference.scopeValue === options.agent,
        weight: 0.35,
        reason: "agent",
      };
    case "task":
      return {
        matches:
          preference.scopeValue !== null && options.sessionId !== undefined && preference.scopeValue === options.sessionId,
        weight: 0.45,
        reason: "task",
      };
    case "repository":
      return {
        matches: pathWithin(options.cwd, preference.scopeValue) || pathWithin(options.path, preference.scopeValue),
        weight: 0.4,
        reason: "repository",
      };
    case "path":
      return {
        matches: pathWithin(options.path, preference.scopeValue) || pathWithin(options.cwd, preference.scopeValue),
        weight: 0.45,
        reason: "path",
      };
  }
}

function pathWithin(value: string | undefined, scopeValue: string | null): boolean {
  if (scopeValue === null) {
    return false;
  }
  if (value === undefined) {
    return false;
  }
  const valueStyle = pathStyle(value);
  if (valueStyle !== pathStyle(scopeValue)) {
    return false;
  }

  const pathApi = valueStyle === "windows" ? win32 : posix;
  const normalizedValue = canonicalPath(value, pathApi);
  const normalizedScope = canonicalPath(scopeValue, pathApi);
  if (pathApi.isAbsolute(normalizedValue) !== pathApi.isAbsolute(normalizedScope)) {
    return false;
  }

  const relative = pathApi.relative(normalizedScope, normalizedValue);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function pathStyle(value: string): "posix" | "windows" {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.includes("\\") ? "windows" : "posix";
}

function canonicalPath(value: string, pathApi: typeof posix | typeof win32): string {
  const normalized = pathApi.normalize(value);
  let existing = normalized;
  const suffix: string[] = [];

  while (!existsSync(existing) && pathApi.dirname(existing) !== existing) {
    suffix.unshift(pathApi.basename(existing));
    existing = pathApi.dirname(existing);
  }

  if (existsSync(existing)) {
    try {
      return pathApi.normalize(pathApi.join(realpathSync.native(existing), ...suffix));
    } catch {
      // Fall back to lexical normalization when the filesystem cannot resolve it.
    }
  }

  return normalized;
}

function isEvidenceUniqueError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed: evidence.evidence_hash");
}

function isRevivableStatus(status: PreferenceStatus): boolean {
  return status === "suppressed" || status === "rejected";
}

function isMissingFtsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("no such table") ||
    message.includes("no such module") ||
    message.includes("unable to use function")
  );
}

function scorePreference(
  preference: PreferenceRecord,
  scopeWeight: number,
  overlap: number,
  rank: number | null,
): number {
  const statusWeight = preference.status === "pinned" ? 0.5 : preference.status === "active" ? 0.25 : 0.1;
  const ftsScore = rank === null ? 0 : Math.max(0, -rank);
  const rankWeight = rank === null ? 0 : 0.25 * (ftsScore / (1 + ftsScore));
  return preference.confidence + statusWeight + scopeWeight + overlap * 0.15 + rankWeight;
}

function resultReasons(
  preference: PreferenceRecord,
  scopeReason: string,
  overlap: number,
  rank: number | null,
): string[] {
  const reasons = [scopeReason, preference.status];
  if (overlap > 0) {
    reasons.push(`${overlap} prompt term${overlap === 1 ? "" : "s"}`);
  }
  if (rank !== null) {
    reasons.push("fts");
  }
  return reasons;
}

function searchableText(preference: PreferenceRecord): string {
  return [preference.statement, preference.category, ...preference.tags].join(" ");
}

function rankField(row: Row): number | null {
  const value = row.fts_rank;
  return typeof value === "number" ? value : null;
}
