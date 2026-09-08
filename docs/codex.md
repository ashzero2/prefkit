# Codex Adapter

The adapter is a Codex plugin built around `UserPromptSubmit`:

```text
Codex prompt
  -> context hook -> prefkit context -> bounded additionalContext
  -> async learning hook -> prefkit queue -> detached prefkit worker
  -> redaction/prefilter/model extraction -> SQLite
```

Codex's documented hook contract lets `UserPromptSubmit` return JSON with `hookSpecificOutput.additionalContext` (plain-text stdout works too). `matcher` is ignored for this event. Command hooks can run with `async: true` in the background; background hooks cannot block, so the adapter keeps retrieval (sync) and learning (async) in separate handlers. See the [hooks reference](https://developers.openai.com/codex/hooks).

## Install

The reliable install target is the user-layer hooks file. Plugin-bundled hooks use the same trust flow but do not execute on every surface (notably Codex Desktop), so prefer this:

```bash
npm install --global @prefkit/cli
prefkit init
prefkit codex install --write
prefkit codex doctor
```

`install --write` merges the two PrefKit `UserPromptSubmit` entries into `~/.codex/hooks.json` (override with `--codex-hooks <path>` or `CODEX_HOME`). Existing user hooks are preserved; re-running is idempotent and never rewrites unrelated entries. Without `--write`, it prints the snippet for manual setup plus the static `AGENTS.md` fallback.

After installing, open Codex and trust the new hooks with `/hooks`. Non-managed hooks are skipped until trusted, and trust is recorded per content hash — re-trust after adapter updates. For vetted automation only, `--dangerously-bypass-hook-trust` skips the trust requirement for that invocation.

The plugin expects `prefkit` on `PATH`. For a wrapper command:

```bash
export PREFKIT_COMMAND="pnpm"
export PREFKIT_ARGS='["--dir","/absolute/path/to/taste","--silent","prefkit"]'
```

Optional settings:

```bash
export PREFKIT_CONFIG="/absolute/path/to/.prefkit.json"
export PREFKIT_QUEUE_DIR="$HOME/.prefkit/queue"
export PREFKIT_CODEX_NOTIFY=true
export PREFKIT_CODEX_DEBUG=true
```

`PREFKIT_CODEX_NOTIFY=true` adds a small `systemMessage` after context is applied. It is off by default. `PREFKIT_CODEX_QUEUE_EVENTS=false` disables learning capture, and `PREFKIT_CODEX_AUTO_START_WORKER=false` leaves queued events for manual processing.

Hook timeouts are 5s for context injection and 30s for async learning capture. Retrieval is local SQLite only — no model call in the hook path — and every failure mode is fail-open: Codex continues normally.

## AGENTS.md fallback

Where hooks are unavailable or untrusted, add the static section printed by `prefkit codex install` to `~/.codex/AGENTS.md` (global) or `<repo>/.codex/AGENTS.md` (project). It is a manual fallback, not the dynamic path: it reminds the agent to call `prefkit context` / `prefkit remember` itself.

## Checks

1. Run `prefkit codex doctor` and confirm all checks pass.
2. In Codex, run `/hooks` and trust the PrefKit entries.
3. Ask: `What is the project status?` and confirm it continues normally.
4. Send: `Remember that I prefer concise status updates.`
5. Wait briefly for the local worker to extract the candidate.
6. Send a new prompt and check that the preference affects the response.
7. Inspect storage with `prefkit list --all --limit 20` and evidence with `prefkit why <id>`.

Weak prompts should not create queue files. If a model or worker error occurs, Codex should continue; enable `PREFKIT_CODEX_DEBUG=true` for hook diagnostics. Existing queue files can be recovered with `prefkit worker --once` or `prefkit replay --persist`.

## Distribution

The npm package is `@prefkit/codex`. It contains only the plugin manifest (`.codex-plugin/plugin.json`, also serving `hooks/hooks.json` by default), hook definitions, shared command helper, and hook scripts; the CLI remains a separate `@prefkit/cli` installation. Codex resolves plugin hook scripts via `PLUGIN_ROOT` (with `CLAUDE_PLUGIN_ROOT` set for compatibility).
