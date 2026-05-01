# Memory Utility — Awareness, Cleanup, and the Pull-Only Architecture

**Date:** 2026-05-01
**Status:** design — implementation phased; see end of document

## Goal

Make the memory layer genuinely useful as a product, not just demonstrably correct in a smoke test. Useful means: when the agent consults memory, the answer is sharp and actionable; the agent reliably knows when to consult; and the layer remains agent-agnostic and deterministic.

## Context

The Phase 2 memory layer (auto-extractor + lifecycle + two-tier storage) ships content into the store but smoke testing on real session data revealed three structural problems:

1. **Conversation-snippet candidates are noisy.** Extracted titles like `Don't we have this "use when you don't know exact function names" in the tool description already?` are transcript fragments, not rule cards. Bodies contain `**Symptom:**` / `_Acknowledged:_` markers and conversational meta-talk. The signal-to-noise in the index is poor; ranking on it is unreliable.

2. **Retrieval ranks in a tight 0.55–0.65 score band.** Hits and misses cluster within 0.10 of each other. The ranker doesn't have enough signal headroom to make confident top-K selections on short or domain-abbreviated queries (`cxx` vs `c++`, `tree-sitter` → `language adapter` chains).

3. **The agent doesn't know what's available, so it doesn't know to ask.** The MCP `recall_memory` tool exists but call rate in real sessions is low. The agent never sees a "table of contents" of what the store contains.

These are not retrieval-tuning problems. They are product-architecture problems. Improving alias maps, embedding model size, or title boosts moves the smoke-test ceiling but not the product utility.

## Constraints

Two hard constraints frame every option:

**Agent-agnostic.** The system must work with Claude Code, Codex, Gemini CLI, Cline, and any future MCP-compliant agent. This rules out hooks, CLI-specific config, dynamic CLAUDE.md, or any per-agent integration.

**Precision-first.** Surfacing irrelevant memories is worse than surfacing none. Volume is not a feature. Push-based injection ("here are 10 memories before every edit") is rejected — the system cannot know what is relevant; only the agent, with its current task and intent, can.

Together these constraints collapse the design space: the agent pulls when it judges memory might apply, the server returns only what fits, no background mechanism, no automatic triggers. Pull-only.

## Architectural decision: ai-cortex stays a deterministic data plane

**The core decision captured by this spec.** ai-cortex contains no LLM client, no API keys, no external network calls of its own. All "intelligence" — rewriting raw candidates into rule cards, deciding when to clean up, judging utility — is delegated to the user's agent and any subagents the agent spawns.

This is a deliberate inversion of the typical pattern (service-with-LLM-inside). The reasoning:

- **Cost transparency.** Token usage shows up in the user's agent billing, not hidden behind a service. No surprise charges. Users see what they pay for.
- **Deployment simplicity.** No API key configuration, no provider lock-in, no fallback logic for missing credentials.
- **Agent-agnostic at the contract level.** The MCP surface is the only integration point. Any agent that can iterate over a list of pending items and write results back can drive cleanup. The "spawn subagent" mechanism is agent-specific (Task tool, spawn, etc.) but ai-cortex doesn't care which.
- **Aligned with the pull model.** The agent decides when cleanup is worth it, just as it decides when to recall. Consistent semantics throughout.
- **Graceful degradation.** Without subagent cleanup, raw candidates still work via FTS; the system stays functional. Cleanup is opt-in.

**Tradeoff accepted.** Memories are not crisp at the moment of creation. Raw candidates sit in the store until a cleanup pass converts them. This is fine: most candidates are noise that ages out at 90d; paying to rewrite ephemera wastes tokens. Cleanup runs on signals of value (re-extraction stability, pin, explicit `get_memory` access) — not on every candidate.

## Architecture

Four reinforcing pieces. Each ships independently; together they convert the layer from "stored data the agent might query" into "a reliable consultation point the agent learns to trust."

### 1. Briefing-phase memory awareness (push-once at session start)

The rehydration briefing gains a memory section that answers two questions for the agent:

