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
