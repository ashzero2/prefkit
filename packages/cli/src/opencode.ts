import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHome, type ConfigLoadResult, type DoctorCheck } from "@prefkit/core";

interface JsonObject {
  [key: string]: unknown;
}

interface OpenCodePluginEntry {
  source: string;
  packageValue: string;
  options: JsonObject | null;
}

interface OpenCodeConfigInspection {
  path: string;
  ok: boolean;
  message?: string;
  entries: OpenCodePluginEntry[];
  disabled: boolean;
}

export interface OpenCodeDoctorOptions {
  cwd: string;
  opencodeConfigPath?: string;
  adapterPackage?: string;
  env?: NodeJS.ProcessEnv;
}

export interface OpenCodeDoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  configPaths: string[];
}

export interface OpenCodeInstallOptions {
  cwd: string;
  opencodeConfigPath?: string;
  adapterPackage?: string;
  prefkitConfigPath?: string;
  queueDir?: string;
  write?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface OpenCodeInstallReport {
  ok: boolean;
  wrote: boolean;
  targetPath: string;
  snippet: string;
  message: string;
  checks: DoctorCheck[];
}

const pluginId = "prefkit.opencode";
const defaultAdapterPackage = "@prefkit/adapter-opencode";

export function runOpenCodeDoctor(
  loadResult: ConfigLoadResult,
  options: OpenCodeDoctorOptions,
): OpenCodeDoctorReport {
  const cwd = resolve(options.cwd);
  const env = options.env ?? process.env;
  const candidates = discoverOpenCodeConfigPaths(cwd, options.opencodeConfigPath, env);
  const existingConfigs = candidates.filter((path) => existsSync(path));
  const inspections = existingConfigs.map((path) => inspectOpenCodeConfig(path));
  const discoveredEntries =
    options.opencodeConfigPath === undefined ? discoverLocalPluginEntries(cwd, env) : [];
  const activeEntries = activePrefKitEntries(inspections, discoveredEntries);
  const preferredEntry = activeEntries[0];
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "opencode-config",
    ok: existingConfigs.length > 0 || discoveredEntries.length > 0,
    message:
      existingConfigs.length === 0 && discoveredEntries.length === 0
        ? "No OpenCode config found. Add opencode.jsonc or .opencode/opencode.jsonc."
        : `Found ${existingConfigs.length} config file(s) and ${discoveredEntries.length} local plugin file(s).`,
  });

  checks.push(...parseChecks(inspections));

  checks.push({
    name: "plugin-entry",
    ok: activeEntries.length > 0,
    message:
      activeEntries.length === 0
        ? `No active ${pluginId} plugin entry found. Add a plugins entry for ${options.adapterPackage ?? defaultAdapterPackage}.`
        : `Found active PrefKit plugin entry in ${preferredEntry?.source}: ${preferredEntry?.packageValue}`,
  });

  if (preferredEntry !== undefined) {
    checks.push(adapterPackageCheck(preferredEntry, options.adapterPackage ?? defaultAdapterPackage));
    checks.push(pluginOptionsCheck(preferredEntry));
  }

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

  checks.push(queuePathCheck(preferredEntry, loadResult));

  return {
    ok: checks.every((check) => check.ok),
    checks,
    configPaths: existingConfigs,
  };
}

