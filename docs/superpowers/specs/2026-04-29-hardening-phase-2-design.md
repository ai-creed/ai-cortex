# Architecture Hardening — Phase 2: Async I/O, History Manifest, Adapter Contract

**Date:** 2026-04-29
**Status:** draft

---

## Goal

Address the three remaining structural weaknesses from the architecture assessment:
synchronous I/O throughout hot paths, full-scan history search, and loose adapter
loading contracts. No new features. No behavior changes. All existing test cases
(assertions, not just wiring) must pass unchanged.

Phase 2 depends on Phase 1 landing first. The cache coordinator from Phase 1 is the
natural place to consume the async cache-store APIs introduced here.

---

## Non-Regression Contract

Public API behavior of `suggestRepo`, `rehydrateRepo`, `indexRepo`, and all MCP/CLI
entry points stays identical. Existing integration test scenarios must produce identical
results.

**One permitted signature change:** `getCachedIndex` goes from sync to `async` as a
direct, unavoidable consequence of `readCacheForWorktree` and `buildRepoFingerprint`
going async (see Part 1). No other public export changes signature.

Test files may be updated for `await` where functions become async, but no assertion
values may change and no test cases may be removed.

---

## Part 1 — Async I/O Migration

### Problem

Synchronous file operations block the Node.js event loop throughout the core path.
Affected modules and their sync surface:

| Module                       | Sync calls                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/lib/cache-store.ts`     | `readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`                                            |
| `src/lib/history/store.ts`   | `readFileSync`, `writeFileSync`, `mkdirSync`, `openSync`, `readdirSync`                               |
| `src/lib/vector-sidecar.ts`  | `readFileSync` × 2, `writeFileSync` × 2, `renameSync` × 2, `existsSync` × 2 (history search hot path) |
| `src/lib/entry-files.ts`     | `readFileSync`, `existsSync`                                                                          |
| `src/lib/import-graph.ts`    | `readFileSync` (3 sites)                                                                              |
| `src/lib/vector-builder.ts`  | `mkdirSync`                                                                                           |
| `src/lib/indexable-files.ts` | `readdirSync`, `existsSync`, `statSync` (full-index and diff hot path)                                |

For a local beta tool on modest repos this is acceptable today. It becomes a visible
bottleneck as file count, session count, and embedding volume grow. MCP server context
makes this more acute: blocking I/O in one tool call delays all concurrent requests.

### Migration Strategy

Migrate module by module, bottom-up, so each change is independently reviewable:

**Order:**

1. `entry-files.ts` — smallest, no dependents other than `indexer.ts`
2. `cache-store.ts` — core dependency; `rehydrate.ts`, `suggest.ts`, `indexer.ts`
3. `import-graph.ts` — already called from async `extractImports`
4. `vector-builder.ts` — already called from async contexts
5. `indexable-files.ts` — hot path for full index and diff; called from `indexer.ts`
6. `vector-sidecar.ts` — called from `history/store.ts` via `readChunkVectors`; migrate before the store
7. `history/store.ts` — largest surface; last because history is a parallel concern

### Design: Per-Module Changes

**`entry-files.ts`:**

```ts
// Before
export function readPackageMeta(worktreePath: string): PackageMeta;

// After
export async function readPackageMeta(
	worktreePath: string,
): Promise<PackageMeta>;
```

`existsSync` → `fs.promises.access`. `readFileSync` → `fs.promises.readFile`.

**`cache-store.ts`:**

```ts
// Before
export function readCacheForWorktree(repoKey: string, worktreeKey: string): RepoCache | null;
export function writeCache(cache: RepoCache): void;
export function isWorktreeDirty(worktreePath: string): boolean;

// After
export async function readCacheForWorktree(...): Promise<RepoCache | null>;
export async function writeCache(cache: RepoCache): Promise<void>;
export async function isWorktreeDirty(worktreePath: string): Promise<boolean>;
```

`readFileSync` / `writeFileSync` / `mkdirSync` → `fs.promises` equivalents.
`isWorktreeDirty` already shells out via `execSync`; migrate to `exec` from `node:child_process` promisified or use `execa` if already a dependency.
`buildRepoFingerprint` likewise shells out — migrate to async.

Note: `writeCache` uses a temp-file-then-rename pattern for atomicity. `fs.promises.rename`
preserves this.

**`import-graph.ts`:**

Internal `readFileSync` calls → `fs.promises.readFile`. `extractImports` is already
`async`; internal reads simply become `await` calls. Signature unchanged.

**`vector-builder.ts`:**

`mkdirSync` → `fs.promises.mkdir`. Functions already async; change is one line each.

**`vector-sidecar.ts`:**

```ts
// Before
export function writeVectorIndex(dir: string, index: VectorIndex): void;
export function readVectorIndex(
	dir: string,
	modelName: string,
): VectorIndex | null;

