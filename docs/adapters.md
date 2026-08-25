# Adapters

Adapters are intentionally thin.

- Claude Code: command hooks inject `additionalContext` and enqueue learning events.
- Codex: hooks are preferred when available; generated `AGENTS.md` and MCP are fallbacks.
- OpenCode: V2 plugin context hooks are preferred, but the API is beta and requires version checks.
- MCP: portable tools for manual retrieval and explicit memory commands.

No adapter should run local LLM extraction in a hot hook path.
