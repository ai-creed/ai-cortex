# Phase 4 — Hardening: Speed and Incremental Refresh

**Date:** 2026-04-11
**Status:** approved
**Phase:** 4 of 5

---

## Goal

Make indexing and rehydration fast on medium repos (500-2k files) by adding
incremental refresh. Instead of full reindex on every staleness signal, detect
which files changed and reprocess only those.

Phase 4 delivers performance infrastructure. No new commands. Existing `index`,
`rehydrate`, and future `suggest` benefit from incremental path. One known
trade-off: stale import hot spots may appear in briefing output after
rename/delete-heavy changes until the next full reindex. Phase 5 import
resolution work closes this gap.

---

## Context

Phases 1-2 established the indexing spine and rehydration flow. The current
pipeline rebuilds the entire cache on any staleness — fingerprint mismatch or
dirty worktree triggers full reindex. For medium repos this means re-reading and
re-parsing 500-2000 files when only a handful changed.

Phase 4 fixes this with a two-tier changed-file detection strategy and an
incremental merge step that reprocesses only what changed.

---

## Target Scale

Medium repos: 500-2000 files. Typical TypeScript/JavaScript projects. No
streaming, sharding, or async I/O architecture changes needed at this scale.

---

## Approach: Git-Diff Primary + Hash Validation

Two-tier detection:

1. **Git diff (fast path):** Use git plumbing to find changed files between
   cached commit and current HEAD, plus staged/unstaged/untracked changes.
   Near-instant.

2. **Hash comparison (fallback):** When git diff is unavailable (ancestor commit
   gone after force push, shallow clone), compare per-file content hashes stored
   in cache against current file contents. ~50-100ms for 2k files.

Git diff handles ~95% of cases. Hash fallback covers edge cases without
requiring full reindex.

---

## Architecture

### Module Structure

Phase 4 adds one file to `src/lib/`:

```text
src/lib/
  diff-files.ts   <- changed-file detection: git-diff tier + hash-compare fallback
```

Existing modules modified:

```text
src/lib/
  models.ts       <- FileNode.contentHash, schema version bump
  indexer.ts       <- buildIncrementalIndex, hash population in full index
  rehydrate.ts     <- incremental path in staleness branch
```

No changes to public API surface. Incremental refresh is mostly an internal
optimization, with one known user-visible limitation: after rename or delete
of a heavily-imported file, stale import targets may appear in the briefing's
Import Hot Spots section until the next full reindex (`index --refresh`).
This is a trade-off for avoiding full reindex on every change. Phase 5
import resolution improvements will close this gap. See Import Edge Handling
section for details.

---

## Data Model Changes

### FileNode

```ts
export type FileNode = {
	path: string;
	kind: "file" | "dir";
	contentHash?: string; // SHA-256 hex of file content
};
```

`contentHash` is optional for backwards compatibility during schema migration.
In practice, schema version bump from `"1"` to `"2"` causes existing caches to
be nuked and rebuilt with hashes populated.

### Schema Version

`SCHEMA_VERSION` bumps from `"1"` to `"2"`. Existing v1 caches are discarded
on read (current `readCacheForWorktree` behavior handles this).

### RepoCache

```ts
export type RepoCache = {
	// ... existing fields unchanged ...
	dirtyAtIndex?: boolean; // true when cache was built from a dirty worktree
};
```

`dirtyAtIndex` is optional (absent or `false` = clean). Set to `true` by
`buildIncrementalIndex` when the incremental refresh was triggered by a dirty
worktree at the same HEAD fingerprint. Set to `false` (or omitted) by full
`indexRepo` and by incremental refreshes triggered by a fingerprint change.

This flag catches the dirty-revert scenario: if a prior incremental refresh
processed dirty edits, and the user later reverts those edits (worktree
becomes clean), the fingerprint still matches HEAD and the worktree is clean,
but the cached content hashes and import edges reflect the old dirty state.
Without this flag, the orchestrator would incorrectly return `"fresh"`.

`fingerprint` field (HEAD commit hash) remains for fast "anything changed?"
check. Per-file hashes live in `files[]` entries.

---

## Changed-File Detection

### Module: `src/lib/diff-files.ts`

Exports:

```ts
export type FilesDiff = {
	changed: string[]; // modified or added paths (relative to repo root)
	removed: string[]; // paths in cache but gone from disk
	method: "git-diff" | "hash-compare";
};

export function diffChangedFiles(
	identity: RepoIdentity,
	cached: RepoCache,
): FilesDiff;

export function hashFileContent(worktreePath: string, filePath: string): string;
```

### Tier 1 — Git Diff + Hash Validation

Runs four git commands and unions results:

```bash
git diff --name-only <cached-fingerprint>..HEAD    # committed changes
git diff --name-only                                # unstaged changes
git diff --name-only --cached                       # staged changes
git ls-files --others --exclude-standard            # untracked files
```

Union of all four = raw candidate set.

**Hash validation step:** Git diff reports files that differ from HEAD/index,
not files that differ from the cached snapshot. In a steady-state dirty
worktree (unstaged edits already processed by a prior incremental refresh),
the same files reappear on every call. To avoid reprocessing, filter the raw
candidate set against cached `contentHash` values: hash each candidate's
current content and drop any whose hash matches the cached hash. Only truly
new changes survive into the final `changed[]` list.

