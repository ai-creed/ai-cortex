# TUI Stats Dashboard — Design

**Date:** 2026-05-15
**Status:** Draft, awaiting plan
**Scope:** new feature — `ai-cortex stats` subcommand that surfaces how ai-cortex performs during real-world work.

## Problem

Today ai-cortex emits per-call timing and status to stderr only. There is no persistent record and no way to inspect aggregate behavior: which tools are hot, what their latency looks like, how often recalled memories are actually used, how much storage each project occupies, or how the cache (`fresh` / `reindexed` / `stale`) is performing.

We want a TUI that an engineer can leave open while working in another session, watch ai-cortex behave in real time, and drill into a single project for diagnosis.

## Goals

1. Capture every MCP tool call (latency, status, light metadata) to a persistent local store.
2. Render a master-detail TUI: all-projects overview with a drill-down per project.
3. Live polling so numbers tick during real work, with a manual refresh fallback.
4. Cover four metric categories: tool usage + latency, memory effectiveness, suggestion + session activity, storage + index health.

## Non-goals

- Export to CSV/JSON, filter-by-tool UI, side-by-side window comparison, alerts/thresholds, web-renderable view. Deferred to a later iteration.
- Top suggested files widget. Would require a separate sanitized file-path stats table and an explicit privacy review; the schema and Suggest tab in v1 deliberately omit it.
- Backfilling historical stats from prior stderr output (it's gone).
- Cross-host aggregation. The dashboard reads only the local `~/.cache/ai-cortex/` tree.

## Constraints

- ai-cortex MUST NOT write into any target repository (pinned project rule). All new state lives under `~/.cache/ai-cortex/v1/<repoKey>/`.
- The sink must not block or fail an MCP tool response. Sink errors log to stderr and are swallowed.
- Query strings, memory bodies, and other user content MUST NOT be persisted to the stats store. Lengths and counts only.

## Architecture

Three components, all local:

1. **Stats sink (writer)** — `src/lib/stats/sink.ts`. Wraps the existing `logged()` helper in `src/mcp/server.ts:66-114`. After the wrapped handler resolves, the sink appends one row to a per-repo SQLite events table. Fire-and-forget.
2. **Stats reader** — `src/lib/stats/query.ts`. Pure read functions over the events table plus the existing `memory/index.sqlite`. Walks every repo cache dir for the cross-project aggregate view.
3. **TUI app** — `src/tui/` (Ink). Two screens: `<Overview>` (sidebar + 2×2 widget grid) and `<ProjectDetail>` (Tools / Memory / Suggest / Storage tabs). Polls the reader every 1.5s.

Memory effectiveness, top-accessed memories, and pending-review depth come from the **existing** memory store — no new schema there. Storage footprint is computed by walking the cache dir.

### Boundaries

- The sink is the only thing that touches the MCP hot path.
- The reader has no knowledge of MCP or the TUI; it returns plain data shapes.
- The TUI knows the reader API but never opens SQLite directly.

This keeps the writer testable against a mock store, the reader testable against fixtures, and the TUI testable with `ink-testing-library`.

## Stats sink

### Path

`~/.cache/ai-cortex/v1/<repoKey>/stats/events.sqlite` — one DB per repo. The cross-project view is N parallel reads.

`repoKey` is obtained via the new sink contract described in **Sink routing** below — it is **not** the existing `withRepoIdentity` wrapper, which most handlers don't go through.

### Sink routing

The current `logged()` helper (`src/mcp/server.ts:87`) only receives `tool`, `extractMeta(params)`, and `handler(params)`. It cannot see the result and cannot reliably attribute a call to a repo (most handlers, e.g. `suggest_files` at `src/mcp/server.ts:358` and `index_project` at `src/mcp/server.ts:487`, resolve identity inside the handler).

`logged()` is extended to a six-argument form:

```ts
logged<P, R>(
  tool: string,
  extractMeta:          (p: P) => Record<string, unknown>,         // stderr only
  extractStatsParams:   (p: P) => StatsParamFields | null,         // sink only
  resolveRepoKey:       (p: P) => string | null,                   // sink only
  extractResult:        (r: R) => StatsResultFields | null,        // sink only
  handler:              (p: P) => Promise<R>,
): (p: P) => Promise<R>

type StatsParamFields  = { query_len?: number };                   // length only — never the text
type StatsResultFields = { cache_status?: 'fresh'|'reindexed'|'stale';
                           mode?: 'fast'|'deep'|'semantic';
                           result_count?: number };
```

- `extractMeta(params)` is **stderr-only**. It keeps its current behavior of returning short-form params (`task`, `query`, `path`, `id`, `title` — see `src/mcp/server.ts:357,585,786`) for the human-readable `logCall` line. The sink **never** reads from it.
- `extractStatsParams(params)` is **sink-only** and returns a strictly typed shape. The sink writes only known length/count fields from it. Any call site that wants to emit `query_len` (e.g. `recall_memory`, `suggest_files`) computes it here as `p.query?.length` / `p.task?.length`. Anything not in the typed shape is a type error.
- `resolveRepoKey(params)` runs **before** the handler. Typically `resolveRepoIdentity(params.path ?? process.cwd()).repoKey`, or `sha16(gitCommonDirOf(params.worktreePath))` for memory tools. Tools with no notion of a repo return `null`. If the resolver throws (invalid path), the row is **dropped from stats** (still logged to stderr via the existing `logCall`); the original handler error semantics are unchanged.
- `extractResult(result)` runs on success and may populate `cache_status`, `mode`, `result_count`. On error it is not called; those columns stay `NULL`.
- `null` from `resolveRepoKey` drops the row from stats — there is no `_global` bucket in v1. Add one only if a real tool needs it (YAGNI).

A dedicated unit test asserts the sink does not import or call `extractMeta`. Type-level: `StatsParamFields` is a closed object type with optional numeric fields only; adding string fields requires a type change + a sanitizer pass.

This keeps the routing contract explicit at every tool registration site rather than implicit and inconsistent.

### Schema (v1)

```sql
PRAGMA user_version = 1;
PRAGMA journal_mode = WAL;

CREATE TABLE tool_calls (
  ts            INTEGER NOT NULL,   -- unix ms
  tool          TEXT    NOT NULL,   -- e.g. 'suggest_files', 'recall_memory'
  dur_ms        INTEGER NOT NULL,
  status        TEXT    NOT NULL,   -- 'ok' | 'error'
  err_class     TEXT,               -- error constructor name only (e.g. 'WorktreePathError'), never the message
  err_code      TEXT,               -- short fixed-vocabulary code if the error type carries one, else null
  cache_status  TEXT,               -- 'fresh' | 'reindexed' | 'stale' | null
  mode          TEXT,               -- 'fast' | 'deep' | 'semantic' | null
  result_count  INTEGER,            -- files/memories returned, nullable
  query_len     INTEGER,            -- length of query string, never the text
  meta          TEXT                -- JSON escape hatch for future fields; must be sanitizer-checked
);

CREATE INDEX idx_tc_ts      ON tool_calls(ts);
CREATE INDEX idx_tc_tool_ts ON tool_calls(tool, ts);
```

### Write path

- WAL mode (matches `memory/index.sqlite`).
- One cached prepared `INSERT` statement, no transaction wrapping.
- On success: `logged()` invokes `extractResult(result)` after the handler resolves; the returned `cache_status` / `mode` / `result_count` fields are passed through to the sink. `extractResult` is **not** called on the error path; those columns stay `NULL`.
- Sink errors logged to stderr and swallowed. The MCP response is unaffected.
- On open: `DELETE FROM tool_calls WHERE ts < (now - 90d)`. WAL auto-checkpoints; no explicit vacuum.

### Migration

`user_version` pragma + the same lazy-migrate idiom used in `src/lib/memory/index.ts`. Future fields go through `meta` JSON until a v2 migration adds explicit columns.

## Stats reader

`src/lib/stats/query.ts` exposes:

- `aggregate(window)` — total calls, p50/p95, error rate, cache-status mix.
- `topTools(window, limit)` — `[ {tool, n, errs} ]`.
- `latencyPerTool(window)` — `{ [tool]: { p50, p95, samples } }`.
- `memoryHealth(repoKey)` — counts by status, recall→get rate, top-accessed by `get_count`, pending-review depth.
- `storageFootprint()` — bytes per repo cache dir (cached for 10s).

### Percentiles

SQLite has no native percentile. The reader pulls `dur_ms` sorted for each tool inside the window and computes p50/p95 in JS. The set is bounded by the window's row count (~thousands max) — acceptable.

### Recall→get ratio

Defined as `count(get_memory calls) / sum(result_count of recall_memory calls)` within the window. Approximate but useful as a trend signal.

## TUI app

### Stack

Ink + `ink-spinner`. Custom `<Sparkline>` (~30 LOC, unicode-block bars) and `<TopList>` (column-aligned text table) to avoid pulling `ink-table`.

### Screens

**Overview** (layout A from brainstorm):

```
┌─ ai-cortex stats — overview · last 7d ─────────────────────────────────┐
│ Projects (5)         │  Aggregate (all projects, 7d)                   │
│ ▸ ai-cortex   1.2k   │  ┌─ Tool calls ───┐ ┌─ Memory ───────────────┐  │
│   ai-whisper  842    │  │ 2,481 ↑12%     │ │ 247 active, 62 pending │  │
│   ai-pref      96    │  │ p50 42  p95 210│ │ recall→get 73%         │  │
│   foo-bar      12    │  │ err 0.4%       │ │ deprecated/wk 4        │  │
│   demo-app     3     │  └────────────────┘ └────────────────────────┘  │
│ filter: [7d ▾]       │  ┌─ Suggest mix ──┐ ┌─ Storage ──────────────┐  │
│ /  search            │  │ fast 62%       │ │ ai-cortex   18 MB      │  │
│                      │  │ deep 28%       │ │ ai-whisper  11 MB      │  │
│                      │  │ sem  10%       │ │ total: 38 MB           │  │
│                      │  └────────────────┘ └────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
 [q]uit  [r]efresh  [/]search  [Enter] drill in  [Tab] cycle widget
```

**Project detail** (reached via Enter; Esc returns):

- Tabs: Tools · Memory · Suggest · Storage.
- Tools tab: per-tool p50/p95 with sparkline, volume table, error log, cache-status mix.
- Memory tab: counts, recall→get rate, top-accessed memories, audit churn (7d), pending-review summary.
- Suggest tab: fast/deep/semantic split, empty-result rate (`result_count = 0` ratio), p50/p95 per mode. **Does not show top suggested files** — file paths are user/repo content (e.g. branch-named directories, secret-bearing filenames) and the schema does not persist them. Re-adding this widget would require an explicit privacy-allowed file-path table with its own sanitizer.
- Storage tab: cache size, last reindex, sqlite + vector index growth, fingerprint state.

### Components

- `<App>` — root, owns window / project / screen state and the polling effect.
- `<Overview>` → `<ProjectList>` + `<AggregatePanels>` (four widgets).
- `<ProjectDetail>` → `<DetailTabs>` + per-tab content.
- `<Sparkline>`, `<TopList>` — small custom primitives.
- `<KeyBar>` — footer hint strip.
- `<WindowPicker>` — modal popover for `[w]`.

### Keybindings

| Key | Effect |
|---|---|
| `q` | quit |
| `r` | force refresh now |
| `/` | filter projects |
| `Enter` | drill into selected project |
| `Esc` | back to overview |
| `Tab` / `1`–`4` | cycle/select detail tabs |
| `j` / `k` | move selection in lists |
| `w` | cycle window (1h / 24h / 7d / 30d) |

### State + polling

- 1500ms `useEffect` interval.
- `readInFlight` ref skips a tick if the previous read hasn't returned (backpressure).
- `r` and `w` trigger an immediate tick.
- Reader errors go to a footer status line ("last error: …, 3s ago"); the loop keeps running.

### Empty + degraded states

- No calls in window → "No calls in this window yet — start using ai-cortex to see data."
- Per-tab: "No <category> data yet."
- Missing repo mid-session → drop from list silently, log to footer.
- Terminal smaller than 80×24 → friendly min-size guard.

## CLI surface

Add `ai-cortex stats` to `src/cli.ts`. Boots the Ink app, no positional args. Flags:

- `--window <1h|24h|7d|30d>` (default 7d)
- `--project <repoKey>` (skip overview, jump straight to drill-down)
- `--once` (snapshot mode — render once and exit; useful for piping/screenshots)

## Privacy + retention

- No query text or memory body persisted. Only lengths, counts, IDs.
- **Error attribution is class-only.** Errors from existing handlers can embed user-controlled content in their messages (e.g. `WorktreePathError` includes the path at `src/lib/repo-identity.ts:35`; `RepoIdentityError` includes the input at `src/lib/repo-identity.ts:64`; `getMemory` echoes the requested id at `src/lib/memory/retrieve.ts:28`). The sink therefore stores only `err.constructor.name` in `err_class`, plus an optional short `err_code` for known error types. `err.message` is **never** persisted. A dedicated unit test asserts the sink rejects any column value containing characters outside a small safe set for `err_class` / `err_code` (alphanumeric + `_`/`-`).
- `meta` is reserved for future structured fields. Any code writing to `meta` must pass a sanitizer that rejects free-form strings; this is enforced by a dedicated unit test.
- 90d retention with prune on each sink open.
- All state remains under `~/.cache/ai-cortex/v1/`. Nothing written into target repos.

## Testing strategy

TDD per project preference. Layered coverage:

| Layer | Coverage | Mechanism |
|---|---|---|
| Sink writer | schema migrate, insert, 90d prune, error swallow | unit, tmpdir SQLite |
| Err/meta sanitizer | rejects free-form strings; `err_class`/`err_code` constrained to safe charset | unit |
| `logged()` wrapper | sink throw does not affect MCP response; `extractResult` invoked on success only; `resolveRepoKey` null drops the row from stats but preserves original handler error; sink never invokes `extractMeta` | unit, mock sink + mock resolver |
| Stats-param isolation | `StatsParamFields` is the only param source the sink reads; raw `task`/`query`/`path`/`id`/`title` from `extractMeta` never appear in `events.sqlite` | unit, schema + writer mock |
| Reader queries | aggregate, percentiles, top tools, recall→get, top-accessed | unit, fixture SQLite |
| Cross-project walk | missing repos, mid-session drop | unit, tmp cache root |
| Storage cache | 10s TTL, recompute after expiry | unit, fake clock |
| Ink components | `<Overview>`, `<ProjectDetail>`, each tab, empty state, error footer | `ink-testing-library` |
| Keyboard nav | j/k, Enter, Esc, 1–4, Tab, r, w, q | `ink-testing-library` stdin |
| Min terminal size | <80×24 shows guard | unit |
| E2E smoke | `ai-cortex stats`, auto-quit after 1s | spawn integration |

## Rollout

- Version bump: minor (`v0.6.0`).
- New deps: `ink`, `ink-spinner`.
- Sink ships unflagged. Cost is one tiny insert per MCP call.
- Migration: sink lazily creates `stats/events.sqlite` on first MCP call per repo. Existing repos start collecting from then on.
- Docs: README "Inspecting performance" section, CHANGELOG entry, privacy/storage paragraph updated with the new file path.

## Risks + mitigations

- **WAL contention under heavy parallel MCP traffic** — single cached prepared insert, fire-and-forget; WAL handles concurrent readers/writer.
- **Stats DB growth** — 90d prune on open + WAL auto-checkpoint.
- **Long-running TUI holding SQLite handles** — handles cached for the session, closed on `q`.
- **Ink rendering on tiny terminals** — min-size guard with friendly message.
- **Sink hot-path overhead** — measured in unit benchmark; expected sub-ms per call. If it ever isn't, batch via a small in-process queue flushed on a timer.

## Open questions

None at design freeze. Window defaults, retention horizon, and TUI stack are all decided.

## File map

```
src/
  cli.ts                       (+ 'stats' subcommand wiring)
  lib/
    stats/
      sink.ts                  (writer + schema + prune)
      query.ts                 (reader: aggregate, percentiles, memoryHealth, storageFootprint)
      types.ts                 (shared shapes)
  mcp/
    server.ts                  (logged() calls sink after handler resolves)
  tui/
    index.tsx                  (boot Ink app, parses --window/--project/--once)
    App.tsx                    (state + polling)
    overview/
      Overview.tsx
      ProjectList.tsx
      AggregatePanels.tsx
    detail/
      ProjectDetail.tsx
      ToolsTab.tsx
      MemoryTab.tsx
      SuggestTab.tsx
      StorageTab.tsx
    components/
      Sparkline.tsx
      TopList.tsx
      KeyBar.tsx
      WindowPicker.tsx
tests/
  unit/lib/stats/sink.test.ts
  unit/lib/stats/query.test.ts
  unit/tui/...                 (ink-testing-library specs per component)
  integration/stats-cli.test.ts
```
