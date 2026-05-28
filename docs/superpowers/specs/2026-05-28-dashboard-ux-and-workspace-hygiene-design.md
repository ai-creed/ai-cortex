# Dashboard UX: Self-Explaining Stats + Workspace Hygiene — Design

**Date:** 2026-05-28
**Status:** Draft, awaiting plan
**Scope:** follow-up to `2026-05-15-tui-stats-dashboard-design.md`. Two related improvements to the shipped `cortex stats` TUI:
1. **Interpretation layer** so the dashboard answers "is ai-cortex helping?" without external docs.
2. **Workspace hygiene** so test/smoke-run repos can be excluded, archived, or cleaned without polluting the numbers.

The two ship in one spec because they share the TUI and the dashboard is the natural place to spot junk workspaces and act on them. They split into independent plan tasks.

## Problem

The shipped dashboard surfaces the right metrics but buries the answer to the only question users actually open it to answer: *is this tool earning its keep?*

Three concrete symptoms, all observable in a real snapshot:

1. **Effectiveness signal is buried.** The single line that speaks to adoption (`recall→get 72%`) lives as line 4 of the Memory box, next to deprecated counts. The canonical adoption metric per `docs/shared/adoption-metrics.md` — `memoryUsed%` — is computed per-project for the Sessions tab but is **not** available at the overview/aggregate level (the overview returns `EMPTY_ADOPTION`). There is no synthesized verdict anywhere.
2. **No inline meaning.** A newcomer sees `recall→get 72%` and has no idea whether that is good, what it measures, or how it differs from `memory used %`. The good/bad ranges live only in `docs/shared/adoption-metrics.md`. The footer advertises `q / r / Tab / w` only, hiding `j/k`, `1–5`, and `Enter`.
3. **Junk workspaces pollute the list.** A real snapshot shows 12 projects of which 6 are zero-call repos. Three have no package name and the list falls back to displaying the leading 14 chars of their canonical 16-hex repoKey (e.g. `29751ede0f594c…`, `41f3b42e80a139…`, `d8076502043d81…`), `ralph-smoke` appears twice, and `ai-samantha` / `ai-pref-nsync` have zero activity. There is no in-app way to hide or remove these, so they consume sidebar real estate and skew cross-project aggregates.

## Goals

1. A plain-language **verdict band** at the top of the overview that synthesizes "is ai-cortex helping?" from `memoryUsed% + recall→get + error rate + activity volume` with a status dot (`●` helping / `◐` mixed / `○` too little data).
2. **Effectiveness as a first-class panel** in the overview grid, holding the three adoption metrics (`memoryUsed%`, `recall→get`, `suggest hit`).
3. **`[?]` help overlay** explaining each metric in one line plus its good/ok/bad thresholds, dismissible with `?` or `Esc`.
4. **Workspace hygiene from the TUI**: `e` exclude / `a` archive / `x` clean on the selected project, with confirm only for the destructive case.
5. **Discoverability fix**: KeyBar advertises every active key in the current view, including hygiene actions for the selected project.
6. **Aggregate adoption** computed cross-project so the verdict band is grounded in real adoption data, not just `recall→get` (a partial proxy).

## Non-goals

- Auto-detection of junk workspaces. Heuristics are tempting but error-prone; the user picks. (Deferred; revisit if manual selection feels tedious.)
- In-TUI restore of excluded/archived workspaces. Restoring is rare; users edit `stats-config.json` or move directories back manually. Keeps the TUI simple.
- Rework of master-detail navigation. The current stacked overview+detail layout stays; this is targeted improvement, not restructuring.
- Inline glosses on every metric. We chose "verdict line + help overlay" over always-visible per-metric explanations to keep the main view dense but uncluttered.
- New CLI subcommands for hygiene. All hygiene operations are TUI-only in v1.

## Constraints

