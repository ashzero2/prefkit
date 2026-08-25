import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPreferenceStore, renderPreferenceContext, type StoreConfig } from "../../src/index.js";

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
          failOpen: true,
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
});

function testStoreConfig(): StoreConfig {
  return {
    path: join(mkdtempSync(join(tmpdir(), "prefkit-retrieval-")), "prefs.db"),
    wal: false,
    busyTimeoutMs: 1000,
  };
}
