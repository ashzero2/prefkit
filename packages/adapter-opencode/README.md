# @prefkit/opencode

The [OpenCode](https://opencode.ai) plugin for [PrefKit](../../README.md). It injects bounded preference context before model dispatch and queues strong prompts for background learning.

Supports both plugin APIs from one entrypoint:

- **OpenCode 2.x** — the V2 `setup()` lifecycle (`session.hook("prompt")`, `session.hook("context")`).
- **OpenCode 1.18.x** — the V1 `server()` hooks (`chat.message`, `experimental.chat.*`).

```bash
npm install --global @prefkit/cli
npm install --global @prefkit/opencode
prefkit opencode install --adapter-package @prefkit/opencode
prefkit opencode doctor
```

OpenCode 2.x config (`.opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "@prefkit/opencode", "options": { "enabled": true } }]
}
```

OpenCode 1.x uses the `plugin` key with a `[package, options]` tuple.

The plugin shells out to the `prefkit` executable, so install `@prefkit/cli` and keep it on `PATH`. Restart the OpenCode server after changing config (`opencode service restart`). Set `PREFKIT_OPENCODE_DEBUG=/path/to/log` for hook diagnostics.

See `docs/opencode.md` in the repository for details.

Licensed under Apache-2.0.
