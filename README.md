# PrefKit

PrefKit is a local-first preference memory layer for coding agents. The Phase 0 scaffold includes strict TypeScript packages, configuration loading, local model health checks, and a small CLI doctor command.

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

If the model is not running, `prefkit doctor` should fail cleanly while showing the storage/config checks that did run.
