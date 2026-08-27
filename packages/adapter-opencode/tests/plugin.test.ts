import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("OpenCode plugin entry", () => {
  it("exports the server plugin module shape used by opencode", async () => {
    expect(plugin.id).toBe("prefkit.opencode");
    const hooks = await plugin.server({ directory: process.cwd(), worktree: process.cwd() }, { enabled: false });

    expect(hooks["chat.message"]).toBeTypeOf("function");
    expect(hooks["experimental.chat.system.transform"]).toBeTypeOf("function");
  });

  it("does not queue or inject when disabled", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-plugin-"));
    const hooks = await plugin.server(
      { directory: process.cwd(), worktree: process.cwd() },
      { enabled: false, queueDir },
    );

    await hooks["chat.message"]?.(
      { sessionID: "session_test", agent: "build" },
      { message: { role: "user" }, parts: [{ type: "text", text: "Remember that I prefer concise status updates." }] },
    );

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "session_test" }, output);
    expect(readdirSync(queueDir).filter((entry) => entry.endsWith(".json"))).toHaveLength(0);
    expect(output.system).toEqual([]);
  });

  it("queues strong prompts from chat.message", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-plugin-"));
    const hooks = await plugin.server(
      { directory: process.cwd(), worktree: process.cwd() },
      { enabled: true, injectContext: false, queueDir },
    );

    await hooks["chat.message"]?.(
      { sessionID: "session_test", agent: "build" },
      { message: { role: "user" }, parts: [{ type: "text", text: "Remember that I prefer concise status updates." }] },
    );

    expect(readdirSync(queueDir).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
  });

  it("normalizes JSON-quoted message parts", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-plugin-"));
    const hooks = await plugin.server(
      { directory: process.cwd(), worktree: process.cwd() },
      { enabled: true, injectContext: false, queueDir },
    );

    await hooks["chat.message"]?.(
      { sessionID: "session_test", agent: "build" },
      { message: { role: "user" }, parts: [{ type: "text", text: '"Remember that I prefer concise status updates."' }] },
    );

    expect(readdirSync(queueDir).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
  });

  it("injects context into the model message transform", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-plugin-"));
    const command = join(cwd, "prefkit-context.sh");
    writeFileSync(command, "#!/bin/sh\nprintf '%s' 'Relevant user preferences:\\n- Prefer exactly 10 names.'\n", {
      mode: 0o700,
    });
    const hooks = await plugin.server(
      { directory: cwd, worktree: cwd },
      { enabled: true, queueEvents: false, prefkitCommand: command },
    );

    await hooks["chat.message"]?.(
      { sessionID: "session_test", agent: "build" },
      { message: { role: "user" }, parts: [{ type: "text", text: "Give me food app names." }] },
    );

    const output = {
      messages: [
        {
          info: { role: "user", sessionID: "session_test" },
          parts: [{ type: "text", text: "Give me food app names." }],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);

    expect(output.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "Give me food app names.\n\nRelevant user preferences:\\n- Prefer exactly 10 names.",
    });
  });

  it("shows one non-blocking notification per session by default", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-plugin-"));
    const command = join(cwd, "prefkit-context.sh");
    writeFileSync(command, "#!/bin/sh\nprintf '%s' 'Relevant user preferences:\\n- Prefer concise updates.'\n", {
      mode: 0o700,
    });
    const notifications: unknown[] = [];
    const hooks = await plugin.server(
      {
        directory: cwd,
        worktree: cwd,
        client: { tui: { showToast: async (input) => notifications.push(input) } },
      },
      { enabled: true, queueEvents: false, prefkitCommand: command },
    );

    await hooks["chat.message"]?.(
      { sessionID: "session_test", agent: "build" },
      { message: { role: "user" }, parts: [{ type: "text", text: "How should I communicate?" }] },
    );
    const firstOutput = {
      messages: [
        {
          info: { role: "user", sessionID: "session_test" },
          parts: [{ type: "text", text: "How should I communicate?" }],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, firstOutput);

    await hooks["chat.message"]?.(
      { sessionID: "session_test", agent: "build" },
      { message: { role: "user" }, parts: [{ type: "text", text: "How should I report progress?" }] },
    );
    const secondOutput = {
      messages: [
        {
          info: { role: "user", sessionID: "session_test" },
          parts: [{ type: "text", text: "How should I report progress?" }],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, secondOutput);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      body: {
        title: "PrefKit",
        message: "Applied saved preferences",
        variant: "info",
        duration: 5000,
      },
    });
  });
});
