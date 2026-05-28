# Dashboard: Two Verdicts (Overall + Selected Project) — Design

**Date:** 2026-05-28
**Status:** Draft, awaiting plan
**Scope:** follow-up to `2026-05-28-dashboard-ux-and-workspace-hygiene-design.md`. Targeted UX fix to the `cortex stats` overview verdict chrome shipped in `v0.12.0`.

## Problem

The shipped overview verdict band synthesizes a single answer to "is ai-cortex helping?" from cross-project aggregates. In real use this pollutes the signal: when a user is focused on one workspace, the verdict averages every other workspace into the answer they care about. The aggregate-driven view masks per-project effectiveness — a project that's working well can look "mixed" because other projects in the cache drag the numbers down, and vice versa.

The same pollution shows up in the overview panels (`Effectiveness` / `Activity` / `Memory`), which today display cross-project aggregates regardless of which project is highlighted in the sidebar.

## Goals

1. Render **two verdict bands** at the top of the overview: one for "all projects" (today's behavior) and one for "this project" (the row selected in the project list).
2. Flip the overview panels (`Effectiveness` / `Activity` / `Memory`) to the **selected project's** data so the verdict band and panels tell a consistent story.
3. Keep the `Storage` panel as cross-project aggregate (a top-N list reads better that way).
4. Hide the per-project band entirely when no project is selected (e.g. empty cache).
5. Preserve every existing test contract: thresholds, verdict synthesis, help overlay binding, hygiene actions, detail panel — none of those change semantics.

## Non-goals

- No new keybindings. No "global-only mode" toggle. The user picks a project with `j/k`; both views update.
- No change to verdict thresholds, phrase priority, or `THRESHOLD_TEXT`. Constants stay in `src/lib/stats/verdict.ts`.
- No change to the `[?]` help overlay (same metrics, just doubled in display — no need to document the dual band there).
- No change to the per-project detail panel (Effectiveness/Tools/Memory/Suggest/Storage tabs).
- No new MCP-tool or CLI surface.

## Constraints

- ai-cortex never writes into the target repository (pinned project rule). All new state stays in the existing TUI render path; no new persisted files.
- Layout must respect the existing `MIN_COLS = 80`, `MIN_ROWS = 24` guard. Adding the second verdict band costs ~3 extra rows; the dashboard remains usable at 80×24.
- The new band must not flicker or reflow on every tick. It is driven by the same per-project data that already feeds the detail panel.

## Architecture

Three small changes; no new modules.

1. **`VerdictBand` gains a `title` prop.** Today the title is hardcoded to `"Is ai-cortex helping?"`. The component becomes a pure renderer — one component, two call sites with different titles.
2. **`readAll` returns a per-project `suggestHit` even when a project is focused via the `det` branch.** The reader already computes it via `suggestHitRate(focus, window)`; today it's dropped at the snapshot boundary because the per-project verdict didn't exist. Thread it through.
3. **`Overview` accepts a second adoption bundle** (the selected project's) plus the selected project's aggregate/memory, and renders panel data from the per-project bundle instead of the overall.

Everything else is wiring in `App.tsx` between `snap.ov` (aggregate overview) and `snap.det` (selected project detail).

### Boundaries

- `VerdictBand` stays a pure renderer. It receives all data via props; it does not know whether it's "the overall band" or "the per-project band".
- `Overview` is the only component that knows about the dual-band layout. It owns the choice of which adoption bundle feeds which band, and which bundle feeds the panels.
- `App.tsx` keeps doing what it does today: pull `ov` + `det` from `snap`, pass them down. The wiring change is in *which* snapshot fields flow into Overview, not in *how* App composes state.
- `readAll`'s contract gains one optional field (`Snapshot.suggestHit` is already there; `Detail.suggestHit` is the new addition).

## Component changes

### `VerdictBand`

Today:
```ts
export type VerdictBandProps = {
  memoryUsedPct: number;
  recallToGetPct: number;
  suggestHitPct: number;
  errPct: number;
  totalSessions: number;
  totalCalls: number;
};
```

Becomes:
```ts
export type VerdictBandProps = {
  title: string;
  memoryUsedPct: number;
  recallToGetPct: number;
  suggestHitPct: number;
  errPct: number;
  totalSessions: number;
  totalCalls: number;
};
```

The hardcoded `"Is ai-cortex helping?"` is replaced by `{p.title}`. No other render change. Verdict synthesis (`synthesizeVerdict`) and color logic are untouched.

### `Overview`

`OverviewProps` gains the per-project bundle as direct props (NOT a nested object — keeps the component free of `?.` chains):

```ts
export type OverviewProps = {
  window: StatsWindow;
  projects: ProjectRow[];
  // Aggregate (all projects)
  aggregate: Aggregate;
  memory: MemoryHealth;
  memoryUsedPct: number;
  recallToGetPct: number;
  suggestHitPct: number;
  totalSessions: number;
  // Selected project (null when no project is selected)
  selectedRepoKey: string | null;
  selectedName: string | null;
  selectedAggregate: Aggregate | null;
  selectedMemory: MemoryHealth | null;
  selectedMemoryUsedPct: number;
  selectedRecallToGetPct: number;
  selectedSuggestHitPct: number;
  selectedTotalSessions: number;
  // Cross-project (kept aggregate)
  storage: Record<string, number>;
  projectNames: Record<string, string | null>;
  selected: number;
  onSelect: (i: number) => void;
  interactive?: boolean;
};
```

Render order in `Overview`:

```
<Text>ai-cortex stats · {window}</Text>
<VerdictBand title="Is ai-cortex helping? (all projects)" ... overall ... />
{selectedRepoKey ? (
  <VerdictBand title={`${selectedName ?? selectedRepoKey.slice(0,14)} (this project)`} ... selected ... />
) : null}
<ProjectList ... />
<AggregatePanels
  aggregate={selectedAggregate ?? aggregate}
  memory={selectedMemory ?? memory}
  storage={storage}                            // kept aggregate
  memoryUsedPct={selectedRepoKey ? selectedMemoryUsedPct : memoryUsedPct}
  recallToGetPct={selectedRepoKey ? selectedRecallToGetPct : recallToGetPct}
  suggestHitPct={selectedRepoKey ? selectedSuggestHitPct : suggestHitPct}
  ... />
```

When no project is selected, the per-project band is omitted and panels fall back to the aggregate (preserves today's behavior on an empty cache).

### `App.tsx`

Reads both bundles from the existing snapshot and passes them through:

```ts
const det = snap.det;            // the selected project's bundle (already loaded today)
<Overview
  window={window}
  projects={snap.ov.projects}
  aggregate={snap.ov.aggregate}
  memory={snap.ov.memory}
  memoryUsedPct={snap.ov.adoption.summary.memoryUsedPct}
  recallToGetPct={snap.ov.adoption.summary.recallToGetPct}
  suggestHitPct={snap.ov.suggestHit * 100}
  totalSessions={snap.ov.adoption.summary.sessionCount}
  selectedRepoKey={det?.repoKey ?? null}
  selectedName={det?.meta.name ?? null}
  selectedAggregate={det?.aggregate ?? null}
  selectedMemory={det?.memory ?? null}
  selectedMemoryUsedPct={det?.adoption.summary.memoryUsedPct ?? 0}
  selectedRecallToGetPct={det?.adoption.summary.recallToGetPct ?? 0}
  selectedSuggestHitPct={(det?.suggestHit ?? 0) * 100}
  selectedTotalSessions={det?.adoption.summary.sessionCount ?? 0}
  storage={snap.ov.storage}
  projectNames={snap.ov.projectNames}
  selected={selected}
  onSelect={onSelect}
  interactive={!once && !helpOpen && confirm === null}
/>
```

### `readAll` + `Detail`

`Detail` gains `suggestHit: number` (a ratio 0..1, matching `Snapshot.suggestHit`):

```ts
export type Detail = {
  repoKey: string;
  aggregate: Aggregate;
  latencyPerTool: Record<string, LatencyStats>;
  topTools: ToolStat[];
  memory: MemoryHealth;
  storage: Record<string, number>;
  meta: CacheMeta;
  adoption: { sessions: SessionRow[]; summary: AdoptionSummary };
  suggestHit: number;
};
```

`readAll` already calls `suggestHitRate(focus, window)` in the per-project branch; the per-detail snapshot in `App.tsx`'s tick callback assembles `Detail` and just needs to add `suggestHit: s.suggestHit` (the snapshot's value when `focus` is the selected project).

## Data flow

```
listProjects()  ─► repoKeys
                    │
                    ▼
readAll(window, null)
   ├─ aggregate / memory / suggestHit (aggregate)  ────► VerdictBand #1 + AggregatePanels fallback
   └─ Snapshot.adoption.summary (adoptionAcross)   ────► VerdictBand #1
                    │
                    ▼
   per-tick re-read with focus = selectedRepoKey
   ├─ aggregate / memory / suggestHit (per-project) ───► VerdictBand #2 + AggregatePanels primary
   └─ adoption.summary (loadSessionAdoption)        ───► VerdictBand #2
```

No new SQL, no new reader function, no new storage. The fix is presentation-only on top of data that already exists in the snapshot.

## Edge cases

| Case | Behavior |
|---|---|
| Cache empty / no projects | Per-project band omitted. Overall band renders muted ("too little data yet"). Panels render the aggregate fallback (which is also empty/muted). |
| One project | Both bands render. They will often agree; that's fine — stable layout. |
| Project freshly added with zero sessions | Per-project band renders muted via the same `totalSessions < 5` / `totalCalls < 20` floor used by the overall band. Same synthesizer, same thresholds. |
| Selected index moves (`j`/`k`) | Both bands update on the same tick (App's `onSelect` calls `refresh()` which re-runs the per-detail read). |
| Project excluded / archived / cleaned while selected | Existing `moveSelectionAfterRemoval` runs; the next tick's per-detail bundle reflects the new selection (or null when list goes empty). Per-project band hides on null. |
| Terminal at minimum size (80×24) | Two bands (~6 rows) + project list (5 rows) + panels (8 rows) + key bar (3 rows) = ~22 rows, fits within 24-row floor. No new min-size guard needed. |
| Live tick during render | `useStatsTick` already debounces; no extra coordination needed. |

## Testing strategy

Layered, following the project's TDD pattern. All new tests use `ink-testing-library`; no new fixtures or reader stubs needed.

| Layer | Coverage | Mechanism |
|---|---|---|
| `VerdictBand` | renders the `title` prop verbatim; existing dot/text/strip assertions still pass under both titles | `ink-testing-library`, extend existing test |
| `Overview` | both bands render when `selectedRepoKey` is non-null; per-project band hides when `selectedRepoKey === null`; the per-project band's metric strip matches `selected*` props, the overall band's strip matches `memoryUsedPct/...` props | `ink-testing-library` |
| `Overview` panels | when a project is selected, `AggregatePanels` receives the selected project's `aggregate` / `memory` / `memoryUsedPct` / `recallToGetPct` / `suggestHitPct` — NOT the overall ones (verify by passing distinguishable numbers and asserting which appear in the panel) | `ink-testing-library` |
| `Detail.suggestHit` | `readAll(window, focus)` returns a Snapshot whose `suggestHit` matches `suggestHitRate(focus, window)` for the focused project | existing `readAll-overview.test.ts` companion test |
| `App.tsx` | passes the right snapshot fields to Overview when `det` is present and when `det` is null | `ink-testing-library`, extend `App.hygiene.test.tsx` (no new file needed) |

The existing tests for the overall verdict, help overlay, hygiene, detail panel, and KeyBar continue to pass unchanged — none of those touch the new wiring.

## Rollout

- Patch bump: `v0.12.1`.
- No new deps. No SQLite migration. No `stats-config.json` migration.
- Backwards compatible: caches written by `v0.12.0` work unchanged. Sidecars don't need rewriting. The change is purely TUI-side.
- Docs: README "Inspecting Performance" gains one sentence noting that the verdict shows both global and selected-project answers. CHANGELOG entry under `v0.12.1`.

### Release authorization (binding rule for this phase)

Releases require **explicit user authorization for the specific version**, in the turn that authorizes it. Authorization does not transfer across sessions, plans, reviewer findings, or memory rules. In this autonomous workflow:

1. The implementer **MUST NOT** run any of: `scripts/release.sh`, `pnpm run release`, `npm publish`, `git tag` on a release tag, or `git push` of a release tag.
2. The implementer **MUST** stop after committing the local version bump (`package.json` and `src/version.ts` updated to `0.12.1`) and hand control back. The human decides when to publish.
3. The existing project rule that releases should use `scripts/release.sh` (rather than hand-edited bumps) is a **how**-rule: it specifies the release mechanism the human invokes, not a license for the agent to invoke it. When that mechanism's only sanctioned path is also a publish action, the resolution is to surface the conflict to the human, not to publish.

This rule is the binding contract for this phase. A cross-session memory (`mem-2026-05-28-releases-require-explicit-user-cc8865`, `globalScope=true`) records the same rule for future sessions; if it does not surface via project-scoped `recall_memory`, retry with `source: 'all'`. The spec text above is authoritative regardless of whether the memory resolves.

## Risks and mitigations

- **Per-project band overshadows overall.** Risk: users learn to read only the second band and ignore the global one. Mitigation: the global band stays first (top-most) and keeps its distinctive `"Is ai-cortex helping? (all projects)"` title.
- **Panel data and verdict band disagree.** Risk: panels show per-project numbers but a user reads them as global. Mitigation: when a project is selected, the project name is in the second band's title directly above the panels; the spatial proximity binds them. Future polish: a colored gutter or a `selected: ai-cortex` strip above the panel grid (out of scope).
- **80×24 terminal cramping.** Risk: two bands cost vertical space. Mitigation: keep both bands at 3 rows (border + verdict line + metric strip); no inflation. Verified in the edge-case table above.

## File map

```
src/
  tui/
    overview/
      VerdictBand.tsx              (+ `title` prop; render `p.title` instead of hardcoded literal)
      Overview.tsx                 (accept selected-* props, render two bands, route panel data)
    detail/
      DetailPanel.tsx              (Detail type gains `suggestHit: number`)
    readAll.ts                     (Snapshot already has suggestHit; ensure Detail builder threads it through)
    App.tsx                        (pass selected-* fields to Overview from `snap.det`)
tests/
  unit/tui/
    VerdictBand.test.tsx           (+ title prop assertion)
    Overview.verdict.test.tsx      (+ two-bands + hide-when-empty + panels-follow-selected)
    readAll-overview.test.ts       (+ per-project Detail.suggestHit assertion)
docs/
  superpowers/specs/2026-05-28-two-verdicts-design.md   (this file)
README.md                          (one-sentence note)
CHANGELOG.md                       (v0.12.1 entry)
```

## Open questions

None at design freeze.
