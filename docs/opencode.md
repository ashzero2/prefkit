# OpenCode Adapter

PrefKit's OpenCode adapter targets the current OpenCode v2 plugin API.

OpenCode v2 plugin docs describe:

- plugin entries in `plugins`
- local discovery under `.opencode/plugins/`
- default plugin exports with `id` and `setup`
- `ctx.session.hook("context", ...)` for modifying assembled context before model dispatch
- hook failures failing the intercepted operation, so adapters must catch expected errors inside hooks

The v2 plugin API is beta, so verify against your installed OpenCode version before relying on this in daily work.

## Current Behavior

The adapter currently injects PrefKit context only.

Flow:

```text
OpenCode context hook
  -> extract latest user prompt from request messages
  -> load PrefKit config
  -> query SQLite preferences
  -> render bounded context
  -> append to OpenCode system context
```

The hook catches errors and logs a warning instead of throwing.

It does not run local model learning inside the prompt path.

## Local Development Loading

From an OpenCode project, add a plugin entry to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/taste/packages/adapter-opencode/src/index.ts",
      "options": {
        "enabled": true,
        "configPath": "/absolute/path/to/your/.prefkit.json",
        "includeWhy": false,
        "limit": 8,
        "minConfidence": 0.45
      }
    }
  ]
}
```

If you do not use `configPath`, PrefKit will look for `.prefkit.json` from the OpenCode worktree and then the user config path.

Restart OpenCode after adding the plugin.

## Smoke Check

Use a temp store first:

```bash
export PREFKIT_STORE="/tmp/prefkit-opencode-check.db"
pnpm prefkit init
pnpm prefkit remember "For product naming, prefer elegant professional names." --category naming --tag product --tag naming
pnpm prefkit context --prompt "I need to name an app"
```

Then ask OpenCode:

```text
I need to name an app
```

Expected:

- OpenCode should behave as if the relevant PrefKit preference was part of system context.
- If PrefKit fails, OpenCode should continue and log a `[prefkit] context injection skipped` warning.

## Next Adapter Chunk

Next work:

- event queue writer for OpenCode sessions
- conservative event capture from user prompts/corrections
- no model calls in OpenCode hooks
- replay events later with `prefkit replay`