// After
export async function writeVectorIndex(
	dir: string,
	index: VectorIndex,
): Promise<void>;
export async function readVectorIndex(
	dir: string,
	modelName: string,
): Promise<VectorIndex | null>;
```

`existsSync` → `fs.promises.access`. All `readFileSync` / `writeFileSync` →
`fs.promises` equivalents. `renameSync` → `fs.promises.rename` (atomic rename
semantics preserved). Callers `readChunkVectors` and `writeChunkVectors` in
`history/store.ts` are already sync-to-be-migrated; they add `await` when
`history/store.ts` is migrated in step 7.

**`indexable-files.ts`:**

```ts
// Before
export function listIndexableFiles(worktreePath: string): string[];

// After
export async function listIndexableFiles(
	worktreePath: string,
): Promise<string[]>;
```

`readdirSync` → `fs.promises.readdir`. `existsSync` → `fs.promises.access`.
`statSync` → `fs.promises.stat`. Caller `buildIndex` in `indexer.ts` is already
`async`; the call site adds `await`. `buildIncrementalIndex` also calls it and is
already `async`.

**`history/store.ts`:**

Largest surface. Functions converted (names verified against `src/lib/history/store.ts`):

```ts
export async function acquireLock(...): Promise<AcquireResult>;
export async function releaseLock(...): Promise<void>;
export async function writeSession(...): Promise<void>;
export async function readSession(...): Promise<SessionRecord | null>;
export async function writeAllChunks(...): Promise<void>;
export async function readAllChunks(...): Promise<ChunkText[]>;
export async function listSessions(...): Promise<string[]>;
export async function pruneSession(...): Promise<void>;
export async function pruneSessionRaw(...): Promise<void>;
```

`openSync` with `"wx"` flag (atomic lock creation) → `fs.promises.open` with `"wx"`.
`readdirSync` → `fs.promises.readdir`.
All `readFileSync` / `writeFileSync` → `fs.promises` equivalents.

Lock acquisition is the one subtle case: the `"wx"` flag atomicity guarantee holds with
`fs.promises.open`. No behavioral change.

### Callers

All top-level callers (`indexRepo`, `rehydrateRepo`, `suggestRepo`, MCP handlers,
CLI handlers) are already `async`. Propagating `await` into previously-sync calls
requires no architectural change — only adding `await` at the call sites.

`cache-coordinator.ts` (Phase 1) becomes the single place where cache-store calls
are concentrated, making the async migration there clean.

**`getCachedIndex`:**

`getCachedIndex` in `src/lib/indexer.ts` calls both `readCacheForWorktree` and
`buildRepoFingerprint` directly. Both go async in this phase, so `getCachedIndex`
must also become async:

```ts
// Before
export function getCachedIndex(repoPath: string): RepoCache | null;

// After
export async function getCachedIndex(
	repoPath: string,
): Promise<RepoCache | null>;
```

Its single call site (`src/cli.ts:207`) adds `await`; behavior is identical. The
public library export (`src/lib/index.ts`) re-exports the async signature.

### Testing

- Unit tests that stub `readCacheForWorktree`, `writeCache`, `isWorktreeDirty` update
  stubs to return `Promise.resolve(...)` instead of raw values. Assertion logic unchanged.
- Integration tests hit real file system; behavior identical. No changes needed.
- History store unit tests (`store-*.test.ts`) add `await` at call sites. No assertion
  changes.

---

## Part 2 — History Session Manifest

### Problem

`history/store.ts` `listSessions` returns all session IDs by reading the directory.
History search in `history/search.ts` then reads every session file to match against
query criteria. This is a full O(n) scan per search call.

For early usage (< 100 sessions) this is invisible. At > 500 sessions with frequent MCP
history queries, scan time accumulates.

### Design

Add a lightweight manifest file alongside the sessions directory:

```
~/.ai-cortex/<repoKey>/history/
  sessions/
    <sessionId>/
      session.json
      chunks.jsonl
  manifest.jsonl      ← new
