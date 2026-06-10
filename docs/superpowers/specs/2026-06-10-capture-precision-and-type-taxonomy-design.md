# Capture Precision v2 + Type Taxonomy Extension — Design

**Date:** 2026-06-10
**Status:** Approved, ready for implementation planning
**Scope:** Reduce capture-triage noise via gate v2 + computed signal tiering + auto-expiry + agent triage nudge; extend the memory type registry with `constraint`, `preference`, and `deferred`; default `gotcha.severity`.

## Problem

### Capture noise

The 2026-06-08 capture audit (`docs/misc/2026-06-08-capture-quality-followup.md`) reviewed 140 captures across four workspaces (ai-14all, ai-cortex, ai-whisper, ai-ezio): **11 keepers (~8%), 128 noise (~91%)**. Triage cost is ~12 noise items per keeper, which discourages cleanup (the weekly audit cron has never fired) and bloats the candidate store, degrading recall precision.

Forensic findings (2026-06-10, against live cache data):

1. **The noise is post-gate.** The structural gate (`src/lib/memory/gate.ts`) shipped 2026-05-19 (commits 7e7d1fc, 642782a). Deprecated noise captures created after that date: ai-14all 56 (05-23..06-06), ai-ezio 40 (06-03..06-07). The gate is leaking at volume.
2. **Root cause: accept-by-default.** Every user prompt that survives the reject-only gate becomes a candidate. Most prompts in a coding session are operational commands ("commit the fix", "push it, and we can prepare a new patch release", "Merge it into master now", "cancel wf_d8f3..."). The pipeline conflates "user said something" with "user stated knowledge". A reject blocklist can never enumerate session chatter.
3. **Phrase blocklists age instantly.** `ui-micro-tweak` misses "the dot glowing too much" / "make the codegraph denser"; `process-control` lists exact phrases so "Merge it into master now" leaks; `error-log`'s `Uncaught .*Error` cannot cross a newline so "Uncaught Exception:\nError..." leaked into the live ai-14all queue.
4. **The discriminator exists but is unused as a filter.** `signalScore(body)` (0–3: standing directive / rationale / correction shape) already separates keepers from noise — the audit found nearly all keepers score ≥1 and nearly all noise scores 0 — but zero-score captures enter the queue at equal standing.

### Type taxonomy

Agents are unsure which type to pick when recording valuable memories, and reach for types that do not exist. Evidence:

- Active gotcha `mem-2026-06-04-diagnosis-gotcha-requires-severity-52d6b1`: "Agents repeatedly call these tools with an unregistered type or a gotcha missing severity, then blindly retry-fail-reconcile." Agents specifically try `constraint`.
- Mis-typed memories in the live store: "ai-cortex never writes into the target repository" (constraint, stored as decision); "CaptureInput signature is a stable public contract" (constraint, stored as decision); "No em-dashes in publishable copy" (preference, stored as decision); "trace_history and recall_session deferred" (deferred work, stored as decision + backlog tag).

## Goals

1. Triage ratio drops from ~12:1 to ≤3:1 with **zero keeper loss**, measured against a labeled corpus built from the 140 audited captures.
2. Zero-signal captures stop occupying every default triage surface (the captures section, the generic "Pending review" section, `review_pending_captures`, and `list_memories_pending_rewrite`) and auto-expire (recoverable) instead of rotting.
3. The briefing actively closes the triage loop by nudging the agent to dispatch `review_pending_captures`.
4. Agents can type constraints, preferences, and deferred work first-try; `gotcha` calls stop failing on missing severity.

## Non-goals

- No LLM/provider/key inside ai-cortex. Judgment stays with the calling agent via MCP (unchanged principle).
- No stored tier/score columns. Tier is computed, never persisted (consistent with the 2026-05-17 decision that signalScore is recomputed from body at query time).
- No full agent-judged extraction replacing the regex pipeline (Phase 15 remains deferred; this round is heuristics + agent triage nudge).
- No supersession detection for mid-session iterative tweaks: tiering buries them (they score 0). Revisit only if high-tier duplicates appear in practice.
- No bulk retype migration of existing memories; agents retype opportunistically via `rewrite_memory`.
- No change to `captureSession`'s `CaptureInput` signature (stable public contract, `mem-2026-06-09-capturesession-s-captureinput-signature-ea36c7`).

## Constraints

- Local-first; no network calls; no writes into target repositories (all state under `~/.cache/ai-cortex/v1/<repoKey>/`).
- The gate stays **reject-only** — structural shapes, no positive/semantic classification (per the 2026-05-17 capture-redesign rationale: positive classifiers are provably lossy on real keepers).
- Markdown remains canonical; all new behavior derivable from bodies (rebuildable).
- Additive release: no schema migration, no breaking MCP/CLI changes.

## Design — Workstream 1: capture precision

### 1a. Gate v2 (`src/lib/memory/gate.ts`)

