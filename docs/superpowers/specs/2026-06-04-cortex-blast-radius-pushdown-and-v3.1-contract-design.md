# Cortex Stage 2: blast_radius SQL push-down + v3.1 callsite/range contract

Date: 2026-06-04
Status: Approved (design); ready for implementation plan
Scope: Stage 2 of the SQLite migration. One spec, two coherent parts:
  Part A folds in the parked v3.1 callsite/function-range contract;
  Part B pushes `blast_radius` into a recursive SQL CTE and surfaces the
  v3.1 location data in results.
Predecessor: docs/superpowers/specs/2026-06-03-cortex-sqlite-structural-store-design.md (Stage 1, shipped on feat/cortex-sqlite-structural-store).

## Problem and goal

Stage 1 made a per-worktree SQLite database the canonical structural store, but
the read shim still assembles a whole `RepoCache` per call, so the memory ceiling
(materializing the entire graph) is unchanged. `blast_radius` is the one consumer
that does a graph TRAVERSAL: `queryBlastRadius` (src/lib/blast-radius.ts:18) builds
a reverse-adjacency map over ALL `calls` and BFSs from the target, yet only the
reachable subgraph matters. On a heavy monorepo the `calls` array is ~140K edges;
loading it into JS per query is the cost Stage 2 removes.

Two findings shaped the scope:
1. Only `blast_radius` benefits from SQL push-down. `rankSuggestions`
   (src/lib/suggest-ranker.ts:103) scores EVERY file (inherently a full scan) and
   `rehydrate`/`briefing` (src/lib/rehydrate.ts, src/lib/briefing.ts) render a
   broad summary over most of the graph. Pushing those into SQL is a large rewrite
   for little memory win, so they stay on the whole-load path.
2. The parked v3.1 work (branch feat/cortex-callsite-func-range) adds
   `CallEdge.site` and `FunctionNode` ranges to the index contract. Stage 1's
   SQLite schema was deliberately built with the matching nullable columns
   (`calls.site_*`, `functions.col/end_line/end_col/id`) and the
   `replaceAll`/`assembleCache` plumbing + `majorOf` invalidation already handle
   them. So v3.1 folds onto the SQLite foundation almost for free, and the
   call-site data is exactly what makes a traversal result navigable.

Goal: remove blast_radius's whole-graph materialization via a recursive CTE, and
in the same change land the v3.1 contract so blast results carry call-site and
function-range locations.

Non-goals (deferred):
- Pushing `suggest` or `rehydrate`/`briefing` into SQL (whole-load is correct for
  full-scan/broad-render consumers; the query layer is available to them later).
- Row-level incremental writes (still the Stage 1 `applyFileDelta` seam).
- Emitting `FunctionNode.id` (reserved; writers MUST NOT emit at v3.x).

## Decisions (locked during brainstorming)

1. One Stage 2 spec, two parts (A = v3.1 contract emission; B = blast_radius CTE
   + location enrichment). B's value depends on A's data; the Stage 1 schema
   already bridges them.
2. Lean freshness handle: extract `ensureFreshDb(identity, opts) -> { dbPath,
   cacheStatus, rebuiltCache? }`; `resolveCacheWithFreshness` becomes a thin
   wrapper so whole-load consumers are behaviorally unchanged. No-materialization
   is scoped to the fresh/`options.stale` paths; the stale incremental rebuild
   materializes transiently (it needs the prior graph) and returns `rebuiltCache`.
3. blast_radius bypasses `rehydrateRepo`; opens the `.db` readonly per-call, runs
   the CTE, closes. No memoization of the parsed graph (the Stage 1 memory trap).
4. Enrich `BlastHit`/`BlastRadiusResult.target` with optional location fields
   (additive, non-breaking).

## Part A: v3.1 contract emission

### Section A1: model + version

`src/lib/models.ts`:
- Add `Position = { line: number; column: number }` (both 1-indexed).
- Add `Range = Position & { endLine: number; endColumn: number }` (1-indexed,
  inclusive).
