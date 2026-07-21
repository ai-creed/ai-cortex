# Intake Gate v2 — Tier-Routing Design

**Date:** 2026-07-22
**Status:** Approved design, pre-implementation
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
- Survivor with `signalScore = 0` (low tier) → memory row created and immediately trashed (`status = trashed`, reason `intake: zero-signal capture`). Restorable for the existing `trashedToPurgedDays` retention (90d) via `untrash_memory`; purged by the aging sweep thereafter.

The trash tier IS the soft-drop ledger the program plan requires: no new storage, browse/restore/purge machinery already exists.

Supporting changes: a roleplay reject rule, title sanitation, a workspace ignore-list, dedup skip for zero-signal captures, and auto-scheduling of the aging sweep. A two-layer replay evaluation harness is the acceptance gate.

## 4. Detailed design

### 4.1 Intake routing (`extract.ts`)

In `extractFromSession`, for each produced capture candidate:

1. Compute tier from the user prompt text (`captureTier(u.text)`), consistent with the gate operating on prompt text. (The stored body appends the `_Acknowledged:_` echo; aging recomputes tier from the body, and drift between the two is acceptable — it can only move a candidate toward expiry, never resurrect junk.)
2. High tier: unchanged path (dedup → candidate).
3. Low tier: skip dedup/embedding entirely (the row is going to trash; saves the embed call on the majority class), then `createMemory` + `trashMemory` under the same lifecycle handle with reason `intake: zero-signal capture`.
4. Failure isolation: if the `trashMemory` step throws, leave the row as a candidate and log to stderr. A capture must never be silently lost to a routing failure.

Extractor manifest: add optional `discardedCaptures: { title: string; reason: string }[]` (and count into a `discardedCount`). Additive optional fields; manifest version stays 1.

Routing is governed by config flag `memory.intakeTierRouting` (default `true`). The flag exists for rollback, not for a soft launch: the release that ships this must pass the replay acceptance gates first (§5).

### 4.2 Gate additions (`gate.ts`)

- **Roleplay/persona rule (reject):** prompts assigning duo/session personas (the SANCHO PANZA / IGOR / ROBIN class). Must be a *reject rule*, not a tier concern: persona assignments frequently contain "always"/"never" and would otherwise score as high-signal standing directives. Exact regex driven by fixture cases harvested from the corpus.
- **Title sanitation (producer-side):** title := first non-empty line of the prompt, markdown/quote markers stripped, internal whitespace collapsed to single spaces, hard cap 80 chars with ellipsis. Never contains a newline (kills the YAML block-scalar `>-` leak). If the result is empty or a bare git hash (`/^[0-9a-f]{7,40}$/`), derive the title from the first meaningful words of the body instead.

### 4.3 Workspace ignore-list

Config `memory.ignoreWorktreePrefixes: string[]`, default `["/tmp/", "/private/tmp/"]`. At `extractFromSession` entry, resolve the bucket's `worktreePath` from its meta; on prefix match, write a manifest recording the skip and return without producing candidates. Kills smoke-test exhaust buckets (`ws`, `lifecycle-smoke-*`) at zero cost.

Considered and excluded from the default: `/var/folders/` (macOS temp) — ai-whisper live-session mounts run there and may host real sessions. Users can add it per machine.

### 4.4 Aging sweep auto-run

`rehydrate_project` triggers `sweepAging` opportunistically after the briefing is assembled:

- Config `aging.autoSweep` (default `true`; opt-out).
- Rate limit: at most once per 24h per repo, via sentinel timestamp file `memory/.last-auto-sweep`.
- Fault isolation: sweep failures are logged to stderr and never block or degrade the briefing (same pattern as `runCaptureTriageIfNeeded`).

This activates the already-implemented low-signal expiry (`lowSignalCaptureToTrashedDays`) and trash retention (`trashedToPurgedDays`) that have never fired in production.

## 5. Replay evaluation harness (acceptance gate)

Two layers:

**Unit layer (CI):** extend `tests/fixtures/memory-capture-corpus.ts` with labeled cases for the new classes (roleplay assignments, block-scalar-prone multi-line prompts, git-hash titles, bare imperatives, gems with each signal marker). Vitest asserts the gate + tier decision for every fixture. This is the regression net for all future rule tweaks.

**Corpus layer (local, read-only):** `scripts/replay-intake.ts`, following the `build-audit-corpus.ts` pattern. Reads every live bucket under `~/.cache/ai-cortex/v1`, replays each capture body through gate + tier, and reports against ground truth:

- **Junk labels:** captures with `status = deprecated` and a noise-taxonomy deprecation reason.
- **Gem labels:** captures that were rewritten into typed cards (rewrite lineage in `memory_audit` / `promotedFrom`), plus the keeper set from the 2026-06-08 audit corpus.

Output (human table + `--json`): suppression rate on junk labels, loss list on gem labels (each lost gem printed with ID and body excerpt), per-rule hit counts.

**Acceptance gates (hard, pre-release):** junk suppression ≥ 80%; gem loss = 0, or every individual loss explicitly reviewed and waived by the user. If gem loss > 0, tune `signalScore` markers, not the routing.

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

1. Routing: zero-signal → trashed row with the intake reason; high-signal → candidate; `trashMemory` failure → candidate fallback + stderr log; flag off → current behavior.
2. Gate: fixture corpus green for every new class; roleplay rule fires before tier scoring.
3. Titles: all historical block-scalar and git-hash fixture cases produce single-line human-readable titles.
4. Ignore-list: matching worktree no-ops with manifest note; non-matching unaffected.
5. Sweep: sentinel rate-limit honored (no run < 24h since last); failure does not block rehydrate; `autoSweep: false` disables.
6. Replay harness: deterministic on the fixture corpus in CI; live-corpus mode exercised locally before release.

## 10. Acceptance criteria

1. Replay corpus run meets both gates (≥ 80% suppression, 0 unwaived gem loss).
2. A fresh session's zero-signal captures appear in trash with reason `intake: zero-signal capture` and restore cleanly via `untrash_memory`.
3. Extraction in a `/tmp` smoke worktree produces zero memory rows.
4. Two consecutive `rehydrate_project` calls within 24h run the sweep exactly once.
5. Full release gate green (`scripts/release.sh` — typecheck, typecheck:web, lint, build, `CI=true` test).

## 11. References

- Program plan: `local-docs/ai-ecosystem/plans/2026-07-07-memory-system-improvement-plan.md` (Phase 1)
- Corpus audit: `local-docs/ai-ecosystem/knowledge-references/2026-07-07-ai-cortex-memory-corpus-audit.md`; re-audit 2026-07-21 (same directory)
- Capture-quality followup: `docs/misc/2026-06-08-capture-quality-followup.md`
- Capture redesign (prior art): `docs/superpowers/specs/2026-05-17-memory-capture-redesign-design.md`