New reject rules (mechanical shapes, zero keeper risk), in the existing `RULES` table:

| Rule | Shape |
|---|---|
| `interrupt-marker` | Body is/starts with `[Request interrupted by user` (covers the "for tool use" variant) |
| `resume-kickoff` | Short body that is purely session control: starts with "continue from where", "let('s) resume", "recap me", "the workflow halted" (case-insensitive) |
| `screenshot-path` | Body dominated (>50% of trimmed length) by an image file path (`Screenshot ... .png/.jpg/.jpeg` style) |
| `structured-blob` | Trimmed body starts with `{` or `[` and parses as JSON, or is dominated by key:value / log-dump lines (catches raw env/version blobs) |

Fix to existing rule:

- `error-log`: replace `Uncaught .*Error` with a newline-crossing form (`Uncaught [\s\S]*?(Error|Exception)` or equivalent) and add `Uncaught Exception`.

### 1b. Computed tier (`gate.ts` + consumers)

```ts
export function captureTier(body: string): "high" | "low" {
  return signalScore(body) >= 1 ? "high" : "low";
}
```

Pure, total, never stored. Consumers:

- **`reviewPendingCaptures()`** (`src/lib/memory/pending-captures.ts`): after scoring the full eligible set (existing behavior), filter out low-tier rows by default. New option `includeLowSignal?: boolean` returns everything. Sort order unchanged (signalScore desc, then updated_at desc).
- **MCP `review_pending_captures`** (`src/mcp/server.ts`): expose optional `includeLowSignal` boolean param; description documents the default ("low-signal captures are hidden and auto-expire; pass includeLowSignal to audit them").
- **Briefing digest** (`src/lib/memory/briefing-digest.ts`, "Captures pending confirmation" section): count high tier only, with low tier disclosed: `## Captures pending confirmation — {high} (+{low} low-signal, auto-expiring)`. When `high > 0`, the section's guidance becomes directive: dispatch `review_pending_captures` now (batch ≤5), `rewrite_memory` keepers, `deprecate_memory` noise.
- **Generic pending-review surface** (`briefing-digest.ts` "Pending review" section + `list_memories_pending_rewrite`): both currently match `status='candidate' AND rewritten_at IS NULL`, which includes capture rows — so captures are double-surfaced today, and low-signal captures would survive in this default view. Fix by making the two queues disjoint on type: the "Pending review" count query and the `list_memories_pending_rewrite` query add `AND type != 'capture'`. Capture triage is owned exclusively by the captures section + `review_pending_captures` flow (whose guidance differs — e.g. "never `confirm_memory` on a capture row"). This closes every default triage surface for low-signal captures and removes the existing double-counting of high-signal ones.

Retroactivity is free: existing zero-score candidates demote on the next read, and every future scoring improvement re-tiers the whole store with no migration.

### 1c. Auto-expiry (`src/lib/memory/aging.ts`, `src/lib/memory/config.ts`)

- New aging config key: `lowSignalCaptureToTrashedDays: 14` (alongside existing keys; same config override mechanism).
- New sweep step in `sweepAging()`: select `type='capture' AND status='candidate' AND updated_at < cutoff(lowSignalCaptureToTrashedDays)`; for each row read the body (`readMemoryFile`), compute `captureTier`; if `"low"`, trash with reason `aging: low-signal capture untouched >14d`. High-tier captures are untouched by this step and keep the existing 90d `candidateToTrashedDays` behavior.
- Body-read failures (index/file drift) skip the row silently and continue the sweep (same pattern as `pending-captures.ts`; a sweep must never abort on one bad row).
- Recovery path: trashed captures follow the existing `trashedToPurgedDays: 90` window — rescuable via `untrash_memory` + `rewrite_memory` for ~3 months. `updated_at` as the clock means re-extraction of a recurring rule resets the timer (recurrence keeps captures alive).

### 1d. Agent triage nudge

- Briefing text change per 1b (directive when high-tier count > 0).
- `install-prompt-guide` template (`src/lib/memory/prompt-guide.ts`): add one line teaching the session-start habit: when the briefing shows pending high-signal captures, dispatch `review_pending_captures` and resolve each item (rewrite or deprecate) before starting work.

No new tools. The judgment loop runs in the calling agent via the already-shipped `review_pending_captures` / `rewrite_memory` / `deprecate_memory`.

## Design — Workstream 2: type taxonomy

### 2a. Registry (`src/lib/memory/registry.ts`)

Bump `REGISTRY_VERSION` 2 → 3. Three new built-in seeds (the existing `mergeSeed` migration adds them to every project/global store on next access; user-registered same-named entries win — only `capture` is force-reserved):

