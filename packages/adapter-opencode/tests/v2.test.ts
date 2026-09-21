import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCodePluginId, openCodeV2Plugin } from "../src/index.js";
import type { OpenCodeV2PluginContext } from "../src/index.js";

function fakeContext(options: Record<string, unknown>): {
  ctx: OpenCodeV2PluginContext;
  hooks: Map<string, (event: unknown) => unknown>;
} {
  const hooks = new Map<string, (event: unknown) => unknown>();
  const ctx = {
    options,
    location: { directory: process.cwd() },
    session: {
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        hooks.set(name, callback);
        return {};
      },
    },
  } as unknown as OpenCodeV2PluginContext;
  return { ctx, hooks };
}

function testCliOptions(): { prefkitCommand: string; prefkitArgs: string[]; autoStartWorker: false } {
  return {
    prefkitCommand: process.execPath,
    prefkitArgs: ["--import", "tsx/esm", join(process.cwd(), "packages/cli/src/main.ts")],
    autoStartWorker: false,
  };
}

describe("OpenCode V2 plugin", () => {
  it("registers prompt and context hooks under a stable id", async () => {
    const { ctx, hooks } = fakeContext({ enabled: true });
    const cleanup = await openCodeV2Plugin().setup(ctx);

    expect(openCodeV2Plugin().id).toBe(openCodePluginId);
    expect(hooks.has("prompt")).toBe(true);
    expect(hooks.has("context")).toBe(true);
    cleanup();
  });

  it("queues a strong prompt from the prompt hook", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-v2-"));
    const { ctx, hooks } = fakeContext({ enabled: true, injectContext: false, queueDir, ...testCliOptions() });
    await openCodeV2Plugin().setup(ctx);

    await hooks.get("prompt")?.({
      sessionID: "session_1",
      prompt: { text: "Remember that I prefer concise status updates." },
    });

    expect(readdirSync(queueDir).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
  });

  it("injects context once per session into the system parts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-v2-"));
    const command = join(cwd, "prefkit-context.sh");
    writeFileSync(command, "#!/bin/sh\nprintf '%s' 'Relevant user preferences:\\n- Prefer exactly 10 names.'\n", {
      mode: 0o700,
    });
    const { ctx, hooks } = fakeContext({ enabled: true, queueEvents: false, prefkitCommand: command });
    await openCodeV2Plugin().setup(ctx);

    await hooks.get("prompt")?.({ sessionID: "session_1", prompt: { text: "Give me food app names." } });

    const first = [{ type: "text", text: "base instructions" }];
    await hooks.get("context")?.({ sessionID: "session_1", system: first, messages: [] });
    expect(first[0]?.text).toContain("Prefer exactly 10 names.");

    const second = [{ type: "text", text: "base instructions" }];
    await hooks.get("context")?.({ sessionID: "session_1", system: second, messages: [] });
    expect(second[0]?.text).toBe("base instructions");
  });
});
