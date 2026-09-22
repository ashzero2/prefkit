# @prefkit/cli

The `prefkit` command for [PrefKit](../../README.md) — local-first preference memory and context injection for coding agents.

Requires Node >= 20. Learning needs a local [Ollama](https://ollama.com) server; storage and retrieval do not.

```bash
npm install --global @prefkit/cli
prefkit init
prefkit remember "Prefer pnpm for JavaScript projects." --category tooling
prefkit context --prompt "set up a new project"
```

Includes the queue/worker for background learning, `learn`/`replay`, backup/export/import, outcome evaluation, and the `opencode`/`codex` adapter install and doctor commands.

```bash
prefkit doctor
prefkit --help
```

Store defaults to `~/.prefkit/prefs.db`; override with `PREFKIT_STORE` or `--config`.

Licensed under Apache-2.0.
