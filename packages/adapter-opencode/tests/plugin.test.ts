import { readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import type { OpenCodeContextEvent, OpenCodePluginContext } from "../src/types.js";

describe("OpenCode plugin entry", () => {
  it("registers the context hook", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-plugin-"));
    const registered: Array<{ name: string; event: OpenCodeContextEvent }> = [];
    const ctx: OpenCodePluginContext = {
      directory: process.cwd(),
      options: { enabled: false, queueDir },
      session: {
        hook: async (name, callback) => {
          const event: OpenCodeContextEvent = {
            system: [],
            messages: [{ role: "user", content: "I need to name an app" }],
          };
          await callback(event);
          registered.push({ name, event });
          return {};
        },
      },
    };

    await plugin.setup(ctx);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("context");
    expect(registered[0]?.event.system).toEqual([]);
  });

  it("queues strong prompt events from the context hook", async () => {
    const queueDir = mkdtempSync(join(tmpdir(), "prefkit-opencode-plugin-"));
    const ctx: OpenCodePluginContext = {
      directory: process.cwd(),
      options: {
        enabled: true,
        injectContext: false,
        queueDir,
      },
      session: {
        hook: async (_name, callback) => {
          await callback({
            system: [],
            messages: [{ role: "user", content: "Remember that I prefer concise status updates." }],
          });
          return {};
        },
      },
    };

    await plugin.setup(ctx);

    expect(readdirSync(queueDir).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
  });
});
