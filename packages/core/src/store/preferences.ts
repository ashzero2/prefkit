import { createHash, randomUUID } from "node:crypto";
import type { StoreContext } from "./context.js";
import {
  boundedLimit,
  nullableStringField,
  numberField,
  rowToEvidence,
  rowToPreference,
  type Row,
} from "./rows.js";
import type {
  EvidenceRecord,
  EvidenceStats,
  ListPreferencesOptions,
  PreferenceRecord,
  PreferenceReviewDecision,
  PreferenceStatus,
  PreferenceWithEvidence,
  RememberPreferenceInput,
  ScopeType,
} from "./types.js";

export function rememberPreference(ctx: StoreContext, input: RememberPreferenceInput): PreferenceWithEvidence {
  ctx.ensureSchema();

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

  const existingByHash = findByEvidenceHash(ctx, evidence.evidenceHash);
  if (existingByHash !== null) {
    if (input.reactivate === true && isRevivableStatus(existingByHash.preference.status)) {
      const status = input.status ?? "active";
      ctx.db
        .prepare("UPDATE preferences SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, existingByHash.preference.id);
      return getPreference(ctx, existingByHash.preference.id) ?? existingByHash;
    }
    return existingByHash;
  }

  const duplicate = findPreferenceByStatement(
    ctx,
    preference.normalizedStatement,
    preference.scopeType,
    preference.scopeValue,
  );
  if (duplicate !== null) {
    const targetPref = duplicate.preference;
    const targetEvidence: EvidenceRecord = {
      ...evidence,
      preferenceId: targetPref.id,
      evidenceHash: evidenceHash(targetPref, evidenceSummary),
    };

    const existingEvidence = findByEvidenceHash(ctx, targetEvidence.evidenceHash);
    if (existingEvidence !== null) {
      return existingEvidence;
    }

    const newConfidence = clampConfidence(
      input.confidence !== undefined ? Math.max(targetPref.confidence, input.confidence) : targetPref.confidence,
    );
    const revivedStatus =
      input.reactivate === true && isRevivableStatus(targetPref.status) ? input.status ?? "active" : null;

    ctx.db.transaction(() => {
      insertEvidence(ctx, targetEvidence);
      ctx.db
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

    const updated = getPreference(ctx, targetPref.id);
    return updated ?? { preference: targetPref, evidence: [targetEvidence] };
  }

  const write = ctx.db.transaction(() => {
    if (preference.supersedesId !== null && !preferenceExists(ctx, preference.supersedesId)) {
      throw new Error(`Preference to supersede was not found: ${preference.supersedesId}`);
    }
    insertPreference(ctx, preference);
    insertEvidence(ctx, evidence);
  });
  try {
    write();
  } catch (error) {
    if (!isEvidenceUniqueError(error)) {
      throw error;
    }
    const concurrent = findByEvidenceHash(ctx, evidence.evidenceHash);
    if (concurrent === null) {
      throw error;
    }
    return concurrent;
  }

  return { preference, evidence: [evidence] };
}

export function listPreferences(ctx: StoreContext, options: ListPreferencesOptions = {}): PreferenceRecord[] {
  ctx.ensureSchema();

  const limit = boundedLimit(options.limit);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const { whereClause, params } = listConditions(options);
  const sql = `
    SELECT * FROM preferences
    ${whereClause}
    ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
             updated_at DESC
    LIMIT ? OFFSET ?
  `;

  const rows = ctx.db.prepare(sql).all(...params, limit, offset) as Row[];
  return rows.map(rowToPreference);
}

export function countPreferences(ctx: StoreContext, options: ListPreferencesOptions = {}): number {
  ctx.ensureSchema();

  const { whereClause, params } = listConditions(options);
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS count FROM preferences ${whereClause}`)
    .get(...params) as Row | undefined;
  return row === undefined ? 0 : numberField(row, "count");
}

export function getPreference(ctx: StoreContext, id: string): PreferenceWithEvidence | null {
  ctx.ensureSchema();

  const row = ctx.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
  if (row === undefined) {
    return null;
  }

  return {
    preference: rowToPreference(row),
    evidence: evidenceFor(ctx, id),
  };
}

export function findPreferenceByStatement(
  ctx: StoreContext,
  normalizedStatement: string,
  scopeType: ScopeType,
  scopeValue?: string | null,
): PreferenceWithEvidence | null {
  ctx.ensureSchema();

  const normalized = normalizeWhitespace(normalizedStatement).toLowerCase();
  const row =
    scopeValue === null || scopeValue === undefined
      ? (ctx.db
          .prepare(
            `SELECT * FROM preferences
             WHERE normalized_statement = ?
               AND scope_type = ?
               AND scope_value IS NULL
             LIMIT 1`,
          )
          .get(normalized, scopeType) as Row | undefined)
      : (ctx.db
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
    evidence: evidenceFor(ctx, preference.id),
  };
}

export function countPositiveEvidence(ctx: StoreContext, preferenceId: string): number {
  ctx.ensureSchema();
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE preference_id = ? AND polarity = 'positive'`,
    )
    .get(preferenceId) as Row | undefined;
  return row === undefined ? 0 : numberField(row, "count");
}

export function getEvidenceStats(ctx: StoreContext, preferenceId: string): EvidenceStats {
  const positiveCount = countPositiveEvidence(ctx, preferenceId);
  const rows = ctx.db.prepare("SELECT metadata_json FROM evidence WHERE preference_id = ?").all(preferenceId) as Row[];

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

export function pinPreference(ctx: StoreContext, id: string): PreferenceRecord | null {
  return updatePreferenceStatus(ctx, id, "pinned");
}

export function forgetPreference(ctx: StoreContext, id: string): PreferenceRecord | null {
  return updatePreferenceStatus(ctx, id, "suppressed");
}

export function reviewPreference(
  ctx: StoreContext,
  id: string,
  decision: PreferenceReviewDecision,
): PreferenceRecord | null {
  ctx.ensureSchema();

  const reviewed = ctx.db.transaction(() => {
    const row = ctx.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) {
      return false;
    }

    const now = new Date().toISOString();
    const status = decision === "accept" ? "active" : "rejected";
    ctx.db.prepare("UPDATE preferences SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);

    if (decision === "accept") {
      const supersedesId = nullableStringField(row, "supersedes_id");
      if (supersedesId !== null) {
        ctx.db
          .prepare("UPDATE preferences SET status = 'superseded', updated_at = ? WHERE id = ?")
          .run(now, supersedesId);
      }
    }
    return true;
  })();

  if (!reviewed) {
    return null;
  }
  const row = ctx.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : rowToPreference(row);
}

export function updatePreferenceStatus(
  ctx: StoreContext,
  id: string,
  status: PreferenceStatus,
): PreferenceRecord | null {
  ctx.ensureSchema();

  const now = new Date().toISOString();
  ctx.db.prepare("UPDATE preferences SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  const row = ctx.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : rowToPreference(row);
}

export function insertPreference(ctx: StoreContext, preference: PreferenceRecord): void {
  ctx.db
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

export function insertEvidence(ctx: StoreContext, evidence: EvidenceRecord): void {
  ctx.db
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

export function evidenceFor(ctx: StoreContext, preferenceId: string): EvidenceRecord[] {
  return (
    ctx.db.prepare("SELECT * FROM evidence WHERE preference_id = ? ORDER BY created_at DESC").all(preferenceId) as Row[]
  ).map(rowToEvidence);
}

export function allPreferences(ctx: StoreContext): PreferenceRecord[] {
  return (ctx.db.prepare("SELECT * FROM preferences ORDER BY updated_at DESC").all() as Row[]).map(rowToPreference);
}

export function preferenceExists(ctx: StoreContext, id: string): boolean {
  return ctx.db.prepare("SELECT 1 FROM preferences WHERE id = ?").get(id) !== undefined;
}

function findByEvidenceHash(ctx: StoreContext, hash: string): PreferenceWithEvidence | null {
  const row = ctx.db.prepare("SELECT preference_id FROM evidence WHERE evidence_hash = ?").get(hash) as
    | Row
    | undefined;
  if (row === undefined) {
    return null;
  }
  const preferenceId = stringField(row, "preference_id");
  const preferenceRow = ctx.db.prepare("SELECT * FROM preferences WHERE id = ?").get(preferenceId) as Row | undefined;
  if (preferenceRow === undefined) {
    return null;
  }
  return {
    preference: rowToPreference(preferenceRow),
    evidence: evidenceFor(ctx, preferenceId),
  };
}

function listConditions(options: ListPreferencesOptions): { whereClause: string; params: unknown[] } {
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

function stringField(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Expected string field ${field}.`);
  }
  return value;
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

function isEvidenceUniqueError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed: evidence.evidence_hash");
}

function isRevivableStatus(status: PreferenceStatus): boolean {
  return status === "suppressed" || status === "rejected";
}
