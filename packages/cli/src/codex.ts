import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHome, type ConfigLoadResult, type DoctorCheck } from "@prefkit/core";

interface JsonObject {
  [key: string]: unknown;
}

export interface CodexDoctorOptions {
  cwd: string;
  codexHooksPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexDoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  hooksPaths: string[];
}

export interface CodexInstallOptions {
  cwd: string;
  codexHooksPath?: string;
  write?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CodexInstallReport {
  ok: boolean;
  wrote: boolean;
  targetPath: string;
  snippet: string;
  message: string;
  checks: DoctorCheck[];
}

const contextScript = "prefkit-context.mjs";
const learnScript = "prefkit-learn.mjs";

export function runCodexDoctor(
  loadResult: ConfigLoadResult,
  options: CodexDoctorOptions,
): CodexDoctorReport {
  const cwd = resolve(options.cwd);
  const env = options.env ?? process.env;
  const candidates = discoverCodexHooksPaths(cwd, options.codexHooksPath, env);
  const existingPaths = candidates.filter((path) => existsSync(path));
  const inspections = existingPaths.map((path) => inspectCodexHooks(path));
  const checks: DoctorCheck[] = [];

  const hasContext = inspections.some((inspection) => inspection.hasContext);
  const hasLearn = inspections.some((inspection) => inspection.hasLearn);
  checks.push({
    name: "codex-hooks",
    ok: hasContext && hasLearn,
    message:
      existingPaths.length === 0
        ? `No Codex hooks file found. Run prefkit codex install --write to create ${candidates[0]}.`
        : !hasContext || !hasLearn
          ? `Found ${existingPaths.length} hooks file(s) but PrefKit entries are missing: ${[!hasContext ? contextScript : null, !hasLearn ? learnScript : null].filter(Boolean).join(", ")}. Run prefkit codex install --write to merge them.`
          : `Found PrefKit context and learning hooks in ${existingPaths.join(", ")}.`,
  });

  checks.push(...parseChecks(inspections));

  checks.push({
    name: "hook-trust",
    ok: true,
    message:
      "Codex skips new or changed non-managed hooks until trusted. Review and trust them with /hooks in Codex.",
  });

  checks.push({
    name: "prefkit-config",
    ok: loadResult.warnings.length === 0,
    message:
      loadResult.warnings.length === 0
        ? loadResult.sources.length === 0
          ? "Using PrefKit defaults and environment variables."
          : `Loaded PrefKit config from ${loadResult.sources.join(", ")}`
        : loadResult.warnings.join(" "),
  });

  checks.push(queuePathCheck(loadResult));

  return {
    ok: checks.every((check) => check.ok),
    checks,
    hooksPaths: existingPaths,
  };
}

export function installCodexAdapter(options: CodexInstallOptions): CodexInstallReport {
  const cwd = resolve(options.cwd);
  const env = options.env ?? process.env;
  const targetPath = selectCodexHooksPath(cwd, options.codexHooksPath, env);
  const entries = codexHookEntries();
  const snippet = JSON.stringify({ hooks: { UserPromptSubmit: entries } }, null, 2);
  const scriptsOk = entries.every((entry) => !isLocalScriptPath(entryScript(entry)) || existsSync(entryScript(entry)));
  const checks: DoctorCheck[] = [
    {
      name: "target-hooks",
      ok: true,
      message: `Target Codex hooks file: ${targetPath}`,
    },
    {
      name: "adapter-scripts",
      ok: scriptsOk,
      message: scriptsOk
        ? "Adapter hook scripts are available."
        : "Local adapter scripts are missing; the snippet uses ${PLUGIN_ROOT} paths for plugin installs.",
    },
  ];

  if (!options.write) {
    return {
      ok: checks.every((check) => check.ok),
      wrote: false,
      targetPath,
      snippet,
      message:
        "Generated Codex hooks snippet. Re-run with --write to merge it into the hooks file, then trust the hooks with /hooks in Codex.",
      checks,
    };
  }

  if (!checks.every((check) => check.ok)) {
    return {
      ok: false,
      wrote: false,
      targetPath,
      snippet,
      message: "Codex hooks were not written because the install checks need attention.",
      checks,
    };
  }

  const merged = mergeHooksFile(targetPath, entries);
  if (merged.error !== undefined) {
    return {
      ok: false,
      wrote: false,
      targetPath,
      snippet,
      message: merged.error,
      checks: [
        ...checks,
        { name: "write-hooks", ok: false, message: merged.error },
      ],
    };
  }

  if (!merged.changed) {
    return {
      ok: true,
      wrote: false,
      targetPath,
      snippet,
      message: "Codex hooks already contain the PrefKit entries.",
      checks,
    };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(merged.document, null, 2)}\n`, { mode: 0o600 });

  return {
    ok: true,
    wrote: true,
    targetPath,
    snippet,
    message: `Updated Codex hooks: ${targetPath}. Trust them with /hooks in Codex.`,
    checks,
  };
}

export function discoverCodexHooksPaths(
  cwd: string,
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    return [resolveUserPath(cwd, explicitPath, env)];
  }
  return [join(codexHomeDir(env), "hooks.json")];
}

export function codexAgentsMdSnippet(): string {
  return `<!-- prefkit:managed -->
## PrefKit Learned Preferences

Before substantial tasks, run \`prefkit context --prompt "<task>" --cwd <repo>\` and follow the returned preferences.
To save a durable preference, run \`prefkit remember "<statement>" --scope global\`.
`;
}

interface CodexHooksInspection {
  path: string;
  ok: boolean;
  message?: string;
  hasContext: boolean;
  hasLearn: boolean;
}

interface CodexHookHandler {
  type: string;
  command: string;
  args: string[];
  async?: boolean;
  timeout: number;
  statusMessage: string;
}

interface CodexHookMatcherGroup {
  hooks: CodexHookHandler[];
}

function codexHookEntries(): CodexHookMatcherGroup[] {
  const contextArg = resolveAdapterScript(contextScript);
  const learnArg = resolveAdapterScript(learnScript);
  return [
    {
      hooks: [
        {
          type: "command",
          command: "node",
          args: [contextArg],
          timeout: 5,
          statusMessage: "Loading PrefKit context",
        },
      ],
    },
    {
      hooks: [
        {
          type: "command",
          command: "node",
          args: [learnArg],
          async: true,
          timeout: 30,
          statusMessage: "Saving PrefKit preference",
        },
      ],
    },
  ];
}

function resolveAdapterScript(name: string): string {
  const localSource = new URL(`../../adapter-codex/scripts/${name}`, import.meta.url).pathname;
  if (existsSync(localSource)) {
    return localSource;
  }
  return `\${PLUGIN_ROOT}/scripts/${name}`;
}

function inspectCodexHooks(path: string): CodexHooksInspection {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(parsed) || !isJsonObject(parsed.hooks)) {
      return { path, ok: false, message: "Expected the hooks file to be a JSON object with a hooks table.", hasContext: false, hasLearn: false };
    }
    const submit = parsed.hooks.UserPromptSubmit;
    if (!Array.isArray(submit)) {
      return { path, ok: true, message: "No UserPromptSubmit hooks configured.", hasContext: false, hasLearn: false };
    }
    const text = JSON.stringify(submit);
    return {
      path,
      ok: true,
      hasContext: text.includes(contextScript),
      hasLearn: text.includes(learnScript),
    };
  } catch (error) {
    return {
      path,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      hasContext: false,
      hasLearn: false,
    };
  }
}

