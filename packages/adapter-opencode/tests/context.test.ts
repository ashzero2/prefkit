import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPreferenceStore, defaultConfig } from "@prefkit/core";
import { appendSystemContext, extractLatestUserPrompt, injectOpenCodePreferenceContext } from "../src/context.js";
import type { OpenCodeContextEvent } from "../src/types.js";

describe("OpenCode context adapter", () => {
  it("extracts the latest user prompt from string content", () => {
    expect(
      extractLatestUserPrompt({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "latest" },
        ],
      }),
    ).toBe("latest");
  });

  it("extracts prompt text from part arrays", () => {
    expect(
      extractLatestUserPrompt({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "name" },
              { type: "text", text: "an app" },
            ],
          },
        ],
      }),
    ).toBe("name\nan app");
  });

  it("appends string system context by default", () => {
    const event: OpenCodeContextEvent = { system: [] };

    appendSystemContext(event, "Relevant user preferences:\n- Prefer pnpm.\n");

    expect(event.system).toEqual(["Relevant user preferences:\n- Prefer pnpm.\n"]);
  });

  it("appends object system context when OpenCode uses text objects", () => {
    const event: OpenCodeContextEvent = { system: [{ text: "base" }] };

    appendSystemContext(event, "Relevant user preferences:\n- Prefer pnpm.\n");

    expect(event.system).toEqual([{ text: "base" }, { text: "Relevant user preferences:\n- Prefer pnpm.\n" }]);
  });

  it("injects relevant preferences from the configured store", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-"));
    const storePath = join(cwd, "prefs.db");
    const store = createPreferenceStore({ ...defaultConfig.store, path: storePath });
    store.remember({
      statement: "For product naming, prefer elegant professional names.",
      category: "naming",
      tags: ["product", "naming"],
      confidence: 1,
      status: "active",
    });
    store.close();
    const event: OpenCodeContextEvent = {
      sessionID: "session_test",
      agent: "build",
      system: [],
      messages: [{ role: "user", content: "I need to name an app" }],
    };

    injectOpenCodePreferenceContext({
      event,
      cwd,
      options: {},
      loadConfig: () => ({
        sources: [],
        warnings: [],
        config: {
          ...defaultConfig,
          store: { ...defaultConfig.store, path: storePath },
        },
      }),
    });

    expect(event.system?.join("\n")).toContain("Relevant user preferences:");
    expect(event.system?.join("\n")).toContain("elegant professional names");
  });

  it("does not inject when disabled", () => {
    const event: OpenCodeContextEvent = {
      system: [],
      messages: [{ role: "user", content: "I need to name an app" }],
    };

    injectOpenCodePreferenceContext({
      event,
      cwd: process.cwd(),
      options: { enabled: false },
    });

    expect(event.system).toEqual([]);
  });
});
