import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import type { OpenCodeContextEvent, OpenCodePluginContext } from "../src/types.js";

describe("OpenCode plugin entry", () => {
  it("registers the context hook", async () => {
    const registered: Array<{ name: string; event: OpenCodeContextEvent }> = [];
    const ctx: OpenCodePluginContext = {
      directory: process.cwd(),
      options: { enabled: false },
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
});
