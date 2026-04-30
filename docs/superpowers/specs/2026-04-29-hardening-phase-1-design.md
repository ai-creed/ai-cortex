# Architecture Hardening — Phase 1: Cache Coordinator, Build Integrity, Single-Pass Indexing

**Date:** 2026-04-29
**Status:** draft

---

## Goal

Three targeted refactors that eliminate the most concrete structural weaknesses in the
current codebase. No new features. No behavior changes. All existing tests must pass
without modification to test logic; only test double adjustments for updated internal
signatures are permitted.

---

## Non-Regression Contract

This phase is purely internal hardening. The public API surface — `suggestRepo`,
`rehydrateRepo`, `indexRepo`, `getCachedIndex`, `buildIncrementalIndex` — stays
identical in signature and behavior. The MCP server, CLI, and all integration test
scenarios must produce identical results before and after.

Any change that requires modifying a test assertion (not just a spy/stub wiring) is a
regression and must not land.

---

## Part 1 — Cache Lifecycle Coordinator

### Problem

`suggest.ts` (`suggestRepo`, lines 114–144) and `rehydrate.ts` (`rehydrateRepo`,
lines 39–73) contain near-identical cache freshness logic:

- fingerprint comparison
- dirty worktree detection
- dirty-revert detection (`dirtyAtIndex` flag)
- `fresh` / `stale` / `reindexed` branching
- `diffChangedFiles` → `buildIncrementalIndex` path

This duplication means any future change to cache policy (e.g. Python adapter
invalidation, new staleness signal) must be applied in two places. They have already
drifted in minor ways (`options?.stale` vs `options.stale`) and will continue to drift.

### Design

Extract a single shared coordinator function:

```ts
// src/lib/cache-coordinator.ts

export type CacheResolutionOptions = {
	stale?: boolean;
};

export type CacheResolutionResult = {
	cache: RepoCache;
	cacheStatus: "fresh" | "reindexed" | "stale";
};

export async function resolveCacheWithFreshness(
	identity: RepoIdentity,
	options: CacheResolutionOptions,
): Promise<CacheResolutionResult>;
```

Logic inside `resolveCacheWithFreshness` is the exact logic currently duplicated across
`suggestRepo` and `rehydrateRepo` — lifted verbatim, no behavioral change.

`suggestRepo` and `rehydrateRepo` each replace their inline cache block with a single
`await resolveCacheWithFreshness(identity, options)` call.

### Files Changed

| File                           | Change                                      |
| ------------------------------ | ------------------------------------------- |
| `src/lib/cache-coordinator.ts` | **new** — shared cache freshness logic      |
| `src/lib/suggest.ts`           | remove inline cache block, call coordinator |
| `src/lib/rehydrate.ts`         | remove inline cache block, call coordinator |

### Testing

No test case changes required. Existing unit tests for `suggest.ts` and `rehydrate.ts`
exercise all branches (fresh, stale, reindexed, dirty-revert) via stubs on
`readCacheForWorktree`, `buildRepoFingerprint`, `isWorktreeDirty`. Those stubs wire to
the same public functions — coordinator extraction does not change what gets called.

Add unit tests for `cache-coordinator.ts` directly covering the same branches, so the
coordinator itself has first-class coverage independent of callers:

- no cache → calls `indexRepo`, returns `"reindexed"`
- fingerprint stale → incremental path, returns `"reindexed"`
- dirty worktree → incremental path, returns `"reindexed"`
- dirty-revert → forced hash-compare incremental, returns `"reindexed"`
- `stale: true` with stale cache → returns `"stale"` without refresh
- fresh cache → returns `"fresh"`, no index calls

---

## Part 2 — Build Integrity: Version Drift Detection

### Problem

`src/mcp/server.ts:22` hardcodes:

```ts
const SERVER_VERSION = "0.3.0-beta.2";
```

