# Cleanup Loop Activation — Briefing Nudge + Lenient Pending Predicate

**Date:** 2026-05-04
**Status:** design — implementation pending

## Goal

Make the candidate → active cleanup loop discoverable and actually invokable in real sessions. Today the MCP tools `list_memories_pending_rewrite` and `rewrite_memory` exist but are effectively unreachable: the eligibility predicate gates fresh candidates behind a value signal that real-world agent behavior never produces, and the briefing surfaces no count or workflow hint. The result is that bootstrapped or extracted candidates accumulate as raw transcript fragments, recall returns those fragments, and the memory layer feels noisy.

## Context

Candidate state on a freshly bootstrapped repo (observed this session, 2026-05-04 on the affected machine):

| Project | Active | Candidate | Pinned | Pending (current predicate) |
|---|---|---|---|---|
| ai-cortex | 0 | 5 | 0 | 0 |
| Favro | 0 | 17 | 0 | 0 |

The "Pending" column is zero because `listMemoriesPendingRewrite` (`src/lib/memory/retrieve.ts:120-134`) requires:

```sql
status = 'candidate'
AND rewritten_at IS NULL
AND re_extract_count >= 1
AND (pinned = 1 OR get_count > 0)
```

Two AND clauses gate fresh candidates:

- `re_extract_count >= 1` — only fires when a later session re-extracts the same prompt. Most candidates are transcript-specific and never get re-extracted.
- `pinned = 1 OR get_count > 0` — assumes agents organically pin candidates or call `get_memory` on them. Real-world agent behavior almost never produces these signals during normal task work.

Combined: a fresh user runs `ai-cortex memory bootstrap`, sees N candidates in the briefing summary line, but `list_memories_pending_rewrite` returns `[]`, so cleanup never runs, and the next `recall_memory` returns raw transcript bodies. The system looks idle; the user concludes the memory layer is not useful.

The existing memory-utility-design (`docs/superpowers/specs/2026-05-01-memory-utility-design.md`) already chose pull-only architecture (no auto-trigger, no background daemon) and subagent-driven cleanup. Both stand. The gap is at the entry point — the agent has no reason to invoke the loop because nothing surfaces.

## Constraints

**Pull-only stays.** No auto-trigger, no per-N-call budgets, no server-side enforcement. The agent decides when cleanup is worthwhile; the briefing makes that decision possible by surfacing the count.

**No extractor coupling.** The predicate must not depend on extractor confidence quality. Extractor improvements are a parallel track; this work should be useful regardless of whether the extractor improves.

**Reversibility.** Both changes are one-line SQL / one-section markdown. No schema changes, no new tables, no new fields, no migrations.

