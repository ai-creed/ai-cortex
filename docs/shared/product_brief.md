# ai-cortex Product Brief

> **v2** (2026-05-02). Supersedes v1 (now at `docs/misc/product_brief-v1.md`),
> which framed ai-cortex as an MVP-stage rehydration tool. The product has
> grown well past that scope and warrants a current-state brief.

## One Line

**ai-cortex is a local-first intelligence layer that gives AI agents fast project context, persistent memory, and session continuity — without writing into the target repository.**

## Users

**Primary (today):** solo AI-heavy developers who use Claude Code, Codex, Cline, or similar MCP-compliant agents. They have multiple projects, switch contexts often, and lose hours per week to agents re-deriving the same project knowledge.

**Adjacent (planned):** the broader `ai-*` ecosystem of agent-adjacent tools (e.g. `ai-14all` workspace tooling) that benefit from a shared substrate for project knowledge.

**Not the user:** team-shared knowledge bases, cloud-hosted RAG products, IDE-integrated assistants. ai-cortex is per-developer, local-only, and substrate-not-product.

## Core Problems

Three problems compound and reinforce each other:

1. **Cold start.** New agent sessions don't understand the project — structure, conventions, entry points. Default response: broad repo scan, slow startup, inconsistent context.
2. **Continuity.** Agents don't remember past sessions — decisions, gotchas, mistakes already made and corrected. Default response: rediscover, redebate, remistake.
3. **Hidden knowledge.** Code shows the *what*. Docs sometimes show the *how*. Neither shows the *why* and the *what we tried that didn't work*. The most valuable context lives nowhere in the repo.

## Value Props

| Job to be done | How ai-cortex does it |
|---|---|
| Start a new session productively | `rehydrate` produces a markdown briefing in milliseconds: structure, key files, pinned memories, memory digest, recent changes |
| Find the right files for a task | `suggest` (fast / deep / semantic) ranks files by relevance with explanations |
| Recover context lost to harness compaction | `search_history` queries past sessions for decisions, file paths, prior discussion |
| Capture project-specific rules and gotchas | Memory layer auto-extracts from session evidence; agent uses the recall→get pattern to apply them |
| Keep the target repo clean | All data is tool-owned in `~/.cache/ai-cortex/`. The repo never sees a write. |
| Work across whichever agent you prefer | MCP server delivers 30 tools to any MCP-compliant agent. No agent-specific lock-in. |

## Current Scope

Three layers, each useful on its own, each compounding when stacked.

**Structural layer**
- Repo indexing with tree-sitter (TypeScript, JavaScript, Python, C, C++)
- Call graph + import graph + trigram index + content scan
- File ranking in three modes: fast, deep, semantic
- Blast-radius / impact analysis

**Continuity layer**
- Session history capture (Claude Code, Codex hooks)
- Compacted history search across past sessions
- Persistent memory layer (markdown-of-record + SQLite + vectors)
  - Four built-in types: `decision`, `gotcha`, `pattern`, `how-to`
  - Full lifecycle: candidate → active → deprecated → trashed → purged
  - Two-tier storage: project-scoped + cross-project global
  - Auto-extraction from session evidence with re-extraction confidence stability
  - Aging sweeps remove stale candidates; rewrite cleanup polishes high-signal ones

**Integration layer**
- MCP server with 30 tools
- Briefing injection at session start (rehydration + memory digest + tool guidance)
- `install-prompt-guide` writes a versioned guidance block to CLAUDE.md / AGENTS.md to nudge agents into the recall→get pattern

## Non-Goals

These are deliberate, not deferred:

- **Not a full assistant.** ai-cortex is a context substrate; the agent is the agent.
- **Not an LLM-hosting service.** Zero LLM calls in the substrate. No API keys. Cost transparency stays with the user's agent.
- **Not committed-to-repo memory.** Cache is tool-owned and local. Repos stay publish-safe. (Differentiator vs. CLAUDE.md / `.cursor/rules`.)
- **Not cloud-synced.** No multi-machine sync, no team sharing.
- **Not a real-time watcher.** Cache refreshes on-demand, not continuously.
- **Not a code search engine.** Tree-sitter parsing is good enough for navigation; not a replacement for grep on file content.