- ai-cortex never writes into target repositories (pinned project rule). All new state lives under `~/.cache/ai-cortex/v1/`.
- The verdict band must degrade gracefully when sample size is small. Below an activity floor the dot is `○` and the verbal verdict is "too little data yet" regardless of percentages.
- Hygiene state must not corrupt the existing cache layout. The exclusion list is additive; the archive dir uses a `_` prefix so it never collides with a real repoKey.
- Clean is irreversible. It is the only TUI action that prompts `y/n`.

## Architecture

Both workstreams share the existing `src/tui/` + `src/lib/stats/` boundaries. Three new ingredients:

1. **`adoptionAcross(repoKeys, window)` reader** — `src/lib/stats/sessions.ts`. Sums session counts and the recall/get/used buckets across all included repos, returning the same `AdoptionSummary` shape as the per-project loader. The overview's `readAll` calls this when `focus === null`, replacing today's `EMPTY_ADOPTION`.
2. **`stats-config.json`** — `~/.cache/ai-cortex/v1/stats-config.json`. A small JSON file holding the exclusion list and a `version` field. Lazy-created on first hygiene action; absent file means "nothing excluded".
3. **`_archived/` cache subtree** — `~/.cache/ai-cortex/v1/_archived/<repoKey>/`. Where archived repo caches move. `listProjects()` already walks the cache root; it gains a prefix filter that skips any directory whose name starts with `_`.

Everything else is presentation: new TUI components, restructured panels, expanded KeyBar.

### Boundaries

- The reader gains `adoptionAcross` and a `listProjects()` that consults `stats-config.json`. Neither knows anything about the TUI.
- A new `src/lib/stats/hygiene.ts` owns the three operations (`excludeWorkspace`, `archiveWorkspace`, `cleanWorkspace`) and the config file format. It is the only module that mutates the cache layout. TUI keybindings call into it.
- The TUI gains a verdict component, a help overlay component, and a confirm-dialog component. No new screens; both overlays render over the existing overview.

## Workstream A — Interpretation

### Verdict band

A full-width bordered panel at the top of the overview, between the title line and the projects + panels block. Content:

```
┌─ Is ai-cortex helping? ──────────────────────────────────────────────────────────────────┐
│ ● YES — saved memories get used in most sessions, recalls usually open, errors low       │
│ memory used 72%   ·   recall→get 72%   ·   suggest hit 61%   ·   err 3.2%                │
└──────────────────────────────────────────────────────────────────────────────────────────┘

The example above satisfies every green clause: `memoryUsed 72% ≥ 50`, `recall→get 72% ≥ 30`, `err 3.2% < 5`. If `err%` were ≥ 5, the synthesis rule and the mixed-verdict priority below would force the dot to `◐` with the verbal verdict "mixed — error rate is high"; the example here is the green path, not an exception to it.
```

**Synthesis rule** (deterministic, no ML):

| Dot | Verbal verdict | Condition |
|---|---|---|
| `○` muted | "too little data yet to tell — keep using ai-cortex" | `totalSessions < 5` OR `totalCalls < 20` in window |
| `●` green | "YES — saved memories get used in most sessions, recalls usually open, errors low" | `memoryUsed% ≥ 50` AND `recall→get ≥ 30` AND `err% < 5` |
| `◐` yellow | "mixed — <named dimension>" | anything else with enough data |

`err%` = `count(status='error') / totalCalls × 100` over the window.

**Mixed-verdict naming.** When the dot is yellow, the verbal verdict names the **first failing dimension** in this fixed priority order:

| Priority | Failing condition | Phrase |
|---|---|---|
| 1 | `err% ≥ 5` | "mixed — error rate is high" |
| 2 | `memoryUsed% < 20` | "mixed — saved memories rarely get used" |
| 3 | `memoryUsed% < 50` | "mixed — memories sometimes used but not consistently" |
| 4 | `recall→get% < 30` | "mixed — recalls rarely open a result" |

Priority order is deterministic so the verdict text doesn't flicker between equally-failing dimensions. Single source of truth: `src/lib/stats/verdict.ts`. The thresholds are constants documented at the top of that file and mirror the help-overlay table.

