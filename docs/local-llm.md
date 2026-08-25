# Local LLM

PrefKit uses a local model as a preference extractor, not as the source of truth.

V1 targets Ollama first because its API supports JSON mode and schema-constrained structured outputs through the `format` field. The retrieval hot path never calls the model.

Default development settings:

```bash
PREFKIT_LEARNER=ollama
PREFKIT_OLLAMA_BASE_URL=http://127.0.0.1:11434
PREFKIT_OLLAMA_MODEL=qwen3:4b
PREFKIT_MODEL_TEMPERATURE=0
```

Run:

```bash
pnpm prefkit doctor
```

The local model check is non-invasive: it calls Ollama's model listing endpoint and verifies the configured model is installed.
