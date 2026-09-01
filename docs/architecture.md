# PrefKit Architecture

PrefKit is split into a stable core and thin agent adapters.

```text
agent hooks/plugins/MCP
  -> adapter package
  -> @prefkit/core
  -> SQLite/config/model/retrieval services

learning event queue
  -> one locked background worker
  -> redaction/prefilter/model extraction
  -> SQLite preference store
```

The core must not import Claude, Codex, OpenCode, or MCP-specific code. Adapters translate host events into core calls and must fail open for context injection.

Storage uses SQLite through a core store interface. The first implementation uses `better-sqlite3`; callers depend on `PreferenceStore`, so the driver can be replaced later if runtime constraints change.

Retrieval is deterministic. The store uses SQLite FTS5 for the first candidate set, applies status/confidence/scope filters, ranks candidates in core code, and renders a context block that fits the configured injection budget. Retrieval does not call a local or remote model.

Learning is separate from retrieval. Agent adapters should write compact event files or call core learner APIs; they should not run model extraction in hot prompt-injection hooks. The learner path validates the event, redacts evidence, applies a deterministic prefilter, calls the configured JSON model only for strong signals, validates model output, and scores confidence in code.

The CLI worker watches the queue and also polls it periodically because filesystem notifications are not guaranteed on every platform. It processes one bounded batch at a time, keeps failures retryable, and holds an exclusive per-queue lease. Multiple adapters and OpenCode sessions may enqueue concurrently; only the worker writes learned preferences. SQLite WAL allows retrieval to continue while the worker writes, while the worker's serialized batches respect SQLite's single-writer behavior.

The local model does not decide final status. It proposes an extractor output; PrefKit normalizes model-proposed `active` back to `candidate`, forces confirmation, and then applies deterministic confidence rules. Global preferences remain candidates by default unless the user pins or later policy explicitly allows promotion.

Reusable wording such as "for naming tasks, always..." is normalized to global scope when the model incorrectly returns an invented task label. Task scope is retained only when it is tied to the exact event session, preventing a reusable rule from disappearing after one conversation.

Learning uses validated, redacted event packets, deterministic signal gating, confidence scoring, local extractor orchestration, structured model output, opt-in persistence, and retryable queue replay.
