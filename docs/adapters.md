# Adapters

Adapters are intentionally thin.

- Claude Code: command hooks inject `additionalContext` and enqueue learning events.
- Codex: hooks are preferred when available; generated `AGENTS.md` and MCP are fallbacks.
- OpenCode: V2 plugin context hooks are preferred, but the API is beta and requires version checks.
- MCP: portable tools for manual retrieval and explicit memory commands.

No adapter should run local LLM extraction in a hot hook path.

Adapter responsibilities:

- request bounded context from `prefkit context`
- write compact learner event JSON files into `learning.queuePath`
- keep hook failures non-blocking
- avoid storing full transcripts or large code blobs
- let `prefkit replay` perform slower local model extraction later

The event format is documented in [events.md](events.md).
