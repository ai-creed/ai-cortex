# Design: Dismissal-aware surfacing — stop re-surfacing memories the agent already ignored

- **Date:** 2026-06-27
- **Repo:** ai-cortex (branch `surface-memories-impr`)
- **Status:** Design approved; pending spec review → implementation plan
- **Author:** Vu Phan (with Claude)

---

## 1. Context & problem

The ai-cortex edit-time surfacing hook proactively hands the coding agent a list
of memories scoped to the file it is about to edit. In practice the agent often
emits lines like:

```
(Voice-hosting memory — not relevant, skipping.)
```

i.e. the **same** memory is surfaced repeatedly, the agent re-judges it
irrelevant every time, and that verdict is thrown away. This wastes context,
adds visible noise, and erodes trust in the surfacing signal.

Root cause is three independent defects stacked on top of each other:

- **L1 — no negative-feedback signal.** The data model tracks positive usage
  (`get_count`, `last_accessed_at` via `get_memory`) but has no notion of
  "agent saw this and judged it irrelevant for this scope." The verdict is
  never learned — not within a session, not across sessions.
- **L2 — dedup keys on the whole-set hash, not per-memory.** The per-session
  ledger stores one SHA per file = hash of the *sorted matched-ID set*. If one
  new/relevant memory enters or leaves that file's set between edits, the hash
  changes and the **entire** set re-emits, dragging already-dismissed memories
  back into the narration.
- **L3 — Tier-2 tag-overlap is precision-poor.** A `voice-hosting` memory that
  surfaces while editing unrelated files is almost certainly arriving via the
  Tier-2 fallback, matched by incidental path-/tag-token overlap rather than
  real file scope.

## 2. Goals / non-goals

**Goals**

- Stop re-surfacing a memory for a file once the agent has demonstrably ignored
  it there, without the agent having to do anything new.
- Reduce irrelevant Tier-2 matches at the source.
- Keep the hot path (PreToolUse hook, 250 ms budget, no model load) fast and
  never block an edit.

**Non-goals**

- Do **not** touch `recall_memory` ranking. Suppression affects **edit-time
  surfacing only** — deliberate recall always returns the memory. This is the
  primary guardrail against over-suppression.
- No new agent-facing tool or required agent behavior (capture is implicit).
- No change to the memory markdown store / lifecycle (active/candidate/etc.).

## 3. Current architecture (traced)

| Stage | File | Notes |
|---|---|---|
| PreToolUse hook entry | `src/lib/memory/cli/surface-hook.ts` | Separate CLI process; `DEADLINE_MS = 250`; always silent-allow on any failure. |
| Match | `src/lib/memory/surface-core.ts` `matchSurfaceMemories(rh, relPaths, {tier2:true})` | Tier 1 = file-scope (literal/glob); Tier 2 = tag-overlap fallback; `CAP = 5`. Tier-2 cutoff is only `score <= 0` (`surface-core.ts:129`). |
| Per-session dedup | `src/lib/memory/surface-ledger.ts` `evaluateLedger(...)` | One SHA per file over the **sorted matched-ID set** (`setHash`, lines 18-21, 54-60). Cache-only; 7-day prune. |
| Telemetry | `src/lib/stats/surface-events.ts` `appendSurfaceEvent(...)` | JSONL `adoption/surface-events.jsonl`; logs `{ts, session_id, memoryIds[], tiers[], count}` — **no `paths`**; 90-day retention via `readSurfaceEvents`. |
| Context render | `surface-hook.ts:buildContext` | "Evaluate each against THIS edit … Surfaced ≠ relevant — do NOT get_memory ones that do not apply." |
| Positive usage | `src/lib/memory/retrieve.ts:getMemory` → `index.bumpGetCount` | `get_count`, `last_accessed_at` are **global** counters, not per-session. |
| `get_memory` tool | `src/mcp/server.ts:838-870` | Runs inside `withReconcileForRepoKey` (once-per-process `reconcileStore` gate). |
| Disk↔index reconcile | `src/lib/memory/reconcile.ts:reconcileStore` | Adopt/reindex/phantom-removal/legacy-repair. **Not** a telemetry reconciler. |

Key facts that shape the design:

