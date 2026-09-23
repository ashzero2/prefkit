import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextReminderHeader, createPreferenceStore, renderPreferenceContext, type StoreConfig } from "../../src/index.js";

describe("retrieval and context rendering", () => {
  it("retrieves prompt-relevant preferences and excludes suppressed records", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const naming = store.remember({
        statement: "For product and app naming, prefer elegant professional names.",
        category: "naming",
        tags: ["product", "app"],
      });
      store.remember({
        statement: "Prefer pnpm for JavaScript package management.",
        category: "tooling",
        tags: ["javascript"],
      });
      const suppressed = store.remember({
        statement: "Prefer silly names for temporary demos.",
        category: "naming",
        tags: ["app"],
      });
      store.forget(suppressed.preference.id);

      const results = store.search({
        prompt: "I need to name an app.",
        limit: 5,
        minConfidence: 0.45,
      });

      expect(results.map((result) => result.preference.id)).toContain(naming.preference.id);
      expect(results.map((result) => result.preference.id)).not.toContain(suppressed.preference.id);
      expect(results[0]?.preference.category).toBe("naming");
    } finally {
      store.close();
    }
  });

  it("respects task and agent scope boundaries", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      const global = store.remember({ statement: "Prefer concise final answers." });
      const task = store.remember({
        statement: "For this task, prefer verbose implementation notes.",
        scopeType: "task",
        scopeValue: "session-a",
      });
      const agent = store.remember({
        statement: "When using Claude, prefer hook examples.",
        scopeType: "agent",
        scopeValue: "claude",
      });

      const codexResults = store.search({
        prompt: "Prefer implementation notes and hook examples.",
        agent: "codex",
        sessionId: "session-b",
      });

      const codexIds = codexResults.map((result) => result.preference.id);
      expect(codexIds).toContain(global.preference.id);
      expect(codexIds).not.toContain(task.preference.id);
      expect(codexIds).not.toContain(agent.preference.id);

      const scopedResults = store.search({
        prompt: "Prefer implementation notes and hook examples.",
        agent: "claude",
        sessionId: "session-a",
      });
      const scopedIds = scopedResults.map((result) => result.preference.id);
      expect(scopedIds).toContain(task.preference.id);
      expect(scopedIds).toContain(agent.preference.id);
    } finally {
      store.close();
    }
  });

  it("renders context within max rules and token budget", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      store.remember({ statement: "Prefer elegant professional product names.", category: "naming" });
      store.remember({ statement: "Avoid overloaded meanings in final naming picks.", category: "naming" });
      store.remember({ statement: "Verify collisions only after a shortlist exists.", category: "naming" });

      const results = store.search({ prompt: "Help me name an app.", limit: 8 });
      const rendered = renderPreferenceContext(results, {
        injection: {
          maxRules: 2,
          maxTokens: 45,
          includeWhy: false,
          minConfidence: 0.45,
          includeHeader: false,
          usageHalfLifeDays: 0,
        },
      });

      expect(rendered.included.length).toBeLessThanOrEqual(2);
      expect(rendered.tokenEstimate).toBeLessThanOrEqual(45);
      expect(rendered.text).toContain("Relevant user preferences:");
      expect(rendered.text).not.toContain("Verify collisions only after a shortlist exists.");
    } finally {
      store.close();
    }
  });

  it("keeps warm retrieval and rendering under the context latency budget", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      for (let index = 0; index < 250; index += 1) {
        store.remember({
          statement: `For repository task ${index}, prefer concise implementation notes and focused tests.`,
          category: "workflow",
          tags: ["testing", "implementation"],
        });
      }

      const searchOptions = { prompt: "Help me plan focused implementation tests.", limit: 8, minConfidence: 0.45 };
      const renderOptions = {
        injection: {
          maxRules: 8,
          maxTokens: 700,
          includeWhy: false,
          minConfidence: 0.45,
          includeHeader: false,
          usageHalfLifeDays: 0,
        },
      };

      store.search(searchOptions);
      const durations = Array.from({ length: 20 }, () => {
        const startedAt = performance.now();
        const results = store.search(searchOptions);
        const rendered = renderPreferenceContext(results, renderOptions);
        expect(rendered.tokenEstimate).toBeLessThanOrEqual(700);
        return performance.now() - startedAt;
      }).sort((left, right) => left - right);

      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(200);
    } finally {
      store.close();
    }
  });

  it("matches repository scopes through symlinks and normalizes boundaries", () => {
    const store = createPreferenceStore(testStoreConfig());
    const root = mkdtempSync(join(tmpdir(), "prefkit-path-scope-"));
    const realRepository = join(root, "real-repository");
    const linkedRepository = join(root, "linked-repository");
    mkdirSync(realRepository);
    symlinkSync(realRepository, linkedRepository, "dir");

    try {
      const scoped = store.remember({
        statement: "Use repository-specific naming conventions.",
        scopeType: "repository",
        scopeValue: realRepository,
        category: "conventions",
      });
      const other = store.remember({
        statement: "Use the other repository convention.",
        scopeType: "repository",
        scopeValue: `${realRepository}-other`,
        category: "conventions",
      });

      const results = store.search({
        prompt: "Use repository-specific naming conventions.",
        cwd: join(linkedRepository, "nested", ".."),
        limit: 5,
      });
      const ids = results.map((result) => result.preference.id);

      expect(ids).toContain(scoped.preference.id);
      expect(ids).not.toContain(other.preference.id);
    } finally {
      store.close();
    }
  });

  it("replaces the default header with the reminder when requested", () => {
    const store = createPreferenceStore(testStoreConfig());
    try {
      store.remember({ statement: "Prefer elegant professional product names.", category: "naming" });

      const results = store.search({ prompt: "elegant product names", limit: 5 });
      const rendered = renderPreferenceContext(results, {
        injection: {
          maxRules: 8,
          maxTokens: 700,
          includeWhy: false,
          minConfidence: 0.45,
          includeHeader: false,
          usageHalfLifeDays: 0,
        },
        header: contextReminderHeader,
      });

      expect(rendered.text.startsWith(contextReminderHeader)).toBe(true);
      expect(rendered.text).not.toContain("Relevant user preferences:");
    } finally {
      store.close();
    }
  });
});

function testStoreConfig(): StoreConfig {
  return {
    path: join(mkdtempSync(join(tmpdir(), "prefkit-retrieval-")), "prefs.db"),
    wal: false,
    busyTimeoutMs: 1000,
  };
}
