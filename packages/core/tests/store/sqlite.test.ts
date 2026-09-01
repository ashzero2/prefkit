import { mkdtempSync } from "node:fs";
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
});

function testStoreConfig(): StoreConfig {
  return {
    path: join(mkdtempSync(join(tmpdir(), "prefkit-store-")), "prefs.db"),
    wal: false,
    busyTimeoutMs: 1000,
  };
}
