# Intake Gate v2 — Tier-Routing Design

**Date:** 2026-07-22
**Status:** Approved design, revised per SDD review round 1 (routing atomicity, worktree identity, restore semantics, replay ground truth)
**Program context:** Phase 1 of the Memory System Improvement Plan (`~/.ai-pref-nsync/local-docs/ai-ecosystem/plans/2026-07-07-memory-system-improvement-plan.md`), informed by the 2026-07-07 corpus audit and the 2026-07-21 re-audit.

## 1. Context and problem

The capture intake path already has a structural gate (`src/lib/memory/gate.ts`: 13 reject-only rules) and a signal score (`signalScore`/`captureTier`: standing-directive, rationale, correction-shape markers). Rejected prompts are dropped; survivors become `capture` candidates at confidence 0.35. `captureTier` is currently used only to *hide* low-signal captures in review views and (in the dormant aging sweep) to expire them.

The 2026-07-21 re-audit measured the outcome: ~90% of new candidate captures carry a junk signature, the candidate backlog grew 426 → 627 in two weeks (+~100/week), and the aging sweep has never run (trash = 0 in every bucket). The dominant junk class — short imperative task chatter with an `_Acknowledged:_` echo — passes all 13 reject rules by design. The 2026-06-08 capture-quality followup observed that nearly all human-kept captures were the rare non-zero signal scores: the existing score already separates gems from junk, but nothing routes on it.

## 2. Goal and KPIs

Stop zero-signal junk from entering the candidate store, without losing a single gem.

| KPI | Current | Target |
|---|---|---|
| Junk share of new candidate captures | ~90% | < 30% |
| Candidate backlog growth | +~100/week | ~0 structural growth |
| Labeled-junk suppression (replay) | n/a | ≥ 80% |
| Labeled-gem loss (replay) | n/a | 0 |

## 3. Design overview

Route captures by the existing tier at extraction time:

- `structuralReject` hit → dropped, as today (structural noise, no ledger).
- Survivor with `signalScore ≥ 1` (high tier) → candidate, as today.
- Survivor with `signalScore = 0` (low tier) → memory row born directly in trash (`status = trashed`, reason `intake: zero-signal capture`), never passing through candidate state. Restorable for the existing `trashedToPurgedDays` retention (90d) via `untrash_memory`; purged by the aging sweep thereafter. Restoring a trashed capture returns it to `candidate` (see §4.5) — never `active`, which is a forbidden state for `type: capture`.

The trash tier IS the soft-drop ledger the program plan requires: no new storage, browse/restore/purge machinery already exists.

Supporting changes: a roleplay reject rule, title sanitation, a workspace ignore-list, dedup skip for zero-signal captures, and auto-scheduling of the aging sweep. A two-layer replay evaluation harness is the acceptance gate.

## 4. Detailed design

### 4.1 Intake routing (`extract.ts`)

In `extractFromSession`, for each produced capture candidate:

1. Compute tier from the user prompt text (`captureTier(u.text)`), consistent with the gate operating on prompt text. (The stored body appends the `_Acknowledged:_` echo; aging recomputes tier from the body, and drift between the two is acceptable — it can only move a candidate toward expiry, never resurrect junk.)
2. High tier: unchanged path (dedup → candidate).
3. Low tier: a dedicated lifecycle write path, `createDiscardedCapture` (name final at implementation), NOT `createMemory` + `trashMemory`. Rationale, verified against current code: `createMemory` funnels through `commit`, which unconditionally calls `upsertMemoryVector` — so the existing path cannot honor "skip embedding"; and `trashMemory` moves the markdown file before its index transaction, so a mid-sequence throw leaves file/index divergent rather than a usable candidate. The new path writes the markdown directly into `trash/` and inserts the index row with `status = trashed` (reason `intake: zero-signal capture`, audit `changeType: create`) as one commit-style operation with **no vector upsert** and no intermediate candidate state. Ordering requirement: no observable divergent state on failure — either the index transaction runs first with the file write compensated on failure, or the file write is compensated before the error propagates; the implementation plan picks the ordering, the fault-injection test (§9.2) enforces the property.
4. Failure isolation: if the discard path throws, fall back to standard candidate creation (`createMemory`) and log to stderr. A capture must never be silently lost to a routing failure, and a failed discard must never leave a half-written row.

Extractor manifest: add optional `discardedCaptures: { title: string; reason: string }[]` (and count into a `discardedCount`). Additive optional fields; manifest version stays 1.

Routing is governed by config flag `memory.intakeTierRouting` (default `true`). The flag exists for rollback, not for a soft launch: the release that ships this must pass the replay acceptance gates first (§5).

### 4.2 Gate additions (`gate.ts`)

