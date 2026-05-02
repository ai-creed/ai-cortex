# ai-cortex — High-Level Plan

> **v2** (2026-05-02). Supersedes v1 (now at `docs/misc/high_level_plan-v1.md`),
> which framed the project as a 3–4 week MVP push. The product has shipped
> well past that scope and warrants a current-state plan.

## Planning Intent

This document is a current-state map of the project — what's been delivered, where things stand today, and what's proposed next. It is not a task-by-task implementation checklist (those live in `docs/superpowers/plans/`, gitignored).

The plan continues to assume:

- local-first execution
- no writes into target repositories
- agent-agnostic via MCP (no hooks beyond opt-in capture)
- no LLM client in the substrate; intelligence delegated to the user's agent
- markdown is the source of truth for memories; derived indexes are rebuildable

These are durable principles, not phase goals.

## Delivery Cadence

The project ships in **phases** with explicit gates. Each phase produces working product on its own; subsequent phases compose on top without reshuffling earlier work.

We've stopped using day-count timelines (they were misleading even in v1). Phases ship when their gate is met.

## Status of Past Phases

### Phase 0 — Plausibility Spike

**Status:** complete (2026-04-10)

Cached rehydration beat cold-orient on the N=20 median benchmark on `ai-14all`. Cleared the gate to productize.

### Phase 1 — Core Indexing Spine

**Status:** complete

Repo-scoped local cache, indexing pipeline (file tree, package metadata, imports, docs), tree-sitter adapters for TypeScript and JavaScript, stable internal representation, CLI `index`. The indexing backbone is in place; subsequent features compose against it without reshuffling.

### Phase 2 — Rehydration Flow

**Status:** complete

`rehydrate` command (CLI + library + MCP), markdown briefing format, structured JSON output, stale detection, targeted refresh. New agent sessions can start from `rehydrate` output instead of a broad repo scan. Briefing now also carries pinned memories and the memory digest (added in later phases).

### Phase 3 — Suggest Flow

**Status:** complete and expanded

Initial scope was a single `suggest` mode. Shipped in three modes: fast (path + symbol + import graph), deep (adds trigram + content scan), semantic (sentence embeddings via `Xenova/all-MiniLM-L6-v2`). Each mode escalates from the last when relevance is unclear. Plus `blast_radius` impact analysis using the call graph, added during this phase.

### Phase 4 — Hardening

**Status:** complete

Performance work for larger repos, refresh cost control, cache invalidation via repo-fingerprint + worktree-key, atomic write protocols. The product is dependable enough that the user prefers `ai-cortex rehydrate` over manual repo scanning for new sessions.

### Phase 5 — Multi-Language Adapters

**Status:** complete

Tree-sitter adapters for Python, C, and C++ shipped beyond the original TS/JS scope. Go and Rust will index but yield no call graph; documented as a known limitation rather than a phase commitment.

### Phase 6 — History Capture

**Status:** complete

Session capture for Claude Code and Codex via hooks (`ai-cortex history install-hooks`). Compaction → `EvidenceLayer` → `search_history` MCP tool. Recovers context lost to harness compaction.

### Phase 7 — Memory Layer (Phase 1: foundation)

**Status:** complete

Markdown-of-record + SQLite (WAL + FTS5) + vector sidecar. Full lifecycle (10 states), 18 lifecycle functions, 24 MCP tools at the time of shipping. Reconcile-on-first-call recovery for orphan files and phantom rows. Type registry with extensible JSON config.

### Phase 8 — Memory Layer (Phase 2a: auto-extractor + bootstrap)

**Status:** complete

Heuristic extractor with four candidate types (decision, gotcha, pattern, how-to). Cross-session dedup (cosine ≥ 0.85 + same type + tag overlap). Re-extraction stability bumps confidence by 0.10 per match. Manifest persistence for incremental runs. CLI `bootstrap` for one-shot extraction over existing transcripts. `history capture` auto-triggers extraction.

Post-implementation correction shipped: changed correction-prefix from a hard gate to a +0.10 confidence boost. Recovered ~30× of previously-dropped signal in real session data.

### Phase 9 — Memory Layer (Phase 2b: aging + global tier)

**Status:** complete

Aging sweeps (candidate→trashed at 90d, deprecated→trashed at 180d, etc.). Two-tier storage: project-scoped + cross-project global. `promote_to_global` lifecycle function. Cross-tier recall with `+0.10` source boost for project results. CLI `sweep` and `promote`.

### Phase 10 — Memory Layer (Phase 3: utility)

**Status:** complete (current release)

The release that turns the memory layer from "stored data" into "a consultation point the agent learns to trust":

