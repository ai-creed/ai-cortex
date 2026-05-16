# Memory Browser + Activity Visualization — Design

**Date:** 2026-05-16
**Status:** Draft, awaiting plan
**Scope:** new feature — a full-screen memory browser reachable from the stats TUI, plus a memory-activity sparkline view. Groundwork for a future LLM-rewrite feature.

## Problem

The stats TUI's Memory tab is counts-only (`active 0  candidate 10  pinned 0  deprecated 0`) and a near-empty "Top accessed" list. There is no way to actually read the memories ai-cortex has stored for a project, and no view of how the memory corpus grows or gets used over time. Both are needed before the planned LLM-rewrite feature (which will let a user select a memory and trigger a rewrite — it needs a browseable list and a readable body view to build on).

## Goals

1. Browse a project's memories full-screen: grouped list + readable body, scoped to the highlighted project.
2. Visualize memory activity (recorded vs. used) over the selected time window.
3. Reuse the existing memory data layer — no new SQL schema, no new persistence.
4. Leave a clean seam for the future LLM-rewrite action (a reserved keybinding, no behavior yet).

## Non-goals

- The LLM-rewrite feature itself. `Enter` in the browser is a reserved no-op for now.
- Editing, deleting, pinning, or otherwise mutating memories from the browser. Read-only.
- The `global` memory tier. Browser is project-scoped only.
- Trashed / purge-redacted memories. Excluded from all views.
- Live polling of memory data. The browser loads on entry and on explicit refresh.

## Constraints

- The TUI must not import `src/lib/memory/*` directly. All access goes through the stats-reader layer (`src/lib/stats/*`), mirroring the existing reader/TUI boundary and its source-scan isolation test. The stats-reader layer **may** import the *pure* memory helpers (`readMemoryFile`, `parseMemoryMarkdown`) and may open the memory SQLite read-only — it must not use the side-effecting paths.
- This feature is strictly read-only and adds **no** writes anywhere. In particular it must **not** call `getMemory()` / `openRetrieve()` / `openMemoryIndex()`: `getMemory` bumps `get_count` + `last_accessed_at` (`src/lib/memory/retrieve.ts:31`) and `openMemoryIndex` creates the memory dir/schema if absent (`src/lib/memory/index.ts`). The reader uses a read-only `better-sqlite3` open (the existing `memoryHealth` pattern) and the pure `readMemoryFile` (`src/lib/memory/store.ts:37` — just `fs.readFile` + parse).
- Readers are **stateless**: each call opens its read-only handle (or reads a file) and closes within the call, returning plain view models. No `RetrieveHandle` is created, held, or returned. The TUI never owns a memory handle.
- Must not break `--once` / non-interactive mode (the browser is unreachable there by construction).

## Architecture

### View model

`App` gains a `view: "dashboard" | "memory-browser"` state plus the highlighted project's `repoKey`. Dashboard renders as today. Entering the browser swaps the entire render tree to `<MemoryBrowser>`; `Esc` flips `view` back. This avoids nesting a full-screen feature inside the cramped bottom DetailPanel and gives the browser its own `useInput` (gated `isActive` to this view, consistent with the codebase pattern). Rejected alternatives: swap-inside-DetailPanel (fights panel size, tangled focus), separate Ink render (loses shared state, over-engineered).

### Components (all new, under `src/tui/memory/`)

- `<MemoryBrowser>` — owns the browser: calls the stateless readers on mount and on `r`, owns selection + body-scroll + body-memo state, owns `useInput`, renders the activity strip + list + body. `Esc` calls an `onExit` prop. Holds no DB/file handle.
- `<MemoryList>` — left pane. Status groups (`ACTIVE` / `CANDIDATE` / `DEPRECATED`), each always shown with its `(N)` count even when 0 (stable structure). `pinned` is **not** a status (it is a boolean column, `src/lib/memory/index.ts:44`; valid statuses are in `src/lib/memory/types.ts:5`) — pinned memories appear under their real status group with a `📌` marker prefix on the row (and `pinned` is shown in the body header). Rows are `📌? [type] title`, the `[type]` tag colored via `typeColor`. Windowed viewport around the selection for large lists. *(This corrects the earlier mockup, which drew PINNED as its own group — not implementable since the status filter cannot select pinned rows.)*
- `<MemoryBodyView>` — right pane. Metadata header (`type · status · pinned · updated · scope`) then the full markdown body. `bodyScroll` offset; `↓ more` hint when content overflows.
- `<MemoryActivityStrip>` — compact 2-line `rec`/`use` sparklines shown above the panes in the browser.

