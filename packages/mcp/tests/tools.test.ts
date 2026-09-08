import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPreferenceStore, defaultConfig } from "@prefkit/core";
import {
  explainPreference,
  forgetPreference,
  listPreferences,
  recallPreferences,
  rememberPreference,
  searchPreferences,
} from "../src/tools.js";

const injection = defaultConfig.injection;

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "prefkit-mcp-tools-"));
  const store = createPreferenceStore({ ...defaultConfig.store, path: join(dir, "prefs.db") });
  store.init();
  return store;
}

function seed(store: ReturnType<typeof createPreferenceStore>) {
  store.remember({
    statement: "Prefer pnpm for JavaScript package management.",
    scopeType: "global",
    category: "tooling",
    evidence: { sourceType: "USER_EXPLICIT" },
  });
}

describe("MCP preference tools", () => {
  it("recalls relevant rules within the token budget", () => {
    const store = freshStore();
    try {
      seed(store);
      const result = recallPreferences(store, injection, { task: "set up a JavaScript project" });

      expect(result.isError).toBeUndefined();
      const output = result.structuredContent as { rules: { text: string }[]; tokenEstimate: number; omitted: number };
      expect(output.rules.length).toBeGreaterThan(0);
      expect(output.rules[0]?.text).toContain("pnpm");
      expect(output.tokenEstimate).toBeLessThanOrEqual(injection.maxTokens);
      expect(output.omitted).toBeGreaterThanOrEqual(0);
    } finally {
      store.close();
    }
  });

  it("dedupes repeat remembers to the same id", () => {
    const store = freshStore();
    try {
      const first = rememberPreference(store, { statement: "Prefer pnpm for JavaScript projects." });
      const second = rememberPreference(store, { statement: "Prefer pnpm for JavaScript projects." });

      expect((first.structuredContent as { id: string }).id).toBe(
        (second.structuredContent as { id: string }).id,
      );
      expect(first.isError).toBeUndefined();
      expect(second.isError).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects non-global scopes without a scope value", () => {
    const store = freshStore();
    try {
      const result = rememberPreference(store, { statement: "Use tabs.", scope: "repository" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/scopeValue/);
    } finally {
      store.close();
    }
  });

  it("returns actionable errors for unknown ids", () => {
    const store = freshStore();
    try {
      const forgotten = forgetPreference(store, { id: "pref_missing" });

      expect(forgotten.isError).toBe(true);
      expect(forgotten.content[0]?.text).toMatch(/prefkit_(list|search)/);
    } finally {
      store.close();
    }
  });

  it("explains provenance for a stored preference", () => {
    const store = freshStore();
    try {
      seed(store);
      const listed = listPreferences(store, {});
      const id = (listed.structuredContent as { rules: { id: string }[] }).rules[0]?.id ?? "";
      const explained = explainPreference(store, { id });

      expect(explained.isError).toBeUndefined();
      expect(explained.content[0]?.text).toMatch(/pnpm/);
      expect(explained.content[0]?.text).toMatch(/Evidence/);
    } finally {
      store.close();
    }
  });

  it("searches and paginates", () => {
    const store = freshStore();
    try {
      seed(store);
      const result = searchPreferences(store, { query: "pnpm", limit: 1, offset: 0 });

      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { rules: unknown[] }).rules).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
