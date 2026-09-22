# @prefkit/mcp

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server for [PrefKit](../../README.md) preference memory. It is the portable, manual/fallback access path — hooks (Claude Code, Codex, OpenCode) remain the automatic path.

Seven annotated tools: `prefkit_recall`, `prefkit_search`, `prefkit_list`, `prefkit_remember`, `prefkit_forget`, `prefkit_pin`, `prefkit_why`.

```bash
npm install --global @prefkit/cli @prefkit/mcp
prefkit init
```

Claude Code:

```bash
claude mcp add prefkit -- prefkit-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.prefkit]
command = "prefkit-mcp"
```

Or run it through the CLI: `prefkit mcp`.

Uses the same `@prefkit/core` store as the CLI (default `~/.prefkit/prefs.db`, override with `PREFKIT_STORE`).

Licensed under Apache-2.0.