### Reusing the activity view in the dashboard

The dashboard Memory tab (`src/tui/detail/MemoryTab.tsx`) is rebuilt to: status counts line → two labeled sparklines (`recorded`, `used`) → top-accessed list → one-line legend. It uses the same `memoryActivity` reader and the existing `<Sparkline>` component. The browser's `<MemoryActivityStrip>` is a condensed rendering of the same data.

### Readers (no new schema)

`loadMemoryList` / `loadMemoryBody` live in a new `src/lib/stats/memory-browser.ts`; `memoryActivity` lives in `src/lib/stats/query.ts` alongside the existing stats readers. The TUI imports only from the stats reader layer:

- `loadMemoryList(repoKey): MemoryListGroups`
  - Opens `memory/index.sqlite` **read-only** (`new Database(path, { readonly: true })`, the existing `memoryHealth` pattern — no schema creation). Missing file → empty groups (not an error).
  - Direct query (the reader owns its SQL; `ListItem` lacks `pinned` so we select it explicitly): `SELECT id, type, status, title, updated_at AS updatedAt, pinned FROM memories WHERE status IN ('active','candidate','deprecated') ORDER BY updated_at DESC`.
  - Returns groups in fixed status order `[active, candidate, deprecated]`, each `{ status, count, items: MemoryListItem[] }` where `MemoryListItem = {id,type,status,title,updatedAt,pinned:boolean}`.
  - Trashed / merged_into / stale_reference / purged_redacted excluded by the status filter.
- `loadMemoryBody(repoKey, id): { record: MemoryRecord } | { error: string }`
  - `readMemoryFile(repoKey, id, "memories")` — pure `fs.readFile` + `parseMemoryMarkdown`, **no DB access, no `get_count` bump**. Location is always `"memories"` because trashed is excluded from the list.
  - Missing/unreadable `.md` (index/file drift) → typed `{ error }`, never throws to the UI.
- `memoryActivity(repoKey, window): { recorded: number[]; used: number[]; recordedTotal: number; usedTotal: number; buckets: number }`
  - Compute `sinceMs = Date.now() - WINDOW_MS[window]`; `bucketMs = WINDOW_MS[window] / 30`.
  - `used` — `stats/events.sqlite` `tool_calls` (ts is **INTEGER ms**): `WHERE tool IN ('get_memory','recall_memory') AND ts > :sinceMs`; bucket index = `floor((ts - sinceMs) / bucketMs)`. `synthetic` rows included (real historical usage, just coarse-grained).
  - `recorded` — `memory/index.sqlite` `memory_audit` (ts is **TEXT ISO-8601**, `src/lib/memory/index.ts:80`): `WHERE change_type='create' AND ts >= :sinceIso` where `sinceIso = new Date(sinceMs).toISOString()` (ISO-8601 UTC sorts lexicographically == chronologically, so the SQL text comparison is valid); bucket index = `floor((Date.parse(row.ts) - sinceMs) / bucketMs)`. The ISO→ms conversion happens in JS, never via a numeric SQL comparison against the text column.
  - Fixed bucket count = `30` (the sparkline render width; one shared constant used by both the dashboard tab and the browser strip). Empty → all-zero arrays, zero totals.
  - Both DBs opened **read-only**; missing DB → that series all-zeros (independently — a missing events.sqlite must not zero `recorded`, and vice-versa).
- `typeColor(type: string): string` — added to `src/tui/theme.ts`. Fixed hues for known types; custom types hash deterministically into the same palette (stable across calls).

Type → color:

| type | hex |
|---|---|
| decision | `#D97757` |
| gotcha | `#E5544B` |
| feedback | `#5FB3C9` |
| project | `#7FB069` |
| reference | `#B589D6` |
| pattern | `#E0A93B` |
| how-to | `#4FAF8E` |
| user | `#6F9FD9` |
| *custom* | `palette[hash(type) % palette.length]` where `palette` = the 8 hues above |

