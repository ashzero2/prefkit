import { describe, expect, it } from "vitest";
import { resultReasons, scopeMatch, scorePreference, searchableText, usageBoost } from "../../src/retrieval/rank.js";
import type { PreferenceRecord } from "../../src/store/types.js";

function preference(overrides: Partial<PreferenceRecord> = {}): PreferenceRecord {
  return {
    id: "pref_1",
    statement: "Prefer pnpm.",
    normalizedStatement: "prefer pnpm.",
    scopeType: "global",
    scopeValue: null,
    category: "tooling",
    tags: ["js"],
    confidence: 0.5,
    status: "active",
    source: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
    supersedesId: null,
    metadata: {},
    ...overrides,
  };
}

describe("retrieval ranking", () => {
  it("matches scopes against the supplied context", () => {
    expect(scopeMatch(preference(), { prompt: "x" })).toMatchObject({ matches: true, weight: 0.2 });

    const agent = preference({ scopeType: "agent", scopeValue: "claude" });
    expect(scopeMatch(agent, { prompt: "x", agent: "claude" }).matches).toBe(true);
    expect(scopeMatch(agent, { prompt: "x", agent: "codex" }).matches).toBe(false);

    const task = preference({ scopeType: "task", scopeValue: "session-a" });
    expect(scopeMatch(task, { prompt: "x", sessionId: "session-a" }).matches).toBe(true);
    expect(scopeMatch(task, { prompt: "x", sessionId: "session-b" }).matches).toBe(false);

    const repository = preference({ scopeType: "repository", scopeValue: "/workspace/project-a" });
    expect(scopeMatch(repository, { prompt: "x", cwd: "/workspace/project-a/sub" }).matches).toBe(true);
    expect(scopeMatch(repository, { prompt: "x", cwd: "/workspace/project-b" }).matches).toBe(false);
  });

  it("admits out-of-scope preferences only for scope-agnostic search", () => {
    const repository = preference({ scopeType: "repository", scopeValue: "/workspace/project-a" });

    expect(scopeMatch(repository, { prompt: "x", cwd: "/workspace/project-b" }).matches).toBe(false);
    expect(scopeMatch(repository, { prompt: "x", cwd: "/workspace/project-b", scopeAgnostic: true })).toMatchObject({
      matches: true,
      reason: "scope-agnostic",
    });
  });

  it("raises the score with better bm25 rank and prompt overlap", () => {
    const base = scorePreference(preference(), 0.2, 0, null);
    const withRank = scorePreference(preference(), 0.2, 0, -2);
    const withOverlap = scorePreference(preference(), 0.2, 3, -2);

    expect(withRank).toBeGreaterThan(base);
    expect(withOverlap).toBeGreaterThan(withRank);
  });

  it("reports overlap and fts reasons", () => {
    expect(resultReasons(preference(), "global", 2, -1)).toEqual(["global", "active", "2 prompt terms", "fts"]);
    expect(resultReasons(preference(), "global", 1, null)).toEqual(["global", "active", "1 prompt term"]);
  });

  it("searches statement, category and tags", () => {
    expect(searchableText(preference())).toBe("Prefer pnpm. tooling js");
  });

  it("boosts recent reuse and decays it on the half-life", () => {
    const now = Date.parse("2026-01-11T00:00:00.000Z");
    const fresh = { useCount: 3, lastInjectedAt: "2026-01-10T00:00:00.000Z" };
    const stale = { useCount: 3, lastInjectedAt: "2025-12-01T00:00:00.000Z" };

    expect(usageBoost(undefined, 30, now)).toBe(0);
    expect(usageBoost(fresh, 0, now)).toBe(0);

    const freshBoost = usageBoost(fresh, 30, now);
    expect(freshBoost).toBeGreaterThan(0);
    expect(freshBoost).toBeLessThanOrEqual(0.1);
    expect(usageBoost(stale, 30, now)).toBeLessThan(freshBoost);
  });
});