- `CallEdge` gains `site?: Range` (callsite location in `from`'s file).
- `FunctionNode` gains `column?`, `endLine?`, `endColumn?` (1-indexed inclusive)
  and `id?` (RESERVED for a future rename-stable symbol ID; writers MUST NOT emit
  at v3.1; readers MUST tolerate present or absent).
- `SCHEMA_VERSION` "3" -> "3.1".

### Section A2: emission

- New `src/lib/adapters/_range.ts` with `rangeFromNode(node): Range` converting
  tree-sitter coordinates (0-indexed row/column, `endPosition.column` exclusive)
  to cortex 1-indexed inclusive: `line=row+1`, `column=column+1`,
  `endLine=endRow+1`, `endColumn=endColumn` (exclusive 0-indexed end maps to
  inclusive 1-indexed). Reuse the implementation from the v3.1 branch.
- `adapters/{typescript,python,cfamily}.ts` spread `...rangeFromNode(node)` onto
  emitted functions, and set `site: rangeFromNode(node)` on raw call sites.
- `src/lib/lang-adapter.ts`: `RawCallSite` gains `site?: Range` (internal type,
  never serialized).
- `src/lib/call-graph.ts`: `makeEdge(from, to, raw)` threads `raw.site` onto
  `CallEdge.site` at all call-edge push sites; `site` is set only when present.

### Section A3: persistence (no schema change)

The Stage 1 SQLite schema already has `calls.site_line/site_col/site_end_line/
site_end_col` and `functions.col/end_line/end_col/id`, and `replaceAll`/
`assembleCache` (src/lib/cache-store-sqlite.ts) already write and reconstruct
them via the widened casts. No schema or store-code change is required; the
columns simply stop being NULL once adapters emit. Add a store round-trip test
that populates `site`/ranges (Stage 1 fixtures left them null).

`id` stays NULL: writers never emit it; the column exists for forward-compat.

### Section A4: invalidation (no change)

`readFromDb` (src/lib/cache-store-sqlite.ts) already gates on
`majorOf(schemaVersion)`, so a `schemaVersion:"3"` `.db` from Stage 1 is still
accepted by v3.1 code (additive-minor compatibility) rather than nuked. The
SQLite store also dissolves v3.1's measured +60% JSON size objection: `site` is
four INTEGER columns per row, not pretty-printed JSON.

### Section A5: contract doc

Reconcile `docs/architecture/cortex-index-contract.md` (the ecosystem contract)
onto this branch from the v3.1 branch, describing `site`/`Range` and the reserved
`id`.

## Part B: blast_radius SQL push-down

### Section B1: lean freshness handle

This requires factoring the validity/migration logic out of
`readCacheForWorktree` (src/lib/cache-store.ts) so both the whole-load and the
handle paths share it WITHOUT materializing:

```
ensureValidDb(repoKey, worktreeKey) -> string | null
```
- Performs exactly what `readCacheForWorktree` does today MINUS the final
  `assembleCache`: if a `.db` exists, version-gate it (`user_version` +
  `majorOf(schemaVersion)`), discarding on mismatch; else if a legacy `.json`
  exists, run the transcode-or-reindex-fallback migration; returns the valid
  `dbPath` or `null` (cache miss). `readCacheForWorktree` is then
  `ensureValidDb` + `readFromDb(dbPath)` so its behavior is unchanged.

```
ensureFreshDb(identity, { stale }) -> { dbPath: string; cacheStatus: "fresh" | "reindexed" | "stale"; rebuiltCache?: RepoCache }
```

The no-materialization guarantee is scoped to the FRESH path (the hot path Stage 2
targets), because the stale INCREMENTAL rebuild genuinely needs the prior graph:
`diffChangedFiles(identity, cached)` reads `cached.files`
(src/lib/diff-files.ts:36) and `buildIncrementalIndex(identity, cached, ...)`
reads `existingCache.files/imports/docs/calls/functions/packageMeta`
(src/lib/indexer.ts:120-177). That input is unavoidable, so the contract is:

- Freshness DECISION is meta-only (no materialization): read `fingerprint` and
  `dirtyAtIndex` from the db `meta` table (a tiny SELECT; `dirtyAtIndex` absent ->
  undefined, matching the optional), then compute `fingerprintStale` /
  `dirty` / `dirtyReverted` exactly as the coordinator does today.
- `ensureValidDb` returned `null` (cache miss) -> full `indexRepo` (writes the
  `.db`) -> `{ dbPath, "reindexed", rebuiltCache }`.
- FRESH (`!isStale`) -> `{ dbPath, "fresh" }` with NO materialization. This is the
  path blast_radius hits in the common case and where the whole-graph load is
  eliminated.
- `options.stale` AND stale -> `{ dbPath, "stale" }` with NO materialization
  (blast reads the existing, valid-but-outdated `.db`).
- stale AND not `options.stale` -> materialize the cached `RepoCache`
  (`readFromDb(dbPath)`) ONLY here, run the existing `diffChangedFiles` +
  `buildIncrementalIndex` + `writeCache`, and return `{ dbPath, "reindexed",
  rebuiltCache: <the just-built cache> }`. This transient materialization is
  acceptable: it is the rare path that is already re-parsing changed files, and
  the materialized cache is not retained past the rebuild.
- `resolveCacheWithFreshness` becomes a thin wrapper that preserves its exact
  external contract: `const r = ensureFreshDb(...); return { cache: r.rebuiltCache
  ?? readFromDb(r.dbPath), cacheStatus: r.cacheStatus }`. Using `rebuiltCache` on
  rebuild paths avoids a double materialization (build -> write -> re-read), so
  whole-load consumers (`rehydrate`, `suggest`) are byte-for-byte unchanged,
  including on reindex.

blast_radius ignores `rebuiltCache` entirely and always runs its CTE against
`dbPath`; it therefore pays zero materialization on the fresh/stale paths and only
the normal (unavoidable, transient) reindex cost on a stale rebuild — identical to
what any consumer pays today when the cache is stale.

### Section B2: recursive CTE

New `queryBlastRadiusDb(dbPath, target, { maxHops }) -> BlastRadiusResult`. Opens
the `.db` readonly, runs the query, closes (no memoization). The CTE reproduces
`queryBlastRadius`'s exact semantics:

- `targetKey = target.file || '::' || target.qualifiedName`.
- Recursive reverse walk: from a visited callee key K, callers are
  `SELECT from_key, site_* FROM calls WHERE to_key = K`. The seed `targetKey` and
  every recursed `from_key` are resolved (`file::name`) keys, so an edge with an
  unresolved (`::`-prefixed) `to_key` can never match `to_key = K`; unresolved
  edges are thus excluded from the traversal naturally (mirroring the in-memory
  `edge.to.startsWith("::")` guard) with no extra predicate needed.
- Recurse with `depth + 1 <= maxHops`. CYCLE SAFETY: the call graph can contain
  cycles; `maxHops` bounds recursion depth so the CTE always terminates, and the
  final result takes `MIN(depth)` per caller (group by caller key) so a node
  reached by multiple paths lands in its nearest tier, matching the BFS
  `visited`-set semantics. (No SQLite `cycle` clause is required.)
- Unresolved edges are counted separately for confidence (NOT traversed). Mirror
  the in-memory metric exactly: let `m` = the substring of `qualifiedName` after
  its last `.` (only when `qualifiedName` contains a `.`; otherwise no method
  clause). `unresolvedEdges = COUNT(calls WHERE to_key = '::'||qualifiedName` plus,
  when `m` exists, `OR to_key = '::'||m)`.
- Join `functions` on `(file, qualified_name)` for `exported`, the overload count
  (`COUNT(*) > 1` of matching functions -> `overloadCount`), and the range fields.
- `confidence = unresolvedEdges === 0 ? "full" : "partial"`.
- Build `tiers` by hop with the existing deterministic sort (`file`, then
  `qualifiedName`); `totalAffected = sum of tier hit counts`.

The MCP handler (src/mcp/server.ts blast_radius) swaps `rehydrateRepo` for
`ensureFreshDb` + `queryBlastRadiusDb`, passing `cacheStatus` through for stats
logging. The 140K-edge array never enters JS; only reachable rows are read.

### Section B3: BlastHit location enrichment

Additive optional fields on `models.ts` types (non-breaking):
- `BlastRadiusResult.target` gains `range?: Range` (the target function's range).
- `BlastHit` gains `range?: Range` (the caller function's range) and
  `callSite?: Range` (the `site` of the edge by which this caller reaches the next
  callee toward the target; carried through the CTE alongside `from_key`).
- Determinism: when a caller reaches its callee via more than one edge (multiple
  call sites), `callSite` is the edge with the lexicographically smallest
  `(site_line, site_col)` among the edges at that caller's `MIN(depth)` hop. This
  keeps results reproducible and testable.
- Hits whose underlying edge has no `site` (pre-v3.1 `.db` not yet reindexed, or an
  adapter that captured none) omit `callSite`; readers tolerate absent per the
  contract. Likewise `range` is omitted when the joined function row has NULL range
  columns.

## Section C: testing

Part A:
- Adapter range/site emission unit tests (reuse the v3.1 branch's
  `tests/unit/lib/range.test.ts`, adapter tests, and call-graph site-threading).
- SQLite store round-trip with POPULATED `site`/ranges (extends the Stage 1
  cache-store-sqlite test, whose fixtures left them null).
- `SCHEMA_VERSION === "3.1"` assertions updated (indexer test et al.).
- Major-only invalidation: a `schemaVersion:"3"` `.db` is still read, not nuked.

Part B:
- Golden parity: `queryBlastRadiusDb` vs the existing in-memory `queryBlastRadius`
  on a shared fixture must produce identical `tiers`, `totalAffected`,
  `unresolvedEdges`, `confidence`, and `overloadCount`. This proves the CTE
  preserves semantics.
- `maxHops` bound; unresolved-edge counting (incl. the method-portion clause only
  firing for dotted names); overload (same name twice); readonly open leaves no
  `-wal`/`-shm` residue.
- Cycle safety: a fixture with a call cycle (A->B->A) terminates and yields the
  correct nearest-hop tiers (parity with the in-memory BFS).
- Enrichment: a fixture with known positions asserts `target.range`, each
  `BlastHit.range`, and `callSite` map to the right line/col; a caller with two
  call sites yields the deterministic smallest-`(line,col)` `callSite`; an
  absent-site edge omits `callSite`.

Integration:
- MCP blast path (`ensureFreshDb` + `queryBlastRadiusDb`) over a real fixture repo
  across `fresh` / `reindexed` / `stale`.
- Fresh-path no-materialization: on a `fresh` `.db`, `ensureFreshDb` returns
  without assembling a `RepoCache` (spy/assert `assembleCache` / `readFromDb` is
  NOT called on the fresh and `options.stale` paths), proving blast skips the
  whole-graph load in the common case.
- Stale-rebuild contract: on a stale (non-`options.stale`) refresh, `ensureFreshDb`
  returns `rebuiltCache`, and `resolveCacheWithFreshness` reuses it (assert no
  second `readFromDb` after the rebuild) so whole-load reindex behavior is
  unchanged.
- Regression guard for the Section B1 refactor: `resolveCacheWithFreshness`
  whole-load consumers (`rehydrate`, `suggest`) behave identically (status +
  returned cache) across fresh/reindexed/stale after the extraction.

## Files in scope

Part A:
- src/lib/models.ts (Position/Range, CallEdge.site, FunctionNode ranges + reserved
  id, SCHEMA_VERSION 3.1, plus BlastHit/BlastRadiusResult location fields used by B3).
- src/lib/adapters/_range.ts (new), adapters/{typescript,python,cfamily}.ts.
- src/lib/lang-adapter.ts, src/lib/call-graph.ts.
- docs/architecture/cortex-index-contract.md.
- Store round-trip test addition.

Part B:
- src/lib/cache-store.ts (factor `ensureValidDb` out of `readCacheForWorktree`;
  the latter becomes `ensureValidDb` + `readFromDb`).
- src/lib/cache-coordinator.ts (add `ensureFreshDb` using `ensureValidDb`; rewrap
  `resolveCacheWithFreshness` as `ensureFreshDb` + `readFromDb`).
- src/lib/blast-radius.ts (`queryBlastRadiusDb` + enriched result assembly).
- src/mcp/server.ts (blast_radius handler swap).

Out of scope (no change): suggest rankers, rehydrate/briefing, the indexer's
incremental path, row-level writes (`applyFileDelta` seam stays deferred).

## Risks and mitigations

- CTE semantic drift from the in-memory BFS: mitigated by the golden-parity test
  (identical result objects on a shared fixture) as the acceptance gate.
- Freshness extraction changing whole-load behavior: mitigated by the
  `resolveCacheWithFreshness` regression test and keeping it a thin wrapper.
- Reading freshness scalars (fingerprint/dirtyAtIndex) without a full load:
  mitigated by a tiny `meta`-table SELECT rather than `assembleCache`.
- Stale-refresh needs the prior graph: the incremental rebuild
  (`diffChangedFiles` + `buildIncrementalIndex`) requires the full cached
  `RepoCache`, so the no-materialization guarantee is intentionally scoped to the
  fresh/`options.stale` paths; the stale rebuild materializes transiently (the
  rare, already-expensive path) and returns `rebuiltCache` so the whole-load
  wrapper does not double-read.
- Merge friction with the parked v3.1 branch: the v3.1 `cache-store.ts` change is
  superseded by Stage 1's SQLite rewrite (already does `majorOf`), so it is
  dropped, not carried; only emission + the version bump + the contract doc come
  over.
- Pre-v3.1 `.db` lacking `site`: results omit `callSite` gracefully; a reindex
  populates it.