## Data flow

1. Dashboard, project highlighted (App tracks the highlighted `repoKey` via the existing selection ref). User presses `Tab` to the Memory tab, then `Enter`.
2. App sets `view="memory-browser"` and passes `repoKey`.
3. `<MemoryBrowser>` mounts → calls the stateless readers `loadMemoryList(repoKey)` + `memoryActivity(repoKey, window)`. Each reader opens and closes its own read-only handle within the call; **no handle is held by the component**. The component stores the returned plain view models in React state.
4. Initial selection = first selectable row (first non-header). `loadMemoryBody(repoKey, id)` (a stateless pure file read) fills the right pane; results memoized by id in component state for the session.
5. `j` / `k` move the selection across rows, skipping group headers (wraps within the flattened list). `J` / `K` jump to the next / previous group header's first row. Selection change → `loadMemoryBody` (cache hit after first) → body re-renders, `bodyScroll` reset to 0.
6. `Ctrl+d` / `Ctrl+u` adjust `bodyScroll`, clamped to `[0, max(0, bodyLines - viewportLines)]`.
7. `r` re-invokes `loadMemoryList` + `memoryActivity`; selection kept if its id still exists, else clamped to nearest. The body memo cache is cleared on reload.
8. `Enter` — reserved no-op; footer shows `[Enter]rewrite (soon)`.
9. `Esc` — App sets `view="dashboard"`; `<MemoryBrowser>` unmounts. Nothing to close (readers are stateless).

The window selector (`w`) still belongs to the dashboard. On entering the browser the current window is passed in and used for the activity strip; changing the window is a dashboard action (not bound inside the browser in v1).

## Edge / empty / error states

Every state keeps `Esc` working and never crashes the app.

- **No memories / no store** — centered empty state `No memories for <project> yet.` Treated as empty, not error.
- **`loadMemoryList` read fails** (corrupt/locked index, or read-only open error) — list pane shows `⚠ memory index unavailable`; body empty; `Esc` / `r` still work.
- **`loadMemoryBody` error** (indexed id whose `.md` drifted) — body pane shows `⚠ body unavailable (<id>)`; list stays navigable.
- **Empty status group** — header still shown as `STATUS (0)` for each of ACTIVE / CANDIDATE / DEPRECATED (stable structure).
- **Large list** — list pane is a windowed viewport around the selection; body pane scrolls independently.
- **Min terminal size** — reuse App's 80×24 guard before rendering the browser.
- **`--once` / non-interactive** — browser only reachable via interactive `Enter`; never opens; no special-casing.
- **Backfilled `used` data** — coarse (session-start) timestamps make historical `used` buckets lumpy. Acceptable; documented in the legend context. `recorded` is audit-sourced and always accurate.

## Keybindings (browser)

| Key | Action |
|---|---|
| `j` / `k` | move row selection (skips group headers, wraps) |
| `J` / `K` | jump to next / previous group |
| `Ctrl+d` / `Ctrl+u` | scroll body pane |
| `r` | reload list + activity |
| `Enter` | reserved (LLM-rewrite, no-op) |
| `Esc` | return to dashboard |

Dashboard entry: `Tab` (or `2`) to Memory tab → `Enter`.

## Testing strategy