## Storage Model

- Cache lives outside the target repo (`~/.cache/ai-cortex/<repoKey>/`)
- Storage is tool-owned and local-only
- Markdown is the source of truth for memories; SQLite + vectors are derived (rebuildable)
- Audit log captures every state transition; full version chain is reconstructable
- Target repos stay clean and publish-safe

## Distribution

- npm: `npm install -g ai-cortex` (current)
- From source: `git clone … && pnpm build && pnpm link --global`
- Homepage: <https://ai-creed.dev/projects/ai-cortex/>
- Source: <https://github.com/ai-creed/ai-cortex>

## Roadmap (Near-Term)

These are intentions, not commitments. Order is rough; priorities shift with usage signal.

1. **Adoption telemetry.** Aggregate the `logged()` MCP tool-call traces into a per-session histogram so call rate is observable. Without this we're guessing whether agents actually use the tools.
2. **Closed feedback loop.** Reconcile recall events against subsequent session evidence to detect "memory recalled but rule violated" — auto-decay confidence on negative signal, bump on positive. Counters are in place; the analyzer is not.
3. **Wider ecosystem integration.** First-class hooks for `ai-14all` and other `ai-*` tools. Currently the integration is via MCP; tighter coupling may be warranted.
4. **Wow-loop UX wrapper.** Thin command wrapper (`ai ask "how does auth work?"`) that hides the verbose `ai-cortex memory recall …` form. Primitives exist; the wrapper doesn't.
5. **Larger embedding model option.** `bge-small-en-v1.5` or `multilingual-e5-small` as opt-in via config to handle short / abbreviation-heavy queries the current 22M model misses.
6. **Memory extraction quality.** The regex-based heuristics catch some signal; an LLM-based extractor (running in a subagent) would catch much more. Deferred until call rate validates the demand.

## Key Risks

- **Adoption gap.** Tools are useless if the agent doesn't call them. The cardinal pattern (`recall`→`get`) and `install-prompt-guide` are bets on changing this; we need real-use telemetry to know if they work.
- **Recall ceiling on short queries.** The default 22M embedding model handles thematic matches well but struggles with domain abbreviations. A keyword anchor in the query usually rescues it; pure-semantic recall on 2–3 word queries can fail.
- **Heuristic extractor.** Auto-extraction misses well-phrased decisions that don't match the regex. The boost-not-gate confidence model recovered ~30× of dropped signal in real session data, but the upper bound is still the regex itself.
- **MCP tool-discovery friction.** Agents must read tool descriptions and act on them. Even with hardened descriptions, behavior is inconsistent across agents and sessions. Adoption tooling helps but doesn't guarantee.
- **Per-developer cache drift.** No multi-machine sync means a developer's memory store is per-laptop. Acceptable for the user persona today; may become a constraint as the user base grows.

## Product Thesis

The original v1 thesis is still load-bearing:

> Agents do not need a full repo scan every session. Agents need a good cached project map plus a small live refresh. ai-cortex exists to provide that map.

The v2 extension:

> Agents also need durable knowledge of past decisions, recurring gotchas, and conventions. Code shows the *what*; ai-cortex memory captures the *why* and the *what we already tried*. Together with rehydration and history, the result is **usable context across time** — not just retrieval.

## Cross-References

- Strategy / competitive positioning: `docs/misc/ai-cortex-strategy-v4.md` (gitignored)
- Current state and next phases: `docs/shared/high_level_plan.md`
- Memory layer technical reference: `MEMORY_LAYER.md`
- User-facing CLI manual: `MANUAL.md`
- v1 brief (historical): `docs/misc/product_brief-v1.md`
