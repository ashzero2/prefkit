# OpenCode Adapter

PrefKit's OpenCode adapter targets **both** the V1 and V2 plugin APIs from one entrypoint:

- OpenCode 1.18.x and newer: the V1 `server()` hook object (`chat.message`, `experimental.chat.*`).
- OpenCode 2.x: the V2 `setup()` lifecycle, registering `session.hook("prompt")` for prompt capture and `session.hook("context")` for context injection.

V2 is a breaking plugin API change: V1 hook objects are not invoked in V2, so the adapter default-exports one object that implements both. V2 reads `id` and `setup()`; V1 reads `server()`.

On OpenCode 2.x the `context` hook also sees the conversation, so the adapter records the previous assistant message as `assistantSummary` for the next learner event. That makes a correction read as "the user said X after the assistant did Y". On the V1 path (and on Claude Code / Codex) events carry an empty `assistantSummary`.

V2 also differs in configuration:

- The plugin key is `plugins` (plural), not `plugin`.
- An entry is a string/path or a `{ "package": ..., "options": { ... } }` object, not a `[package, options]` tuple.
- A configured `package` must be a **directory** (the adapter's `src` directory locally, or the installed `@prefkit/opencode` package). A file path is rejected by the V2 loader.

`prefkit opencode install` emits the V2-native shape by default and points at the local adapter directory.

After changing the config, restart the OpenCode server so it reloads plugins:

```bash
opencode service restart
```

The plugin runs inside OpenCode's server process, so the `prefkit` calls it makes inherit the **server's** environment. Set `PREFKIT_STORE` / `PREFKIT_CONFIG` before starting the server, not just on the client command.

For hook diagnostics, set `PREFKIT_OPENCODE_DEBUG` to a file path; the plugin appends one line per hook invocation:

```bash
export PREFKIT_OPENCODE_DEBUG=/tmp/prefkit-opencode.log
```

OpenCode plugin docs describe:

- plugin entries in `plugins` for OpenCode 2.x (`plugin` for 1.x)
- the V2 `setup()` lifecycle and `session.hook(...)` registrations
- local discovery under `.opencode/plugins/`
- the stable `chat.message` hook for user-message capture in 1.x
- context injection before model dispatch in 1.x via `experimental.chat.system.transform` and `experimental.chat.messages.transform`
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
  -> start one detached `prefkit worker` for the queue
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

It does not run local model learning inside the prompt path. The worker processes queued events asynchronously, so two OpenCode instances can write to the same queue without each running a learner. A per-queue lock ensures only one worker consumes that queue.

## Local Development Loading

From an OpenCode project, generate a config snippet:

```bash
pnpm prefkit opencode install
```

If the project has no local OpenCode config yet, PrefKit can create `.opencode/opencode.jsonc`:

```bash
pnpm prefkit opencode install --write
```

For current local development from this repo, the generated `package` value points at the local adapter directory. For a packaged install, use the `@prefkit/opencode` package once it is published:

```bash
npm install --global @prefkit/cli
prefkit opencode install --adapter-package @prefkit/opencode
```

You can also add the plugin entry manually to `opencode.jsonc`. OpenCode 2.x uses `plugins`, and the entry must point at a directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@prefkit/opencode",
      "options": {
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
        "autoStartWorker": true,
        "contextTimeoutMs": 5000,
        "notifyOnInjection": "once-per-session",
        "notificationDurationMs": 5000
      }
    }
  ]
}
```

On OpenCode 1.18.x, keep the V1 shape (`plugin` with a `[package, options]` tuple). The same adapter package serves both.

If you do not use `configPath`, PrefKit will look for `.prefkit.json` from the OpenCode worktree and then the user config path.

The adapter does not open SQLite inside OpenCode's Bun runtime. It invokes the Node-based `prefkit` CLI for both context lookup and learner-event queueing. Queue input is sent over stdin, then the CLI validates, redacts, gates, and writes it. The published plugin package has no `@prefkit/core` or native SQLite dependency. Install the published `@prefkit/cli` package separately and keep its `prefkit` executable on `PATH`, or configure `prefkitCommand` and `prefkitArgs` for a custom executable.

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

The adapter starts the worker automatically after a strong preference prompt. To inspect or recover events, use:

```bash
pnpm prefkit worker --queue-dir ~/.prefkit/queue --once
pnpm prefkit list --all --limit 20
```

Expected:

- explicit memory/correction prompts create `.json` event files
- weak prompts do not queue by default
- queued files are redacted before they are written
- the worker performs local model learning later, outside the OpenCode hook
- `prefkit replay --persist` remains available for manual recovery and diagnostics

## Packaging Status

The `@prefkit/cli`, `@prefkit/core`, and `@prefkit/opencode` packages are prepared with compiled `dist` entrypoints. Validate them locally from this repository with:

```bash
pnpm build:packages
pnpm --filter @prefkit/core pack --dry-run
pnpm --filter ./packages/cli pack --dry-run
pnpm --filter @prefkit/opencode pack --dry-run
```

The published OpenCode package exposes `./server` (and `main`) because OpenCode resolves npm server plugins through that entrypoint. Keep both fields when changing the package manifest.

The plugin and CLI are intentionally separate: OpenCode loads `@prefkit/opencode`, while that plugin calls the separately installed `prefkit` executable from `@prefkit/cli` for context and queue operations. Publishing to npm is still a release step; use pnpm's publish flow so workspace dependency ranges are converted to regular semver ranges in the published manifests.