| Type | bodySections | extraFrontmatter | Notes |
|---|---|---|---|
| `constraint` | Rule, Scope, Consequences if violated | — | `auditPreserveBody: true` (like decision) |
| `preference` | Preference, Applies when | — | No `strength` field: registry validation has no optional-enum support, and YAGNI |
| `deferred` | What was deferred, Why, Revisit when | — | Recorded as `status: active`; the sweep only ages candidate/deprecated/merged/trashed, so deferred memories never auto-expire |

### 2b. Gotcha severity default

Applied at the tool layer, not the registry (enum validation stays intact): `record_memory` and `rewrite_memory` MCP handlers and the CLI `memory record` / rewrite paths fill `typeFields.severity = "warning"` when `type === "gotcha"` and severity is absent, before `validateRegistration`. Tool descriptions document the default.

### 2c. Guidance surfaces

`typeContractHint()` becomes a one-line decision tree, propagated to MCP tool descriptions (`record_memory`, `rewrite_memory`) and the prompt guide:

> decision = chose A over B with rationale · constraint = non-negotiable, no B exists · preference = user taste, violating disappoints rather than breaks · gotcha = surprising behavior + severity (defaults to warning) · pattern = codebase convention · how-to = procedure · deferred = parked work + revisit condition

`briefing-digest.ts` is registry-driven and picks up the new types automatically.

## Data flow (after)

```
user turn ──► gate v2 ──reject──► never stored (reason logged in extractor-runs)
                │ survive
                ▼
        candidate (type: capture)
                │
        captureTier(body)   ← computed, never stored
        ┌───────┴────────┐
     high tier        low tier
        │                 │
  briefing count     hidden from default views
  + agent nudge      untouched 14d → trashed → purged at 90d
        │                 │ (rescuable: untrash + rewrite)
  review_pending_captures (batch ≤5)
        │
  rewrite (keep, real type) / deprecate (noise)
```

## Error handling

- `captureTier` is total: any string input yields a valid tier.
- Aging body-reads and pending-captures reads skip drifted rows silently (existing pattern); a sweep or briefing render never crashes on a sibling's failure.
- Registry migration failure leaves the store on v2: new types unavailable, nothing else breaks (same failure mode as the existing v1→v2 path).

## Testing (TDD — corpus first)

1. **Labeled corpus (the red test).** Build a fixture from the audited captures sourced from the four workspace stores, added next to the existing gate regression corpus. The audit reviewed 140 items: 11 rewritten-to-active (= keeper label), 128 deprecated (= noise label), and **1 untouched** (ai-whisper) — still `status='candidate'`, never judged. The corpus is therefore **139 labeled rows**; the untouched row is excluded from all assertions (do not guess a label for it — if it gets triaged later it can join the corpus with its real label). Curate when extracting: the bodies are the user's own prompts from their own machines, but strip anything secret-like before committing. Assertions over the 139 labeled rows:
   - 0 of the 11 keepers gate-rejected
   - 0 of the 11 keepers low-tier (if any keeper scores 0, tune `RATIONALE`/`CORRECTION_SHAPE` — the zero-loss constraint stands, the heuristic moves)
   - ≥80% of the 128 noise rows gate-rejected OR low-tier
2. **Unit.** Each new gate rule (hit + near-miss negative); `error-log` newline fix; `captureTier`; `reviewPendingCaptures` tier filter + `includeLowSignal`; generic pending-review exclusion (a `type='capture'` candidate appears in neither the "Pending review" count nor `list_memories_pending_rewrite` results, regardless of tier, while a non-capture candidate still does); aging step (low-tier 14d trashed, high-tier untouched, non-capture candidates keep 90d rule, drifted row skipped); registry v2→v3 migration (new types added, user custom types preserved, `capture` force-preserved); `validateRegistration` for the three new types; severity defaulting at MCP and CLI layers.
3. **Integration.** Extraction over the existing fixture transcript → briefing shows tier-aware capture count and a "Pending review" count that excludes capture rows; MCP `review_pending_captures` returns high tier by default and everything with `includeLowSignal`.
4. **Suite stays green.** `pnpm build` then `CI=true pnpm test` before any tag (release rule; cli tests spawn dist).

## Rollout and measurement

One additive minor release. Immediate retroactive effect: stale zero-signal candidates (e.g. ai-ezio's ~30 pending) disappear from the default view on the next briefing and trash on the next sweep. Watch over the following two weeks in `cortex stats`:

- pending high-tier count (should stay near zero)
- `extract→cleanup %` (should rise — the nudge closes the loop)
- `recall→get %` (longer-horizon: less candidate noise should lift recall precision)

## Cross-references

- Capture audit: `docs/misc/2026-06-08-capture-quality-followup.md`
- Prior capture redesign (gate v1, reject-only rationale): `docs/superpowers/specs/2026-05-17-memory-capture-redesign-design.md`
- Adoption metrics interpretation: `docs/shared/adoption-metrics.md`
- Stable contract: `src/lib/history/capture.ts` `CaptureInput` (do not change)