- **Roleplay/persona rule (reject):** prompts assigning duo/session personas (the SANCHO PANZA / IGOR / ROBIN class). Must be a *reject rule*, not a tier concern: persona assignments frequently contain "always"/"never" and would otherwise score as high-signal standing directives. Exact regex driven by fixture cases harvested from the corpus.
- **Title sanitation (producer-side):** title := first non-empty line of the prompt, markdown/quote markers stripped, internal whitespace collapsed to single spaces, hard cap 80 chars with ellipsis. Never contains a newline (kills the YAML block-scalar `>-` leak). If the result is empty or a bare git hash (`/^[0-9a-f]{7,40}$/`), derive the title from the first meaningful words of the body instead.

### 4.3 Workspace ignore-list

Config `memory.ignoreWorktreePrefixes: string[]`, default `["/tmp/", "/private/tmp/"]`.

**Identity plumbing (required first):** extraction currently receives only `(repoKey, sessionId)`, `SessionRecord` stores no worktree identity, and one `repoKey` (hash of the git common dir) is shared by every worktree of a repo — so neither the extraction signature nor the bucket meta (which records only the last-indexed worktree) can reliably identify a session's origin. Fix: persist the origin `worktreePath` (from `resolveRepoIdentity`, which already computes it at capture time) into `SessionRecord` as a new optional field, following the `contentHash` precedent for version-tolerant additive fields.

**Skip decision:** at `extractFromSession` entry, read the session's stored `worktreePath`; on prefix match against the ignore list, write a manifest recording the skip (zero candidates, skip reason) and return. History capture itself is unaffected — only memory extraction is suppressed.

**Legacy sessions** (records written before the field existed): never prefix-skipped — extraction proceeds normally. A missing origin must fail open (extract) rather than guess.

Kills smoke-test exhaust buckets (`ws`, `lifecycle-smoke-*`) at zero cost going forward. Considered and excluded from the default: `/var/folders/` (macOS temp) — ai-whisper live-session mounts run there and may host real sessions. Users can add it per machine.

### 4.4 Aging sweep auto-run

`rehydrate_project` triggers `sweepAging` opportunistically after the briefing is assembled:

- Config `aging.autoSweep` (default `true`; opt-out).
- Rate limit: at most once per 24h per repo, via sentinel timestamp file `memory/.last-auto-sweep`.
- Fault isolation: sweep failures are logged to stderr and never block or degrade the briefing (same pattern as `runCaptureTriageIfNeeded`).

This activates the already-implemented low-signal expiry (`lowSignalCaptureToTrashedDays`) and trash retention (`trashedToPurgedDays`) that have never fired in production.

### 4.5 Type-aware restore (`untrashMemory`)

`untrashMemory` currently hard-codes restored `status = 'active'`. For `type: capture` rows that is a forbidden state: the lifecycle explicitly rejects active captures (`confirmMemory` guard — captures are kept via `rewriteMemory`, which assigns a real type AND promotes). Change: `untrashMemory` restores `type: capture` rows to `status = candidate` (back into the review queue where a human/agent judges them); all other types keep the existing behavior, which is out of P1 scope. Restored captures must not appear in active surfacing paths; the restore test (§9.7) asserts status, type, and surfacing exclusion.

## 5. Replay evaluation harness (acceptance gate)

Two layers:

**Unit layer (CI):** extend `tests/fixtures/memory-capture-corpus.ts` with labeled cases for the new classes (roleplay assignments, block-scalar-prone multi-line prompts, git-hash titles, bare imperatives, gems with each signal marker). Vitest asserts the gate + tier decision for every fixture. This is the regression net for all future rule tweaks.

**Authoritative ground truth is a fixed, committed, labeled raw-input snapshot** — not live-store reconstruction. Verified constraint: rewritten captures do not retain their intake body (`rewriteMemory` preserves `prevBody` only for opt-in types, and `capture` does not opt in; the 2026-06-08 keeper set survives only as provenance excerpts), and `promotedFrom` records cross-project promotion, not rewrite lineage. Live rewritten-card text is therefore NOT valid gem ground truth for an intake-routing gate.

The snapshot corpus (in `tests/fixtures/`, extending `memory-capture-corpus.ts`):

1. The existing 2026-06-08 labeled corpus (11 keepers as provenance excerpts, flagged as excerpt-fidelity; 128 noise).
2. **A new harvest, taken before the Phase 2 backlog drain:** the current 600+ untriaged candidates still hold their full raw bodies. A curation pass labels a sample (all high-tier survivors plus a noise sample) and freezes the labeled raw bodies into the snapshot. This is the only window where full-fidelity gem bodies exist — after the drain they are gone.
3. Synthetic cases for each gate rule and signal marker (already the fixture pattern).

