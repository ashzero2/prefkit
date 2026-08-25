# PrefKit Architecture

PrefKit is split into a stable core and thin agent adapters.

```text
agent hooks/plugins/MCP
  -> adapter package
  -> @prefkit/core
  -> SQLite/config/model/retrieval services
```

The core must not import Claude, Codex, OpenCode, or MCP-specific code. Adapters translate host events into core calls and must fail open for context injection.

Phase 0 includes the monorepo scaffold, configuration loader, local model health probe, and `prefkit doctor`.
