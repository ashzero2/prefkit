# Adapters

Adapters are intentionally thin.

- Claude Code: command hooks inject `additionalContext` and enqueue learning events.
- Codex: hooks are preferred when available; generated `AGENTS.md` and MCP are fallbacks.
- OpenCode: V2 `setup()` hooks on OpenCode 2.x, V1 `server()` hooks on 1.18.x, from one entrypoint. See [opencode.md](opencode.md).
- MCP: portable tools for manual retrieval and explicit memory commands.

No adapter should run local LLM extraction in a hot hook path.

Adapter responsibilities:

- request bounded context from `prefkit context`
- write compact learner event JSON files into `learning.queuePath`
- keep hook failures non-blocking
- avoid storing full transcripts or large code blobs
- let the background worker perform slower local model extraction later
- keep `prefkit replay --persist` available for manual recovery

The worker is shared by adapters. It owns one queue at a time, uses a lock to prevent duplicate consumers, processes bounded batches, and periodically rescans in case a filesystem notification is missed. Adapters may auto-start it, but they must never run model extraction in the prompt hook.

The event format is documented in [events.md](events.md).

## Compatibility matrix

Adapters depend on host APIs that move independently of PrefKit. Every failure mode below is fail-open: the host keeps working, PrefKit simply does nothing, so a silent no-op is the expected symptom.

| Host | Surface | Notes |
| --- | --- | --- |
| Claude Code | `UserPromptSubmit` (context, sync) + async learning hook | Prompt-only: no assistant turn is exposed, so `assistantSummary` is empty. The `Stop` hook exists but its assistant-message field is undocumented and racy (it fires before the final message is flushed), so it is not used. |
| Codex | User-layer `~/.codex/hooks.json` preferred; plugin-bundled hooks are not honoured on every surface (Codex Desktop). Fallback: generated `AGENTS.md` section, or MCP. | New or changed non-managed hooks are skipped until trusted via `/hooks`; trust is recorded per content hash, so re-trust after adapter updates. |
| OpenCode 1.18.x+ | V1 `server()` hooks (`chat.message`, `experimental.chat.*`) | `chat.message` / `messages.transform` regressed in at least one 1.17.x release (hooks never fired). Doctor checks the detected major version against the configured plugin key. |
| OpenCode 2.x | V2 `setup()` (`session.hook("prompt")`, `session.hook("context")`) | V1 hook objects are not invoked. Config must use `plugins` with a directory entry. Restart the server after config changes; the plugin inherits the server's environment. |
| Any host without hooks | MCP (`prefkit_recall`, …) | The agent has to choose to call the tools; pair with a standing instruction. |

Diagnostics: `prefkit doctor`, `prefkit opencode doctor`, `prefkit codex doctor`, and `PREFKIT_OPENCODE_DEBUG=<path>` for OpenCode hook traces.

## Procedural layer (AGENTS.md)

`AGENTS.md` is the cross-tool standard for the static instruction layer, and Claude, Copilot, and Codex all read it. PrefKit is the layer *under* it: AGENTS.md states the rules you know up front, PrefKit recalls the scoped preferences you have accumulated and keeps the reviewable, auditable record.

`prefkit codex install` prints this snippet; the same text works in `CLAUDE.md` or a project `AGENTS.md`:

```md
<!-- prefkit:managed -->
## PrefKit Learned Preferences

Before substantial tasks, run `prefkit context --prompt "<task>" --cwd <repo>` and follow the returned preferences.
To save a durable preference, run `prefkit remember "<statement>" --scope global`.
```

Where hooks are unavailable or untrusted, this is the fallback path: the agent calls the CLI itself instead of being injected automatically.
