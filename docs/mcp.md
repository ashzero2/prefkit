# MCP Server

The MCP server exposes PrefKit preference memory to any MCP-capable agent over stdio. It is the **manual and fallback** access path: hooks (Claude Code, Codex, OpenCode adapters) remain the primary automatic path, because an agent can always skip calling a memory tool.

```text
agent --stdio--> prefkit-mcp --> SQLite (same core store as the CLI)
```

The server and the CLI share `@prefkit/core` — no forked logic. Writes through MCP get the same validation, dedupe, and confidence defaults as `prefkit remember`.

## Install

```bash
npm install --global @prefkit/cli @prefkit/mcp
prefkit init
```

Or run without installing via the CLI passthrough (same server, inherits your PrefKit config):

```bash
prefkit mcp
```

`prefkit mcp [--config .prefkit.json]` respects `PREFKIT_CONFIG` / `PREFKIT_STORE` like every other command.

## Client configuration

Claude Code:

```bash
claude mcp add prefkit -- prefkit-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.prefkit]
command = "prefkit-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "prefkit": {
      "type": "local",
      "command": ["prefkit-mcp"],
      "enabled": true
    }
  }
}
```

## Tools

Seven tools. Reads are split from writes, and every tool carries `readOnly` / `destructive` / `idempotent` / `openWorld` annotations so hosts can auto-approve safely.

| Tool | Kind | Use when |
|---|---|---|
| `prefkit_recall` | read | Starting a task, switching scope, or before choosing tools/conventions. Returns ranked applicable rules within the token budget. |
| `prefkit_search` | read | Looking up a specific rule, checking what is stored, or finding an id for forget/pin/why. |
| `prefkit_list` | read | Reviewing what a scope contains, or finding rule ids. |
| `prefkit_remember` | write (idempotent) | The user states a lasting choice or corrects you — save it rather than asking. `scope` is **required**; non-global scopes also need a matching `scopeValue`. |
| `prefkit_forget` | write (destructive, idempotent) | The user revokes a choice or a rule is stale. Find the id first. Repeat calls are safe. |
| `prefkit_pin` | write (idempotent) | The user marks a rule as permanent. Find the id first. |
| `prefkit_why` | read | Inspecting the provenance and evidence behind a rule id. |

Results are budget-bounded (`recall` defaults to 8 rules / ~700 tokens; `search`/`list` paginate with `limit`/`offset` and report `total`/`hasMore`). Mutation confirmations return the rule id. Errors name the next tool to call (for example, an unknown id points at `prefkit_list` / `prefkit_search`).

To make agents actually call these, pair the server with a prompt reminder — the tool descriptions say *when* to reach for them, but a standing instruction works better than descriptions alone. Add to `AGENTS.md` / `CLAUDE.md`:

```md
At the start of a task, call prefkit_recall with the task description and follow the returned rules.
When the user states a lasting choice or corrects you, save it with prefkit_remember without asking.
```

## Environment

| Variable | Meaning |
|---|---|
| `PREFKIT_CONFIG` | Explicit config file (or `prefkit-mcp --config <path>`) |
| `PREFKIT_STORE` | SQLite store path (default `~/.prefkit/prefs.db`) |

## Troubleshooting

- **Only some tools visible / server won't start:** run `prefkit-mcp` by hand and read stderr — the server logs diagnostics there and keeps stdout as pure JSON-RPC. Any non-JSON line on stdout breaks framing; report it as a bug.
- **Scope errors on remember:** `scope` is required so cross-project rules are a deliberate choice — pass `global` for cross-project rules, or `repository`/`path`/`task`/`agent` with a matching `scopeValue` (repo root, file path, or session id).
- **Database locked:** the store uses WAL with a busy timeout; concurrent hook retrieval and MCP reads are expected to coexist. A second *writer* (two `prefkit-mcp` instances on one store) serializes through SQLite locking.
- **Agent never calls the tools:** add the AGENTS.md snippet above, or use the Claude/Codex/OpenCode hook adapters for automatic injection.