- The hook is a **separate process** from the MCP server, so the server's
  in-process `reconciledKeys` gate does not apply — reconciliation logic that
  must run at surface time has to live in the hook.
- `get_count` / `last_accessed_at` are **global**, so they cannot answer "was
  memory M consulted *in session S*?" A per-session get-events log is required.

## 4. Design overview

Three independently shippable layers, applied in order. Each is a separate
implementation task (see §10 — the change touches >3 files overall, so it is
decomposed by layer per the project's "break large tasks down" rule).

1. **Phase 1 — L2:** per-`(file, memoryId)` session dedup.
2. **Phase 2 — L3:** real Tier-2 overlap threshold + generic-tag exclusion.
3. **Phase 3 — L1:** implicit, per-`(memory, file)` persistent suppression.

## 5. Phase 1 — L2: per-memory session dedup

**File:** `src/lib/memory/surface-ledger.ts` (+ its caller in `surface-hook.ts`).

Replace the per-file whole-set SHA with a per-`(file, memoryId)` **seen-set**.

- Ledger state becomes `{ [file]: string[] /* seen memory ids */ }` (or a
  `Record<file, Record<id, true>>`).
- On each surface, compute `fresh = pointers.filter(p => !seen[p.file]?.has(p.id))`.
  Emit **only** `fresh`; union the freshly-emitted ids into `seen[p.file]`.
- An id shown for a file this session is never re-shown for that file this
  session, even when the matched set churns.

**Interface change:** `evaluateLedger` returns the filtered pointer set (or the
set of suppressed ids) rather than a single `{emit}` boolean, so the hook can
render only fresh pointers. Keep the cache-only, best-effort, atomic
(`tmp`+`rename`) IO contract and the 7-day prune.

## 6. Phase 2 — L3: tighten Tier 2

**File:** `src/lib/memory/surface-core.ts` (Tier-2 block, lines ~109-154).

- Replace the `score <= 0` cutoff with a configurable **minimum overlap
  threshold** (`> 0` → `>= cfg.surface.tier2MinScore`).
- Exclude generic/popular tags from the overlap computation (extend the
  existing `getPopularTags`/`tagOverlapScore` interaction) so a memory that only
  overlaps on common tags (e.g. `architecture`, `testing`) does not match
  incidental path tokens.
- Tunable via config (see §7.5). Default chosen empirically against the current
  corpus during implementation; start conservative (surface fewer).

This phase is independent of Phases 1 and 3.

## 7. Phase 3 — L1: implicit per-(memory, file) suppression

### 7.1 Data model

- **New get-events log** in `src/lib/stats/surface-events.ts` (sibling JSONL
  `adoption/get-events.jsonl`): `appendGetEvent(repoKey, {ts, session_id, memoryId})`
  + `readGetEvents(repoKey)`, mirroring the existing append/read/prune contract
  (best-effort, 90-day retention). Called from the `get_memory` MCP handler
  (`src/mcp/server.ts:858`).
  - **Session-attribution invariant (load-bearing).** The `get_memory` tool input
    carries only `worktreePath` and `id` (`src/mcp/server.ts:843-846`) — it has no
    `session_id`. The handler therefore resolves the session via the existing
    **`resolveLoggedSessionId()`** (`src/mcp/server.ts:168-177`; env-preferred,
    `detectCurrentSession` fallback, memoized, never throws) — the same resolver
    the MCP stats sink already uses. The surface-hook, by contrast, records
    surface-events with `input.session_id` taken from hook stdin
    (`surface-hook.ts:182-186`). Dismissal cancellation (§7.2) joins get-events to
    surface-events on `(session_id, memoryId)`, so **correctness requires both
    paths to resolve to the same canonical session id.** This is the design
    invariant; it must be verified, not assumed.
  - **Fallback when ids cannot be reconciled.** If, on some harness, the hook's
    `input.session_id` and `resolveLoggedSessionId()` diverge, a get simply fails
    to match any surface event and therefore **does not cancel** a dismissal — a
    conservative bias toward (mild) over-suppression, bounded by version-reset
    (§7.4) and the `recall_memory` escape hatch (§2). No crash, no under-surfacing
    of unrelated memories.
- **Extend `SurfaceEvent`** with an optional `paths?: string[]` array parallel
  to `memoryIds` (back-compat: optional, like `tiers`). Populate it at the
  existing `appendSurfaceEvent` call (`surface-hook.ts:182`) from `p.path`.
  **Important:** after Phase 1, the event logs the **shown** (fresh, post-L2-dedup)
  pointers — not the full matched set — so dismissal accounting reflects what the
  agent actually saw and an id is never double-counted across repeated edits in a
  session (it is logged once, at its first showing).
- **New `memory_dismissals` table** in the index DB:
  `(memory_id TEXT, file TEXT, count INTEGER, last_ts TEXT, memory_version INTEGER, PRIMARY KEY(memory_id, file))`.
  The PK deliberately excludes `version`; `memory_version` is a stored column the
  increment logic compares against (§7.2) so a version bump resets rather than
  accumulates (§7.4).
- **New `dismissal_reconciled_sessions` table** in the index DB:
  `(session_id TEXT PRIMARY KEY, watermark_ts INTEGER)` — a per-session
  **high-water mark**: the `ts` of the newest surface-event already folded into
  dismissal counts for that session. It is a moving watermark, **not** a
  "reconciled-forever" flag — a session that resumes and emits newer events is
  reconciled again from its watermark forward (see §7.2), so later same-session
  events are never skipped.

Both tables are **derived state**, rebuildable by replaying the telemetry JSONL
logs (within their 90-day retention window) — NOT from the markdown store. Note:
`rebuild_index` reconstructs from disk memories and therefore does **not**
rebuild these; rebuilding dismissals is a separate replay of the JSONL logs.

### 7.2 Reconciliation (lazy incremental write-back, session-based)

Runs inside the hook **ahead of suppression** (§7.3) so the counts it writes are
current when suppression reads them, in a new module
`src/lib/memory/surface-dismissal.ts`, best-effort and bounded. It is
"independent" only in that it touches *past closed sessions*, never the current
edit's pointers.

A surface of memory `M` for file `F` in session `S` is a **dismissal** iff there
is no get-event `(S, M)` with `ts >= the surface ts`. (Get-events carry no file,
so a get of `M` in `S` cancels dismissal for *all* files surfaced for `M` in `S`
— a deliberate conservative under-count that biases against over-suppression.)
The get-event lookup uses the **full** get-events log for `S`, not just the delta
processed this run (see step 3), so a consult is honored regardless of which
reconciliation pass first saw the matching surface event.

**Watermark-delta processing — correct under interleaved *and* resumed sessions:**

1. Read surface-events + get-events.
2. Group surface-events by `session_id`. A session is **reconcilable now** when
   `session_id != currentSession` AND it has **no events newer than `now - GRACE_MS`**
   (idle past grace). The current session and any session with recent activity are
   left untouched this pass.
3. For each reconcilable session `S`, read its stored `watermark_ts` (default `-∞`
   if absent) and process only its surface events with `ts > watermark_ts` (the
   **unprocessed delta**). For each distinct `(M, F)` in the delta with no
   get-event `(S, M)` at/after that surface's `ts` in the full get-events log →
   record a **version-aware dismissal** for `(M, F)` (see §7.2.1).
4. Advance `watermark_ts` for `S` to the max `ts` among the surface events
   processed in step 3 (atomic with the count updates). Re-running with no new
   events yields an empty delta → no double counting. A session that later resumes
   and emits events past its watermark is reconciled again on the next
   idle-past-grace pass — **never skipped**.
5. Prune `dismissal_reconciled_sessions` rows older than telemetry retention.

> **Residual edge (documented, accepted).** A get that arrives in a much-later
> resume (>`GRACE_MS` after the surface was already counted as a dismissal in an
> earlier pass) cannot retroactively decrement that count. `GRACE_MS` makes this
> rare; version-reset (§7.4) and the `recall_memory` escape hatch (§2) bound the
> impact. Decrement-on-late-consult is explicitly out of scope.

#### 7.2.1 Version-aware dismissal increment

The `memory_dismissals` PK is `(memory_id, file)` with no `version` column, so the
increment **must** branch on the stored `memory_version` to honor the reset
requirement (§7.4) — a plain `count += 1` would let a stale `count = K` row tip to
`K+1` under a new version and stay suppressed. For each `(M, F)` dismissal:

- **No existing row:** insert `{count: 1, memory_version: M.currentVersion, last_ts}`.
- **Existing row, `stored.memory_version == M.currentVersion`:** `count += 1`;
  update `last_ts`.
- **Existing row, `stored.memory_version != M.currentVersion`:** **reset first** —
  overwrite to `{count: 1, memory_version: M.currentVersion, last_ts}`. The new
  version starts its dismissal count at 1, well below `K`, so a bumped memory
  re-earns a fresh chance to be surfaced.

**Hot-path safety:** reconciliation is wrapped in a sub-deadline check; if the
remaining hook budget is too low it is skipped and catches up on a later run.
All IO/DB writes are best-effort and never block the edit. A heavier full-replay
pass MAY later be added to the MCP `reconcileStore` sweep as belt-and-suspenders
(future, not in scope).

### 7.3 Suppression at surface time

In `matchSurfaceMemories` (or a thin filter the hook applies to its output):
after producing pointers, drop any pointer `(M, F)` where
`memory_dismissals.count >= K` **and** the stored `memory_version` equals the
memory's current version. Applies to both Tier-1 and Tier-2 pointers. Surfacing
only — `recall_memory` is untouched.

**Hook pipeline order (post-change):** match → **L1 suppress** (drop
`count >= K` pairings) → **L2 dedup** (drop ids already shown this session) →
append surface-event for the shown set → render. Reconciliation (§7.2, updating
counts from *past closed sessions*) is independent of this pass and runs under
its own sub-deadline.

### 7.4 Reset & decay

- **Version reset (primary):** a dismissal row whose stored `memory_version`
  differs from the memory's current version is **reset before the next
  increment** — overwritten to `count = 1` under the new version (§7.2.1), never
  accumulated on top of the stale count. Suppression (§7.3) additionally requires
  `stored.memory_version == current`, so even before the next reconciliation a
  stale-version row never suppresses. Net effect: a rewritten/updated memory
  re-earns its place and must be ignored `K` times *under the new version* before
  it is suppressed again.
- **Time decay (optional, deferred):** a suppressed `(M, F)` pairing is re-tried
  after N days so a now-relevant memory is not hidden forever. Implement only if
  needed; the version-reset + recall escape hatch may suffice.
- **Tier-1 scope-hint (optional, YAGNI-flagged):** repeated dismissals of an
  *explicitly file-scoped* memory also signal its scope may be wrong; could emit
  a soft flag for a later cleanup pass instead of only silencing. Deferred.

### 7.5 Config knobs (`src/lib/memory/config.ts`)

Add a `surface` block to `MemoryConfig` / `DEFAULT_CONFIG`:

```
surface: {
  tier2MinScore: <float>,     // L3 overlap threshold (default TBD-empirical, start conservative)
  dismissalThresholdK: 2,     // L1 dismissals before suppressing a (M,F) pairing
  reconcileGraceMs: 600000,   // 10 min grace before a non-current session is "closed"
}
```

## 8. Edge cases (→ test matrix)

- **Set churn (L2):** second edit to a file with a churned matched set suppresses
  already-shown ids but still surfaces genuinely-new ids.
- **Generic-tag overlap (L3):** a memory overlapping only on popular tags scores
  below `tier2MinScore` and does not surface; strong overlap still does.
- **Implicit dismissal (L1):** surface `M`/`F` in session A with no get → after
  A closes, count = 1; repeat in session B → count = 2 = K → suppressed in C.
- **Consultation cancels dismissal:** `get_memory(M)` in a session prevents a
  dismissal for *all* files surfaced for `M` that session (conservative).
- **Version reset:** bumping `M`'s version clears its dismissal counts.
- **Grace window:** the current session's (and very recent) surface events are
  not counted prematurely.
- **Resumed session:** a non-current session idle past `GRACE_MS` is reconciled up
  to its watermark; if it later resumes and emits newer events, the next
  idle-past-grace pass reconciles the delta past the watermark — later
  same-session events are never skipped.
- **Session attribution:** a get-event recorded by the `get_memory` handler and a
  surface-event recorded by the hook for the same logical session carry the same
  canonical `session_id` (the cancellation join depends on it); if they ever
  diverge the get fails to cancel (conservative), it never crashes.
- **Recall escape hatch:** a surfacing-suppressed `(M, F)` is still returned by
  `recall_memory`.
- **Concurrency:** hook process and MCP server process both touch the index DB;
  dismissal writes are small, best-effort, and atomic per `(M, F)` row. Re-running
  reconciliation without new events is a no-op (empty delta past the watermark),
  so repeated/overlapping passes never double-count.
- **Telemetry pruned:** dismissal counts only reflect events within the 90-day
  window; older signal ages out — acceptable.
- **Missing `paths` (legacy events):** pre-change surface events lack `paths` and
  are simply not attributable to a pairing — skipped, not crashed.

## 9. Test plan (TDD — failing tests first, per project rules)

- **Phase 1 (L2):** unit tests on `evaluateLedger` for the seen-set behavior
  (churn suppression, new-id pass-through, same-session idempotence). Extend
  `tests/integration/surface-hook.test.ts` for the end-to-end render.
- **Phase 2 (L3):** unit tests on `matchSurfaceMemories` Tier-2 threshold and
  generic-tag exclusion (above/below threshold; popular-tag-only overlap).
- **Phase 3 (L1):**
  - `surface-dismissal` reconciliation: surfaced-not-consulted → count increments
    only after the session is idle past grace; consultation cancels (full
    get-log lookup); grace window respected; re-run with no new events is a no-op.
  - **Watermark / resumed session (B2 regression):** reconcile session `S`
    (watermark advances); then append *newer* surface/get events with the **same**
    `session_id`; on the next idle-past-grace pass the delta past the watermark is
    processed — the later events are **not** skipped. Guards against the
    "reconciled-forever" defect.
  - **Version-aware reset (B3 regression):** seed a suppressed row
    (`count = K`, old version); bump the memory's version; record exactly **one**
    new dismissal → row is `count = 1` (reset, not `K+1`) and `< K`, so the memory
    is **not** suppressed. Also assert a stale-version row never suppresses (§7.3).
  - **Session attribution (B1 regression):** a handler-level test that the
    get-event appended by the `get_memory` handler carries the **same**
    `session_id` as the surface-event the hook records for the same session (i.e.
    `resolveLoggedSessionId()` and the hook's `input.session_id` reconcile), so the
    cancellation join in §7.2 actually matches. Include a divergence case asserting
    the conservative fallback (get does not cancel; no crash).
  - Suppression: pointer dropped at K; below K still surfaces; `recall_memory`
    unaffected.
  - get-events log append/read/prune contract.
- Per project rule: prefer existing helpers; place E2E additions in the existing
  surface-hook integration file.

## 10. Sequencing & file inventory

Decomposed into three implementation tasks (the overall change spans >3 files):

- **Task 1 (Phase 1 / L2):** `surface-ledger.ts`, `surface-hook.ts`, tests.
- **Task 2 (Phase 2 / L3):** `surface-core.ts`, `config.ts`, tests. Independent.
- **Task 3 (Phase 3 / L1):** `surface-events.ts` (get-events + `paths`),
  `server.ts` (`appendGetEvent` call in the `get_memory` handler, sourcing the
  session id from the existing `resolveLoggedSessionId()` — §7.1 invariant),
  `index.ts` (two new tables + accessors: `memory_dismissals`,
  `dismissal_reconciled_sessions` with `watermark_ts`), new `surface-dismissal.ts`
  (watermark-delta reconciliation + version-aware increment, §7.2/§7.2.1),
  `surface-hook.ts` (reconcile + suppress wiring), `config.ts`, tests. Gets its
  own implementation plan.

Ship order: 1 → 2 → 3. Phases 1 and 2 deliver immediate relief; Phase 3 adds the
cross-session learning.

## 11. Open questions / future work

- Empirical default for `tier2MinScore` (tune against the live corpus in Phase 2).
- Whether time-decay (§7.4) is needed beyond version-reset + recall escape hatch.
- Whether to surface the Tier-1 "scope may be wrong" hint (§7.4) into cleanup.
- Optional: fold a full dismissal replay into `reconcileStore` for robustness.