export function installOpenCodeAdapter(options: OpenCodeInstallOptions): OpenCodeInstallReport {
  const cwd = resolve(options.cwd);
  const targetPath = selectOpenCodeInstallPath(cwd, options.opencodeConfigPath);
  const adapterPackage = options.adapterPackage ?? defaultAdapterSpecifier();
  const entry = openCodePluginEntry(adapterPackage, options);
  const snippet = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [entry],
    },
    null,
    2,
  );
  const checks: DoctorCheck[] = [
    {
      name: "target-config",
      ok: true,
      message: `Target OpenCode config: ${targetPath}`,
    },
    {
      name: "adapter-package",
      ok: !isLocalPluginPath(adapterPackage) || existsSync(resolvePluginPath(targetPath, adapterPackage)),
      message:
        !isLocalPluginPath(adapterPackage) || existsSync(resolvePluginPath(targetPath, adapterPackage))
          ? `Adapter package/path is usable: ${adapterPackage}`
          : `Adapter path does not exist: ${resolvePluginPath(targetPath, adapterPackage)}`,
    },
  ];

  if (!options.write) {
    return {
      ok: checks.every((check) => check.ok),
      wrote: false,
      targetPath,
      snippet,
      message: "Generated OpenCode config snippet. Re-run with --write to create a missing local config file.",
      checks,
    };
  }

  if (!checks.every((check) => check.ok)) {
    return {
      ok: false,
      wrote: false,
      targetPath,
      snippet,
      message: "OpenCode config was not written because the install checks need attention.",
      checks,
    };
  }

  if (existsSync(targetPath)) {
    const inspection = inspectOpenCodeConfig(targetPath);
    if (inspection.ok && activePrefKitEntries([inspection], []).length > 0) {
      return {
        ok: checks.every((check) => check.ok),
        wrote: false,
        targetPath,
        snippet,
        message: "OpenCode config already contains an active PrefKit plugin entry.",
        checks,
      };
    }

    return {
      ok: false,
      wrote: false,
      targetPath,
      snippet,
      message: "OpenCode config already exists. Add the plugin entry from the snippet, then run prefkit opencode doctor.",
      checks: [
        ...checks,
        {
          name: "write-config",
          ok: false,
          message: "Refusing to rewrite an existing JSON/JSONC config automatically.",
        },
      ],
    };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${snippet}\n`, { mode: 0o600 });

  return {
    ok: checks.every((check) => check.ok),
    wrote: true,
    targetPath,
    snippet,
    message: `Created OpenCode config: ${targetPath}`,
    checks,
  };
}

export function discoverOpenCodeConfigPaths(
  cwd: string,
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    return [resolveUserPath(cwd, explicitPath)];
  }

  const paths: string[] = [];
  const globalConfigDir = env.OPENCODE_CONFIG_DIR ?? "~/.config/opencode";
  pushIfPresent(paths, join(resolveUserPath(cwd, globalConfigDir), "opencode.jsonc"));
  pushIfPresent(paths, join(resolveUserPath(cwd, globalConfigDir), "opencode.json"));

  if (env.OPENCODE_CONFIG !== undefined && env.OPENCODE_CONFIG.trim().length > 0) {
    pushIfPresent(paths, resolveUserPath(cwd, env.OPENCODE_CONFIG));
  }

  for (const directory of ancestorDirectories(cwd)) {
    pushIfPresent(paths, join(directory, "opencode.jsonc"));
    pushIfPresent(paths, join(directory, "opencode.json"));
    pushIfPresent(paths, join(directory, ".opencode", "opencode.jsonc"));
    pushIfPresent(paths, join(directory, ".opencode", "opencode.json"));
  }

  return paths;
}

function selectOpenCodeInstallPath(cwd: string, explicitPath: string | undefined): string {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    return resolveUserPath(cwd, explicitPath);
  }

  const localCandidates = [
    join(cwd, "opencode.jsonc"),
    join(cwd, "opencode.json"),
    join(cwd, ".opencode", "opencode.jsonc"),
    join(cwd, ".opencode", "opencode.json"),
  ];
  return localCandidates.find((path) => existsSync(path)) ?? join(cwd, ".opencode", "opencode.jsonc");
}

function openCodePluginEntry(
  adapterPackage: string,
  options: Pick<OpenCodeInstallOptions, "prefkitConfigPath" | "queueDir">,
): { package: string; options: JsonObject } {
  return {
    package: adapterPackage,
    options: {
      enabled: true,
      injectContext: true,
      queueEvents: true,
      ...(options.prefkitConfigPath === undefined ? {} : { configPath: options.prefkitConfigPath }),
      includeWhy: false,
      limit: 8,
      minConfidence: 0.45,
      ...(options.queueDir === undefined ? {} : { queueDir: options.queueDir }),
      queueWeakEvents: false,
      maxPromptChars: 4000,
    },
  };
}

function defaultAdapterSpecifier(): string {
  const localSource = new URL("../../adapter-opencode/src/index.ts", import.meta.url).pathname;
  return existsSync(localSource) ? localSource : defaultAdapterPackage;
}

function inspectOpenCodeConfig(path: string): OpenCodeConfigInspection {
  try {
    const parsed = parseJsonc(readFileSync(path, "utf8"));
    if (!isJsonObject(parsed)) {
      return {
        path,
        ok: false,
        message: "Expected the OpenCode config to be a JSON object.",
        entries: [],
        disabled: false,
      };
    }

    const plugins = parsed.plugins;
    if (!Array.isArray(plugins)) {
      return {
        path,
        ok: true,
        entries: [],
        disabled: false,
      };
    }

    return {
      path,
      ok: true,
      entries: pluginEntries(path, plugins),
      disabled: disablesPrefKit(plugins),
    };
  } catch (error) {
    return {
      path,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      entries: [],
      disabled: false,
    };
  }
}

function parseChecks(inspections: OpenCodeConfigInspection[]): DoctorCheck[] {
  return inspections
    .filter((inspection) => !inspection.ok)
    .map((inspection) => ({
      name: "opencode-config-parse",
      ok: false,
      message: `${inspection.path}: ${inspection.message ?? "could not parse config"}`,
    }));
}

function activePrefKitEntries(
  inspections: OpenCodeConfigInspection[],
  discoveredEntries: OpenCodePluginEntry[],
): OpenCodePluginEntry[] {
  const entries: OpenCodePluginEntry[] = [...discoveredEntries];
  let disabled = false;

  for (const inspection of inspections) {
    if (!inspection.ok) {
      continue;
    }
    entries.push(...inspection.entries);
    if (inspection.disabled) {
      disabled = true;
    }
  }

  return disabled ? [] : entries;
}

function discoverLocalPluginEntries(cwd: string, env: NodeJS.ProcessEnv): OpenCodePluginEntry[] {
  const entries: OpenCodePluginEntry[] = [];
  const globalConfigDir = env.OPENCODE_CONFIG_DIR ?? "~/.config/opencode";
  const directories = [
    join(resolveUserPath(cwd, globalConfigDir), "plugins"),
    ...ancestorDirectories(cwd).map((directory) => join(directory, ".opencode", "plugins")),
  ];

  for (const directory of directories) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      continue;
    }

    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (isPrefKitSpecifier(entry) && isLoadableLocalPlugin(path)) {
        entries.push({ source: directory, packageValue: path, options: null });
      }
    }
  }

  return entries;
}

function isLoadableLocalPlugin(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  const stat = statSync(path);
  return stat.isDirectory() || path.endsWith(".ts") || path.endsWith(".js");
}

function pluginEntries(configPath: string, plugins: unknown[]): OpenCodePluginEntry[] {
  const entries: OpenCodePluginEntry[] = [];

  for (const plugin of plugins) {
    if (typeof plugin === "string") {
      if (isPrefKitSpecifier(plugin)) {
        entries.push({ source: configPath, packageValue: plugin, options: null });
      }
      continue;
    }

    if (!isJsonObject(plugin) || typeof plugin.package !== "string") {
      continue;
    }

    if (isPrefKitSpecifier(plugin.package)) {
      entries.push({
        source: configPath,
        packageValue: plugin.package,
        options: isJsonObject(plugin.options) ? plugin.options : null,
      });
    }
  }

  return entries;
}

function disablesPrefKit(plugins: unknown[]): boolean {
  let disabled = false;

  for (const plugin of plugins) {
    if (typeof plugin !== "string") {
      continue;
    }

    if (plugin.startsWith("-") && selectorMatches(plugin.slice(1), pluginId)) {
      disabled = true;
    } else if (selectorMatches(plugin, pluginId)) {
      disabled = false;
    }
  }

  return disabled;
}

function adapterPackageCheck(entry: OpenCodePluginEntry, expectedPackage: string): DoctorCheck {
  if (isLocalPluginPath(entry.packageValue)) {
    const resolvedPath = resolvePluginPath(entry.source, entry.packageValue);
    const exists = existsSync(resolvedPath);
    return {
      name: "adapter-package",
      ok: exists,
      message: exists
        ? `Local adapter path exists: ${resolvedPath}`
        : `Local adapter path does not exist: ${resolvedPath}`,
    };
  }

  const expected = entry.packageValue === expectedPackage;
  return {
    name: "adapter-package",
    ok: expected || isPrefKitSpecifier(entry.packageValue),
    message: expected
      ? `Configured package matches ${expectedPackage}.`
      : `Configured package is ${entry.packageValue}; expected ${expectedPackage} for packaged installs.`,
  };
}

function pluginOptionsCheck(entry: OpenCodePluginEntry): DoctorCheck {
  if (entry.options === null) {
    return {
      name: "plugin-options",
      ok: true,
      message: "Plugin has no options; adapter defaults will be used.",
    };
  }

  if (entry.options.enabled === false) {
    return {
      name: "plugin-options",
      ok: false,
      message: "Plugin options set enabled=false, so PrefKit will not run.",
    };
  }

  if (entry.options.injectContext === false && entry.options.queueEvents === false) {
    return {
      name: "plugin-options",
      ok: false,
      message: "Both injectContext=false and queueEvents=false; the adapter has no enabled behavior.",
    };
  }

  const configPath = typeof entry.options.configPath === "string" ? entry.options.configPath : undefined;
  if (configPath !== undefined && !existsSync(resolveUserPath(dirname(entry.source), configPath))) {
    return {
      name: "plugin-options",
      ok: false,
      message: `configPath does not exist: ${resolveUserPath(dirname(entry.source), configPath)}`,
    };
  }

  return {
    name: "plugin-options",
    ok: true,
    message: "Plugin options are usable.",
  };
}

function queuePathCheck(entry: OpenCodePluginEntry | undefined, loadResult: ConfigLoadResult): DoctorCheck {
  const optionQueueDir =
    entry?.options !== null && typeof entry?.options.queueDir === "string" ? entry.options.queueDir : undefined;
  const queuePath = expandHome(optionQueueDir ?? loadResult.config.learning.queuePath);
  const parent = dirname(queuePath);
  const ok = existsSync(queuePath) ? statSync(queuePath).isDirectory() : existsSync(parent);

  return {
    name: "queue-directory",
    ok,
    message: ok
      ? `Queue directory is available or creatable: ${queuePath}`
      : `Queue parent directory does not exist: ${parent}`,
  };
}

function isPrefKitSpecifier(value: string): boolean {
  return (
    value === defaultAdapterPackage ||
    value.includes("@prefkit/adapter-opencode") ||
    value.includes("adapter-opencode") ||
    value.includes("prefkit")
  );
}

function isLocalPluginPath(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("file://");
}

function resolvePluginPath(configPath: string, value: string): string {
  if (value.startsWith("file://")) {
    return new URL(value).pathname;
  }
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(dirname(configPath), expanded);
}

function selectorMatches(selector: string, id: string): boolean {
  if (selector === "*" || selector === id) {
    return true;
  }
  if (selector.endsWith(".*")) {
    return id.startsWith(selector.slice(0, -1));
  }
  return false;
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown;
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escape = false;
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === undefined) {
      continue;
    }

    if (inString) {
      output += char;
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        output += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escape = false;
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === undefined) {
      continue;
    }

    if (inString) {
      output += char;
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? "")) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function ancestorDirectories(cwd: string): string[] {
  const directories: string[] = [];
  let current = resolve(cwd);

  while (true) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories;
}

function resolveUserPath(cwd: string, value: string): string {
  const expanded =
    value === "~" || value.startsWith("~/") ? join(homedir(), value === "~" ? "" : value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function pushIfPresent(paths: string[], path: string): void {
  if (!paths.includes(path)) {
    paths.push(path);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