| Layer | Coverage | Mechanism |
|---|---|---|
| `memoryActivity` | bucketing math, window boundaries, ISO-text vs INTEGER-ms timestamp handling (audit ISO `since` compare + `Date.parse` bucketing; sink ms compare), audit `create` filter, sink `get/recall` filter, empty → all-zero, one DB missing must not zero the other series | unit, tmpdir sqlite (audit + events fixtures) |
| `loadMemoryList` | status grouping (ACTIVE/CANDIDATE/DEPRECATED) + fixed order, `pinned` boolean passthrough, type passthrough, excludes trashed/merged/stale/purged, empty store → empty, read-only open (asserts no schema created on a missing-index path) | unit, fixture memory index |
| `loadMemoryBody` | returns frontmatter+body via pure file read; **asserts `get_count`/`last_accessed_at` unchanged after a body load** (no side effects); missing id → typed error, no throw | unit, fixture index + .md |
| `typeColor` | known types fixed; custom type deterministic + stable across calls; palette membership | unit |
| `<MemoryList>` | group headers non-selectable, `[type]` colored, `📌` marker on pinned rows, `(0)` groups shown for the 3 statuses, windowed viewport | `ink-testing-library` |
| `<MemoryBodyView>` | header fields present, scroll clamp, `↓ more` hint, `⚠ body unavailable` | `ink-testing-library` |
| `<MemoryActivityStrip>` | two series render, totals, all-zero empty state | `ink-testing-library` |
| `<MemoryBrowser>` | j/k skip headers, J/K group jump, Ctrl+d/u scroll + clamp, `r` reload keeps/clamps selection + clears body memo, Esc→exit (no handle to close), Enter no-op | `ink-testing-library` stdin |
| `MemoryTab` rebuild | counts + 2 sparklines + top-accessed + legend; empty state | `ink-testing-library` |
| App integration | Tab→Memory→Enter opens browser; Esc returns; `--once` never opens; min-size guard | `ink-testing-library` |
| Reader/TUI boundary | no `src/tui/**` file imports `src/lib/memory/*` directly | source-scan unit (mirrors existing sink-isolation test) |

## Rollout

- Minor feature; no schema change, no new deps.
- Version bump deferred to the implementation plan (folds into the next release after the merged v0.6.0 work).
- Docs: README "Inspecting performance" section gains a short "Browsing memories" paragraph; CHANGELOG entry.

## Risks + mitigations

- **`memory_audit` / `memories` schema drift** — the reader hard-codes `change_type='create'`, `ts`, and the `memories` columns (`id,type,status,title,updated_at,pinned`). If the memory schema changes, `recorded` silently zeroes or the list query throws. Mitigation: a unit test asserts the exact columns/values it reads against the current `src/lib/memory/index.ts` schema (fails loudly if they move).
- **Timestamp type mismatch** — `memory_audit.ts` is ISO TEXT, `tool_calls.ts` is INTEGER ms. Mitigation: the spec mandates ISO `since` (`new Date(sinceMs).toISOString()`) for the audit SQL filter and `Date.parse` for its bucketing; a unit test seeds both stores and asserts the buckets align on the same timeline.
- **Large memory corpus** (hundreds of candidates) — windowed list viewport + memoized body loads keep render and IO bounded; no full-corpus body preload.
- **Read-only invariant** — all opens are `{ readonly: true }` and the body path is the pure `readMemoryFile`; a unit test asserts `get_count`/`last_accessed_at` are unchanged after `loadMemoryBody` and that no memory dir/schema is created when the index is absent.
- **Type-color collisions for custom types** — deterministic hash can collide two custom types onto one hue; acceptable (the `[type]` label text still disambiguates).

## Open questions

None at design freeze. Grouping (status sections ACTIVE/CANDIDATE/DEPRECATED + `📌` pin marker — corrected from the earlier PINNED-as-group mockup, since `pinned` is a boolean not a status), layout (full-screen takeover), entry/exit, body scroll, metadata header, scope (project-only), trashed exclusion, activity metrics (recorded + used), and placements (dashboard tab + browser strip) are all decided.

## File map

```
src/
  lib/stats/
    memory-browser.ts        (loadMemoryList, loadMemoryBody — read-only sqlite + pure readMemoryFile)
    query.ts                 (+ memoryActivity, alongside the existing readers)
  tui/
    theme.ts                 (+ typeColor + palette)
    App.tsx                  (+ view state, browser entry/exit)
    memory/
      MemoryBrowser.tsx
      MemoryList.tsx
      MemoryBodyView.tsx
      MemoryActivityStrip.tsx
    detail/
      MemoryTab.tsx          (rebuilt: counts + sparklines + top-accessed)
tests/
  unit/lib/stats/memory-activity.test.ts
  unit/lib/stats/memory-browser-reader.test.ts
  unit/tui/MemoryList.test.tsx
  unit/tui/MemoryBodyView.test.tsx
  unit/tui/MemoryActivityStrip.test.tsx
  unit/tui/MemoryBrowser.test.tsx
  unit/tui/MemoryTab.test.tsx
  unit/tui/memory-tui-isolation.test.ts
```
