import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPreferenceStore, type StoreConfig } from "../../src/index.js";

describe("SqlitePreferenceStore", () => {
  it("initializes migrations and stores explicit preferences with evidence", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      store.init();
      const remembered = store.remember({
        statement: "Prefer pnpm for JavaScript package management.",
        category: "tooling",
        tags: ["javascript", "package-manager", "javascript"],
        evidence: {
          agent: "codex",
          sessionId: "session-1",
          summary: "User explicitly asked to prefer pnpm.",
        },
      });

      expect(remembered.preference.status).toBe("active");
      expect(remembered.preference.tags).toEqual(["javascript", "package-manager"]);
      expect(remembered.evidence[0]?.sourceType).toBe("USER_EXPLICIT");

      const listed = store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.statement).toBe("Prefer pnpm for JavaScript package management.");

      const withEvidence = store.get(remembered.preference.id);
      expect(withEvidence?.evidence[0]?.summary).toBe("User explicitly asked to prefer pnpm.");
    } finally {
      store.close();
    }
  });

  it("pins and forgets preferences without deleting provenance", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const remembered = store.remember({ statement: "Use concise final answers." });

      expect(store.pin(remembered.preference.id)?.status).toBe("pinned");
      expect(store.forget(remembered.preference.id)?.status).toBe("suppressed");
      expect(store.list()).toHaveLength(0);

      const suppressed = store.get(remembered.preference.id);
      expect(suppressed?.preference.status).toBe("suppressed");
      expect(suppressed?.evidence).toHaveLength(1);
      expect(store.list({ status: "suppressed" })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("treats duplicate evidence as an idempotent write", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const input = {
        statement: "Prefer concise status updates.",
        evidence: { summary: "User explicitly requested concise status updates." },
      };
      const first = store.remember(input);
      const second = store.remember(input);

      expect(second.preference.id).toBe(first.preference.id);
      expect(store.list()).toHaveLength(1);
      expect(store.get(first.preference.id)?.evidence).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("reviews a proposed supersession atomically", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const existing = store.remember({ statement: "Use pnpm in this repository." });
      const candidate = store.remember({
        statement: "Use npm in this repository.",
        status: "candidate",
        supersedesId: existing.preference.id,
        evidence: { summary: "The user corrected the package manager." },
      });

      expect(store.get(existing.preference.id)?.preference.status).toBe("active");
      expect(store.review(candidate.preference.id, "accept")?.status).toBe("active");
      expect(store.get(existing.preference.id)?.preference.status).toBe("superseded");
    } finally {
      store.close();
    }
  });

  it("rejects a proposed supersession without changing the predecessor", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const existing = store.remember({ statement: "Use pnpm in this repository." });
      const candidate = store.remember({
        statement: "Use npm in this repository.",
        status: "candidate",
        supersedesId: existing.preference.id,
        evidence: { summary: "A conflicting package manager suggestion needs review." },
      });

      expect(store.review(candidate.preference.id, "reject")?.status).toBe("rejected");
      expect(store.get(existing.preference.id)?.preference.status).toBe("active");
      expect(store.get(candidate.preference.id)?.preference.supersedesId).toBe(existing.preference.id);
    } finally {
      store.close();
    }
  });

  it("returns null when reviewing an unknown preference", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      expect(store.review("pref_missing", "accept")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reports local preference and evidence inventory without exposing summaries", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const active = store.remember({
        statement: "Prefer focused tests.",
        evidence: { sourceType: "USER_EXPLICIT", polarity: "positive" },
      });
      const candidate = store.remember({
        statement: "Prefer broad integration tests.",
        status: "candidate",
        evidence: { sourceType: "MODEL_EXTRACTED", polarity: "neutral" },
      });
      store.forget(active.preference.id);
      store.review(candidate.preference.id, "reject");

      expect(store.stats()).toEqual({
        preferences: {
          total: 2,
          byStatus: {
            candidate: 0,
            active: 0,
            pinned: 0,
            suppressed: 1,
            superseded: 0,
            rejected: 1,
          },
        },
        evidence: {
          total: 2,
          bySourceType: {
            USER_EXPLICIT: 1,
            MODEL_EXTRACTED: 1,
            AGENT_EVENT: 0,
            IMPORT: 0,
          },
          byPolarity: {
            positive: 1,
            negative: 0,
            neutral: 1,
          },
        },
        metrics: {
          contextRequests: 0,
          contextMatches: 0,
          contextHits: 0,
          contextInjectedRules: 0,
          contextInjectedTokens: 0,
          contextHitRate: 0,
          correctionsAfterContext: 0,
          correctionsWithoutContext: 0,
        },
      });
    } finally {
      store.close();
    }
  });

  it("records context counters without storing prompt content", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      store.recordContext({ matchedRules: 3, injectedRules: 2, tokenEstimate: 44 });
      store.recordContext({ matchedRules: 0, injectedRules: 0, tokenEstimate: 0 });
      store.recordContext({ matchedRules: 1, injectedRules: 1, tokenEstimate: 18 });

      expect(store.stats().metrics).toEqual({
        contextRequests: 3,
        contextMatches: 4,
        contextHits: 2,
        contextInjectedRules: 3,
        contextInjectedTokens: 62,
        contextHitRate: 2 / 3,
        correctionsAfterContext: 0,
        correctionsWithoutContext: 0,
      });
    } finally {
      store.close();
    }
  });

  it("links one explicit correction to the latest injected context for its session", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      store.recordContext({
        matchedRules: 1,
        injectedRules: 1,
        tokenEstimate: 12,
        sessionId: "session-a",
        injectedPreferenceIds: ["pref_example"],
      });

      expect(store.recordCorrection({ sessionId: "session-a" })).toBe(true);
      expect(store.recordCorrection({ sessionId: "session-a" })).toBe(false);
      expect(store.recordCorrection({ sessionId: "session-b" })).toBe(false);
      expect(store.stats().metrics.correctionsAfterContext).toBe(1);
      expect(store.stats().metrics.correctionsWithoutContext).toBe(2);
    } finally {
      store.close();
    }
  });

  it("exports inspectable markdown", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const remembered = store.remember({
        statement: "Prefer elegant professional product names.",
        category: "naming",
        tags: ["product", "style"],
      });

      const markdown = store.exportMarkdown();
      expect(markdown).toContain("# PrefKit Preferences");
      expect(markdown).toContain("## Prefer elegant professional product names.");
      expect(markdown).toContain(`- id: ${remembered.preference.id}`);
      expect(markdown).toContain("- category: naming");
    } finally {
      store.close();
    }
  });

  it("creates a restorable SQLite backup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "prefkit-store-backup-"));
    const sourcePath = join(directory, "prefs.db");
    const backupPath = join(directory, "backups", "prefs.db");
    const source = createPreferenceStore({ ...testStoreConfig(), path: sourcePath });

    try {
      const remembered = source.remember({ statement: "Prefer colocated tests." });
      await source.backup(backupPath);

      expect(existsSync(backupPath)).toBe(true);

      const restored = createPreferenceStore({ ...testStoreConfig(), path: backupPath });
      try {
        expect(restored.get(remembered.preference.id)?.preference.statement).toBe("Prefer colocated tests.");
        expect(restored.get(remembered.preference.id)?.evidence).toHaveLength(1);
      } finally {
        restored.close();
      }
    } finally {
      source.close();
    }
  });

  it("exports all preferences and evidence as JSON", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const remembered = store.remember({
        statement: "Prefer JSON transfer exports.",
        evidence: { summary: "User requested a lossless export." },
      });

      const exported = JSON.parse(store.exportJson()) as {
        version: number;
        preferences: Array<{ preference: { id: string }; evidence: Array<{ summary: string }> }>;
      };

      expect(exported.version).toBe(1);
      expect(exported.preferences).toHaveLength(1);
      expect(exported.preferences[0]?.preference.id).toBe(remembered.preference.id);
      expect(exported.preferences[0]?.evidence[0]?.summary).toBe("User requested a lossless export.");
    } finally {
      store.close();
    }
  });

  it("imports JSON preferences and evidence idempotently", () => {
    const source = createPreferenceStore(testStoreConfig());
    const target = createPreferenceStore(testStoreConfig());

    try {
      const remembered = source.remember({
        statement: "Prefer lossless preference transfers.",
        evidence: { summary: "User requested a portable backup." },
      });
      const exported = source.exportJson();

      expect(target.importJson(exported)).toEqual({
        preferencesImported: 1,
        preferencesSkipped: 0,
        evidenceImported: 1,
        conflicts: 0,
      });
      expect(target.importJson(exported)).toEqual({
        preferencesImported: 0,
        preferencesSkipped: 1,
        evidenceImported: 0,
        conflicts: 0,
      });
      expect(target.get(remembered.preference.id)?.evidence[0]?.summary).toBe("User requested a portable backup.");
    } finally {
      source.close();
      target.close();
    }
  });

  it("excludes unreviewed candidates from search by default and includes them when requested", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const active = store.remember({
        statement: "Always format code with prettier.",
        category: "formatting",
      });
      const candidate = store.remember({
        statement: "Always format code with biome.",
        category: "formatting",
        status: "candidate",
      });

      // Default search: only active and pinned
      const defaultResults = store.search({ prompt: "format code with tools" });
      const defaultIds = defaultResults.map((r) => r.preference.id);
      expect(defaultIds).toContain(active.preference.id);
      expect(defaultIds).not.toContain(candidate.preference.id);

      // Explicit search with candidate status
      const candidateResults = store.search({
        prompt: "format code with tools",
        statuses: ["candidate"],
      });
      const candidateIds = candidateResults.map((r) => r.preference.id);
      expect(candidateIds).toContain(candidate.preference.id);
      expect(candidateIds).not.toContain(active.preference.id);
    } finally {
      store.close();
    }
  });

  it("excludes candidates from list by default and filters by scope and offset in SQL", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      store.remember({ statement: "Global rule 1", scopeType: "global" });
      store.remember({ statement: "Global rule 2", scopeType: "global" });
      store.remember({ statement: "Repo rule A", scopeType: "repository", scopeValue: "/workspace/project-a" });
      store.remember({ statement: "Repo rule B", scopeType: "repository", scopeValue: "/workspace/project-b" });
      store.remember({ statement: "Candidate rule", status: "candidate" });

      // Default list excludes candidates
      const defaultList = store.list();
      expect(defaultList).toHaveLength(4);
      expect(defaultList.map((p) => p.status)).not.toContain("candidate");

      // Filter by status candidate
      const candidates = store.list({ status: "candidate" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.statement).toBe("Candidate rule");

      // Filter by scope
      const repoPrefs = store.list({ scope: "repository" });
      expect(repoPrefs).toHaveLength(2);

      // Pagination with limit and offset
      const page1 = store.list({ scope: "repository", limit: 1, offset: 0 });
      const page2 = store.list({ scope: "repository", limit: 1, offset: 1 });
      expect(page1).toHaveLength(1);
      expect(page2).toHaveLength(1);
      expect(page1[0]?.id).not.toBe(page2[0]?.id);
    } finally {
      store.close();
    }
  });

  it("computes monotonic positive rank weights for FTS5 bm25 negative scores", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      store.remember({
        statement: "Use typescript strict mode for backend services.",
        category: "compiler",
      });
      store.remember({
        statement: "Backend services require typescript validation.",
        category: "compiler",
      });

      const results = store.search({ prompt: "typescript strict mode" });
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
        if (result.reasons.includes("fts")) {
          expect(result.score).toBeGreaterThan(result.preference.confidence);
        }
      }
    } finally {
      store.close();
    }
  });
});

function testStoreConfig(): StoreConfig {
  return {
    path: join(mkdtempSync(join(tmpdir(), "prefkit-store-")), "prefs.db"),
    wal: false,
    busyTimeoutMs: 1000,
  };
}