**The release gate consumes the snapshot corpus, deterministically, in CI:** junk suppression ≥ 80% across labeled noise; gem loss = 0 across labeled keepers, or every individual loss explicitly reviewed and waived by the user (waivers recorded in the fixture file). Excerpt-fidelity keepers that fail only due to truncation may be waived with that stated reason. If gem loss > 0, tune `signalScore` markers, not the routing.

**Live corpus replay (`scripts/replay-intake.ts`, local, read-only)** remains as an advisory report following the `build-audit-corpus.ts` pattern: replays live capture bodies, reports suppression on deprecated-with-noise-reason rows and per-rule hit counts, and states its coverage limits (which labeled classes it can and cannot observe) separately from the snapshot numbers. It informs tuning; it does not gate the release.

## 6. Config summary

| Key | Default | Meaning |
|---|---|---|
| `memory.intakeTierRouting` | `true` | Zero-signal captures route to trash instead of candidate |
| `memory.ignoreWorktreePrefixes` | `["/tmp/", "/private/tmp/"]` | Skip extraction for matching worktrees |
| `aging.autoSweep` | `true` | Run aging sweep at rehydrate, rate-limited |
| (existing) `aging.lowSignalCaptureToTrashedDays` | unchanged | Low-signal candidate expiry |
| (existing) `aging.trashedToPurgedDays` | 90 | Trash retention before purge |

## 7. Out of scope (YAGNI)

- No LLM classifier (Tier B). The replay harness numbers decide whether it is ever needed.
- No retroactive application to the existing 627-candidate backlog. Phase 2 (backlog drain) runs this mechanism over the backlog as a separate operation.
- No new MCP tools. Trash browsing, restore, and purge already exist.
- No surfacing/intent changes (Phase 5).

## 8. Invariants honored

- ai-cortex never writes into the target repository (all changes under `~/.cache/ai-cortex/`).
- Visibility, not consumption: no action gated on `get_memory`.
- Push-only, precision-first surfacing untouched.
- No hard deletes: every routed capture is restorable for the full trash retention window.
- Harness-agnostic: nothing Claude-specific in naming or capture paths.

## 9. Testing plan (TDD)

1. Routing: zero-signal → row born in trash with the intake reason and **no vector row written** (assert absence, not just terminal status); high-signal → candidate; flag off → current behavior.
2. Fault injection: force the discard path to fail **after its first durable side effect** (not by mocking the whole operation) → standard candidate creation fallback, no divergent file/index state left behind, stderr log emitted.
3. Gate: fixture corpus green for every new class; roleplay rule fires before tier scoring.
4. Titles: all historical block-scalar and git-hash fixture cases produce single-line human-readable titles.
5. Ignore-list: session with a stored ignored `worktreePath` no-ops with a manifest skip note; legacy session without a stored origin extracts normally (fail-open); non-matching worktrees unaffected.
6. Sweep: sentinel rate-limit honored (no run < 24h since last); failure does not block rehydrate; `autoSweep: false` disables.
7. Restore: `untrash_memory` on a routed capture → `status = candidate`, `type = capture`, absent from active surfacing paths; non-capture untrash behavior unchanged.
8. Replay: snapshot corpus assertions deterministic in CI (these are the release gates); live-corpus advisory mode exercised locally before release.

## 10. Acceptance criteria

1. The committed snapshot corpus meets both gates in CI (≥ 80% suppression on labeled noise, 0 unwaived gem loss on labeled keepers).
2. The pre-drain harvest is committed: labeled raw-body cases from the current untriaged backlog are frozen into the fixture corpus **before** Phase 2 deletes their only full-fidelity source.
3. A fresh session's zero-signal captures appear in trash with reason `intake: zero-signal capture`, with no vector rows, and `untrash_memory` returns them to `candidate` (never `active`).
4. Extraction for a session recorded in a `/tmp` smoke worktree produces zero memory rows and a manifest skip note.
5. Two consecutive `rehydrate_project` calls within 24h run the sweep exactly once.
6. Full release gate green (`scripts/release.sh` — typecheck, typecheck:web, lint, build, `CI=true` test).

## 11. References

- Program plan: `local-docs/ai-ecosystem/plans/2026-07-07-memory-system-improvement-plan.md` (Phase 1)
- Corpus audit: `local-docs/ai-ecosystem/knowledge-references/2026-07-07-ai-cortex-memory-corpus-audit.md`; re-audit 2026-07-21 (same directory)
- Capture-quality followup: `docs/misc/2026-06-08-capture-quality-followup.md`
- Capture redesign (prior art): `docs/superpowers/specs/2026-05-17-memory-capture-redesign-design.md`