- Hardened MCP tool descriptions teaching the cardinal pattern (`recall_memory` browse-only vs. `get_memory` use signal)
- Briefing-phase memory digest (counts + top-5 per type + tool guidance)
- Access counters: `get_count`, `last_accessed_at`, `re_extract_count`, `rewritten_at`
- Subagent-driven cleanup MCP tools: `list_memories_pending_rewrite`, `rewrite_memory`
- `install-prompt-guide` CLI for nudging agents (Claude / Codex / both, project / global) into the recall→get pattern
- Architectural decisions captured: pull-only injection, no LLM in substrate, agent-agnostic via MCP

Plus ancillary CLI improvements: `--version` / `--help`, `--global-scope` on `memory record` (CLI parity with MCP), update-available notice with cached daily background check.

## Current Phase — v0.5 release prep

**Status:** in flight

What this phase is doing:

- Documentation refresh: README aligned with current product shape (npm-published, three-layer architecture, memory section rewritten, install flow expanded). New `MEMORY_LAYER.md` user-facing reference doc. Strategy doc v4 (gitignored).
- Repository housekeeping: docs/shared reorganized — only durable project knowledge stays; historical docs archived to `docs/misc/`.
- npm package homepage updated to `ai-creed.dev/projects/ai-cortex/`.

Exit gate: ready to cut a `0.5.0` release with a coherent README, complete user docs for the memory layer, and accurate npm metadata.

## Proposed Next Phases

These are intentions. Order will shift with real-use signal.

### Phase 11 — Adoption telemetry

The `logged()` middleware already captures every MCP tool call. Aggregate those traces into a per-session histogram so call rate is observable: which tools the agent actually invokes, the recall→get conversion rate, the extract→cleanup rate. Without this we're guessing whether the cardinal pattern works in practice. ~1 day of work.

**Gate:** the user (and eventually anyone running ai-cortex) can answer "did the agent use memory this session?" with a number, not a feeling.

### Phase 12 — Closed feedback loop

Counters are in place. The reconciliation logic isn't. Implement: recall events compared against subsequent session evidence; rule-violation detection from corrections; auto-decay confidence on negative signal, bump on positive. Counters as input → confidence drift as output. ~1 week.

**Gate:** memory confidence reflects observed utility, not just text patterns. A memory recalled and ignored decays; a memory recalled and applied climbs.

### Phase 13 — `ai-14all` integration

ai-cortex provides the substrate; `ai-14all` is the workspace layer that consumes it. First-class hooks (briefing injection at task start, memory write on user-stated rules, history search on context loss). Currently integration is via MCP; tighter coupling may be warranted.

**Gate:** working in `ai-14all` produces and consumes ai-cortex memories naturally without explicit CLI invocation.

### Phase 14 — Wow-loop UX wrapper

Strategy v4 §11 describes a future user experience:

```
ai ask "how does auth work?"
ai ask "what did we decide about auth?"
ai do "modify auth middleware"
```

The primitives exist. A thin wrapper command (`ai-cortex ask`, `ai-cortex do`) can land this without changing the substrate. Deferred until adoption telemetry validates the demand. ~3–5 days when triggered.

**Gate:** a new user can install ai-cortex and reach the wow loop in three commands.

### Phase 15 — Memory extraction quality

The regex-based extractor has a clear ceiling. An LLM-based extractor (running in the user's subagent, no LLM in substrate) would catch much more signal. Architectural decision is in place; implementation is deferred until adoption telemetry validates the demand. ~1–2 weeks when triggered.

**Gate:** memory candidate quality is determined by the agent's intelligence, not by the substrate's regex.

### Phase 16 — Larger embedding model (opt-in)

`bge-small-en-v1.5` or `multilingual-e5-small` as a config-selectable alternative to `Xenova/all-MiniLM-L6-v2`. Handles short / abbreviation-heavy queries better. Tradeoff: 60–100 MB download + slower first-call. Worth shipping when users actually report the recall ceiling. ~2 days.

**Gate:** users with abbreviation-heavy domain vocabulary (`cxx`, `py`, `ts`) get usable semantic recall.

## Permanent Non-Goals

These have been deliberate from v1 and remain so:

- Real-time watching or daemonized indexing (refresh-on-demand is sufficient)
- Cloud sync (per-developer local cache is the model)
- Team-shared caches (knowledge sharing is a different product)
- Manual annotation surfaces (memory layer captures rules; we don't build a notes UI)
- IDE / editor extensions (CLI + MCP is the interface)
- Generic code search (tree-sitter parsing is good enough for navigation; we don't compete with ripgrep)

## Cross-References

- Product brief: `docs/shared/product_brief.md`
- Strategy / competitive positioning: `docs/misc/ai-cortex-strategy-v4.md` (gitignored)
- v1 plan (historical): `docs/misc/high_level_plan-v1.md`
- Memory layer technical reference: `MEMORY_LAYER.md`
- Design specs: `docs/superpowers/specs/`
