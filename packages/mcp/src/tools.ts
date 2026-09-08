import {
  renderPreferenceContext,
  type InjectionConfig,
  type PreferenceRecord,
  type PreferenceStatus,
  type PreferenceStore,
  type ScopeType,
} from "@prefkit/core";

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: [ToolTextContent, ...ToolTextContent[]];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface RecallArgs {
  task: string;
  cwd?: string | undefined;
  agent?: string | undefined;
  session?: string | undefined;
  limit?: number | undefined;
  includeWhy?: boolean | undefined;
}

export interface SearchArgs {
  query: string;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ListArgs {
  scope?: ScopeType | undefined;
  scopeValue?: string | undefined;
  status?: PreferenceStatus | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface RememberArgs {
  statement: string;
  scope?: ScopeType | undefined;
  scopeValue?: string | undefined;
  category?: string | undefined;
  tags?: string[] | undefined;
}

export interface IdArgs {
  id: string;
}

interface RuleSummary {
  id: string;
  text: string;
  scope: string;
  category: string;
  confidence: number;
}

const SCOPES: ScopeType[] = ["global", "repository", "path", "task", "agent"];

export function recallPreferences(
  store: PreferenceStore,
  injection: InjectionConfig,
  args: RecallArgs,
  metricsEnabled = false,
): ToolResult {
  const task = args.task.trim();
  if (task.length === 0) {
    return toolError("recall requires a non-empty task. Describe what you are about to do.");
  }
  const limit = clampInteger(args.limit, injection.maxRules, 1, 20);
  const results = store.search({
    prompt: task,
    cwd: args.cwd ?? process.cwd(),
    limit,
    minConfidence: injection.minConfidence,
    ...(args.agent === undefined ? {} : { agent: args.agent }),
    ...(args.session === undefined ? {} : { sessionId: args.session }),
  });
  const rendered = renderPreferenceContext(results, {
    injection: { ...injection, maxRules: limit },
    includeWhy: args.includeWhy ?? injection.includeWhy,
  });
  if (metricsEnabled) {
    store.recordContext({
      matchedRules: results.length,
      injectedRules: rendered.included.length,
      tokenEstimate: rendered.tokenEstimate,
    });
  }
  const rules = rendered.included.map(
    (result): RuleSummary => ({
      id: result.preference.id,
      text: result.preference.statement,
      scope: scopeLabel(result.preference),
      category: result.preference.category,
      confidence: result.preference.confidence,
    }),
  );
  const lines =
    rules.length === 0
      ? "No stored preferences apply to this task."
      : rules.map((rule) => `- ${rule.text} [${rule.scope}]`).join("\n");
  const footer =
    rendered.omitted.length === 0
      ? ""
      : `\n(${rendered.omitted.length} more withheld by budget — narrow the task or raise limit.)`;
  const output = { rules, omitted: rendered.omitted.length, tokenEstimate: rendered.tokenEstimate };
  return {
    content: [{ type: "text", text: `${lines}${footer}` }],
    structuredContent: output,
  };
}

export function searchPreferences(store: PreferenceStore, args: SearchArgs): ToolResult {
  const query = args.query.trim();
  if (query.length === 0) {
    return toolError("search requires a non-empty query.");
  }
  const limit = clampInteger(args.limit, 20, 1, 50);
  const offset = clampInteger(args.offset, 0, 0, 500);
  const results = store.search({ prompt: query, limit: limit + offset, minConfidence: 0 });
  const page = results.slice(offset, offset + limit);
  const rules = page.map(
    (result): RuleSummary => ({
      id: result.preference.id,
      text: result.preference.statement,
      scope: scopeLabel(result.preference),
      category: result.preference.category,
      confidence: result.preference.confidence,
    }),
  );
  const output = { rules, total: results.length, hasMore: offset + limit < results.length };
  const lines =
    rules.length === 0
      ? `No preferences match "${query}".`
      : rules.map((rule) => `- ${rule.id}: ${rule.text} [${rule.scope}]`).join("\n");
  return {
    content: [{ type: "text", text: lines }],
    structuredContent: output,
  };
}

export function listPreferences(store: PreferenceStore, args: ListArgs): ToolResult {
  const limit = clampInteger(args.limit, 20, 1, 100);
  const offset = clampInteger(args.offset, 0, 0, 10000);
  const records = store.list({
    limit: limit + offset,
    ...(args.status === undefined ? {} : { status: args.status, includeInactive: true }),
  });
  const scoped = records.filter((record) => {
    if (args.scope !== undefined && record.scopeType !== args.scope) {
      return false;
    }
    if (args.scopeValue !== undefined && record.scopeValue !== args.scopeValue) {
      return false;
    }
    return true;
  });
  const page = scoped.slice(offset, offset + limit);
  const rules = page.map(
    (record): RuleSummary => ({
      id: record.id,
      text: record.statement,
      scope: scopeLabel(record),
      category: record.category,
      confidence: record.confidence,
    }),
  );
  const output = { rules, total: scoped.length, hasMore: offset + limit < scoped.length };
  const lines =
    rules.length === 0
      ? "No preferences stored for this filter. Use prefkit_remember to save the first one."
      : rules.map((rule) => `- ${rule.id}: ${rule.text} [${rule.scope}]`).join("\n");
  return {
    content: [{ type: "text", text: lines }],
    structuredContent: output,
  };
}

export function rememberPreference(store: PreferenceStore, args: RememberArgs): ToolResult {
  const statement = args.statement.trim();
  if (statement.length === 0) {
    return toolError("remember requires a non-empty statement. Include the choice and what it applies to.");
  }
  const scope = args.scope ?? "global";
  if (!SCOPES.includes(scope)) {
    return toolError(`Unknown scope "${scope}". Use one of: ${SCOPES.join(", ")}.`);
  }
  const scopeValue = args.scopeValue?.trim() || undefined;
  if (scope !== "global" && scopeValue === undefined) {
    return toolError(
      `Scope "${scope}" needs a scopeValue: repository root path, file path, or session id. ` +
        `Use "global" for cross-project choices, or pass the matching scopeValue.`,
    );
  }
  const stored = store.remember({
    statement,
    scopeType: scope,
    ...(scopeValue === undefined ? {} : { scopeValue }),
    category: args.category ?? "general",
    tags: args.tags ?? [],
    evidence: { summary: statement, sourceType: "USER_EXPLICIT" },
  });
  const output = {
    id: stored.preference.id,
    statement: stored.preference.statement,
    scope: scopeLabel(stored.preference),
    status: stored.preference.status,
  };
  return {
    content: [
      {
        type: "text",
        text: `Saved ${stored.preference.id} [${output.scope}]: ${stored.preference.statement}`,
      },
    ],
    structuredContent: output,
  };
}

export function forgetPreference(store: PreferenceStore, args: IdArgs): ToolResult {
  const forgotten = store.forget(args.id);
  if (forgotten === null) {
    return toolError(
      `No preference with id "${args.id}". Use prefkit_list or prefkit_search to find valid IDs.`,
    );
  }
  return {
    content: [{ type: "text", text: `Forgot ${forgotten.id}: ${forgotten.statement}` }],
    structuredContent: { id: forgotten.id, forgotten: true },
  };
}

export function pinPreference(store: PreferenceStore, args: IdArgs): ToolResult {
  const pinned = store.pin(args.id);
  if (pinned === null) {
    return toolError(
      `No preference with id "${args.id}". Use prefkit_list or prefkit_search to find valid IDs.`,
    );
  }
  return {
    content: [{ type: "text", text: `Pinned ${pinned.id}: ${pinned.statement}` }],
    structuredContent: { id: pinned.id, pinned: true },
  };
}

export function explainPreference(store: PreferenceStore, args: IdArgs): ToolResult {
  const record = store.get(args.id);
  if (record === null) {
    return toolError(
      `No preference with id "${args.id}". Use prefkit_list or prefkit_search to find valid IDs.`,
    );
  }
  const lines = [
    `${record.preference.id}: ${record.preference.statement}`,
    `scope=${scopeLabel(record.preference)} status=${record.preference.status} confidence=${record.preference.confidence.toFixed(2)}`,
    "",
    "Evidence:",
    ...record.evidence.map(
      (evidence) => `- ${evidence.sourceType} ${evidence.polarity} weight=${evidence.weight}: ${evidence.summary}`,
    ),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      id: record.preference.id,
      statement: record.preference.statement,
      scope: scopeLabel(record.preference),
      status: record.preference.status,
      confidence: record.preference.confidence,
      evidence: record.evidence.map((evidence) => ({
        sourceType: evidence.sourceType,
        polarity: evidence.polarity,
        weight: evidence.weight,
        summary: evidence.summary,
      })),
    },
  };
}

function scopeLabel(record: PreferenceRecord): string {
  if (record.scopeType === "global" || record.scopeValue === null) {
    return record.scopeType;
  }
  return `${record.scopeType}:${record.scopeValue}`;
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}