**Token cost is opt-in.** Cleanup runs only when the user (or agent on user's behalf) asks. Briefing surfaces the count, agent can ignore it indefinitely. Candidates age out at 90d on their own per existing lifecycle.

## Architectural decision: lenient predicate

The current predicate's value-signal gating (`pinned OR get_count > 0`) was an optimistic assumption that didn't hold in practice. Drop it. Replace with the simplest predicate that still excludes already-handled and non-applicable rows:

```sql
status = 'candidate' AND rewritten_at IS NULL
```

Three options were considered (see Decision Log below). Lenient is selected because it admits we don't yet have a real value signal and lets the agent (with user budget awareness) decide what's worth rewriting versus deprecating. The other paths (age-gated, confidence-gated) either delay the unlock or couple this work to extractor improvements that aren't on the critical path.

The `since` filter stays for incremental passes. The `ORDER BY confidence DESC, updated_at DESC` stays so highest-signal candidates surface first within a returned page. Default `limit` stays at 25.

## Design

### 1. Predicate change in `src/lib/memory/retrieve.ts`

`listMemoriesPendingRewrite` (`retrieve.ts:103-135`) updates its core query:

```sql
SELECT id, type, title, body_excerpt AS bodyExcerpt, confidence,
       re_extract_count AS reExtractCount, get_count AS getCount, pinned
FROM memories
WHERE status = 'candidate'
  AND rewritten_at IS NULL
  ${sinceClause}
ORDER BY confidence DESC, updated_at DESC
LIMIT ?
```

`sinceClause`, `params`, `limit` default, return shape: unchanged. The function comment block above the implementation is updated to describe the new semantics ("any unrewritten candidate is eligible — `since` filters incremental passes") and to note that the prior value-signal gating was dropped because real-world agents don't produce those signals reliably.

No new exports, no new types. The `PendingRewriteRow` type and `re_extract_count` / `pinned` fields stay in the response — agents may still find that information useful when ordering their own cleanup work.

### 2. Briefing nudge in `src/lib/memory/briefing-digest.ts`

`renderMemoryDigest` (`briefing-digest.ts:14`) computes the pending count via a count-only query (cheaper than calling `listMemoriesPendingRewrite` and discarding rows):

```sql
SELECT COUNT(*) AS n FROM memories
WHERE status = 'candidate' AND rewritten_at IS NULL
```

When `n > 0`, the briefing inserts a "Pending review" section **after the active-type digest sections and immediately before "How to consult"**. Final section order in the rendered briefing:

1. `## Memory available — N active, M candidates, K pinned` (summary line)
2. `### <Type> (top N)` blocks — one per active type (existing)
3. `## Pending review — N candidates eligible for cleanup` (NEW, conditional on `n > 0`)
4. `### How to consult` (existing, with copy updates per §3 below)

Rationale: "How to consult" governs the read path (recall); "Pending review" governs the write path (cleanup). Grouping both action-oriented sections at the end of the briefing keeps content listing (active types) contiguous and makes the action surfaces discoverable in one place.

Section content (normative wording; implementation matches modulo trivial formatting):

```markdown
## Pending review — N candidates eligible for cleanup

Candidates are raw extracted bodies. Rewriting promotes them to `active` and produces clean rule cards that recall can return without further interpretation.

- `list_memories_pending_rewrite({worktreePath})` — fetch the queue (max 25 per call; pass `since` for incremental passes)
- dispatch a subagent with the result as context → have it rewrite each as a rule card (title + rule + when-applies) → call `rewrite_memory` per item to commit
- for items that turn out to not be rules (one-off directives, transcript fragments without a recurring pattern), call `deprecate_memory` instead

Cleanup is opt-in. Candidates age out at 90d if untouched.
```

When `n == 0`, the section is omitted entirely.

### 3. User-facing copy updates (in lockstep with the predicate change)

The current copy in three places explicitly tells agents that `get_memory` (and pin) is the cleanup-eligibility signal. After §1 drops that gating, those statements become false product claims. The implementation MUST update all three in the same change set:

#### 3a. `src/lib/memory/briefing-digest.ts:84` — "How to consult" bullet

Current copy:

> After `recall_memory` returns a relevant hit, call `get_memory(id)` to actually use it — that's the cleanup-eligibility signal.

Replace with copy that retains the "use what you recall" guidance without coupling it to cleanup eligibility:

> After `recall_memory` returns a relevant hit, call `get_memory(id)` to fetch the full record before applying the rule. `get_memory` records that the rule was actually consulted (used for ranking signal), separate from the cleanup queue.

#### 3b. `src/mcp/server.ts:582` — `get_memory` tool description

Current ends with:

> get_memory is the 'I am using this' signal — it counts toward cleanup eligibility, while recall_memory does not.

Replace with:

> get_memory records that the rule was actually consulted (used for downstream ranking and access tracking), separate from the cleanup queue, while recall_memory is browse-only.

#### 3c. `src/mcp/server.ts:1286` — `list_memories_pending_rewrite` tool description

Current opening:

> List candidate memories eligible for cleanup. A candidate is eligible when it has been re-extracted at least once AND is either pinned OR has been accessed via get_memory.

Replace with:

> List candidate memories eligible for cleanup. A candidate is eligible when it is `status=candidate` and has not yet been rewritten (`rewritten_at IS NULL`). Highest-confidence candidates are returned first.

The remainder of that description (the `since` parameter doc and the subagent-dispatch workflow guidance) stays unchanged.

These edits are NOT optional — without them, the product contract documented in agent-facing surfaces directly contradicts runtime behavior.

### 4. Tests

#### Predicate (extend `tests/unit/lib/memory/retrieve.test.ts`)

The existing `listMemoriesPendingRewrite` describe block should be extended with cases that prove the new predicate:

- A fresh candidate (no re-extract, no pin, zero get_count) is now returned. This case fails under the current predicate; it must pass after the change.
- A candidate with `rewritten_at` set is excluded.
- A non-candidate (`active`, `deprecated`, `trashed`, `merged_into`, `purged_redacted`) is excluded.
- The `since` filter still filters by `updated_at >= since OR last_accessed_at >= since`.
- The `limit` clause still caps the page size.
- `ORDER BY confidence DESC` still applies — within a returned page, higher confidence first.

#### Briefing (extend or add `tests/unit/lib/memory/briefing-digest.test.ts`)

- `n == 0` case: the "Pending review" heading does not appear in the rendered briefing, but the rest of the digest renders normally (active counts, type sections, How to consult).
- `n == 5` case: a "Pending review" heading appears with the count, and the section includes the workflow lines (the three bullet points and the "Cleanup is opt-in" closer).
- `n > 0` AND `active > 0` case: both the active type sections and the pending section render. Order: Memory available header → active type sections → Pending review section → How to consult.

Both test files use the existing fixture pattern (vitest, `mkRepoKey` from `tests/helpers/memory-fixtures.ts`).

#### Copy regression guard (extend `tests/unit/mcp/memory-tools.test.ts` or equivalent)

A small string-presence test asserting the stale phrasing is gone — catches a future revert that re-introduces the contradiction:

- `get_memory` description does NOT contain `"counts toward cleanup eligibility"`.
- `list_memories_pending_rewrite` description does NOT contain `"re-extracted at least once"` and does NOT contain `"accessed via get_memory"`.
- The rendered briefing's "How to consult" block does NOT contain `"that's the cleanup-eligibility signal"`.

These are negative-presence checks against the literal stale phrases; they don't lock in the new wording word-for-word, just prevent the old contract from creeping back.

### 5. Out of scope

- **Auto-trigger.** Pull-only stays. The server does not push cleanup signals into tool responses or the rehydrate briefing beyond the count + workflow hint.
- **NEW tool-description nudges.** Adding "consider cleanup" lines to tool descriptions that don't currently mention cleanup eligibility (e.g. `recall_memory`, `record_memory`) would compete with the briefing. The briefing-once pattern is the established discovery channel. Note: the §3 edits to existing descriptions that already make eligibility claims are corrections, not new nudges, and are in scope.
- **Extractor confidence improvements.** Separate track. The predicate is intentionally orthogonal.
- **Token budget enforcement.** Agent-side concern. The server reports counts; agents budget.
- **Cleanup metrics / telemetry.** Out of scope; can be layered later if useful.
- **Multi-pass orchestration.** The `since` parameter already supports incremental passes; agents implement the loop client-side.

### 6. Reversibility

- Predicate change: one SQL string in one function. Single-commit revert.
- Briefing addition: one section inserted before "How to consult" in one function. Single-commit revert.
- Copy edits in three locations: text-only changes; revert is mechanical.
- No schema changes, no migrations, no new persisted fields.

## Decision log

- **Lenient over age-gated (P2 in brainstorm).** Considered: gate the predicate by an age threshold (e.g. `updated_at <= now() - 24h`) so fresh candidates "settle" before cleanup. Rejected: the soak rationale (re-extract merging new evidence) rarely happens in practice with the current extractor, so an age threshold would just make fresh-bootstrap users wait without producing benefit.

- **Lenient over confidence-gated (P3 in brainstorm).** Considered: only surface candidates with `confidence >= 0.5`. Rejected: the predicate would couple this work to extractor confidence being meaningful — which today it often isn't (correction-prefix is the main boost source). Decoupling the cleanup unlock from extractor improvements lets both ship independently and lets the agent rather than the server decide what's worth rewriting.

- **Briefing-only nudge over multi-channel (tool descriptions, response injection).** The existing memory-utility-design explicitly chose push-once at session start; competing nudges across tool descriptions would dilute that channel. Briefing is the canonical surface for "what's available" — the count belongs there.

- **Count-only query over reusing `listMemoriesPendingRewrite`.** The briefing computes a count separately to avoid materializing 25 rows when only the integer is needed. Cheap; clearer intent. The list function is unchanged.

- **No tool-description change to `rewrite_memory`.** The current tool description already says it auto-promotes candidate → active. No new behavior to document there. The new pull point is the briefing.

- **`limit` default stays at 25.** Per-call cap is a budget heuristic for agents — too small forces multi-call, too large risks one-shot subagent overload. 25 is the existing default; no evidence it needs adjusting.
