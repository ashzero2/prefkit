# @prefkit/codex

The [Codex](https://developers.openai.com/codex/) plugin for [PrefKit](../../README.md). It injects bounded preference context on `UserPromptSubmit` and queues strong prompts for background learning.

```bash
npm install --global @prefkit/cli
prefkit init
prefkit codex install --write   # merges into ~/.codex/hooks.json
prefkit codex doctor
```

Then trust the new hooks in Codex with `/hooks`. Where hooks are unavailable or untrusted, `prefkit codex install` prints a static `AGENTS.md` fallback.

The plugin expects `prefkit` on `PATH`; set `PREFKIT_COMMAND` / `PREFKIT_ARGS` for a wrapper such as `pnpm`.

See `docs/codex.md` in the repository for configuration and troubleshooting.

Licensed under Apache-2.0.