`package.json` has `"version": "0.3.0-beta.6"`. Already four patch versions out of sync.
The comment "Keep in sync with package.json" documents a manual process that fails.

### Goal and Scope

This phase **eliminates silent drift** — the current state where `server.ts` is four
patches behind with no detection mechanism. It does **not** achieve automatic single-source
truth: `src/version.ts` still contains a manually-maintained literal, so bumping
`package.json` still requires a matching edit to `version.ts`. The difference is that
any mismatch now fails CI rather than shipping silently.

True automatic single-source (e.g. a `prebuild` script that generates `version.ts` from
`package.json`) is out of scope for this phase.

### Design

Introduce a shared version module at `src/version.ts`:

```ts
// src/version.ts
export const VERSION = "0.3.0-beta.6";
```

`server.ts` imports from this module:

```ts
import { VERSION as SERVER_VERSION } from "../version.js";
```

The relative path `../version.js` is correct for both execution contexts:

- Source: `src/mcp/server.ts` → `../version.js` resolves to `src/version.ts` ✓
- Compiled: `dist/src/mcp/server.js` → `../version.js` resolves to `dist/src/version.js` ✓

A single hardcoded relative path from `import.meta.url` cannot safely cover both
paths because the source tree is one level shallower than the compiled tree inside
`dist/`. The version module approach eliminates runtime path arithmetic entirely.

Add a test assertion that reads `package.json` and verifies `VERSION` matches, making
any drift a CI failure:

```ts
// tests/unit/mcp/server.test.ts (new case)
it("SERVER_VERSION matches package.json", () => {
	const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
		version: string;
	};
	expect(capturedServerVersion).toBe(pkg.version);
});
```

### Files Changed

| File                            | Change                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `src/version.ts`                | **new** — exports `VERSION` literal                                 |
| `src/mcp/server.ts`             | replace hardcoded `SERVER_VERSION` with import from `../version.js` |
| `tests/unit/mcp/server.test.ts` | add version-sync assertion                                          |

---

## Part 3 — Single-Pass Indexing Pipeline

### Problem

`buildIndex` in `indexer.ts` triggers multiple reads of the same source files:

1. `extractImports()` — reads each TS/JS/Python/C file for import edges
2. `hashFileContent()` (in `files.map()`) — reads each file again for SHA-256
3. `extractCallGraph()` — reads each TS/JS file again for call graph

For a 1000-file TypeScript repo this is ~2–3 file reads per source file, or 2000–3000
total reads instead of 1000. This is the largest unnecessary I/O cost in the hot path.

### Design

Introduce a shared file content buffer that is populated once and passed to all
consumers:

```ts
// src/lib/indexer.ts (internal, not exported)

type FileContentMap = Map<string, string>; // relative path → utf-8 content

function readFileContents(
	worktreePath: string,
	filePaths: string[],
): FileContentMap;
```

`readFileContents` does one `fs.readFileSync` per path and returns the map.
`buildIndex` calls this once before invoking `extractImports`, `hashFileContent`,
and `extractCallGraph`.

Each consumer function gains an optional overload that accepts pre-read content:

**`import-graph.ts`:**

```ts
export async function extractImports(
	worktreePath: string,
	filePaths: string[],
	allFilePaths: string[],
	contentMap?: FileContentMap, // new optional param
): Promise<ImportEdge[]>;
```

When `contentMap` is provided, file reads are skipped; the cached content is used.
When absent, behavior is identical to today (reads files itself). This preserves
backward compatibility for any external callers and for `buildIncrementalIndex`, which
only re-parses changed files and benefits less from pre-reading.

**`call-graph.ts`:**

```ts
export async function extractCallGraph(
  worktreePath: string,
  filePaths: string[],
  contentMap?: FileContentMap,  // new optional param
): Promise<...>;
```

Same pattern.

**`diff-files.ts` (`hashFileContent`):**

