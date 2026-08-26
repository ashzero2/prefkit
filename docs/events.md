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