This makes tier 1 idempotent for repeated calls on a dirty worktree.

Removed files: paths in `cached.files[]` that no longer appear in current
`listIndexableFiles()` output.

If cached fingerprint commit is not reachable (git diff exits non-zero), fall
through to tier 2.

### Tier 2 — Hash Comparison

1. Hash all current indexable files using SHA-256.
2. Compare against `contentHash` in cached `FileNode[]`.
3. Any mismatch or missing hash = changed.
4. Any cached path not on disk = removed.
5. Any new path not in cache = changed (added).

Cost: ~50-100ms for 2k files on modern hardware.

### Content Hashing

Algorithm: SHA-256 via Node `crypto.createHash`.

Input: raw file content bytes, no normalization.

Output: hex string (64 characters).

Cache size impact: 2k files x 64 chars = ~128KB. Negligible.

---

## Incremental Index Merge

### Function: `buildIncrementalIndex`

Added to `indexer.ts`:

```ts
export function buildIncrementalIndex(
	identity: RepoIdentity,
	existingCache: RepoCache,
	diff: FilesDiff,
	dirtyAtIndex: boolean,
): RepoCache;
```

### Merge Flow

1. If `diff.changed` and `diff.removed` are both empty, return existing cache
   with updated `fingerprint` and `indexedAt` (timestamp-only refresh).

2. For changed files only:
   - Re-extract import edges (only from changed TS/JS files)
   - Compute content hashes for changed files
   - Redetect entry files (cheap path matching, no I/O)

3. Merge into existing cache:
   - `files[]` — remove entries for `removed` paths, replace entries for
     `changed` paths, keep all others unchanged
   - `imports[]` — drop all edges where `from` is in `changed` or `removed`,
     add newly extracted edges from changed files
   - `docs[]` — if any `.md` file appears in `changed` or `removed`,
     recompute docs from scratch via `loadDocs(worktreePath, updatedFilePaths)`.
     This preserves correct global top-8 ranking: adding a high-ranked doc
     (e.g., `README.md`) promotes it and evicts the lowest-ranked entry,
     and removing a top-ranked doc promotes the next candidate. Per-path
     patching is insufficient because doc selection is a globally ranked
     operation. `loadDocs` reads at most 8 files — negligible I/O.
   - `entryFiles[]` — recompute full list (cheap, no I/O)
   - `packageMeta` — re-read if `package.json` is in `changed` or `removed`.
     When removed, `readPackageMeta` returns its built-in fallback
     (dir basename, version `"0.0.0"`, no framework). Recompute `entryFiles`
     after `packageMeta` update in either case.

4. Update `fingerprint` to current HEAD, update `indexedAt`.
5. Set `dirtyAtIndex` based on caller context: `true` when the refresh was
   triggered by a dirty worktree at the same fingerprint, `false` otherwise.
   The orchestrator passes this as a parameter to `buildIncrementalIndex`.

### Import Edge Handling

Import edges are keyed by `from` field. Removing all edges from a changed file
and re-extracting gives correct result without global re-parse.

**Stale `to` references deferred:** Renaming or removing a heavily-imported
file leaves dead `to` paths in the cache until every importing file itself
changes. A post-merge existence filter was considered but deferred: current
import extraction stores extensionless, unresolved targets (e.g., `src/foo`
for `import "./foo"`) that don't reliably map back to `files[]` entries
(`src/foo.ts`, `src/foo/index.ts`). Fixing this requires smarter import
resolution, planned for Phase 5 alongside tree-sitter. Until then, stale
`to` edges are cosmetic — they may appear in briefing hot spots but do not
cause errors. A full reindex (`index --refresh`) clears them.

---

## Orchestrator Changes

### `rehydrate.ts` Modified Flow

1. `resolveRepoIdentity(repoPath)` -> identity
2. `readCacheForWorktree(identity.repoKey, identity.worktreeKey)` -> cached or null
3. No cache -> full `indexRepo(repoPath)`, status = `"reindexed"`
4. Cache exists:
   - Compare fingerprint to current HEAD
   - If same fingerprint, check dirty worktree
   - Also check `dirtyAtIndex` flag: if cache has `dirtyAtIndex: true` and
     worktree is now clean, treat as stale (dirty-revert scenario — cache
     content reflects old dirty state that no longer matches disk)
   - If not stale -> use cached, status = `"fresh"`
   - If stale + `stale: true` -> use cached, status = `"stale"`
   - If stale -> `diffChangedFiles(identity, cached)` -> diff
     - `buildIncrementalIndex(identity, cached, diff)` -> updated cache
     - `writeCache(updatedCache)`
     - status = `"reindexed"`
5. Render briefing, write `.md`, return result

### `indexRepo` Unchanged

Always does full index. Used for `index` command and first-time indexing.
Gets content hash computation added so first index populates hashes.

### `getCachedIndex` Unchanged

Returns null on fingerprint mismatch. Callers wanting incremental should use
`rehydrateRepo` or `suggestRepo`.

