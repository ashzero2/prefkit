# Claude Code Adapter

The adapter is a Claude Code plugin built around `UserPromptSubmit`:

```text
Claude prompt
  -> context hook -> prefkit context -> bounded additionalContext
  -> async learning hook -> prefkit queue -> detached prefkit worker
  -> redaction/prefilter/model extraction -> SQLite
```

Claude's documented hook contract allows `UserPromptSubmit` to return JSON with `hookSpecificOutput.additionalContext`. Command hooks can also run asynchronously; async hooks cannot modify the prompt, so the adapter keeps retrieval and learning in separate handlers. See the [hooks reference](https://code.claude.com/docs/en/hooks) and [plugin reference](https://code.claude.com/docs/en/plugins-reference).

## Local Test

Install the CLI and run Claude Code with the plugin directory:

```bash
npm install --global @prefkit/cli
prefkit init
claude --plugin-dir /absolute/path/to/taste/packages/adapter-claude
```

The plugin expects `prefkit` on `PATH`. For a wrapper command:

```bash
export PREFKIT_COMMAND="pnpm"
export PREFKIT_ARGS='["--dir","/absolute/path/to/taste","--silent","prefkit"]'
```

Optional settings:

```bash
export PREFKIT_CONFIG="/absolute/path/to/.prefkit.json"
export PREFKIT_QUEUE_DIR="$HOME/.prefkit/queue"
export PREFKIT_CLAUDE_NOTIFY=true
export PREFKIT_CLAUDE_DEBUG=true
```

`PREFKIT_CLAUDE_NOTIFY=true` adds a small `systemMessage` after context is applied. It is off by default. `PREFKIT_CLAUDE_QUEUE_EVENTS=false` disables learning capture, and `PREFKIT_CLAUDE_AUTO_START_WORKER=false` leaves queued events for manual processing.

## Checks

1. Start Claude Code with `--plugin-dir`.
2. Ask: `What is the project status?` and confirm it continues normally.
3. Send: `Remember that I prefer concise status updates.`
4. Wait briefly for the local worker to extract the candidate.
5. Send a new prompt and check that the preference affects the response.
6. Inspect storage with `prefkit list --all --limit 20` and evidence with `prefkit why <id>`.

Weak prompts should not create queue files. If a model or worker error occurs, Claude should continue; enable `PREFKIT_CLAUDE_DEBUG=true` for hook diagnostics. Existing queue files can be recovered with `prefkit worker --once` or `prefkit replay --persist`.

## Distribution

The npm package is `@prefkit/claude`. Claude Code installs plugins through a marketplace entry, whose plugin source can be an npm package. See the [marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces) for the catalog format and validation commands. The package itself contains only the plugin manifest, hook definition, shared command helper, and hook scripts; the CLI remains a separate `@prefkit/cli` installation.