function parseChecks(inspections: CodexHooksInspection[]): DoctorCheck[] {
  return inspections
    .filter((inspection) => !inspection.ok)
    .map((inspection) => ({
      name: "codex-hooks-parse",
      ok: false,
      message: `${inspection.path}: ${inspection.message ?? "could not parse hooks file"}`,
    }));
}

function queuePathCheck(loadResult: ConfigLoadResult): DoctorCheck {
  const queuePath = expandHome(loadResult.config.learning.queuePath);
  const parent = dirname(queuePath);
  const ok = existsSync(queuePath) || existsSync(parent);
  return {
    name: "queue-directory",
    ok,
    message: ok
      ? `Queue directory is available or creatable: ${queuePath}`
      : `Queue parent directory does not exist: ${parent}`,
  };
}

function selectCodexHooksPath(cwd: string, explicitPath: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    return resolveUserPath(cwd, explicitPath, env);
  }
  return join(codexHomeDir(env), "hooks.json");
}

function mergeHooksFile(
  targetPath: string,
  entries: CodexHookMatcherGroup[],
): { changed: boolean; document: JsonObject; error?: string } {
  let document: JsonObject = { hooks: { UserPromptSubmit: [] } };
  if (existsSync(targetPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(targetPath, "utf8"));
      if (!isJsonObject(parsed)) {
        return { changed: false, document, error: `Refusing to modify ${targetPath}: expected a JSON object.` };
      }
      document = parsed;
    } catch (error) {
      return {
        changed: false,
        document,
        error: `Refusing to modify ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!isJsonObject(document.hooks)) {
    document = { ...document, hooks: {} };
  }
  const hooks = document.hooks as JsonObject;
  const submit = Array.isArray(hooks.UserPromptSubmit) ? [...(hooks.UserPromptSubmit as unknown[])] : [];
  let changed = false;

  for (const entry of entries) {
    const marker = entry.hooks[0]?.args[0]?.includes(contextScript) ? contextScript : learnScript;
    const alreadyPresent = submit.some((group) => JSON.stringify(group).includes(marker));
    if (!alreadyPresent) {
      submit.push(entry);
      changed = true;
    }
  }

  return { changed, document: { ...document, hooks: { ...hooks, UserPromptSubmit: submit } } };
}

function entryScript(entry: CodexHookMatcherGroup): string {
  return entry.hooks[0]?.args[0] ?? "";
}

function isLocalScriptPath(value: string): boolean {
  return value.startsWith("/");
}

function codexHomeDir(env: NodeJS.ProcessEnv): string {
  const override = env.CODEX_HOME?.trim();
  if (override !== undefined && override.length > 0) {
    return expandHome(override);
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(home, ".codex");
}

function resolveUserPath(cwd: string, value: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const expanded =
    value === "~" || value.startsWith("~/") ? join(home, value === "~" ? "" : value.slice(2)) : expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
