# Agent Taste / PrefKit — Plan Review + External Research + Insights

Date: 2026-09-08
Sources: `plans/agent-taste-design.md`, `plans/agent-taste-implementation-plan.md`, `README.md`, current code + tests, web/comparison sites, MCP server roundups, Reddit (`r/AI_Agents`, `r/ClaudeCode`, `r/mcp`), Hacker News, Claude Code hook guides, agent-memory repos (Mem0, Zep, Letta, Cognee, Basic Memory, claude-mem, EchoVault, agentmemory).

## 1. Where the plan stands

The plan — now implemented as **PrefKit** — is:

```text
events → deterministic trigger → local LLM extractor → deterministic confidence/scope → SQLite + FTS5 → bounded retrieval (~700 tokens) → thin adapters
```

Current state vs. plan:

* **Done (Phases 0–8 hardening slice):** config, SQLite store + evidence/provenance, `remember/list/why/pin/forget/review/export/import/backup/stats`, FTS retrieval + scope + token budget, Ollama local extractor + prefilter + redaction + confidence, queue + `worker` + `replay` with bounded retries, OpenCode/Claude Code/Codex adapters, and the MCP server. The current verification baseline is 23 test files and 138 passing tests.
* **Remaining:** impact-level instrumentation for whether a later correction was prevented, plus fixture-based evaluation. Local retrieval impressions, hit rate, and estimated injected token spend are now opt-in counters; correction linkage still needs explicit event semantics before it is reported.
* **Correctly deferred:** no vector DB, no daemon, no sync/UI, no diff-learning, no per-model overrides.

The core thesis — *"LLM proposes, code disposes"* — is the strongest part of the plan. The model never sets confidence, retrieval/hot hooks never call a model, and model-proposed `active` is normalized back to `candidate`.

## 2. What the outside world says

**The problem is real and crowded.** Everyone converged on the same pain: "I re-teach every agent the same preferences."

Landscape in 2026:

| Layer | Examples | Model |
|---|---|---|
| Hosted memory API | **Mem0/OpenMemory** (semantic preferences, fastest to bolt on), **Supermemory** (low latency), **Zep/Graphiti** (temporal graph: "what was true on Tuesday?"), **Letta** (full agent runtime, self-editing core memory), **Cognee** (doc/entity graph) | Cloud embeddings + extraction, $$, data leaves machine |
| Local MCP memory | **Basic Memory** (Markdown on disk), **official knowledge-graph server** (JSON), **codex-agent-mem** (SQLite+FTS5), **mcp-memory/OKF** (HN Show, 71 pts, 36 comments — FTS5 vs vector debate) | Local-first, human-readable, MCP-dependent |
| Coding-agent capture | **claude-mem** (74k stars, SQLite, but RAM-heavy), **EchoVault** (built *because* claude-mem ate RAM; Markdown+FTS5, no daemon), **agentmemory** (SQLite + iii-engine, 12 Claude hooks / 22 OpenCode hooks, BM25+vector+graph, viewer) | Hook auto-capture + summarization |
| This project | **PrefKit** | SQLite+FTS5, *preference-only*, scoped, confidence-gated, Ollama-local |

Key community signals:

* Reddit `r/AI_Agents`: "structured key-value memory feels underrated vs heavy RAG" + "manual + suggested saves solve *what should be remembered*". That is exactly the `remember` + `candidate → review` flow.
* Reddit `r/ClaudeCode` / EchoVault post: #1 complaint is **RAM + perf + cloud fear**. The `<200ms warm retrieval, fail-open, no daemon, queue` design directly answers it.
* HN on MCP Memory: for small N, FTS5 `O(log N)` vs scan barely matters — but boolean/ranking queries scale. Validates the "FTS5 first, embeddings only if needed" V1.
* Mengram / Claude hooks guides: the working loop is `SessionStart → profile, UserPromptSubmit → additionalContext recall, Stop → async save`. PrefKit already does this. One warning from issues: `UserPromptSubmit additionalContext` is flaky in VSCode extension builds — hence `doctor` + fail-open is essential, not nice-to-have.
* CUHK/Zhejiang paper circulating: "RAG is memo, not learning." The answer — provenance, polarity, supersession, decay-on-retrieval-not-delete — is the right rebuttal.

References consulted:

* https://mcp.directory/blog/mem0-vs-letta-vs-zep-vs-cognee-2026
* https://hjarni.com/blog/best-mcp-memory-server
* https://mengram.io/blog/claude-code-memory-hooks
* https://github.com/rohitg00/agentmemory
* https://news.ycombinator.com/item?id=49286073
* https://github.com/mraza007/echovault
* https://code.claude.com/docs/en/hooks
* https://opencode.ai/v2/docs/build/plugins

