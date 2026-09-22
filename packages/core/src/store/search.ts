import { ftsQuery, lexicalOverlap } from "../retrieval/query.js";
import { rankField, resultReasons, scopeMatch, scorePreference, searchableText } from "../retrieval/rank.js";
import type { PreferenceSearchOptions, PreferenceSearchResult } from "../retrieval/types.js";
import type { StoreContext } from "./context.js";
import { boundedLimit, rowToPreference, type Row } from "./rows.js";
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

  if (ftsRows.length > 0) {
    const ranked = rankCandidates(ftsRows, options, false, limit);
    if (ranked.length > 0) {
      return ranked;
    }
  }

  return rankCandidates(searchLexicalCandidates(ctx, minConfidence, 500, statuses), options, true, limit);
}

function rankCandidates(
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
    .sort(
      (left, right) => right.score - left.score || right.preference.updatedAt.localeCompare(left.preference.updatedAt),
    )
    .slice(0, limit);
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
