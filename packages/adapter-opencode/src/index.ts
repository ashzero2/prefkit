import { injectOpenCodePreferenceContext } from "./context.js";
import { queueOpenCodeLearnerEvent } from "./queue.js";
import type { OpenCodeAdapterOptions, OpenCodePluginContext } from "./types.js";

const plugin = {
  id: "prefkit.opencode",
  async setup(ctx: OpenCodePluginContext) {
    const options = adapterOptions(ctx.options);
    const cwd = ctx.worktree ?? ctx.directory ?? process.cwd();

    await ctx.session?.hook?.("context", (event) => {
      try {
        injectOpenCodePreferenceContext({
          event,
          cwd,
          options,
        });
      } catch (error) {
        console.warn(`[prefkit] context injection skipped: ${errorMessage(error)}`);
      }

      try {
        queueOpenCodeLearnerEvent({
          event,
          cwd,
          options,
        });
      } catch (error) {
        console.warn(`[prefkit] learner event queue skipped: ${errorMessage(error)}`);
      }
    });
  },
};

export default plugin;
export { injectOpenCodePreferenceContext } from "./context.js";
export { learnerEventFromOpenCodeContext, queueOpenCodeLearnerEvent } from "./queue.js";
export type {
  OpenCodeAdapterOptions,
  OpenCodeContextEvent,
  OpenCodePluginContext,
  OpenCodePreferenceContextInput,
  OpenCodeRegistration,
} from "./types.js";

function adapterOptions(input: Record<string, unknown> | undefined): OpenCodeAdapterOptions {
  if (input === undefined) {
    return {};
  }

  return {
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    ...(typeof input.injectContext === "boolean" ? { injectContext: input.injectContext } : {}),
    ...(typeof input.configPath === "string" ? { configPath: input.configPath } : {}),
    ...(typeof input.includeWhy === "boolean" ? { includeWhy: input.includeWhy } : {}),
    ...(typeof input.minConfidence === "number" ? { minConfidence: input.minConfidence } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(typeof input.queueEvents === "boolean" ? { queueEvents: input.queueEvents } : {}),
    ...(typeof input.queueDir === "string" ? { queueDir: input.queueDir } : {}),
    ...(typeof input.queueWeakEvents === "boolean" ? { queueWeakEvents: input.queueWeakEvents } : {}),
    ...(typeof input.maxPromptChars === "number" ? { maxPromptChars: input.maxPromptChars } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
