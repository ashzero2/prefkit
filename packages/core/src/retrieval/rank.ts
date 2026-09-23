import { existsSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { PreferenceRecord } from "../store/types.js";
import type { PreferenceSearchOptions } from "./types.js";

export interface ScopeMatch {
  matches: boolean;
  weight: number;
  reason: string;
}

export function scopeMatch(preference: PreferenceRecord, options: PreferenceSearchOptions): ScopeMatch {
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

export function scorePreference(
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

export function resultReasons(
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

export function searchableText(preference: PreferenceRecord): string {
  return [preference.statement, preference.category, ...preference.tags].join(" ");
}

export interface PreferenceUsage {
  useCount: number;
  lastInjectedAt: string | null;
}

const dayMs = 86_400_000;

export function usageBoost(usage: PreferenceUsage | undefined, halfLifeDays: number, now: number): number {
  if (usage === undefined || usage.lastInjectedAt === null || halfLifeDays <= 0) {
    return 0;
  }
  const last = Date.parse(usage.lastInjectedAt);
  if (!Number.isFinite(last)) {
    return 0;
  }
  const days = Math.max(0, (now - last) / dayMs);
  return 0.1 * Math.pow(0.5, days / halfLifeDays);
}

export function rankField(row: Record<string, unknown>): number | null {
  const value = row.fts_rank;
  return typeof value === "number" ? value : null;
}
