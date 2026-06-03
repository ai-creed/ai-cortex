# Cortex structural store: SQLite migration (Stage 1, foundation)

Date: 2026-06-03
Status: Approved (design); ready for implementation plan
Scope: Stage 1 of a two-stage migration. This spec covers ONLY the storage
foundation. Stage 2 (consumer query push-down) is a separate spec.

## Problem

The on-disk structural cache is one pretty-printed JSON file per worktree
(`<repoKey>/<worktreeKey>.json`). `readCacheForWorktree`
(src/lib/cache-store.ts:123) reads the whole file and `JSON.parse`s it on
EVERY tool call; `resolveCacheWithFreshness` (src/lib/cache-coordinator.ts:21)
re-reads fresh each call with no memoization. On a heavy monorepo worktree the
file measures ~30MB (7089 files / 31194 functions / 140614 calls), so each
suggest/blast/rehydrate call pays a ~30MB string read plus a monolithic parse,
and machine-wide RAM scales with the number of concurrently active worktrees.
One-shot whole-graph load is the architectural ceiling.

Recorded analysis: memory `mem-2026-05-30-structural-cache-is-loaded-whole-into-75693b`.

## Goal and non-goals

Goal (Stage 1): replace the JSON structural store with a per-worktree SQLite
database as the canonical on-disk format, behind an unchanged read/write
surface, with a clean one-time migration of existing JSON caches. This removes
the 30MB string read and the monolithic `JSON.parse` per call and lays the
schema/indexes that Stage 2 will query directly.

Honest scope of the Stage 1 win: the read shim still assembles a whole
`RepoCache` object from rows, so Stage 1 buys latency / CPU / GC (no giant
string, no monolithic parse) and ENABLES Stage 2. The memory-ceiling removal
(no whole-graph materialization) lands in Stage 2 via SQL-native queries.

Non-goals (deferred):
- Stage 2: rewriting `queryBlastRadius` to a recursive CTE and the suggest /
  rehydrate consumers to indexed row reads. Separate spec.
- Row-level incremental writes (DELETE+INSERT only changed files). Stage 1 ships
  bulk-replace; the write path leaves a seam (`applyFileDelta`) so this drops in
  later without a schema reshape.
- Any change to the freshness algorithm, the indexer, or the dashboard data path.

## Decisions (locked during brainstorming)

1. Full SQL-native target: SQLite is the canonical structural store; Stage 2
   consumers will query it directly. (This spec is Stage 1 only.)
2. Two stages, each independently shippable and testable. This is Stage 1.
3. One DB per worktree: `<repoKey>/<worktreeKey>.db` replaces
   `<worktreeKey>.json`. Rationale: isolation, no write-lock contention when
   ~4 worktrees index in parallel, `rm`-simple GC. Verified dashboard-safe (see
   below).
4. Write path = bulk-replace, indexer untouched (Approach A), with an
   `applyFileDelta` seam for later incremental writes (Approach C).
5. Existing JSON caches migrate via in-place transcode (no forced reindex) with
   a reindex fallback.

### Dashboard-safety verification (why per-worktree DBs cost the dashboard nothing)

The dashboard (src/tui/readAll.ts) never opens the structural store:
- `projects[].calls` is `aggregate(rk).total` from the stats DB
  (tool-call count, not call-graph edges) - src/tui/readAll.ts:52.
- `name` / `fileCount` / `indexedAt` come from the `.meta.json` sidecar via
  `cacheMeta()` - src/lib/stats/query.ts:380.
- `storageFootprint()` is `dirSize()` over the cache dir - src/lib/stats/query.ts:271,
  format-agnostic (counts `.db` the same as `.json`).

The sidecar keeps being written on every `writeCache`, so per-worktree DBs add
zero dashboard work. If a per-project function/call count is ever wanted on the
dashboard, it is added to the sidecar (one tiny write), not a fan-out over DBs.

## Section 1: schema

Per-worktree DB at `<repoKey>/<worktreeKey>.db`, WAL mode, `PRAGMA user_version`
for the store format version (start at 1), mirroring the stats sink
(src/lib/stats/sink.ts). Booleans are stored as INTEGER `0/1`.

