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

- The TUI must not import `src/lib/memory/*` directly. All access goes through a stats-reader wrapper, mirroring the existing reader/TUI boundary (and its source-scan isolation test).
- ai-cortex never writes into target repos; this feature is read-only and adds no writes anywhere.
- Must not break `--once` / non-interactive mode (the browser is unreachable there by construction).

## Architecture

### View model

`App` gains a `view: "dashboard" | "memory-browser"` state plus the highlighted project's `repoKey`. Dashboard renders as today. Entering the browser swaps the entire render tree to `<MemoryBrowser>`; `Esc` flips `view` back. This avoids nesting a full-screen feature inside the cramped bottom DetailPanel and gives the browser its own `useInput` (gated `isActive` to this view, consistent with the codebase pattern). Rejected alternatives: swap-inside-DetailPanel (fights panel size, tangled focus), separate Ink render (loses shared state, over-engineered).

### Components (all new, under `src/tui/memory/`)

- `<MemoryBrowser>` — owns the browser: loads the list on mount, owns selection + body-scroll state, owns `useInput`, renders the activity strip + list + body. `Esc` calls an `onExit` prop.
- `<MemoryList>` — left pane. Status groups (`ACTIVE` / `CANDIDATE` / `PINNED` / `DEPRECATED`), each always shown with its `(N)` count even when 0 (stable structure). Rows are `[type] title`, the `[type]` tag colored via `typeColor`. Windowed viewport around the selection for large lists.
- `<MemoryBodyView>` — right pane. Metadata header (`type · status · pinned · updated · scope`) then the full markdown body. `bodyScroll` offset; `↓ more` hint when content overflows.
- `<MemoryActivityStrip>` — compact 2-line `rec`/`use` sparklines shown above the panes in the browser.

### Reusing the activity view in the dashboard

The dashboard Memory tab (`src/tui/detail/MemoryTab.tsx`) is rebuilt to: status counts line → two labeled sparklines (`recorded`, `used`) → top-accessed list → one-line legend. It uses the same `memoryActivity` reader and the existing `<Sparkline>` component. The browser's `<MemoryActivityStrip>` is a condensed rendering of the same data.

### Readers (no new schema)

Added to `src/lib/stats/query.ts` (or a sibling `src/lib/stats/memory-browser.ts` — implementation plan decides; the TUI imports only from the stats reader layer either way):

- `loadMemoryList(repoKey): MemoryListGroups`
  - `openRetrieve(repoKey)` → `listMemories(rh, { status: ["active","candidate","pinned","deprecated"] })`.
  - Returns groups in fixed status order, each `{ status, count, items: ListItem[] }` where `ListItem = {id,type,status,title,updatedAt,bodyExcerpt}` (existing type).
  - Trashed / purged excluded by virtue of the status filter.
  - Missing/absent store → empty groups (not an error).
- `loadMemoryBody(repoKey, id): MemoryRecord | { error: string }`
  - `getMemory(rh, id)` → `{ frontmatter, body }`.
  - Missing `.md` for an indexed id (drift) → typed `{ error }`, never throws to the UI.
- `memoryActivity(repoKey, window): { recorded: number[]; used: number[]; recordedTotal: number; usedTotal: number; buckets: number }`
  - `recorded` — `memory/index.sqlite` `memory_audit` rows, `change_type='create'`, `ts` within window, bucketed.
  - `used` — `stats/events.sqlite` `tool_calls`, `tool IN ('get_memory','recall_memory')`, `ts` within window, bucketed (`synthetic` rows included — they represent real historical usage, just coarse-grained).
  - Fixed bucket count = `30` (the sparkline render width; a single shared constant used by both the dashboard tab and the browser strip). Bucket size = `WINDOW_MS[window] / 30`. Empty → all-zero arrays, zero totals.
  - Both DBs opened read-only with the existing `openRO`-style guard; missing DB → that series all-zeros.
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
3. `<MemoryBrowser>` mounts → `loadMemoryList(repoKey)` + `memoryActivity(repoKey, window)`. One `RetrieveHandle` is opened and held for the session, closed on unmount.
4. Initial selection = first selectable row (first non-header). `loadMemoryBody(repoKey, id)` fills the right pane; results memoized by id for the session.
5. `j` / `k` move the selection across rows, skipping group headers (wraps within the flattened list). `J` / `K` jump to the next / previous group header's first row. Selection change → `loadMemoryBody` (cache hit after first) → body re-renders, `bodyScroll` reset to 0.
6. `Ctrl+d` / `Ctrl+u` adjust `bodyScroll`, clamped to `[0, max(0, bodyLines - viewportLines)]`.
7. `r` reloads list + activity; selection kept if its id still exists, else clamped to nearest.
8. `Enter` — reserved no-op; footer shows `[Enter]rewrite (soon)`.
9. `Esc` — App sets `view="dashboard"`; `<MemoryBrowser>` unmounts, `RetrieveHandle` closed.