- **What's available?** A digest with counts (active / candidate / pinned), then top-N highest-confidence active memories grouped by type with title, scope, and confidence. The agent reads this once at session start and develops awareness of the store's contents — like a table of contents.
- **How and when to consult?** Project-specific tool guidance: "for work in `src/api/*`, recall with `scope.files`; for cross-project patterns, pass `source: 'all'`; deprecate memories that no longer apply." Reinforces the MCP tool description without duplicating it.

This is push-once, not push-continuous. It primes pull-based behavior. The agent, having seen the digest, decides when a particular task warrants a recall — applying its own judgment about relevance using the only context capable of judging it (the current task).

### 2. Subagent-driven cleanup (the architectural inversion)

ai-cortex publishes raw candidates and accepts polished updates. The agent drives cleanup using whatever subagent mechanism it has.

**MCP surface (new tools):**

- `list_memories_pending_rewrite(repoKey, limit?, since?)` — returns candidates that pass the cleanup eligibility predicate (see below) AND have no `rewrittenAt` timestamp.
- `rewrite_memory(repoKey, id, { title, body, scopeFiles, scopeTags, type? })` — replaces the candidate's content fields with the cleaned version, sets `rewrittenAt`, **promotes status `candidate → active`**, audit-logs as `update` with reason `rewrite`. Body should follow a soft rule-card structure (rule + rationale + when-applies); the tool description recommends sections but the server does not validate.

**Rewrite implies promotion.** A rewrite represents a deliberate decision by the agent (and its subagent) to read the candidate, judge it worth keeping, and rewrite it as a rule card. That investment is a stronger confirmation signal than `confirm_memory`'s one-touch endorsement. So `rewrite_memory` auto-promotes `candidate → active` as part of the same operation. Rewriting an already-active memory leaves status as `active`. Rewriting a `merged_into` / `trashed` / `purged_redacted` memory errors — there is no candidate lifecycle to resolve.

This means `confirm_memory` and `rewrite_memory` are two distinct paths from candidate to active, with different costs and signals: `confirm_memory` is a cheap explicit endorsement; `rewrite_memory` is an investment that produces a cleaner artifact. Both are valid; the agent picks based on what it has at hand.

The agent's flow:

1. Sees `N pending rewrites` line in briefing or notices via tool description nudge.
2. Calls `list_memories_pending_rewrite` to fetch the queue.
3. Spawns a subagent with the candidates as context: "Rewrite each into a rule card."
4. Subagent returns cleaned versions; main agent calls `rewrite_memory` for each.

ai-cortex sees only the MCP calls. It has no opinion on which agent invoked them or how the rewrite was generated. **No CLI commands** ship for `list_memories_pending_rewrite` / `rewrite_memory` in this round — manual cleanup would require the user to bring their own LLM/API key, which contradicts the "no LLM dependency" stance. Users with subagent-capable agents drive cleanup via MCP; users without simply leave candidates raw and accept the lower memory quality.

**Cleanup eligibility:**

A candidate is *pending* (eligible for surfacing in `list_memories_pending_rewrite`) when:

```
status = 'candidate'
  AND rewrittenAt IS NULL
  AND reExtractCount >= 1
  AND (pinned = 1 OR getCount > 0)
```

In words: the candidate has shown re-extraction stability (it recurs), AND it is either pinned (manually marked valuable) or has been explicitly accessed via `get_memory` (an agent picked it out of recall results and used it). Conservative on purpose — only valuable candidates earn cleanup tokens.

**Why `get_memory` and not `recall_memory` as the access signal.** `recall_memory` returns top-K results, most of which the agent doesn't actually use. Counting them all as "valuable" would enqueue false-positive rewrites. `get_memory(id)` is a deliberate act: the agent picked one specific memory and asked for the full record. That is the real "agent used this" signal, and it's what `getCount` tracks.

**Schema additions:**

In `MemoryFrontmatter` (durable, in markdown):