```sql
PRAGMA journal_mode = WAL;

-- Scalar cache fields as key/value (read all-at-once, tiny):
--   schemaVersion, repoKey, worktreeKey, worktreePath, indexedAt,
--   fingerprint, dirtyAtIndex, packageMeta (JSON), entryFiles (JSON array)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,        -- 'file' | 'dir'
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS docs (
  path  TEXT PRIMARY KEY,
  title TEXT,
  body  TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_path);

CREATE TABLE IF NOT EXISTS functions (
  qualified_name      TEXT NOT NULL,
  file                TEXT NOT NULL,
  exported            INTEGER,
  is_default_export   INTEGER,
  line                INTEGER,
  is_declaration_only INTEGER,
  -- v3.1 forward-compat (nullable; populated only when present):
  col                 INTEGER,
  end_line            INTEGER,
  end_col             INTEGER,
  id                  TEXT
);
-- Overloads allowed (queryBlastRadius handles matchingFns.length > 1), so NOT unique:
CREATE INDEX IF NOT EXISTS idx_fn_file_name ON functions(file, qualified_name);

CREATE TABLE IF NOT EXISTS calls (
  from_key      TEXT NOT NULL,
  to_key        TEXT NOT NULL,
  kind          TEXT NOT NULL,        -- 'call' | 'new' | 'method'
  -- v3.1 forward-compat site Range (nullable):
  site_line     INTEGER,
  site_col      INTEGER,
  site_end_line INTEGER,
  site_end_col  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_to   ON calls(to_key);   -- Stage 2 reverse adjacency
CREATE INDEX IF NOT EXISTS idx_calls_from ON calls(from_key);
```

Design notes:
- `idx_calls_to` and `idx_fn_file_name` exist now so Stage 2's reverse-adjacency
  CTE and function lookup are drop-in.
- The nullable `col / end_line / end_col / id` (functions) and `site_*` (calls)
  columns make the schema forward-compatible with the unmerged v3.1 callsite /
  function-range branch: whichever of {this migration, v3.1} lands second needs
  no format bump, it just starts populating those columns. The transcode and
  read paths carry these fields through when present and leave them null when
  absent.
- `meta` kv is chosen over typed columns for `packageMeta` / `entryFiles`
  because they are tiny and always read together; JSON-encoding them keeps the
  schema flat.

## Section 2: write path (bulk-replace + seam)

`writeCache(cache)` (src/lib/cache-store.ts:87) becomes:
1. Open/create `<worktreeKey>.db`; `CREATE TABLE IF NOT EXISTS ...`; set
   `user_version`.
2. One transaction: `DELETE FROM` each table, then batch `INSERT` via prepared
   statements, then upsert the `meta` kv rows. This is bulk-replace: the indexer
   is untouched and still hands us a whole `RepoCache`.
3. `wal_checkpoint(TRUNCATE)` and strip `-wal` / `-shm` on close so the `.db` is
   a single self-contained file for `dirSize` and `rm`-GC. Reuse
   `checkpointAndVerify` from src/lib/cache-store-migrate.ts.
4. Keep writing the `.meta.json` sidecar via `deriveCacheMeta` (unchanged), so
   the dashboard never touches the DB.

The bulk-replace lives behind an internal `replaceAll(db, cache)`. A later
incremental spec adds `applyFileDelta(db, changedPaths, rows)` alongside it (the
seam); no schema reshape is required to adopt it.

## Section 3: read shim (signature unchanged)

`readCacheForWorktree(repoKey, worktreeKey): Promise<RepoCache | null>` keeps its
exact signature, so consumers (`queryBlastRadius`, the three suggest rankers,
`rehydrate`, `briefing`) are untouched in Stage 1. New body:
1. `.db` exists: open readonly; check `user_version` + `meta.schemaVersion`; on
   major mismatch close and return `null` (reindex). Else `SELECT *` per table,
   reassemble the `RepoCache` (INTEGER `0/1` to bool, decode `packageMeta` /
   `entryFiles` JSON, attach `site` / range only when columns are non-null),
   return it. Opportunistically delete any leftover `.json`.
2. No `.db` but `.json` exists: the migration path (Section 4).
3. Neither: return `null` (normal first-index reindex).