The four-metric strip below the verbal verdict is the same on every render. Each metric is color-coded by its individual threshold (see Help overlay table below), independent of the synthesized dot.

### Effectiveness panel

Replaces the top-left position of today's 2x2 grid (currently `Tool calls`). Contents:

```
┌─ Effectiveness ────────────┐
│ memory used    72%         │
│ recall→get     72%         │
│ suggest hit    61%         │
└────────────────────────────┘
```

`suggest hit %` = `count(suggest_files with result_count > 0) / count(suggest_files)` over the window. Reader gains a small helper; the field already exists in `tool_calls`.

### Activity panel (former "Tool calls")

Demoted to top-right, renamed `Activity`:

```
┌─ Activity ───────────────┐
│ 321 calls                │
│ p50 41ms  p95 374ms      │
│ err 3.2%   (10 of 321)   │
└──────────────────────────┘
```

The change is in label, not data. Adds explicit `N of total` framing for errors.

### Memory and Storage panels

`Memory` and `Storage` retain their slots (bottom row). `Memory` drops the duplicated `recall→get` line (now in Effectiveness) and keeps only the counts that are not effectiveness signals. `Storage` is unchanged.

### Cache mix

Moves out of the overview grid entirely. Cache freshness is operational detail, not a signal for "is it helping". It is summarized in the help overlay's per-metric table and remains in full form on the project-detail **Tools** tab.

### [?] Help overlay

A bordered full-width panel rendered over the overview when `?` is pressed (dismissed with `?` or `Esc`). Static content; no live data.

