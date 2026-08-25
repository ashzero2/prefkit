# PrefKit

PrefKit is a local-first preference memory layer for coding agents. It stores explicit user preferences in SQLite, keeps provenance, and will later inject bounded context into Claude Code, Codex, OpenCode, and MCP-capable tools.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm prefkit doctor
```

## Local Model

Learning is planned around a local model by default. V1 targets Ollama because its chat API supports JSON/schema-constrained outputs. The retrieval and context-injection path must not call the model.

Example setup:

```bash
ollama pull qwen3:4b
PREFKIT_OLLAMA_MODEL=qwen3:4b pnpm prefkit doctor
```

If the model is not running, `prefkit doctor` should fail cleanly while storage commands continue to work.
