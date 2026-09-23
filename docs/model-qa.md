# Model QA

Use this checklist before trusting a local model for persisted learning.

## Recommended Baseline

Start with a non-MLX GGUF model that has reliable structured-output behavior on your Ollama server.

```bash
export PREFKIT_LEARNER=local
export PREFKIT_OLLAMA_BASE_URL=http://127.0.0.1:11434
export PREFKIT_OLLAMA_MODEL=qwen3:8b-q4_K_M
export PREFKIT_MODEL_TEMPERATURE=0
export PREFKIT_MODEL_THINK=omit
pnpm prefkit doctor
```

If Ollama is remote, set `PREFKIT_OLLAMA_BASE_URL` to that server.

## QA Pass

Dry-run the example events:

```bash
pnpm prefkit learn --event-file examples/events/explicit-correction.json
pnpm prefkit learn --event-file examples/events/explicit-memory.json
pnpm prefkit learn --event-file examples/events/naming-preference.json
pnpm prefkit learn --event-file examples/events/communication-style.json
pnpm prefkit learn --event-file examples/events/package-manager-contradiction.json
pnpm prefkit learn --event-file examples/events/secret-redaction.json
pnpm prefkit learn --event-file examples/events/weak-user-prompt.json
```

Expected behavior:

- strong explicit events should usually return `extracted`
- weak user prompts should return `learning_skipped`
- secret-bearing events should show `redactions=...`
- global preferences should usually remain `candidate`
- repository-specific corrections can become `active`
- `promptTokens~=` and `usage=input:... output:...` should appear when the model runs and Ollama reports usage

Replay the same examples:

```bash
pnpm prefkit replay --queue-dir examples/events --limit 20
```

Persist only after reviewing output:

```bash
export PREFKIT_STORE="/tmp/prefkit-model-qa.db"
pnpm prefkit init
pnpm prefkit replay --queue-dir examples/events --limit 20 --persist
pnpm prefkit list --all
```

## Structured Output Tuning

PrefKit sends Ollama a JSON schema through `format` and validates the returned `message.content`.

`PREFKIT_MODEL_THINK` controls the optional Ollama `think` field:

- `omit`: do not send `think`; default
- `false`: send `think: false`
- `true`: send `think: true`
- `low`, `medium`, `high`, `max`: send that thinking level

Prefer `omit` first. Recent Ollama issue reports show `think: false` can break schema-constrained output for some model/backend combinations, while the official API still supports the field. If you see invalid JSON or markdown/prose instead of JSON, try:

```bash
export PREFKIT_MODEL_THINK=low
pnpm prefkit learn --event-file examples/events/explicit-correction.json
```

If an MLX-backed model ignores schema output, switch to a GGUF/non-MLX model before tuning PrefKit prompts. The extractor should fail closed with `invalid_model_output` instead of accepting prose.

## Acceptance Criteria

For a model to be acceptable for persisted learning:

- at least the explicit correction and explicit memory fixtures extract successfully
- weak prompt fixture skips before model use
- secret-redaction fixture does not expose raw secrets in output
- no fixture creates an obviously broad personality statement
- invalid outputs are rejected, not persisted
- persisted preferences are inspectable with `prefkit why`

## Scope disambiguation

Scope selection is the weakest local-model behaviour, so check it explicitly rather than trusting the fixtures alone. For each prompt, note the scope the model returned (`prefkit learn --event-file …` prints it), then compare against the intent:

| Prompt shape | Intended scope | Failure to watch for |
| --- | --- | --- |
| "Don't research this one deeply" | task (`scopeValue` = the session id) | promoted to global |
| "No, use pnpm in this repo" | repository | promoted to global |
| "From now on, always use pnpm" | global (reusable) | demoted to task |
| "For naming tasks, always give 10 options" | global (reusable) | invented task label as `scopeValue` |

Run each prompt at least 5 times at `temperature: 0` and record the results. The metric to track is the **false-global rate**: the share of repository- or task-scoped prompts that came back as `global`. PrefKit's deterministic rules absorb some of this — reusable wording forces task scope to global, and global still lands as a `candidate` behind confirmation — but a high false-global rate means the model is guessing, not reading the prompt.

`normalizePreferenceScope` covers the one deterministic case: task-scoped extractions whose prompt uses reusable wording are normalised to global. Everything else is a property of the model, which is why the promotion gate defaults to requiring explicit confirmation.
