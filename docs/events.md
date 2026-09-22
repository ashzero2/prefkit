# Learner Events

Learner events are compact JSON packets produced by CLI commands, hooks, plugins, or MCP tools. They are the input to `prefkit learn` and `prefkit replay`.

## Shape

```json
{
  "agent": "claude",
  "cwd": "/repo",
  "sessionId": "session_123",
  "eventType": "explicit_correction",
  "userPrompt": "No, use pnpm here. I prefer pnpm for JavaScript projects.",
  "assistantSummary": "Suggested npm install.",
  "repoContext": {
    "packageManager": "unknown"
  },
  "metadata": {
    "userEditedGeneratedOutput": false
  }
}
```

Required fields:

- `agent`
- `eventType`

Optional fields:

- `cwd`
- `sessionId`
- `userPrompt`
- `assistantSummary`
- `repoContext`
- `metadata`

`userPrompt` and `assistantSummary` default to empty strings. `repoContext` and `metadata` default to empty objects.

## Event Types

- `explicit_memory`: user directly asks PrefKit or the agent to remember something
- `explicit_correction`: user corrects an agent choice
- `user_prompt`: ordinary prompt, usually skipped unless it contains strong preference language
- `repeated_choice`: adapter-observed repeated user choice
- `manual_replay`: intentionally replayed event

## Metadata Signals

Adapters can add mechanical signals in `metadata`:

- `explicitPreference: true`
- `repeatedChoice: true`
- `userEditedGeneratedOutput: true`
- `rejectedAction: true`

These are treated as signals for extraction. They should only be set from user-originated behavior, not from agent output alone.

## Signal gating

The deterministic gate decides whether an event is worth a model call. It is deliberately narrow:

- `remember` / `save this` / `store this` / `note that` are strong signals.
- Stable preference wording ("I prefer", "I usually", "from now on") is a strong signal.
- `always` / `never` only count when paired with an instruction ("always use …", "never commit …"). Bare absolute wording is a weak booster and cannot pass the gate alone.
- A correction needs an object or redirect ("no, use X instead", "don't run tests", "not that"). Bare "no" is not a signal, so "No worries" and "Fine, thanks" do not queue.
- One-off phrasing ("this once", "just for now", "today only") cancels the signal, because it is not durable guidance.

`assistantSummary` is only populated by hosts that expose the assistant turn. The OpenCode 2 plugin captures the previous assistant message; the Claude Code and Codex hooks see the user prompt only, so their events carry an empty `assistantSummary` and their corrections are detected from the user's wording alone.

A model-proposed supersession is only applied when its `preferenceId` matches a candidate rule that was supplied in the extraction packet. Otherwise the rule is stored as a candidate with `metadata.needsReviewReason = "unresolved-contradiction"` and no supersession link, so a hallucinated id can never retire a real preference. `prefkit review` only accepts candidates.

## Commands

Dry-run:

```bash
pnpm prefkit learn --event-file examples/events/explicit-correction.json
```

Persist:

```bash
pnpm prefkit learn --event-file examples/events/explicit-correction.json --persist
```

Replay a directory:

```bash
pnpm prefkit replay --queue-dir examples/events --limit 10
```

Replay with persistence:

```bash
pnpm prefkit replay --queue-dir examples/events --limit 10 --persist
```

## Adapter Rules

Adapters should:

- write small event files
- summarize assistant behavior instead of storing full transcripts
- avoid source-code blobs in `userPrompt`
- let PrefKit perform redaction before model extraction
- enqueue events outside latency-sensitive context hooks

Adapters should not:

- treat silence as strong evidence
- let agent-generated output reinforce itself
- run local model extraction directly inside prompt-injection hooks
- write broad global preferences without explicit user wording

## Outcome observations

Outcome evaluation is deliberately separate from learner events. After a session has an explicit end or evaluation point, record whether a correction was observed:

```bash
pnpm prefkit evaluate --session session_123 --correction-observed
pnpm prefkit evaluate --session session_456 --no-correction --without-context
pnpm prefkit evaluate
```

Only explicitly closed outcomes are included in correction rates. A session that has context exposure but no outcome record remains open and is not treated as a successful prevention. Session identifiers are stored as hashes; raw prompts and transcripts are not part of the evaluation record.