## 3. Thoughts / insights

### What's genuinely differentiated (keep it)

1. **Preference memory ≠ episodic memory.** Mem0/Zep/agentmemory/claude-mem store *everything that happened*. PrefKit stores *reusable operational rules with scope*. That is smaller, cheaper, more inspectable, and less creepy. Don't drift into full session replay — that is a crowded, token-hungry game.
2. **Scopes + precedence (`task > path > repo > global`)** — almost nobody does this well. Mem0 has `user/agent/session` isolation; PrefKit has repo/path awareness for coding. This is the moat against cross-project leakage, the #1 fear in forums.
3. **Provenance + anti-self-reinforcement.** The rule "agent output ≠ user evidence" is rare and correct. Most auto-capture systems risk amplifying their own mistakes.
4. **Global-promotion gate + `requireConfirmationForGlobal`.** Forums hate "one correction became a permanent personality". One interaction → candidate is the right conservatism.

### Risks / gaps seen from research

1. **Name collision:** "Taste" in AI-coding now means *frontend taste* — `tasteskill.dev`, `tastemaker` (persistent per-developer taste profile for UI), `voidxai/taste` (5-dimension code taste skill). All SEO-heavy in 2026. Keeping `PrefKit` as the code name was smart — don't ship as "Taste".
2. **MCP-only is insufficient** — the plan already notes this ("agent has to remember to call it"). The market confirms: winners use **hooks for auto-inject + MCP for manual `remember/search`**. Finish Codex hooks + MCP together; MCP alone won't prove retention.
3. **Hook fragility is the #1 support cost.** OpenCode V2 plugin API is beta, Claude VSCode hooks have open bugs, Codex Desktop ignores plugin `hooks.json` (openai/codex#16430). The "thin adapters + `doctor <agent>` + version-gated tests" posture is the only sustainable one. Keep adapters dumb.
4. **Evaluation gap:** competitors quote LongMemEval/LoCoMo (Mem0 91.6, Hindsight 94.6 — mostly vendor numbers). PrefKit has fixtures + replay harness, which is better for *preference* correctness, but lacks a public "repeated-correction prevented" metric. The V1 success criteria ("repeated corrections stop recurring") needs instrumentation from day one or it loses the benchmark story.
5. **Extraction quality at qwen3:4b:** plan defaults to `qwen3:4b, temp 0, Ollama JSON mode`. Fine for `pnpm vs npm`, weak for scope disambiguation ("don't research *this* deeply" vs "never research deeply"). Research consensus: pin a cheap model for extraction, batch writes, escalate ambiguous → stronger model. The hybrid note exists — make it explicit in `learn`: low-signal → skip, high-signal → local, ambiguous → flag for `review`, not auto-promote.
6. **Privacy story is half-told.** Local `taste.db` is good, but inference still goes to Claude/OpenAI. Forums care about this nuance. The `redactSecrets + cap evidence + hash provenance + allowRemoteLearning=false` setup is correct — surface it in `why`/`export` so users *see* nothing raw is stored.

## 4. Recommended next moves

1. **Don't add vectors yet.** Keep the Codex adapter (hooks + tiny `AGENTS.md` fallback) and MCP (`context/remember/search/why/forget/pin`) stable — they now complete the "same memory in Claude/Codex/OpenCode" promise.
2. **Add correction linkage:** extend the local metrics with an explicit, privacy-safe relationship between a later correction and the prior injected context. Needed to answer "does this work?" without vibes.
3. **Add a fixture-driven evaluation:** measure extraction decisions, scope normalization, contradiction handling, and redaction misses without sending data off-machine.
4. **Harden the learning gate:** keep `diffLearning.enabled=false` for V1 (diff intent is ambiguous), and require 2+ evidences or explicit pin for `global/active`.
5. **Docs positioning line:** *"Not session memory. Preference memory."* — SQLite you can read, scopes you can audit, rules you can `why/pin/forget`. That separates PrefKit from Mem0/Zep (cloud graph), Basic Memory (notes), claude-mem/agentmemory (episodic capture).

Bottom line: the plan's bets — FTS5 over vector DB, deterministic confidence over LLM authority, scopes over global dump, fail-open hooks over blocking calls, queue-worker over daemon — are all validated by what failed for others in forums/HN in the last year. The hard part was never storage; it is false generalization + scope + retrieval hygiene, which is exactly where this design spends its complexity. The adapter/MCP last mile and the first hardening pass are complete; the next meaningful step is measuring user-visible impact locally.