### Future `suggestRepo`

When Phase 3 lands, `suggest.ts` uses same orchestrator pattern. Incremental
refresh applies automatically — same `diffChangedFiles` + `buildIncrementalIndex`
path.

---

## Testing

### Unit Tests

**`tests/unit/lib/diff-files.test.ts`**

- Git diff tier: detects modified files between two commits
- Git diff tier: detects added files (new in HEAD)
- Git diff tier: detects removed files (in cache, gone from disk)
- Git diff tier: includes staged changes
- Git diff tier: includes unstaged changes
- Git diff tier: includes untracked files
- Git diff tier: hash validation filters out already-processed dirty files
- Git diff tier: repeated call on same dirty worktree returns empty diff
- Git diff tier: falls back to hash compare when ancestor commit unreachable
- Hash compare tier: detects changed files by content hash mismatch
- Hash compare tier: detects removed files (in cache, not on disk)
- Hash compare tier: detects added files (on disk, no cached hash)
- Empty diff when nothing changed

**`tests/unit/lib/indexer.test.ts` (additions)**

- `buildIncrementalIndex` merges changed files into existing cache
- Removed files pruned from `files[]`, `imports[]`, `docs[]`
- Import edges from changed files replaced, unchanged files kept
- Stale import `to` edges remain when target removed (deferred to Phase 5)
- `package.json` change triggers `packageMeta` re-read
- `package.json` removal triggers `packageMeta` fallback and `entryFiles` recompute
- Entry files recomputed after merge
- Content hashes populated on full index
- Content hashes updated for changed files on incremental index
- Empty diff returns same cache with updated fingerprint and timestamp
- `dirtyAtIndex` set to `true` when dirty worktree triggered incremental
- `dirtyAtIndex` set to `false` when fingerprint change triggered incremental
- New high-ranked `.md` doc added promotes into top-8, evicts lowest
- Existing top-ranked doc removed promotes next candidate into top-8

### Integration Tests

- Full index -> modify one file -> rehydrate -> confirms incremental reindex
- Full index -> modify one file -> rehydrate twice -> second call has no
  reprocessing (dirty worktree idempotency)
- Full index -> dirty edit -> rehydrate -> revert edit -> rehydrate ->
  returns reindexed, not fresh (dirty-revert detection via `dirtyAtIndex`)
- Full index -> tamper cached fingerprint to nonexistent SHA -> rehydrate ->
  falls back to hash compare
- Full index -> no changes -> rehydrate returns `"fresh"`
- Full index -> remove `package.json` -> rehydrate -> `packageMeta` uses
  fallback, `entryFiles` recomputed
- Full index -> rename heavily imported file -> rehydrate -> stale import
  edges remain in cache (known limitation, deferred to Phase 5)
- Cache from schema v1 (no contentHash) -> triggers full reindex on schema
  mismatch

---

## Scope Boundaries

### In Scope

- `FileNode.contentHash` field and schema version bump to `"2"`
- `diff-files.ts` module (git-diff tier + hash-compare fallback)
- `buildIncrementalIndex` function in `indexer.ts`
- Content hash computation in full `buildIndex`
- Incremental path in `rehydrate.ts` orchestrator
- Tests per testing section above

### Out of Scope

- Async/parallel file I/O — sync approach sufficient for target scale
- Cache eviction or size management
- Progress/spinner output for CLI
- Git subprocess timeouts
- Configurable ignore patterns
- `require()` or dynamic import parsing — current regex sufficient
- Doc limit configurability
- Tree-sitter function call graph — deferred to Phase 5 (see below)

### Phase 5 Forward Reference

Phase 5 should add tree-sitter-based function call graph (`CallEdge[]`) to
`RepoCache`. This addresses the Phase 0 finding where path-token matching
cannot bridge task vocabulary to files whose paths don't share those terms.

Phase 5 benefits from:

- Phase 3 `suggest` command as consumer for call graph signals
- Phase 4 incremental infrastructure for re-parsing only changed files

Phase 5 should also improve import resolution (extension resolution, `/index`
directory imports) to enable a post-merge stale-edge filter that Phase 4
deferred. With proper resolution, dead `to` references can be pruned during
incremental merge instead of persisting until full reindex.

Recommended extraction: tree-sitter AST parsing (not full TypeScript compiler).
Reserve `calls?: CallEdge[]` on `RepoCache` when Phase 5 work begins.

---

## File Change Summary

| File                                | Change                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `src/lib/models.ts`                 | `FileNode.contentHash`, `RepoCache.dirtyAtIndex`, `SCHEMA_VERSION` to `"2"` |
| `src/lib/diff-files.ts`             | **new** — changed-file detection                                            |
| `src/lib/indexer.ts`                | `buildIncrementalIndex`, hash population in full index                      |
| `src/lib/rehydrate.ts`              | incremental path in staleness branch                                        |
| `tests/unit/lib/diff-files.test.ts` | **new** — diff-files unit tests                                             |
| `tests/unit/lib/indexer.test.ts`    | additional incremental merge tests                                          |

4 modified files, 2 new files. No new dependencies.