```ts
export function hashFileContent(
	worktreePath: string,
	filePath: string,
	content?: string, // new optional param
): string;
```

When `content` is provided, hashing skips the file read.

**`buildIndex` after change:**

```ts
export async function buildIndex(identity: RepoIdentity): Promise<RepoCache> {
	const filePaths = listIndexableFiles(identity.worktreePath);
	const contentMap = readFileContents(identity.worktreePath, filePaths);

	const packageMeta = readPackageMeta(identity.worktreePath);
	const entryFiles = pickEntryFiles(filePaths, packageMeta);
	const docs = loadDocs(identity.worktreePath, filePaths);
	const imports = await extractImports(
		identity.worktreePath,
		filePaths,
		filePaths,
		contentMap,
	);
	const fingerprint = buildRepoFingerprint(identity.worktreePath);
	const files = filePaths.map((p) => ({
		path: p,
		kind: "file" as const,
		contentHash: hashFileContent(identity.worktreePath, p, contentMap.get(p)),
	}));
	const { calls, functions: functionNodes } = await extractCallGraph(
		identity.worktreePath,
		filePaths,
		contentMap,
	);
	// ... rest unchanged
}
```

`buildIncrementalIndex` is left unchanged. It already operates on a small changed-file
subset; the per-call overhead is negligible and pre-reading would add complexity for
minimal gain.

### Files Changed

| File                      | Change                                                |
| ------------------------- | ----------------------------------------------------- |
| `src/lib/indexer.ts`      | `readFileContents`, pass `contentMap` to consumers    |
| `src/lib/import-graph.ts` | optional `contentMap` param; skip reads when provided |
| `src/lib/call-graph.ts`   | optional `contentMap` param; skip reads when provided |
| `src/lib/diff-files.ts`   | optional `content` param on `hashFileContent`         |

### Testing

No test assertion changes. Unit tests for `import-graph`, `call-graph`, and
`diff-files` exercise behavior via real or mock file content — passing content directly
exercises the same code paths. Add one new unit test per module confirming that when
`contentMap` / `content` is provided, no file system reads occur (spy on `fs.readFileSync`).

---

## Scope Boundaries

### In Scope

- Cache coordinator extraction
- Version module (`src/version.ts`) and CI-enforced version-sync test
- Explicit non-goal: automatic single-source version (requires a build script, out of scope)
- Single-pass content buffer in `buildIndex`
- Optional `contentMap` / `content` overloads on `extractImports`, `extractCallGraph`,
  `hashFileContent`

### Out of Scope

- Async I/O migration (Phase 2)
- History manifest index (Phase 2)
- Adapter contract hardening (Phase 2)
- Any change to public function signatures of `suggestRepo`, `rehydrateRepo`,
  `indexRepo`, `getCachedIndex`, `buildIncrementalIndex`
- Schema version bump
- New CLI commands or MCP tools

---

## File Change Summary

| File                                       | Change                                        |
| ------------------------------------------ | --------------------------------------------- |
| `src/lib/cache-coordinator.ts`             | **new**                                       |
| `src/version.ts`                           | **new** — exports `VERSION` literal           |
| `src/lib/suggest.ts`                       | remove inline cache block, call coordinator   |
| `src/lib/rehydrate.ts`                     | remove inline cache block, call coordinator   |
| `src/mcp/server.ts`                        | import `SERVER_VERSION` from `../version.js`  |
| `src/lib/indexer.ts`                       | `readFileContents`, pass `contentMap`         |
| `src/lib/import-graph.ts`                  | optional `contentMap` param                   |
| `src/lib/call-graph.ts`                    | optional `contentMap` param                   |
| `src/lib/diff-files.ts`                    | optional `content` param on `hashFileContent` |
| `tests/unit/lib/cache-coordinator.test.ts` | **new**                                       |
| `tests/unit/mcp/server.test.ts`            | version-sync assertion                        |

8 modified files, 3 new files. No new dependencies.
