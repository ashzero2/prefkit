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
It can also queue compact learner events from strong user prompts.

Flow:

```text
OpenCode context hook
  -> extract latest user prompt from request messages
  -> load PrefKit config
  -> query SQLite preferences
  -> render bounded context
  -> append to OpenCode system context
  -> redact and queue strong learner events
```

The hook catches errors and logs a warning instead of throwing.

It does not run local model learning inside the prompt path.

## Local Development Loading

From an OpenCode project, generate a config snippet:

```bash
pnpm prefkit opencode install
```

If the project has no local OpenCode config yet, PrefKit can create `.opencode/opencode.jsonc`:

```bash
pnpm prefkit opencode install --write
```

For current local development from this repo, the generated package value points at the local adapter source file. For a packaged install, override it:

```bash
pnpm prefkit opencode install --adapter-package @prefkit/adapter-opencode
```

You can also add the plugin entry manually to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/taste/packages/adapter-opencode/src/index.ts",
      "options": {
        "enabled": true,
        "injectContext": true,
        "queueEvents": true,
        "configPath": "/absolute/path/to/your/.prefkit.json",
        "includeWhy": false,
        "limit": 8,
        "minConfidence": 0.45,
        "queueWeakEvents": false,
        "maxPromptChars": 4000
      }
    }
  ]
}
```

If you do not use `configPath`, PrefKit will look for `.prefkit.json` from the OpenCode worktree and then the user config path.

Restart OpenCode after adding the plugin.

Check the setup with:

```bash
pnpm prefkit opencode doctor --opencode-config /path/to/project/opencode.jsonc
```

Without `--opencode-config`, the doctor looks across standard OpenCode config locations and `.opencode/plugins/` discovery paths.

If OpenCode is already running and does not reload the changed file, restart the service:

```bash
opencode2 service restart
```

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

To check queue capture, prompt OpenCode with:

```text
Remember that I prefer concise status updates.
```

Then inspect the queue configured by `learning.queuePath` or `queueDir`:

```bash
pnpm prefkit replay --queue-dir ~/.prefkit/queue --limit 10
```

Expected:

- strong preference/correction prompts create `.json` event files
- weak prompts do not queue by default
- queued files are redacted before they are written
- replay performs local model learning later, outside the OpenCode hook

## Next Adapter Chunk

Next work:

- install/doctor helpers for OpenCode config
- install helper or generated config snippet
- packaged adapter entrypoint hardening
- richer event-stream capture after real OpenCode payload inspection
