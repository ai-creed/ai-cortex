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

**Tradeoff accepted.** Memories are not crisp at the moment of creation. Raw candidates sit in the store until a cleanup pass converts them. This is fine: most candidates are noise that ages out at 90d; paying to rewrite ephemera wastes tokens. Cleanup runs on signals of value (re-extraction stability, pin, first recall) — not on every candidate.

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

- `list_pending_rewrites(repoKey, limit?, since?)` — returns candidates that match `source: "extracted"` AND have no `rewrittenAt` timestamp. Filtered to high-signal candidates only (re-extraction stability ≥1, or pinned, or recently recalled — see "Cleanup triggers" below).
- `apply_rewrite(repoKey, id, { title, body, scopeFiles, scopeTags, type? })` — replaces the candidate fields with the cleaned version, sets `rewrittenAt`, audit-logs as `update` with reason `rewrite`. Body must be a structured rule card (rule + rationale + when-applies).

The agent's flow:

1. Sees `N pending rewrites` line in briefing or notices via tool description nudge.
2. Calls `list_pending_rewrites` to fetch the queue.
3. Spawns a subagent with the candidates as context: "Rewrite each into a rule card."
4. Subagent returns cleaned versions; main agent calls `apply_rewrite` for each.

ai-cortex sees only the MCP calls. It has no opinion on which agent invoked them or how the rewrite was generated. **No CLI commands** ship for `list_pending_rewrites` / `apply_rewrite` in this round — manual cleanup would require the user to bring their own LLM/API key, which contradicts the "no LLM dependency" stance. Users with subagent-capable agents drive cleanup via MCP; users without simply leave candidates raw and accept the lower memory quality.

**Cleanup triggers (what makes a candidate "pending"):**

A candidate is *pending* (eligible for surfacing in `list_pending_rewrites`) if any of:

- It has been re-extracted at least once (the dedup loop bumped its confidence — proves it's recurring).
- It is pinned.
- It has been recalled at least once (some session needed it; worth investing).

Otherwise candidates stay raw and age out at 90d as designed. This is the economic gate — only valuable candidates earn cleanup tokens.

**Schema additions:**

- `rewrittenAt: string | null` in `MemoryFrontmatter` — ISO timestamp of last rewrite, or null.
- `recallCount: integer` in the SQL index — incremented when the memory appears in `recall_memory` results. Used by both cleanup eligibility and (later) the feedback loop.

### 3. MCP tool description hardening

Tool descriptions are the only universal lever for influencing agent behavior. Today's descriptions are generic ("recall memory by query"). Replace with explicit, opinionated guidance:

- `recall_memory`: when to call (before non-trivial edits to unfamiliar files, when debugging recurring symptoms, when the user references past decisions), how to call (pass `scope.files`, use `source: 'all'` for cross-project), what's available (decisions / gotchas / how-tos / patterns).
- `record_memory`: when to record (user states a rule, expresses a preference, or describes a constraint), what makes a good memory (specific, actionable, scoped).
- `deprecate_memory`: when to deprecate (a recalled memory contradicts current code or current user direction).
- `confirm_memory`: when to confirm (user explicitly endorses a candidate; agent has used it successfully and validated).
- `list_pending_rewrites` / `apply_rewrite`: when to clean up, how to structure rule cards.

Strong descriptions teach the loop. Weak descriptions get ignored. This is cheap to do and ships immediately.

### 4. Closed feedback loop foundation (data shape now, behavior later)

The eventual goal: confidence reflects actual utility, not just text patterns. The signal would be "this memory was recalled in session S, and S's evidence shows the rule was not violated → bump." Or conversely, "memory recalled but evidence shows violation → decay or flag."

Implementing the full loop is out of scope for this round. But the data shape must be in place so we can add the behavior without schema migration:

- `recallCount` on the index (already required for cleanup triggers above).
- A new audit `changeType: "recall"` row appended each time a memory is returned from `recall_memory`. The audit row carries `sessionId` (if known) and timestamp.
- An optional `lastRecalledAt` field on the index row.

These additions are cheap and unlock future work where the agent (or a server-side analyzer) reconciles recalls against subsequent session evidence to compute utility scores.

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

- Closed-loop confidence updates from session evidence — data shape only.
- Larger embedding model swap (`bge-small`, `e5-small`) — orthogonal optimization.
- Domain alias / synonym expansion at query time — orthogonal optimization.
- Symbol-level scope (function, class) — extends file/module scope, future work.
- Cross-tier promotion automation — promotion stays manual via `promote_to_global`.
- Auto-extract during compaction — extraction still runs at capture time.

## Test plan sketch

- Unit: tool description content (tests assert key phrases present); pending-rewrite filter logic (eligibility predicate); audit row creation on recall.
- Integration: rehydration briefing contains memory digest with expected sections; `list_pending_rewrites` → `apply_rewrite` round-trip preserves audit history.
- Smoke: re-extract Favro and ai-cortex sessions, run briefing, verify digest reflects current store. Manually drive a cleanup loop with a real subagent on 5 candidates, validate the rewritten cards meet the rule-card shape (title is a rule, body is structured).

## Implementation phases

| Phase | Work | Effort |
|---|---|---|
| 1 | C: Tool description hardening | 30 min |
| 2 | A: Briefing memory digest section | 1–2 h |
| 3 | D: Audit `recall` changeType + `recallCount` field (data shape) | 30 min |
| 4 | B': MCP `list_pending_rewrites` + `apply_rewrite`, schema additions, eligibility logic, descriptions (MCP-only — no CLI parity) | 4–8 h |

Each phase ships a working improvement. Phase 1 lifts call rate even with no other changes. Phase 2 lifts agent awareness. Phase 3 locks future-loop schema. Phase 4 enables cleanup.

Total: ~7–11 hours of focused work plus tests. No big-bang.

## Cross-references

- Builds on: `2026-04-30-memory-schema-design.md` — the schema, lifecycle, and extractor pipeline this spec extends.
- Post-impl finding 2026-05-01 (correction-prefix as boost): commit `48b8f63`. Validates that extraction recall is now adequate; this spec addresses the next bottleneck (precision and utility).
- Phase 2b — `2026-05-01-memory-schema-phase-2b-aging-global.md`: aging sweep + global tier; both still required and unaffected by this spec.