```

**Manifest format** — append-only JSONL, one entry per line:

```json
{
	"id": "abc123",
	"startedAt": "2026-04-29T10:00:00Z",
	"endedAt": "2026-04-29T10:30:00Z"
}
```

No text summary field. `history/search.ts` matches against `summary`, `userPrompts`,
`corrections`, `filePaths`, `toolCalls`, and `rawChunk` hits across the full session
record. A session legitimately matches on a correction, file path, or embedded chunk
content that would never appear in a single-field preview. Text-based matching must
always read the full session file — a manifest summary cannot safely pre-filter it.

The manifest's purpose is narrow: replace `readdirSync` on the sessions directory with
a single sequential file read, and enable optional date-range narrowing before loading
session data.

**New module: `src/lib/history/manifest.ts`**

```ts
export type ManifestEntry = {
	id: string;
	startedAt: string;
	endedAt?: string;
};

export async function appendManifestEntry(
	repoKey: string,
	entry: ManifestEntry,
): Promise<void>;
export async function readManifest(repoKey: string): Promise<ManifestEntry[]>;
export async function pruneManifest(
	repoKey: string,
	activeSessions: Set<string>,
): Promise<void>;
```

**Integration points:**

- `writeSession` is called on both session creation and subsequent updates (e.g.
  `pruneSessionRaw` at `history/store.ts:223`, `history/capture.ts:90`). Only the
  initial creation must append to the manifest — subsequent writes must not. The
  integration point is therefore: check whether `session.json` already exists
  **before** the write; if it does not exist yet, call `appendManifestEntry` after
  writing it.
- `readManifest` deduplicates by `id` before returning, as a safety net against
  any edge case where duplicate entries were written.
- `pruneSession` and `pruneSessionRaw` (the actual exports at `history/store.ts:212`) each call `pruneManifest` after removing the session directory.
- `history/search.ts`: when the manifest exists, use it to obtain session IDs and
  optionally narrow by date range before loading session files. Text/keyword filtering
  still reads every candidate session in full — the manifest provides no text index.
  Falls back to directory scan when manifest is absent (backwards compatibility for
  existing history stores).

### Non-Regression

Manifest is additive. Existing session data is unaffected. Searches without a manifest
fall back to current behavior. No schema changes to `session.json` or `chunks.jsonl`.
All existing search hit kinds (`summary`, `userPrompt`, `correction`, `filePath`,
`toolCall`, `rawChunk`) are preserved because text matching still reads full session
files.

Existing history tests do not need changes. Add new unit tests for `manifest.ts`:

- `appendManifestEntry` writes correct JSONL line
- `readManifest` parses all lines
- `pruneManifest` removes entries for pruned sessions
- search uses manifest for session enumeration, not text pre-filtering
- search falls back gracefully when manifest absent

---

## Part 3 — Adapter Contract Hardening

### Problem

Language adapters (`cfamily.ts`, `python.ts`, `typescript.ts`) are loaded via
`ensure.ts` but the contract between adapters and their callers is implicit.
`extractImports` and `extractCallGraph` in `import-graph.ts` and `call-graph.ts`
inspect file extensions to route to adapters, mixing capability detection with
query orchestration.

Adding a new language today requires changes in multiple files with no single place
declaring what the adapter supports.

### Design

Formalize a `LanguageAdapter` interface with explicit capability flags:

```ts
// src/lib/lang-adapter.ts (extend existing)

export type AdapterCapabilities = {
	importExtraction: boolean; // can extract import edges
	callGraph: boolean; // can extract call graph
	symbolIndex: boolean; // future: symbol-level indexing
};

// RawCallData already exists implicitly in call-graph.ts; surface it here.
// Must include importBindings because resolveCallSites (call-graph.ts:105)
// uses bindingsByFile — populated from importBindings — to resolve cross-file
// call targets. Dropping it would break the existing resolution pipeline.
export type RawCallData = {
	functions: FunctionNode[];
	rawCalls: RawCallSite[];
	importBindings: ImportBinding[];
};

