# OpenCode Adapter

PrefKit's OpenCode adapter targets the stable plugin module API used by current `opencode` releases, including OpenCode 1.18.x.

OpenCode plugin docs describe:

- plugin entries in `plugin` for current `opencode` releases
- beta/v2 plugin entries in `plugins`
- local discovery under `.opencode/plugins/`
- default plugin exports with `id` and `server`
- the stable `chat.message` hook for user-message capture
- the installed runtime's `experimental.chat.system.transform` hook for context injection before model dispatch
- hook failures failing the intercepted operation, so adapters must catch expected errors inside hooks

The plugin API is moving quickly, so verify against your installed OpenCode version before relying on this in daily work.

## Current Behavior

The adapter currently injects PrefKit context only.
It can also queue compact learner events from strong user prompts.

Flow:

```text
OpenCode chat.message hook
  -> extract user prompt from message parts
  -> cache it briefly by session ID
  -> send preference-shaped events to `prefkit queue` over stdin
  -> Node CLI validates, redacts, gates, and writes the queue file
OpenCode experimental.chat.messages.transform hook
  -> consume the cached prompt
  -> invoke the Node-based `prefkit context` CLI
  -> load config and query SQLite outside Bun
  -> render bounded context
  -> append to the latest user text part sent to the model
OpenCode experimental.chat.system.transform hook
  -> provide the same injection as a compatibility fallback
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

For current local development from this repo, the generated package value points at the local adapter source file. For a packaged install, use the `@prefkit/opencode` package once it is published:

```bash
npm install --global @aswinz2/prefkit
prefkit opencode install --adapter-package @prefkit/opencode
```

You can also add the plugin entry manually to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@prefkit/opencode",
      {
        "enabled": true,
        "injectContext": true,
        "queueEvents": true,
        "configPath": "/absolute/path/to/your/.prefkit.json",
        "includeWhy": false,
        "limit": 8,
        "minConfidence": 0.45,
        "queueWeakEvents": false,
        "maxPromptChars": 4000,
        "prefkitCommand": "prefkit",
        "contextTimeoutMs": 5000,
        "notifyOnInjection": "once-per-session",
        "notificationDurationMs": 5000
      }
    ]
  ]
}
```

If you do not use `configPath`, PrefKit will look for `.prefkit.json` from the OpenCode worktree and then the user config path.

The adapter does not open SQLite inside OpenCode's Bun runtime. It invokes the Node-based `prefkit` CLI for both context lookup and learner-event queueing. Queue input is sent over stdin, then the CLI validates, redacts, gates, and writes it. The published plugin package has no `@prefkit/core` or native SQLite dependency. Install the published `@aswinz2/prefkit` CLI separately and keep its `prefkit` executable on `PATH`, or configure `prefkitCommand` and `prefkitArgs` for a custom executable.

When `notifyOnInjection` is `once-per-session` or `always`, the adapter asks OpenCode's TUI to show `PrefKit: Applied saved preferences` after successful injection. Toast failures never affect the model request. Use `off` for silent operation.

Restart OpenCode after adding the plugin.

Check the setup with:

```bash
pnpm prefkit opencode doctor --opencode-config /path/to/project/opencode.jsonc
```

Without `--opencode-config`, the doctor looks across standard OpenCode config locations and `.opencode/plugins/` discovery paths.

If OpenCode is already running and does not reload the changed file, quit and restart the `opencode` TUI. For local diagnostics, use:

```bash
opencode debug config
opencode debug info
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

- explicit memory/correction prompts create `.json` event files
- weak prompts do not queue by default
- queued files are redacted before they are written
- replay performs local model learning later, outside the OpenCode hook

## Packaging Status

The `@aswinz2/prefkit`, `@prefkit/core`, and `@prefkit/opencode` packages are prepared with compiled `dist` entrypoints. Validate them locally from this repository with:

```bash
pnpm build:packages
pnpm --filter @prefkit/core pack --dry-run
pnpm --filter ./packages/cli pack --dry-run
pnpm --filter @prefkit/opencode pack --dry-run
```

The plugin and CLI are intentionally separate: OpenCode loads `@prefkit/opencode`, while that plugin calls the separately installed `prefkit` executable from `@aswinz2/prefkit` for context and queue operations. Publishing to npm is still a release step; use pnpm's publish flow so workspace dependency ranges are converted to regular semver ranges in the published manifests.
