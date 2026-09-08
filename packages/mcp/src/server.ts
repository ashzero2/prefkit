import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  createPreferenceStore,
  loadConfig,
  type InjectionConfig,
  type PreferenceStore,
} from "@prefkit/core";
import {
  explainPreference,
  forgetPreference,
  listPreferences,
  pinPreference,
  recallPreferences,
  rememberPreference,
  searchPreferences,
  type ToolResult,
} from "./tools.js";

export const SERVER_NAME = "prefkit";
export const SERVER_VERSION = "0.1.0";

const scopeSchema = z.enum(["global", "repository", "path", "task", "agent"]);
const statusSchema = z.enum(["candidate", "active", "pinned", "suppressed", "superseded", "rejected"]);

const ruleSchema = z.object({
  id: z.string(),
  text: z.string(),
  scope: z.string(),
  category: z.string(),
  confidence: z.number(),
});

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export interface ServerDeps {
  store: PreferenceStore;
  injection: InjectionConfig;
  version?: string;
}

export function createPrefKitServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: deps.version ?? SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "PrefKit stores durable working preferences (tooling, style, workflow), not conversation history. " +
        "At the start of a task, call prefkit_recall with the task description and follow the returned rules. " +
        "When the user states a lasting choice or corrects you, save it with prefkit_remember without asking. " +
        "Aliases: 'remember this' / 'write this down' / 'prefer X' -> prefkit_remember; " +
        "'what are my prefs' / before starting work -> prefkit_recall. " +
        "Never invent scopeValue — use the active repository path, file path, or session id, or ask.",
    },
  );

  server.registerTool(
    "prefkit_recall",
    {
      title: "Recall task preferences",
      description:
        "Get working preferences that apply to the current task. " +
        "Use this when starting a task, switching scope, or before choosing tools and conventions " +
        "(package manager, formatter, test runner). " +
        "Returns up to `limit` ranked rules within the token budget, most-specific scope first. " +
        "Does not search past conversations — use prefkit_search for ad-hoc lookup across everything stored.",
      inputSchema: z.object({
        task: z.string().min(1).describe("What you are about to do, in the user's words."),
        cwd: z.string().optional().describe("Repository directory for scope matching. Defaults to the server cwd."),
        agent: z.string().optional().describe("Agent name for agent-scoped rules."),
        session: z.string().optional().describe("Session id for task-scoped rules."),
        limit: z.number().int().min(1).max(20).optional().describe("Max rules to return. Defaults to 8."),
        includeWhy: z.boolean().optional().describe("Include match reasons and confidence in the output."),
      }),
      outputSchema: z.object({
        rules: z.array(ruleSchema),
        omitted: z.number(),
        tokenEstimate: z.number(),
      }),
      annotations: readAnnotations,
    },
    (args) => invoke(() => recallPreferences(deps.store, deps.injection, args)),
  );

  server.registerTool(
    "prefkit_search",
    {
      title: "Search preferences",
      description:
        "Search all stored preferences by keyword. " +
        "Use this when looking up a specific rule, checking what is stored, or finding an id " +
        "for prefkit_forget, prefkit_pin, or prefkit_why. " +
        "Returns paginated matches with ids. " +
        "For rules relevant to a task at the start of work, use prefkit_recall.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Keywords to search for."),
        limit: z.number().int().min(1).max(50).optional().describe("Max rules per page. Defaults to 20."),
        offset: z.number().int().min(0).optional().describe("Page offset. Defaults to 0."),
      }),
      outputSchema: z.object({
        rules: z.array(ruleSchema),
        total: z.number(),
        hasMore: z.boolean(),
      }),
      annotations: readAnnotations,
    },
    (args) => invoke(() => searchPreferences(deps.store, args)),
  );

  server.registerTool(
    "prefkit_list",
    {
      title: "List preferences",
      description:
        "List stored preferences, optionally filtered by scope or status. " +
        "Use this to review what is stored in a scope or to find rule ids. " +
        "Returns paginated rules with ids. " +
        "For rules relevant to a task, use prefkit_recall.",
      inputSchema: z.object({
        scope: scopeSchema.optional().describe("Only rules in this scope."),
        scopeValue: z.string().optional().describe("Only rules for this repository path, file path, or session."),
        status: statusSchema.optional().describe("Only rules with this status. Defaults to active rules."),
        limit: z.number().int().min(1).max(100).optional().describe("Max rules per page. Defaults to 20."),
        offset: z.number().int().min(0).optional().describe("Page offset. Defaults to 0."),
      }),
      outputSchema: z.object({
        rules: z.array(ruleSchema),
        total: z.number(),
        hasMore: z.boolean(),
      }),
      annotations: readAnnotations,
    },
    (args) => invoke(() => listPreferences(deps.store, args)),
  );

  server.registerTool(
    "prefkit_remember",
    {
      title: "Save a preference",
      description:
        "Save one durable working preference. " +
        "Use this when the user states a lasting choice ('prefer pnpm', 'tabs over spaces') or corrects you " +
        "mid-task — save it rather than asking for permission. " +
        "Non-global scopes need a scopeValue (repository root, file path, or session id); never guess it. " +
        "Returns the rule id and scope. " +
        "If you only need to read preferences, use prefkit_recall.",
      inputSchema: z.object({
        statement: z.string().min(1).describe("The preference, including the choice and what it applies to."),
        scope: scopeSchema.optional().describe("Scope for the rule. Defaults to global."),
        scopeValue: z.string().optional().describe("Required for repository, path, task, and agent scopes."),
        category: z.string().optional().describe("Category such as tooling, style, or testing."),
        tags: z.array(z.string()).optional().describe("Search tags."),
      }),
      outputSchema: z.object({
        id: z.string(),
        statement: z.string(),
        scope: z.string(),
        status: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => invoke(() => rememberPreference(deps.store, args)),
  );

  server.registerTool(
    "prefkit_forget",
    {
      title: "Forget a preference",
      description:
        "Remove one stored preference by id. " +
        "Use this when the user revokes a choice or a rule is stale. " +
        "Find the id with prefkit_list or prefkit_search first. Repeat calls are safe.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Preference id from prefkit_recall, prefkit_search, or prefkit_list."),
      }),
      outputSchema: z.object({
        id: z.string(),
        forgotten: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => invoke(() => forgetPreference(deps.store, args)),
  );

  server.registerTool(
    "prefkit_pin",
    {
      title: "Pin a preference",
      description:
        "Pin one stored preference by id so it is always injected. " +
        "Use this for rules the user marks as permanent. " +
        "Find the id with prefkit_list or prefkit_search first.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Preference id from prefkit_recall, prefkit_search, or prefkit_list."),
      }),
      outputSchema: z.object({
        id: z.string(),
        pinned: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => invoke(() => pinPreference(deps.store, args)),
  );

  server.registerTool(
    "prefkit_why",
    {
      title: "Explain a preference",
      description:
        "Explain why a preference exists. " +
        "Use this to inspect the provenance and evidence behind a rule id. " +
        "Returns scope, status, confidence, and the evidence trail.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Preference id from prefkit_recall, prefkit_search, or prefkit_list."),
      }),
      outputSchema: z.object({
        id: z.string(),
        statement: z.string(),
        scope: z.string(),
        status: z.string(),
        confidence: z.number(),
        evidence: z.array(
          z.object({
            sourceType: z.string(),
            polarity: z.string(),
            weight: z.number(),
            summary: z.string(),
          }),
        ),
      }),
      annotations: readAnnotations,
    },
    (args) => invoke(() => explainPreference(deps.store, args)),
  );

  return server;
}

export interface StdioOptions {
  configPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function runStdioServer(options: StdioOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const loadResult = loadConfig(options.configPath === undefined ? { env } : { configPath: options.configPath, env });
  for (const warning of loadResult.warnings) {
    console.error(`[prefkit-mcp] config warning: ${warning}`);
  }
  const store = createPreferenceStore(loadResult.config.store);
  store.init();
  const handle = serveStdio(() =>
    createPrefKitServer({ store, injection: loadResult.config.injection }),
  );
  console.error(`[prefkit-mcp] serving tools over stdio (store=${loadResult.config.store.path})`);

  const shutdown = async () => {
    try {
      await handle.close();
    } catch (error) {
      console.error(`[prefkit-mcp] shutdown error: ${error instanceof Error ? error.message : String(error)}`);
    }
    store.close();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.stdin.on("close", () => void shutdown());
  process.on("unhandledRejection", (error) => {
    console.error(`[prefkit-mcp] unhandled rejection: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function invoke(run: () => ToolResult) {
  try {
    const result = run();
    if (result.isError === true) {
      return { content: result.content, isError: true as const };
    }
    return { content: result.content, structuredContent: result.structuredContent };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: `Request failed: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true as const,
    };
  }
}
