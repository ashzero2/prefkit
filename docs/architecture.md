# PrefKit Architecture

PrefKit is split into a stable core and thin agent adapters.

```text
agent hooks/plugins/MCP
  -> adapter package
  -> @prefkit/core
  -> SQLite/config/model/retrieval services
```

The core must not import Claude, Codex, OpenCode, or MCP-specific code. Adapters translate host events into core calls and must fail open for context injection.

Storage uses SQLite through a core store interface. The first implementation uses `better-sqlite3`; callers depend on `PreferenceStore`, so the driver can be replaced later if runtime constraints change.

Retrieval is deterministic. The store uses SQLite FTS5 for the first candidate set, applies status/confidence/scope filters, ranks candidates in core code, and renders a context block that fits the configured injection budget. Retrieval does not call a local or remote model.

Phase 0 includes the monorepo scaffold, configuration loader, local model health probe, and `prefkit doctor`.
Phase 1 adds migrations, explicit manual memory commands, provenance inspection, status mutation, and Markdown export.
Phase 2 adds preference search, scope-aware ranking, token-budgeted rendering, and `prefkit context`.