export type LanguageAdapter = {
	extensions: string[];
	capabilities: AdapterCapabilities;
	extractImports(
		worktreePath: string,
		filePath: string,
		content?: string,
	): ImportEdge[];
	extractCallGraph?(
		worktreePath: string,
		filePath: string,
		content?: string,
	): RawCallData;
};
```

`callGraph` and `extractCallGraph` are optional at the type level — not all adapters
implement call graph (e.g. a hypothetical plain-text adapter). `RawCallData`
preserves the full `FileExtractionResult` shape that the existing call-graph resolution
pipeline depends on: `call-graph.ts:272–297` populates `bindingsByFile` from
`result.importBindings` before calling `resolveCallSites`.

Current adapter capabilities (verified against source):

| Adapter       | `importExtraction` | `callGraph` |
| ------------- | ------------------ | ----------- |
| TypeScript/JS | true               | true        |
| C/C++         | true               | true        |
| Python        | true               | true        |

Python already emits `functions`, `rawCalls`, and `importBindings` in `python.ts:315`.
`callGraph: false` must NOT be set for Python — that would regress existing behavior.

**Adapter registry** — replace the ad-hoc extension checks in `import-graph.ts` and
`call-graph.ts` with a registry lookup:

```ts
// src/lib/adapters/index.ts (extend)

export function getAdapterForFile(filePath: string): LanguageAdapter | null;
export function adapterSupports(
	filePath: string,
	cap: keyof AdapterCapabilities,
): boolean;
```

`extractImports` in `import-graph.ts` calls `getAdapterForFile` and routes to the
adapter's `extractImports` method. Removes the inline `isAdapterExt` extension checks
duplicated across files.

`extractCallGraph` in `call-graph.ts` calls `adapterSupports(file, "callGraph")` before
routing. Files without a capable adapter are skipped, same as today.

**`ensure.ts`** remains the load gate — no change to when adapters are loaded or how
they fail gracefully.

### Non-Regression

All existing adapter behavior is preserved. The refactor is routing logic only —
`cfamily.ts` and `python.ts` implement the same operations they do today, just exposed
through the formal interface.

`isAdapterExt` in `adapters/index.ts` is kept as an alias for backwards compatibility
during transition, then removed in a follow-up.

Existing adapter unit tests and integration tests (`c-cpp.test.ts`, `python.test.ts`)
run unchanged. Add:

- unit test: `getAdapterForFile` returns correct adapter for `.ts`, `.py`, `.c`, unknown
- unit test: `adapterSupports` returns correct bool per capability per adapter
- unit test: `extractImports` routes through registry, not inline extension check
- unit test: `extractCallGraph` skips file when adapter lacks `callGraph` capability

---

## Scope Boundaries

### In Scope

- Async migration of `cache-store`, `entry-files`, `import-graph`, `vector-builder`,
  `vector-sidecar`, `indexable-files`, `history/store`
- History session manifest (new JSONL file, manifest module, session enumeration)
- Adapter capability interface and registry lookup
- Removal of duplicated `isAdapterExt` extension checks after registry lands

### Out of Scope

- Parallel/concurrent embedding (separate performance initiative)
- Persistent query-time caching of scan results
- Session history embeddings infrastructure changes
- Full streaming or sharded index for very large repos
- Any change to `RepoCache` schema or `SCHEMA_VERSION`
- New MCP tools or CLI commands

---

## File Change Summary

| File                                      | Change                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `src/lib/cache-store.ts`                  | async migration                                                               |
| `src/lib/entry-files.ts`                  | async migration                                                               |
| `src/lib/import-graph.ts`                 | async migration (internal reads)                                              |
| `src/lib/vector-builder.ts`               | async migration (`mkdirSync`)                                                 |
| `src/lib/vector-sidecar.ts`               | async migration (`readFileSync`, `writeFileSync`, `renameSync`, `existsSync`) |
| `src/lib/indexable-files.ts`              | async migration (`readdirSync`, `existsSync`, `statSync`)                     |
| `src/lib/history/store.ts`                | async migration                                                               |
| `src/lib/history/manifest.ts`             | **new** — manifest append/read/prune                                          |
| `src/lib/history/search.ts`               | use manifest for session enumeration; fallback to scan                        |
| `src/lib/lang-adapter.ts`                 | `AdapterCapabilities`, updated `LanguageAdapter` interface                    |
| `src/lib/adapters/index.ts`               | `getAdapterForFile`, `adapterSupports`                                        |
| `src/lib/import-graph.ts`                 | route via registry instead of inline extension check                          |
| `src/lib/call-graph.ts`                   | route via registry, check `callGraph` capability                              |
| `tests/unit/lib/history/manifest.test.ts` | **new**                                                                       |
| `tests/unit/lib/adapters/*.test.ts`       | registry routing assertions                                                   |
| Various existing test files               | `await` added at call sites; no assertion changes                             |

13 modified files, 2 new files. No new dependencies (Node built-ins only for async I/O).