- `rewrittenAt: string | null` — ISO timestamp of last rewrite, or null.

In the SQL index only (counters that change too frequently for markdown rewrites):

- `reExtractCount INTEGER NOT NULL DEFAULT 0` — incremented in `extract.ts` whenever `findDedupTarget` collapses a new candidate into this memory (the same call site that runs `bumpConfidence`).
- `getCount INTEGER NOT NULL DEFAULT 0` — incremented on each `get_memory(id)` call.
- `lastAccessedAt TEXT NULL` — ISO timestamp of last `get_memory(id)` call.
- `rewrittenAt TEXT NULL` — mirrors the frontmatter field for fast SQL filtering.

`recall_memory` does not increment any counter — it is a pure read.

### 3. MCP tool description hardening

Tool descriptions are the only universal lever for influencing agent behavior. Today's descriptions are generic ("recall memory by query"). Replace with explicit, opinionated guidance:

- `recall_memory`: when to call (before non-trivial edits to unfamiliar files, when debugging recurring symptoms, when the user references past decisions), how to call (pass `scope.files`, use `source: 'all'` for cross-project), what's available (decisions / gotchas / how-tos / patterns), **and that recall is browse-only** — to actually use a result, follow up with `get_memory(id)`.
- `get_memory`: when to call (after `recall_memory` returns a relevant hit and you intend to apply it; when the user references a memory by ID; when verifying a rule before relying on it). Note that `get_memory` is the "I'm using this" signal — it counts toward cleanup eligibility, while `recall_memory` does not.
- `record_memory`: when to record (user states a rule, expresses a preference, or describes a constraint), what makes a good memory (specific, actionable, scoped).
- `deprecate_memory`: when to deprecate (a recalled memory contradicts current code or current user direction).
- `confirm_memory`: when to confirm (user explicitly endorses a candidate; agent has used it successfully and validated).
- `list_memories_pending_rewrite` / `rewrite_memory`: when to clean up, how to structure rule cards (soft template: rule + rationale + when-applies), and that `rewrite_memory` auto-promotes `candidate → active`.

Strong descriptions teach the loop. Weak descriptions get ignored. This is cheap to do and ships immediately.

### 4. Closed feedback loop foundation (counters now, event log later)

The eventual goal: confidence reflects actual utility, not just text patterns. The signal would be "this memory was accessed in session S, and S's evidence shows the rule was not violated → bump." Or conversely, "memory accessed but evidence shows violation → decay or flag."

Implementing the full loop is out of scope for this round. The minimum viable data shape is the access counters added in piece 2:

- `getCount` and `lastAccessedAt` on the SQL index (required for cleanup eligibility above) — these double as the foundation for utility scoring later.
- `reExtractCount` on the SQL index (also required for cleanup eligibility) — gives the stability dimension.

**What is explicitly deferred:** a per-event memory access log (a separate `memory_events` table or similar). The current audit log is keyed on `(memory_id, version)` for write events and cannot accommodate read events without redesign or version-bump invention. Rather than shoehorn read events into the audit schema, we leave per-event logging for whenever the closed feedback loop actually ships — at which point the right schema can be designed against the real requirements (utility-vs-violation reconciliation, time-windowed analysis, session-grouped queries).

The counters above are sufficient for cleanup eligibility today and serviceable as a coarse signal for the loop tomorrow. If we need fine-grained event timeseries later, that's a future spec.

## Tradeoffs

### Accepted

- **Async crispness.** Raw candidates exist in the store until subagent cleanup runs. Briefing digest may show conversational titles. Acceptable because (a) most candidates age out without ever being used, (b) cleanup runs on value signals, (c) recall ranking on raw candidates is fine for keyword-anchored queries — the agent's natural vocabulary overlaps with extracted text.

- **Cleanup quality is agent-dependent.** Different agents will produce different rule-card quality. Acceptable because the alternative (server-side LLM rewrite) ties ai-cortex to a provider and budget.

