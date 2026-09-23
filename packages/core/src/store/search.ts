import { ftsQuery, lexicalOverlap } from "../retrieval/query.js";
import {
  rankField,
  resultReasons,
  scopeMatch,
  scorePreference,
  searchableText,
  usageBoost,
  type PreferenceUsage,
} from "../retrieval/rank.js";
import type { PreferenceSearchOptions, PreferenceSearchResult } from "../retrieval/types.js";
import type { StoreContext } from "./context.js";
import { boundedLimit, numberField, rowToPreference, stringField, type Row } from "./rows.js";
import type { PreferenceStatus } from "./types.js";

export function searchPreferences(ctx: StoreContext, options: PreferenceSearchOptions): PreferenceSearchResult[] {
  ctx.ensureSchema();

  const statuses = options.statuses ?? ["active", "pinned"];
  if (statuses.length === 0) {
    return [];
  }

  const limit = boundedLimit(options.limit);
  const minConfidence = Math.max(0, Math.min(1, options.minConfidence ?? 0));
  const query = ftsQuery(options.prompt);
  const ftsRows = query === null ? [] : searchFts(ctx, query, minConfidence, limit * 3, statuses);
  const halfLifeDays = Math.max(0, options.usageHalfLifeDays ?? 0);
  const now = Date.now();

  if (ftsRows.length > 0) {
    const ranked = rankCandidates(ftsRows, options, false, limit, loadUsage(ctx, ftsRows), halfLifeDays, now);
    if (ranked.length > 0) {
      return ranked;
    }
  }

  const lexicalRows = searchLexicalCandidates(ctx, minConfidence, 500, statuses);
  return rankCandidates(lexicalRows, options, true, limit, loadUsage(ctx, lexicalRows), halfLifeDays, now);
}

function rankCandidates(
  rows: Row[],
  options: PreferenceSearchOptions,
  requireOverlap: boolean,
  limit: number,
  usage: Map<string, PreferenceUsage>,
  halfLifeDays: number,
  now: number,
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

      const boost = usageBoost(usage.get(preference.id), halfLifeDays, now);
      const reasons = resultReasons(preference, scope.reason, overlap, rankField(row));
      const seen = usage.get(preference.id);
      if (boost > 0 && seen !== undefined) {
        reasons.push(`reused ${seen.useCount}\u00d7`);
      }

      return {
        preference,
        score: scorePreference(preference, scope.weight, overlap, rankField(row)) + boost,
        reasons,
      };
    })
    .filter((result): result is PreferenceSearchResult => result !== null)
    .sort(
      (left, right) => right.score - left.score || right.preference.updatedAt.localeCompare(left.preference.updatedAt),
    )
    .slice(0, limit);
}

function loadUsage(ctx: StoreContext, rows: Row[]): Map<string, PreferenceUsage> {
  const usage = new Map<string, PreferenceUsage>();
  if (rows.length === 0) {
    return usage;
  }

  const ids = rows.map((row) => stringField(row, "id"));
  const placeholders = ids.map(() => "?").join(", ");
  for (const row of ctx.db
    .prepare(
      `SELECT preference_id, use_count, last_injected_at
       FROM preference_usage
       WHERE preference_id IN (${placeholders})`,
    )
    .all(...ids) as Row[]) {
    usage.set(stringField(row, "preference_id"), {
      useCount: numberField(row, "use_count"),
      lastInjectedAt:
        row.last_injected_at === null || row.last_injected_at === undefined
          ? null
          : stringField(row, "last_injected_at"),
    });
  }

  return usage;
}

function searchFts(
  ctx: StoreContext,
  query: string,
  minConfidence: number,
  limit: number,
  statuses: PreferenceStatus[],
): Row[] {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  try {
    return ctx.db
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

function searchLexicalCandidates(
  ctx: StoreContext,
  minConfidence: number,
  limit: number,
  statuses: PreferenceStatus[],
): Row[] {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  return ctx.db
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
