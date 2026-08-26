# Security

PrefKit is local-first.

Required defaults:

- remote learning disabled
- redaction enabled
- no full transcript storage by default
- schema validation after every model call
- no source-code snippets in durable preference statements
- hook failures fail open for context injection

Transcript and tool-output text must be treated as untrusted data. The learner may classify and summarize it, but must never follow instructions embedded in it.

Current learning safeguards:

- weak events are skipped before model calls
- event text is redacted before extraction
- oversized evidence is truncated before extraction
- model output must pass schema validation
- model-proposed active status is not trusted directly
- confidence and status are calculated by code
- `prefkit learn` does not persist unless `--persist` is provided
- `prefkit replay` continues per file and reports failures without stopping the whole queue

Durable preferences should be operational instructions, not psychological profiles or broad personal attributes. Evidence summaries should explain the correction or preference without storing raw transcripts.