- **Pull failure modes.** If the agent doesn't call `recall_memory`, nothing happens. We mitigate via briefing awareness and tool descriptions; we accept that some agents in some sessions will under-consult. This is preferable to the precision damage push-injection causes.

### Rejected

- **Push-via-hooks.** Rejected: agent-specific, ties us to Claude Code's hook system.
- **Dynamic CLAUDE.md.** Rejected: agent-specific, file-watcher complexity, doesn't generalize.
- **Server-side LLM rewrite.** Rejected: API key dependency, cost opacity, deployment complexity.
- **Blanket pre-edit injection.** Rejected: precision destruction; surfacing 10 memories before every edit poisons agent context.

## Out of scope (this round)

- Closed-loop confidence updates from session evidence — counters only; reconciliation logic deferred.
- Per-event memory access log (separate events table) — counters cover cleanup eligibility; event-grain logging deferred until the feedback loop spec ships.
- Larger embedding model swap (`bge-small`, `e5-small`) — orthogonal optimization.
- Domain alias / synonym expansion at query time — orthogonal optimization.
- Symbol-level scope (function, class) — extends file/module scope, future work.
- Cross-tier promotion automation — promotion stays manual via `promote_to_global`.
- Auto-extract during compaction — extraction still runs at capture time.

## Test plan sketch

- Unit: tool description content (tests assert key phrases present); pending-rewrite filter logic (eligibility predicate `reExtractCount >= 1 AND (pinned OR getCount > 0)` with status/rewrittenAt gates); `get_memory` increments `getCount` and `lastAccessedAt`; `recall_memory` does not; `findDedupTarget` increments `reExtractCount` on collapse; `rewrite_memory` auto-promotes `candidate → active`, errors on `merged_into` / `trashed` / `purged_redacted`.
- Integration: rehydration briefing contains memory digest with expected sections; `list_memories_pending_rewrite` → `rewrite_memory` round-trip preserves audit history and produces an `active` memory with `rewrittenAt` set.
- Smoke: re-extract Favro and ai-cortex sessions, run briefing, verify digest reflects current store. Manually drive a cleanup loop with a real subagent on 5 candidates, validate the rewritten cards meet the soft rule-card shape (title is a rule, body has rule + rationale + when-applies sections) and have promoted to `active`.

## Implementation phases

| Phase | Work | Effort |
|---|---|---|
| 1 | C: Tool description hardening — incl. `recall` (browse) vs `get_memory` (use) distinction | 30 min |
| 2 | A: Briefing memory digest section (counts + top-5 per type with title/scope/confidence) | 1–2 h |
| 3 | D: SQL index counter columns (`getCount`, `lastAccessedAt`); `get_memory` increments them; `recall_memory` does not. Per-event logging deferred. | 30 min |
| 4 | B': MCP `list_memories_pending_rewrite` + `rewrite_memory` (auto-promote), `reExtractCount` column + increment in extractor dedup, `rewrittenAt` in frontmatter and SQL, conservative eligibility predicate, descriptions (MCP-only — no CLI parity) | 4–8 h |

Each phase ships a working improvement. Phase 1 lifts call rate even with no other changes. Phase 2 lifts agent awareness. Phase 3 introduces the access-counter primitives. Phase 4 enables cleanup and depends on Phase 3's counters.

Total: ~7–11 hours of focused work plus tests. No big-bang.

## Cross-references

- Builds on: `docs/superpowers/specs/2026-04-30-memory-schema-design.md` — the schema, lifecycle, and extractor pipeline this spec extends.
- Post-impl finding 2026-05-01 (correction-prefix as boost): commit `48b8f63`. Documented in the parent spec above. Validates that extraction recall is now adequate; this spec addresses the next bottleneck (precision and utility).
- Phase 2 implementation plans (already shipped): `docs/superpowers/plans/2026-04-30-memory-schema-phase-2a-extractor-bootstrap.md` and `docs/superpowers/plans/2026-05-01-memory-schema-phase-2b-aging-global.md`. Their lifecycle, aging sweep, and two-tier storage are unaffected by this spec.