The window selector (`w`) still belongs to the dashboard. On entering the browser the current window is passed in and used for the activity strip; changing the window is a dashboard action (not bound inside the browser in v1).

## Edge / empty / error states

Every state keeps `Esc` working and never crashes the app.

- **No memories / no store** — centered empty state `No memories for <project> yet.` Treated as empty, not error.
- **`listMemories` throws** (corrupt/locked index) — list pane shows `⚠ memory index unavailable`; body empty; `Esc` / `r` still work.
- **`loadMemoryBody` error** (indexed id whose `.md` drifted) — body pane shows `⚠ body unavailable (<id>)`; list stays navigable.
- **Empty status group** — header still shown as `STATUS (0)` (stable structure; matches approved mockup).
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
| `memoryActivity` | bucketing math, window boundaries, audit `create` filter, sink `get/recall` filter, empty → all-zero, missing DB → zeros | unit, tmpdir sqlite (audit + events fixtures) |
| `loadMemoryList` | status grouping + fixed order, type passthrough, excludes trashed/purged, empty store → empty | unit, fixture memory index |
| `loadMemoryBody` | returns frontmatter+body; missing id → typed error, no throw | unit |
| `typeColor` | known types fixed; custom type deterministic + stable across calls; palette membership | unit |
| `<MemoryList>` | group headers non-selectable, `[type]` colored, `(0)` groups shown, windowed viewport | `ink-testing-library` |
| `<MemoryBodyView>` | header fields present, scroll clamp, `↓ more` hint, `⚠ body unavailable` | `ink-testing-library` |
| `<MemoryActivityStrip>` | two series render, totals, all-zero empty state | `ink-testing-library` |
| `<MemoryBrowser>` | j/k skip headers, J/K group jump, Ctrl+d/u scroll + clamp, `r` reload keeps/clamps selection, Esc→exit, Enter no-op | `ink-testing-library` stdin |
| `MemoryTab` rebuild | counts + 2 sparklines + top-accessed + legend; empty state | `ink-testing-library` |
| App integration | Tab→Memory→Enter opens browser; Esc returns; `--once` never opens; min-size guard | `ink-testing-library` |
| Reader/TUI boundary | no `src/tui/**` file imports `src/lib/memory/*` directly | source-scan unit (mirrors existing sink-isolation test) |

## Rollout

- Minor feature; no schema change, no new deps.
- Version bump deferred to the implementation plan (folds into the next release after the merged v0.6.0 work).
- Docs: README "Inspecting performance" section gains a short "Browsing memories" paragraph; CHANGELOG entry.

## Risks + mitigations

- **`memory_audit` schema drift** — the reader hard-codes `change_type='create'` + `ts`. If the audit schema changes, the `recorded` series silently zeroes. Mitigation: a unit test asserts the exact columns it reads against the current `src/lib/memory/index.ts` schema (fails loudly if they move).
- **Large memory corpus** (hundreds of candidates) — windowed list viewport + memoized body loads keep render and IO bounded; no full-corpus body preload.
- **RetrieveHandle lifetime** — one handle per browser session, closed on unmount; no handle leak across open/close cycles (test asserts close on Esc).
- **Type-color collisions for custom types** — deterministic hash can collide two custom types onto one hue; acceptable (the `[type]` label text still disambiguates).

## Open questions

None at design freeze. Grouping (status sections, type tag), layout (full-screen takeover), entry/exit, body scroll, metadata header, scope (project-only), trashed exclusion, activity metrics (recorded + used), and placements (dashboard tab + browser strip) are all decided.

## File map

```
src/
  lib/stats/
    query.ts                 (+ memoryActivity; OR a new memory-browser.ts — plan decides)
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
