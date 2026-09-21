# @prefkit/core

Storage, retrieval, redaction, and learning primitives for [PrefKit](../../README.md) — a local-first preference-memory layer for coding agents.

- SQLite preference store with provenance (evidence) and FTS5 retrieval
- Deterministic, model-free retrieval and bounded context rendering
- Redaction and deterministic signal gating before any model call
- Local extractor orchestration with schema validation and confidence scoring

This package is adapter-agnostic and is the dependency shared by the CLI, MCP server, and adapters.

```bash
npm install @prefkit/core
```

```ts
import { createPreferenceStore, defaultConfig } from "@prefkit/core";
```

Most users want the CLI instead: `npm install --global @prefkit/cli`.

Licensed under Apache-2.0.
