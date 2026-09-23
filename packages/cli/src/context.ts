import {
  contextReminderHeader,
  createPreferenceStore,
  renderPreferenceContext,
  storeExists,
  type ConfigLoadResult,
  type PreferenceSearchOptions,
} from "@prefkit/core";
import { flagOne, parseNumberFlag, type ParsedArgs } from "./args.js";

export function runContextCommand(args: ParsedArgs, loadResult: ConfigLoadResult): number {
  const prompt = (flagOne(args, "prompt") ?? args.positionals.join(" ")).trim();
  if (prompt.length === 0) {
    throw new Error("context requires --prompt or prompt text.");
  }

  if (!storeExists(loadResult.config.store)) {
    return 0;
  }

  const store = createPreferenceStore(loadResult.config.store);
  try {
    const searchOptions: PreferenceSearchOptions = {
      prompt,
      cwd: flagOne(args, "cwd") ?? process.cwd(),
      limit: parseNumberFlag(flagOne(args, "limit"), loadResult.config.injection.maxRules),
      minConfidence: parseNumberFlag(flagOne(args, "min-confidence"), loadResult.config.injection.minConfidence),
      usageHalfLifeDays: loadResult.config.injection.usageHalfLifeDays,
    };
    const searchPath = flagOne(args, "path");
    if (searchPath !== undefined) {
      searchOptions.path = searchPath;
    }
    const searchAgent = flagOne(args, "agent");
    if (searchAgent !== undefined) {
      searchOptions.agent = searchAgent;
    }
    const searchSession = flagOne(args, "session");
    if (searchSession !== undefined) {
      searchOptions.sessionId = searchSession;
    }

    const results = store.search(searchOptions);
    const includeHeader = args.flags.has("with-header") || loadResult.config.injection.includeHeader;
    const rendered = renderPreferenceContext(results, {
      injection: loadResult.config.injection,
      includeWhy: args.flags.has("why"),
      ...(includeHeader ? { header: contextReminderHeader } : {}),
    });
    if (loadResult.config.metrics.enabled) {
      store.recordContext({
        matchedRules: results.length,
        injectedRules: rendered.included.length,
        tokenEstimate: rendered.tokenEstimate,
        injectedPreferenceIds: rendered.included.map((result) => result.preference.id),
        ...(searchSession === undefined ? {} : { sessionId: searchSession }),
      });
    }
    process.stdout.write(rendered.text);
    return 0;
  } finally {
    store.close();
  }
}
