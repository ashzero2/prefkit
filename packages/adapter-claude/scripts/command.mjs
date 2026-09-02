export function prefkitCommand(env = process.env) {
  return env.PREFKIT_COMMAND?.trim() || "prefkit";
}

export function prefkitBaseArgs(env = process.env) {
  const args = parseArgs(env.PREFKIT_ARGS);
  const configPath = env.PREFKIT_CONFIG?.trim();
  if (configPath) {
    args.push("--config", configPath);
  }
  return args;
}

function parseArgs(value) {
  if (!value || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? [...parsed] : [];
  } catch {
    return [];
  }
}
