# Changelog

Notable changes per release. PrefKit is a pre-1.0 monorepo, so packages move independently; the versions published in each release are listed with it. Minor versions may include breaking changes.

## 0.3.0 — 2026-09-23

Published: `@prefkit/core@0.3.0`, `@prefkit/cli@0.3.0`, `@prefkit/opencode@0.3.0`, `@prefkit/mcp@0.2.0`, `@prefkit/codex@0.2.0`.

### Learning

- Tightened the signal gate: `always`/`never` only count when paired with an instruction, a correction needs a redirect ("no, use X instead"), and one-off phrasing ("this once", "for now") cancels the signal. Bare "no" and "I never knew that" no longer queue.
- OpenCode 2 now captures the previous assistant turn as `assistantSummary`, so a correction reads as "user said X after the assistant did Y". Claude Code and Codex are prompt-only, so their events carry an empty summary.
- A preference with evidence from two or more earlier sessions earns a `repeated-across-sessions` confidence reason (+2), recorded as `metadata.priorDistinctSessions`.

### Review and safety

- `prefkit review` is candidate-only; reviewing an active or pinned rule is an error rather than a silent status write.
- A model-proposed supersession is applied only when its id matches a candidate that was supplied to the extractor. Otherwise the rule is stored as a candidate with `metadata.needsReviewReason = "unresolved-contradiction"` and no supersession link.
- MCP `prefkit_remember` requires an explicit `scope`; the silent global default is gone.
- Fixed: metadata was silently dropped whenever a rule already existed, discarding review, contradiction, and confidence fields on duplicate writes.

### Retrieval

- `injection.includeHeader` (or `prefkit context --with-header`) prepends "Apply the following stored preferences to this task:".
- Optional usage boost: reuse is counted in a new `preference_usage` table and a recently injected rule ranks slightly higher, decaying on `injection.usageHalfLifeDays` (0 disables). It never demotes or deletes a rule, and `--why` shows `reused N×`.

### Operations

- `prefkit worker status` reports the lock owner, queue depth, and log path; the worker writes to `<store dir>/worker.log`.
- `prefkit opencode doctor` checks the detected OpenCode major version against the configured plugin key.
- `prefkit evaluate` warns below 20 closed sessions and reports a Wilson 95% CI per group.
- Docs: adapter compatibility matrix, AGENTS.md positioning, scope-disambiguation QA procedure.

## 0.2.0 — 2026-09-21

Published: `@prefkit/core@0.2.0`, `@prefkit/cli@0.2.0`, `@prefkit/opencode@0.2.0`, `@prefkit/mcp@0.1.0`, `@prefkit/codex@0.1.0`.

- First publish of `@prefkit/mcp` and `@prefkit/codex`; added a LICENSE (Apache-2.0), per-package READMEs, and CI.
- OpenCode: added a V2 plugin (`setup()`, `session.hook("prompt"/"context")`) alongside the V1 hooks, so one entrypoint serves OpenCode 1.18.x and 2.x. `install` now emits the native `plugins` config with a directory entry.
- Correctness: `remember` no longer silently ignores a forgotten rule (`--reactivate` revives it); the learning path uses the configured confidence thresholds; imports report a dangling supersession instead of aborting; concurrent first-run migrations serialize.
- Retrieval and MCP: scope-agnostic search so `prefkit_search` sees scoped rules, list filtering in SQL with a real `count`, a lexical fallback when FTS misses, and surfaced FTS errors.
- Reliability: worker locks are reclaimed after a crash; Codex adapter path handling fixed on Windows; config precedence is explicit > env > project > user.
- Removed unwired config (`apiModel`, remote learning, file redaction, `failOpen`), dropped the unused `events` table, and stopped read-only commands creating the store.

## 0.1.x — 2026-09-09

Published: `@prefkit/core@0.1.0`, `@prefkit/cli@0.1.1`, `@prefkit/opencode@0.1.1`, `@prefkit/claude@0.1.0`.

Initial release. SQLite preference store with provenance and FTS5 retrieval, deterministic context rendering, local Ollama extraction behind a redaction and signal gate, deterministic confidence scoring, file queue with a single-worker lease and retry/dead-letter, Claude Code / Codex / OpenCode adapters, the MCP server with seven tools, and explicit session outcome recording.
