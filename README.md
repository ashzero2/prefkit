# PrefKit

PrefKit is a local-first preference memory layer for coding agents. It stores explicit user preferences in SQLite, keeps provenance, and will later inject bounded context into Claude Code, Codex, OpenCode, and MCP-capable tools.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm prefkit doctor
```

## Manual Context

```bash
pnpm prefkit remember "For product and app naming, prefer elegant professional names." --category naming --tag app
pnpm prefkit context --prompt "I need to name an app"
```

`prefkit context` is deterministic and read-only. It retrieves active preferences, filters by scope and confidence, and renders a bounded context block without calling a model.

## Local Model

Learning is planned around a local model by default. V1 targets Ollama because its chat API supports JSON/schema-constrained outputs. The retrieval and context-injection path must not call the model.

Example setup:

```bash
ollama pull qwen3:4b
PREFKIT_OLLAMA_MODEL=qwen3:4b pnpm prefkit doctor
```

If the model is not running, `prefkit doctor` should fail cleanly while storage commands continue to work.