## Section 4: versioning, freshness, and JSON migration

Versioning:
- DB `PRAGMA user_version` = store format version (start at 1).
- `meta.schemaVersion` = the indexer content version (the existing
  `SCHEMA_VERSION`). Either mismatching is a cache miss. Major-version
  comparison for the content version (consistent with cache invalidation).

Migration of existing JSON caches (one-time, per worktree, on first read; no
forced reindex):
- `.json` present and `majorOf(json.schemaVersion)` compatible: transcode. Parse
  the JSON once, build a `<worktreeKey>.db.tmp`, write all rows in a single
  transaction, `wal_checkpoint(TRUNCATE)` and strip `-wal` / `-shm`
  (`checkpointAndVerify`), atomic rename `.tmp` to `.db`, then delete the
  `.json`. Return the assembled cache. No source re-parse; freshness state
  (`fingerprint`, `dirtyAtIndex`) is preserved exactly, so the next
  `resolveCacheWithFreshness` still sees "fresh" with no spurious reindex.
- `.json` present but incompatible / old schema: delete it, return `null` so the
  coordinator reindexes.
- Parse / transcode error (corrupt JSON): discard the JSON and any `.tmp`, return
  `null` so the coordinator reindexes. Derived data, so never quarantined.

Concurrency / idempotency: build-in-tmp plus atomic rename means a reader only
ever sees a complete `.db`. Two processes transcoding the same JSON produce
identical content, so last-writer-wins is safe; JSON deletion is idempotent.
This covers parallel worktrees and two clients on one worktree.

`resolveCacheWithFreshness` is unchanged: it still does the git fingerprint plus
dirty check and, when stale, `buildIncrementalIndex` then `writeCache` (now
bulk-replace into the DB).

## Section 5: GC / hygiene

Per-worktree GC (the dashboard clean-confirm) removes `<worktreeKey>.db` plus
`-wal` / `-shm` plus `.meta.json` instead of `.json`. `storageFootprint()`
(`dirSize`) is format-agnostic, so the dashboard MB stays accurate with no
change. The sidecar is still written on every `writeCache`.

## Section 6: testing

Unit:
- Schema create plus `user_version`.
- `writeCache` then `readCacheForWorktree` round-trip parity: the reassembled
  `RepoCache` deep-equals the input.
- Bulk-replace idempotency: rewriting yields no duplicate rows.
- Meta kv encode / decode: `packageMeta`, `entryFiles`, `dirtyAtIndex`, `0/1`
  booleans.
- Version mismatch yields `null`.

Migration (explicit):
- Valid `.json` transcodes to `.db`, JSON deleted, parity (assembled cache equals
  the JSON's content).
- Freshness preserved after transcode (no reindex triggered).
- Incompatible `.json` triggers reindex.
- Corrupt `.json` triggers reindex.
- Concurrent transcode yields a single valid `.db`, no corruption.

Integration:
- Index a fixture repo: `.db` exists and is queryable.
- The assembled cache feeds `queryBlastRadius` and `rankSuggestions` identically
  to the JSON era (golden parity).
- Coordinator fresh / reindexed / stale paths unchanged.

## Files in scope (Stage 1)

- src/lib/cache-store.ts: `writeCache`, `readCacheForWorktree`, new internal
  `replaceAll` / schema / transcode helpers (likely a new `cache-store-sqlite.ts`
  module to keep `cache-store.ts` focused).
- src/lib/cache-store-migrate.ts: reuse `checkpointAndVerify` / WAL helpers.
- Tests: unit + migration + integration per Section 6.

Out of scope (no changes in Stage 1): the indexer, the coordinator algorithm,
all consumers, the dashboard data path.

## Risks and mitigations

- First-call latency on upgrade: mitigated by transcode (no reindex) for
  compatible JSON.
- Half-written DB visible to a concurrent reader: mitigated by build-in-tmp plus
  atomic rename.
- WAL sidecars inflating `dirSize` / breaking single-file GC: mitigated by
  `wal_checkpoint(TRUNCATE)` and sidecar strip on close.
- Schema churn when v3.1 lands: mitigated by nullable forward-compat columns.
