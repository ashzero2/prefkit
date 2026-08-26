# PrefKit

PrefKit is a local-first preference memory layer for coding agents. It stores durable working preferences in SQLite, keeps provenance, retrieves only relevant preferences for a task, and can learn candidate preferences from redacted agent events through a local model.

The current implementation supports:

- manual preference storage
- provenance inspection
- status changes with `pin` and `forget`
- deterministic preference retrieval and context rendering
- local Ollama structured JSON extraction
- redaction before model calls
- deterministic signal gating and confidence scoring
- single-event learning with optional persistence
- queue replay for adapter-produced event files

Agent adapters for Claude Code, Codex, OpenCode, and MCP are planned next. The core package is intentionally adapter-agnostic.

## Install

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Initialize the local store:

```bash
pnpm prefkit init
```

By default the store is `~/.prefkit/prefs.db`.

For isolated checks, use a temporary store:

```bash
export PREFKIT_STORE="/tmp/prefkit-check.db"
pnpm prefkit init
```

## Configuration

PrefKit loads configuration from:

1. `--config path`
2. `PREFKIT_CONFIG`
3. `.prefkit.json` in the current directory
4. `~/.config/prefkit/config.json`
5. environment variables

Useful environment variables:

```bash
PREFKIT_STORE=~/.prefkit/prefs.db
PREFKIT_LEARNER=local
PREFKIT_OLLAMA_BASE_URL=http://127.0.0.1:11434
PREFKIT_OLLAMA_MODEL=qwen3:4b
PREFKIT_MODEL_TEMPERATURE=0
PREFKIT_MODEL_TIMEOUT_MS=20000
PREFKIT_REDACT_SECRETS=true
```

See [.prefkit.example.json](.prefkit.example.json) for all supported settings.

## Doctor

```bash
pnpm prefkit doctor
```

`doctor` checks config loading, store availability, and local Ollama reachability. A model failure should be clean and should not break storage or retrieval commands.

If Ollama runs on another machine, expose Ollama there and point PrefKit at it:

```bash
export PREFKIT_OLLAMA_BASE_URL="http://<host>:11434"
export PREFKIT_OLLAMA_MODEL="qwen3:8b-q4_K_M"
pnpm prefkit doctor
```

Ollama remote serving is controlled by Ollama's `OLLAMA_HOST` setting on the server machine.

## Manual Preferences

Add a preference:

```bash
pnpm prefkit remember "Prefer pnpm for JavaScript package management." --category tooling --tag javascript --tag package-manager
```

List preferences:

```bash
pnpm prefkit list
pnpm prefkit list --all
```

Inspect provenance:

```bash
pnpm prefkit why <pref_id>
```

Pin or suppress a preference:

```bash
pnpm prefkit pin <pref_id>
pnpm prefkit forget <pref_id>
```

Export:

```bash
pnpm prefkit export --format markdown
```

## Context Retrieval

`prefkit context` is deterministic and read-only. It does not call a model.

```bash
pnpm prefkit context --prompt "I need to name an app"
pnpm prefkit context --prompt "I need to name an app" --why
pnpm prefkit context --prompt "I need a testing strategy" --limit 3 --min-confidence 0.6
```

Retrieval uses SQLite FTS plus lexical fallback, scope filtering, confidence filtering, and a token-bounded renderer. It is designed to inject a small set of relevant preferences, not the whole memory database.

## Learning

Learning uses a local model as an extractor, not as the authority.

Flow:

```text
event JSON
  -> validate schema
  -> redact secrets and oversized evidence
  -> deterministic signal prefilter
  -> local model structured JSON extraction
  -> validate model output
  -> deterministic confidence scoring
  -> optional SQLite persistence
```

Dry-run one event:

```bash
pnpm prefkit learn --event-file examples/events/explicit-correction.json
```

Persist only if extraction succeeds:

```bash
pnpm prefkit learn --event-file examples/events/explicit-correction.json --persist
```

Replay queued events:

```bash
pnpm prefkit replay --queue-dir examples/events --limit 10
pnpm prefkit replay --queue-dir examples/events --limit 10 --persist
```

Weak events are skipped before any model call:

```bash
pnpm prefkit learn --event-file examples/events/weak-user-prompt.json
```

## Event JSON

Adapters should write compact event packets like this:

```json
{
  "agent": "claude",
  "cwd": "/repo",
  "sessionId": "session_123",
  "eventType": "explicit_correction",
  "userPrompt": "No, use pnpm here. I prefer pnpm for JavaScript projects.",
  "assistantSummary": "Suggested npm install.",
  "repoContext": {
    "packageManager": "unknown"
  },
  "metadata": {
    "userEditedGeneratedOutput": false
  }
}
```

Supported event types:

- `explicit_memory`
- `explicit_correction`
- `user_prompt`
- `repeated_choice`
- `manual_replay`

Only strong signals should reach the local extractor. Ordinary prompts, silence, and unreviewed agent output should not become preferences.

## Safety Model

PrefKit is conservative by design:

- retrieval never calls the model
- learning is local by default
- remote learning is disabled by default
- redaction runs before model extraction
- model output is schema-validated
- model-proposed `active` status is normalized back to `candidate`
- deterministic confidence code decides status and score
- global preferences require confirmation by default
- skipped and oversized events do not call the model

## Current Roadmap

Completed:

- Phase 0: workspace, config, doctor
- Phase 1: SQLite storage and manual preference commands
- Phase 2: deterministic retrieval and bounded context rendering
- Phase 3: learner schemas, redaction, prefilter, confidence engine, extractor runner, Ollama JSON generation, `learn`, persistence, replay

Next:

- Phase 3 docs and real-model tuning
- Phase 4 Claude Code adapter
- Phase 5 OpenCode adapter
- Phase 6 Codex adapter
- MCP tools for portable preference retrieval and explicit memory
