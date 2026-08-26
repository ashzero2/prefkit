# Local LLM

PrefKit uses a local model as a preference extractor, not as the source of truth. The local model proposes structured output; PrefKit validates the JSON and applies deterministic confidence rules.

## Default Setup

```bash
ollama pull qwen3:4b

export PREFKIT_LEARNER=local
export PREFKIT_OLLAMA_BASE_URL=http://127.0.0.1:11434
export PREFKIT_OLLAMA_MODEL=qwen3:4b
export PREFKIT_MODEL_TEMPERATURE=0

pnpm prefkit doctor
```

`doctor` calls Ollama's model listing endpoint and verifies that the configured model is installed.

## Remote Ollama

If Ollama runs on another machine, configure Ollama on that machine to listen on a reachable host using `OLLAMA_HOST`, then point PrefKit at it:

```bash
export PREFKIT_OLLAMA_BASE_URL="http://<ollama-host>:11434"
export PREFKIT_OLLAMA_MODEL="qwen3:8b-q4_K_M"
pnpm prefkit doctor
```

Keep the Ollama server on a trusted network. PrefKit sends redacted event evidence to this endpoint for learning.

## Structured Output

PrefKit calls Ollama's native `/api/chat` endpoint with:

- `stream: false`
- `think: false`
- `format` set to PrefKit's extractor JSON schema
- `options.temperature` from config
- `options.num_predict` from `localModel.maxOutputTokens`

The response `message.content` is parsed as JSON, then validated with the extractor schema. Token usage is read from `prompt_eval_count` and `eval_count` when Ollama returns those fields.

## Learning Checks

Dry-run a strong event:

```bash
pnpm prefkit learn --event-file examples/events/explicit-correction.json
```

Persist it only after reviewing the output:

```bash
pnpm prefkit learn --event-file examples/events/explicit-correction.json --persist
pnpm prefkit list --all
```

Replay a queue:

```bash
pnpm prefkit replay --queue-dir examples/events --limit 10
```

## Failure Modes

Expected clean failures:

- Ollama is unreachable: `model_error`
- configured model is missing: `doctor` reports local model failure
- model returns non-JSON: `invalid_model_output` or `model_error`
- event has weak signal: `learning_skipped`
- evidence exceeds input budget: `input_too_large`

Storage and retrieval commands should keep working even when the local model is unavailable.