```
┌─ What these numbers mean ─────────────────────────────────────────────────────────────┐
│                                                                                       │
│ memory used %   sessions where a saved memory was actually opened/used.               │
│                 THE adoption signal.  >50% good · 20-50% ok · <20% not landing        │
│ recall→get %    of sessions that searched memory, how many then opened a result.      │
│                 >50% good · 30-50% ok · <30% recalls rarely landing                   │
│ suggest hit %   suggest_files calls that returned at least one file.                  │
│                 >70% good · 40-70% ok · <40% suggestions often empty                  │
│ p50 / p95       median & 95th-pct latency, ms (live calls only; backfill shows 0).    │
│                 p50: <100ms good · 100-300ms ok · >300ms slow                         │
│                 p95: <500ms good · 500-1500ms ok · >1500ms slow                       │
│ cache mix       index reads served fresh / reindexed / stale.                         │
│                 >70% fresh good · 40-70% fresh ok · <40% fresh = lots of reindexing   │
│                                                                                       │
│ Verdict   ● helping   ◐ mixed   ○ too little data yet                                 │
│                                                                                       │
│                                                                press ? or Esc to close│
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Every threshold above is a constant in `src/lib/stats/verdict.ts` (the same file that drives the verdict synthesis), so the overlay text, the verdict synthesizer, and the per-metric color coding in the Effectiveness and Activity panels are guaranteed to agree by construction. Changing a threshold means changing one constant; the overlay and the runtime stay in lockstep.

### Detail panel: tab order + default

Today's detail tabs are `Tools · Memory · Suggest · Storage · Sessions`, default `Tools`. The effectiveness view (`Sessions`) being last + non-default contradicts the user's primary job ("deep diagnosis: is it helping in this project?"). Reorder and rename:

- New order: `Effectiveness · Tools · Memory · Suggest · Storage`
- `Sessions` is renamed `Effectiveness` to match the overview vocabulary.
- Default tab on first open of a project: `Effectiveness`.
- Per-tab content is unchanged. Numeric keys `1–5` follow the new order.

### KeyBar

Replace the current truncated hint strip with a context-aware footer:

```
selected: ai-whisper        e exclude   a archive   x clean
─────────────────────────────────────────────────────────────────────────────────────────
[q]uit  [r]efresh  [j/k]nav  [Tab]tab  [w]indow  [?]help
```

The hygiene action line is only shown when a project is selected. The main hint line is always shown. When the memory browser is open, the bar swaps to that view's hints (unchanged from today).

## Workstream B — Workspace hygiene

### Operations

| Key | Operation | Confirm? | Effect | Reversible by |
|---|---|---|---|---|
| `e` | exclude | no, footer toast | add repoKey to `stats-config.json.excluded[]`. Filtered from `listProjects()` and aggregates. | edit `stats-config.json` |
| `a` | archive | no, footer toast | move `~/.cache/ai-cortex/v1/<repoKey>/` to `~/.cache/ai-cortex/v1/_archived/<repoKey>/`. Filtered by prefix. | `mv` it back |
| `x` | clean | **yes, y/n** | `rm -rf ~/.cache/ai-cortex/v1/<repoKey>/`. | none |

All three act on the currently selected project in the overview's project list. After any of them, the project list refreshes and selection moves to the next row.

### Why no archive confirm

Archive is recoverable by moving the directory back. The footer toast names the destination path, so the user can `mv` it if they were wrong. Adding a prompt for a reversible action is friction without payoff.

### `stats-config.json` schema

`~/.cache/ai-cortex/v1/stats-config.json`:

```json
{
  "version": 1,
  "excluded": ["29751ede0f594c8a", "41f3b42e80a139d2"]
}
```

- `excluded[]` entries are the canonical **16-hex** repoKey strings produced by `sha16(...)` in `src/lib/repo-identity.ts:17` — the same form used as cache directory names under `~/.cache/ai-cortex/v1/`. Entries that do not match `^[a-f0-9]{16}$` are ignored with a one-line stderr warning so a hand-edit typo cannot poison the dashboard.
- Absent file or invalid JSON ⇒ treat as `{ version: 1, excluded: [] }` and log a one-line warning to stderr. Never crash the dashboard on a malformed config.
- `version: 1` is the only accepted shape; an unknown version logs a warning and is ignored. Future fields go through a v2 migration.
- Writes are atomic via `fs.writeFileSync(tmp, ...) + rename(tmp, final)`.

**Note on TUI truncation.** The overview project list and storage panel render repoKeys via `repoKey.slice(0, 14)` as a column-width fallback when no package name is available (`src/tui/overview/AggregatePanels.tsx:20`). The displayed 14-char string is **not** the stored key; the hygiene module always operates on the full 16-hex form resolved from the cache directory entry, never from the truncated display string.

### Archive directory

`~/.cache/ai-cortex/v1/_archived/<repoKey>/`. The underscore prefix is the filter rule for `listProjects()`:

```ts
// listProjects(): skip any cache-root entry whose name starts with "_"
.filter((e) => e.isDirectory() && !e.name.startsWith("_"))
```

This also future-proofs other underscore-prefixed sibling dirs.

### Confirm dialog (clean only)

Rendered over the overview, blocking input until resolved:

```
┌─ Clean workspace? ────────────────────────────────────────┐
│ Permanently delete cached stats + index for               │
│   29751ede0f594c8a   0 calls · /tmp/… · 0.2 MB            │
│                                                           │
│ This deletes the cache dir and cannot be undone.          │
│                                                           │
│         [ y ] delete        [ n ] cancel                  │
└───────────────────────────────────────────────────────────┘
```

`y` (or `Enter`) executes; `n` / `Esc` cancels. Size is shown so the user knows the disk impact. Origin path comes from `cacheMeta` when available; otherwise omitted.

### Footer toast

A one-line confirmation rendered for ~2 ticks (3s) under the KeyBar after a non-confirming action:

```
✓ excluded ai-samantha — hidden from dashboard. Edit stats-config.json to restore.
✓ archived 41f3b42e80a139d2 — moved to ~/.cache/ai-cortex/v1/_archived/.
✓ cleaned 29751ede0f594c8a — 0.2 MB freed.
```

## Data layer additions

### `adoptionAcross(repoKeys, window): AdoptionSummary`

`src/lib/stats/sessions.ts`. Iterates `loadSessionAdoption(rk, opts)` per repo and sums:

- `totalSessions`
- `sessionsWithMemoryUsed` (numerator of `memoryUsed%`)
- `sessionsRecalled`
- `sessionsRecallToGet`

Returns the same `AdoptionSummary` shape. `memoryUsed%` and `recall→get%` are computed at the call site as ratios over the summed counts. Excluded repos are filtered out **upstream** by `listProjects()`; the aggregate function takes the already-filtered list.

### `listProjects()` change

Two filters added:

1. Skip entries with name starting `_` (archive subtree).
2. Skip entries whose repoKey is in `stats-config.json.excluded`.

Both are pure filters; nothing about existing per-repo data changes.

### `suggestHitRate(repoKey, window)` helper

`src/lib/stats/query.ts`. Returns `count(tool='suggest_files' AND result_count > 0) / count(tool='suggest_files')` over the window. Used by the Effectiveness panel.

## Privacy and safety

- `stats-config.json` stores only `repoKey` strings (the canonical 16-hex `sha16(...)` form produced by `src/lib/repo-identity.ts:17`) and integer flags. No user-controllable strings.
- `_archived/` cache subtree is the same content as the live cache, just moved. No new content.
- Clean uses `fs.rm(path, { recursive: true, force: true })`. The path is always `~/.cache/ai-cortex/v1/<repoKey>/` derived from the cache root plus a **validated 16-hex key**. A unit test asserts the resolver rejects any key that does not match `^[a-f0-9]{16}$` (the same invariant `sha16` produces in `src/lib/repo-identity.ts`), so the dialog can never be tricked into deleting an arbitrary path. The same regex is applied to `excluded[]` entries in `stats-config.json`, to the dirname read from the cache root before any hygiene op, and to the source of every `mv` in archive — the hygiene module has a single shared `assertRepoKey(s)` helper used at all three sites.
- The dashboard never auto-cleans. Every destructive action is user-initiated and confirmed.

## Testing strategy

TDD per project preference. New unit and integration coverage:

| Layer | Coverage | Mechanism |
|---|---|---|
| `verdict.ts` | dot + verbal verdict for every threshold permutation incl. low-sample floor | unit, fixture inputs |
| `adoptionAcross` | sums match per-repo sums; empty input returns `EMPTY_ADOPTION`; one bad repo doesn't sink the aggregate | unit, fixture session files |
| `suggestHitRate` | empty window returns 0; only suggest_files counted; nulls excluded | unit, fixture SQLite |
| `hygiene.exclude` | adds to config, idempotent, atomic write, malformed-config recovery; rejects entries that don't match `^[a-f0-9]{16}$` and logs a warning rather than writing them | unit, tmp HOME |
| `hygiene.archive` | moves dir to `_archived/<repoKey>/`, idempotent, fails loudly if destination exists; rejects source keys that don't match `^[a-f0-9]{16}$` | unit, tmp cache root |
| `hygiene.clean` | rejects keys that don't match `^[a-f0-9]{16}$` (14-char display strings, 17-char, `../`, absolute paths, empty), removes dir, idempotent on missing dir; a fuzz case feeds `assertRepoKey` malicious inputs and asserts no `fs.rm` call escapes the cache root | unit, tmp cache root |
| `listProjects` filter | skips `_`-prefixed dirs and excluded keys; both filters compose | unit |
| Verdict band component | renders for green / yellow / muted; degrades to muted on `null` summary | `ink-testing-library` |
| Help overlay | toggle open/close, Esc closes, `?` toggles; each documented metric (`memory used %`, `recall→get %`, `suggest hit %`, `p50 / p95`, `cache mix`) renders its good/ok/bad threshold line; the threshold strings come from the same constants that `verdict.ts` reads (string snapshot per metric so removing a threshold breaks the test) | `ink-testing-library` stdin |
| Clean confirm | `y` triggers cleanWorkspace; `n` / `Esc` cancels; clean failure rolls back nothing but shows error toast | `ink-testing-library` stdin |
| Footer toast | shows for ~3s then clears; replaced by next toast immediately | `ink-testing-library` fake timers |
| KeyBar context | hygiene line only present when selection exists | `ink-testing-library` |
| Detail tab default | first open is Effectiveness; 1–5 follow new order | `ink-testing-library` |
| E2E smoke | `cortex stats --once`: verdict band renders, no crash on empty config, exit clean | spawn integration |

## Rollout

- Version bump: minor (`v0.12.0`).
- No new runtime deps. `ink-testing-library` only in dev.
- Migration: `stats-config.json` is created lazily on first hygiene action. Existing installs see no behavior change until they press `e/a/x`.
- Backwards compatible with the existing schema. No SQLite migration.
- Docs:
  - README "Inspecting performance" section gains a paragraph on the verdict band and hygiene actions.
  - `docs/shared/adoption-metrics.md` cross-links to the in-app help overlay vocabulary.
  - CHANGELOG entry.

## Risks and mitigations

- **Verdict thresholds feel wrong in the field.** Constants live in one file and are documented at the top; tune in a follow-up. The help overlay shows the ranges so the verdict is never a black box.
- **Aggregate adoption is misleading when one mega-project dominates.** v1 sums plain counts; if one repo's session volume swamps others, the cross-project verdict will track that repo. Acceptable; the per-project detail tab tells the per-repo story. If this bites in practice, add a "by project" verdict view later.
- **Config file corruption locks the user out of the dashboard.** Mitigated by malformed-config recovery: read failure logs and treats as empty, never crashes. A unit test enforces this.
- **`fs.rm` on the wrong path.** Mitigated by repoKey regex validation in `cleanWorkspace` plus a unit test that feeds malicious inputs (`../`, absolute paths, empty strings).
- **Archive collision.** If the user archives, restores by `mv`, then archives again, the second archive must fail loudly rather than overwrite. The hygiene module checks destination existence before moving.

## File map

```
src/
  lib/
    stats/
      verdict.ts                (new — synthesis + thresholds + verbal templates)
      hygiene.ts                (new — exclude/archive/clean + config IO)
      sessions.ts               (+ adoptionAcross)
      query.ts                  (+ suggestHitRate)
      paths.ts                  (+ archiveDir, statsConfigPath)
  tui/
    App.tsx                     (+ help-overlay state, confirm state, toast state, hygiene keys)
    overview/
      Overview.tsx              (+ VerdictBand at top)
      AggregatePanels.tsx       (reorder: Effectiveness / Activity / Memory / Storage)
      VerdictBand.tsx           (new)
      EffectivenessPanel.tsx    (new)
      ActivityPanel.tsx         (renamed from Tool calls block)
    detail/
      DetailPanel.tsx           (reorder TABS, rename Sessions → Effectiveness, default = Effectiveness)
    components/
      HelpOverlay.tsx           (new)
      ConfirmDialog.tsx         (new)
      Toast.tsx                 (new — one-line ephemeral footer message)
      KeyBar.tsx                (+ context-aware hygiene line)
    readAll.ts                  (overview aggregate now calls adoptionAcross)
tests/
  unit/lib/stats/verdict.test.ts
  unit/lib/stats/adoption-across.test.ts
  unit/lib/stats/suggest-hit-rate.test.ts
  unit/lib/stats/hygiene.test.ts
  unit/lib/stats/list-projects-filter.test.ts
  unit/tui/VerdictBand.test.tsx
  unit/tui/HelpOverlay.test.tsx
  unit/tui/ConfirmDialog.test.tsx
  unit/tui/Toast.test.tsx
  unit/tui/KeyBar.context.test.tsx
  unit/tui/DetailPanel.default-tab.test.tsx
  integration/stats-hygiene.test.ts
docs/
  shared/adoption-metrics.md    (cross-link to in-app help)
README.md                       (Inspecting performance: verdict + hygiene)
CHANGELOG.md                    (entry)
```

## Open questions

None at design freeze. Verdict thresholds, archive-no-confirm, no-in-TUI-restore, and the detail tab reorder are all decided.
