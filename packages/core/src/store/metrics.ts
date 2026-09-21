import { createHash } from "node:crypto";
import type { StoreContext } from "./context.js";
import { numberField, stringField, type Row } from "./rows.js";
import type {
  ContextMetricInput,
  CorrectionMetricInput,
  EvaluationGroup,
  EvaluationOutcomeInput,
  EvidencePolarity,
  EvidenceSourceType,
  OutcomeEvaluation,
  PreferenceStats,
  PreferenceStatus,
} from "./types.js";

const preferenceStatuses = ["candidate", "active", "pinned", "suppressed", "superseded", "rejected"] as const;
const evidenceSourceTypes = ["USER_EXPLICIT", "MODEL_EXTRACTED", "AGENT_EVENT", "IMPORT"] as const;
const evidencePolarities = ["positive", "negative", "neutral"] as const;
const maxContextExposures = 1000;

export function preferenceStats(ctx: StoreContext): PreferenceStats {
  ctx.ensureSchema();

  const byStatus = emptyCounts(preferenceStatuses);
  for (const row of ctx.db.prepare("SELECT status, COUNT(*) AS count FROM preferences GROUP BY status").all() as Row[]) {
    const status = stringField(row, "status");
    if (isPreferenceStatus(status)) {
      byStatus[status] = numberField(row, "count");
    }
  }

  const bySourceType = emptyCounts(evidenceSourceTypes);
  const byPolarity = emptyCounts(evidencePolarities);
  for (const row of ctx.db
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

  const contextRequests = metricValue(ctx, "context_requests");
  const contextMatches = metricValue(ctx, "context_matches");
  const contextHits = metricValue(ctx, "context_hits");
  const contextInjectedRules = metricValue(ctx, "context_injected_rules");
  const contextInjectedTokens = metricValue(ctx, "context_injected_tokens");
  const correctionsAfterContext = metricValue(ctx, "corrections_after_context");
  const correctionsWithoutContext = metricValue(ctx, "corrections_without_context");

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

export function recordContext(ctx: StoreContext, input: ContextMetricInput): void {
  ctx.ensureSchema();

  const matchedRules = nonNegativeInteger(input.matchedRules);
  const injectedRules = nonNegativeInteger(input.injectedRules);
  const tokenEstimate = nonNegativeInteger(input.tokenEstimate);
  const sessionHash = hashSessionId(input.sessionId);
  const preferenceIds = normalizePreferenceIds(input.injectedPreferenceIds);
  const increment = ctx.db.prepare(
    `INSERT INTO metrics (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = metrics.value + excluded.value`,
  );
  const record = ctx.db.transaction(() => {
    increment.run("context_requests", 1);
    increment.run("context_matches", matchedRules);
    increment.run("context_hits", injectedRules > 0 ? 1 : 0);
    increment.run("context_injected_rules", injectedRules);
    increment.run("context_injected_tokens", tokenEstimate);
    if (sessionHash !== null && injectedRules > 0) {
      const now = new Date().toISOString();
      ctx.db
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
      ctx.db
        .prepare(
          `INSERT INTO context_exposures (session_hash, preference_ids_json, created_at) VALUES (?, ?, ?)
           ON CONFLICT(session_hash) DO UPDATE SET preference_ids_json = excluded.preference_ids_json,
                                                   created_at = excluded.created_at`,
        )
        .run(sessionHash, JSON.stringify(preferenceIds), new Date().toISOString());
      ctx.db
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

export function recordCorrection(ctx: StoreContext, input: CorrectionMetricInput): boolean {
  ctx.ensureSchema();

  const sessionHash = hashSessionId(input.sessionId);
  const increment = ctx.db.prepare(
    `INSERT INTO metrics (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = metrics.value + 1`,
  );
  const record = ctx.db.transaction(() => {
    const linked =
      sessionHash !== null &&
      ctx.db.prepare("SELECT 1 FROM context_exposures WHERE session_hash = ?").get(sessionHash) !== undefined;
    const existingEvaluation =
      sessionHash === null
        ? undefined
        : (ctx.db
            .prepare("SELECT context_injected, status FROM evaluation_sessions WHERE session_hash = ?")
            .get(sessionHash) as Row | undefined);
    const contextInjected =
      linked || (existingEvaluation !== undefined && numberField(existingEvaluation, "context_injected") === 1);
    if (sessionHash !== null && linked) {
      ctx.db.prepare("DELETE FROM context_exposures WHERE session_hash = ?").run(sessionHash);
    }
    if (
      sessionHash !== null &&
      (existingEvaluation === undefined || stringField(existingEvaluation, "status") !== "closed")
    ) {
      const now = new Date().toISOString();
      ctx.db
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

export function recordEvaluationOutcome(ctx: StoreContext, input: EvaluationOutcomeInput): void {
  ctx.ensureSchema();

  const sessionHash = hashSessionId(input.sessionId);
  if (sessionHash === null) {
    throw new Error("An evaluation outcome requires a non-empty sessionId.");
  }

  const record = ctx.db.transaction(() => {
    const existing = ctx.db
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

    ctx.db
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

export function evaluateOutcomes(ctx: StoreContext): OutcomeEvaluation {
  ctx.ensureSchema();

  const groups = {
    withContext: { sessions: 0, corrections: 0 },
    withoutContext: { sessions: 0, corrections: 0 },
  };
  for (const row of ctx.db
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
      ctx.db.prepare("SELECT COUNT(*) AS count FROM evaluation_sessions WHERE status = 'open'").get() as Row,
      "count",
    ),
    withContext,
    withoutContext,
    absoluteRateDifference,
    relativeRateDifference,
  };
}

function metricValue(ctx: StoreContext, name: string): number {
  const row = ctx.db.prepare("SELECT value FROM metrics WHERE name = ?").get(name) as Row | undefined;
  return row === undefined ? 0 : numberField(row, "value");
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
