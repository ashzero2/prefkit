# AGENTS.md

PrefKit is a local-first preference-memory layer for coding agents: a pnpm monorepo, strict TypeScript, ESM, Node >= 20.

## Layout
- `packages/core` - config, SQLite store, FTS retrieval, redaction, prefilter, local extractor, confidence. Must not import agent-specific code.
- `packages/cli` - commands, queue, worker, adapter install/doctor.
- `packages/mcp` - stdio MCP server, a thin wrapper over core.
- `packages/adapter-*` - thin, fail-open hooks that shell out to the `prefkit` CLI.
- `packages/test-harness` - cross-adapter parity tests.
- `docs/` - user-facing docs. Root `plans/` and `docs/plans/` are gitignored scratch space.

## Commands
- `pnpm typecheck` - must pass before every commit.
- `pnpm test` - must pass; add or update tests with every behavior change.
- `pnpm build:packages` - builds `dist` for all publishable packages.
- `pnpm prefkit <command>` - runs the CLI from source.
Tests resolve workspace packages from `src` through `vitest.config.ts` aliases and `tsconfig.base.json` paths. Run `pnpm build:packages` before packing or publishing.

## Testing
- Tests live in `packages/*/tests`; use an isolated temp store (`mkdtempSync`), never `~/.prefkit`.
- Keep tests deterministic and offline: no network, no Ollama, no reliance on the developer's real store.
- Prefer a failing-then-passing test for every bug fix.

## Engineering rules
- Comment only critical, non-obvious decisions. Prefer a clear name over a comment.
- No unnecessary abstractions, helpers, or single-use functions; inline trivial code.
- No backwards-compatibility shims, unused exports, or dead config; delete unused code.
- Follow existing patterns and formatting, and keep diffs surgical.
- Never edit an applied migration; add a new migration id instead.

## Safety invariants
- Core stays adapter-agnostic; adapters translate host events and fail open.
- Retrieval is deterministic and never calls a model. The model proposes; code decides status and confidence.
- Redact before any model call, and schema-validate all model output.
- Global preferences require confirmation; candidates are not injected by default.

## Commit and phase rules
- Conventional commits, imperative mood, two lines maximum (subject plus optional body).
- No co-author trailer.
- Each commit must be independently reviewable with `pnpm typecheck` and `pnpm test` green.
- Work in phases: implement one phase, stop, and report what changed plus dev-build checks; commit only after approval.
- One phase per commit unless a change is explicitly a mechanical follow-up.
- Don't commit build output (`dist/`) or local agent state (`.commandcode/`); both are gitignored.
