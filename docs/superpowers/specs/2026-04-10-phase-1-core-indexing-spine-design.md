# Phase 1 — Core Indexing Spine Design

**Date:** 2026-04-10
**Status:** approved
**Phase:** 1 of 4

---

## Goal

Establish the durable product core for `ai-cortex`: a versioned local indexing
library with correct worktree-aware repo identity, a clean module structure, and
a stable `RepoCache` contract that Phase 2 (`rehydrate`) and Phase 3 (`suggest`)
can build on without surprises.

Phase 1 delivers one command: `index`. No `rehydrate`, no `suggest`.

---

## Context

Phase 0 proved the thesis on one real repo (`ai-14all`). The spike code in
`src/spike/` contains proven algorithms but also proof-specific scaffolding,
hardcoded Electron heuristics, and no versioning. Phase 1 lifts the proven
algorithms into a proper library structure and deletes the spike.

The primary user workflow is worktree-heavy: multiple linked worktrees per repo,
each representing a feature branch. The cache key design must reflect this or
the product is broken for its own primary use case.

---

## Architecture

### Module Structure

```
src/
  lib/
    models.ts          ← all shared types + SCHEMA_VERSION constant
    repo-identity.ts   ← resolves git common dir + worktree key
    indexable-files.ts ← git ls-files with fs walk fallback
    doc-inputs.ts      ← doc ranking + loading
    import-graph.ts    ← TS/JS import extraction
    entry-files.ts     ← package.json-driven + convention fallback
    cache-store.ts     ← versioned read/write, schema invalidation
    indexer.ts         ← pipeline orchestrator
    index.ts           ← public exports only
  spike/               ← untouched until Phase 1 complete, then deleted
  cli.ts               ← updated to call lib/index.ts
tests/
  unit/lib/            ← one file per lib module, no disk I/O
  integration/         ← end-to-end index + read against real temp repo
```

**Key constraint:** `indexer.ts` is the only module allowed to import multiple
`lib/` modules. All other modules import only from `models.ts` and Node built-ins.
This keeps each module independently testable and prevents tangled dependencies.

### Spike Migration Strategy

Build `src/lib/` alongside `src/spike/`. Do not modify the spike during Phase 1.
When all Phase 1 tests pass and `src/cli.ts` points at the new library, delete
`src/spike/` in a single commit.

---

## Data Model

```ts
// models.ts

export const SCHEMA_VERSION = "1";

export class RepoIdentityError extends Error {}
export class IndexError extends Error {}

export type RepoIdentity = {
	repoKey: string;      // SHA256(gitCommonDir).slice(0, 16)
	worktreeKey: string;  // SHA256(worktreePath).slice(0, 16)
	gitCommonDir: string; // absolute path to shared .git/
	worktreePath: string; // absolute path to this worktree root
};

export type PackageMeta = {
	name: string;
	version: string;
	main?: string;
	module?: string;
	framework: "electron" | "next" | "vite" | "node" | null;
};

export type FileNode = {
	path: string;
	kind: "file" | "dir";
};

export type ImportEdge = {
	from: string;
	to: string;
};

export type DocInput = {
	path: string;
	title: string;
	body: string;
};

export type RepoCache = {
	schemaVersion: typeof SCHEMA_VERSION;
	repoKey: string;
	worktreeKey: string;
	worktreePath: string;
	indexedAt: string;       // ISO 8601 timestamp
	fingerprint: string;     // HEAD commit hash
	packageMeta: PackageMeta;
	entryFiles: string[];    // computed at index time, not re-derived on read
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
};
```

`RepoIdentity` is a resolution result — used during indexing but not stored in
the cache file. The cache stores only the derived keys and paths.

`entryFiles` is computed and stored rather than re-derived on read because
derivation requires file existence checks, which are slow on the read path.

---

## Repo Identity & Worktree Handling

### Resolution

`resolveRepoIdentity(inputPath: string): RepoIdentity`

1. Run `git -C <inputPath> rev-parse --git-common-dir` → shared `.git/` dir,
   same for all linked worktrees of the same repo.
2. Run `git -C <inputPath> rev-parse --show-toplevel` → worktree root (resolves
   subdirectory inputs to the worktree root).
3. `repoKey = SHA256(gitCommonDir).slice(0, 16)`
4. `worktreeKey = SHA256(worktreePath).slice(0, 16)`

Throws `RepoIdentityError` if:
- Path is not inside a git repo (`git rev-parse` exits non-zero)
- Git is not installed (`execFileSync` throws ENOENT)

No fallback for non-git repos. Phase 1 is git-first; non-git support is out of
scope for the MVP.

### Storage Layout

```
~/.cache/ai-cortex/v1/
  <repoKey>/
    <worktreeKey>.json
```

All worktrees of the same repo land under the same `<repoKey>/` directory.
Different branches or worktrees of the same repo produce different
`<worktreeKey>` files. No coordination required between worktrees.

---

## Indexing Pipeline

`indexer.ts` calls each module in sequence with explicit typed inputs and
outputs. The internal function `buildIndex` is pure — no disk I/O — making it
directly testable.

```
resolveRepoIdentity(inputPath)       → RepoIdentity
listIndexableFiles(worktreePath)     → string[]
readPackageMeta(worktreePath)        → PackageMeta
pickEntryFiles(filePaths, meta)      → string[]
loadDocs(worktreePath, filePaths)    → DocInput[]
extractImports(worktreePath, paths)  → ImportEdge[]
buildRepoFingerprint(worktreePath)   → string
─────────────────────────────────────────────────
assemble → RepoCache
writeCache(cache)
```

### Module Responsibilities

**`indexable-files.ts`** — `listIndexableFiles(worktreePath): string[]`

Runs `git ls-files --cached --others --exclude-standard`. Falls back to
recursive `fs.readdirSync` walk if git fails. Returns relative paths sorted
alphabetically. Hidden directories (`.git`, `node_modules`, `dist`, `out`,
`build`, `release`) are excluded in both paths.

**`doc-inputs.ts`** — `loadDocs(worktreePath, filePaths, limit?): DocInput[]`

Ranks `.md` files by priority:

1. `README.md` (score 100)
2. `docs/shared/architecture*` (score 90)
3. `docs/shared/high_level_plan*` (score 80)
4. `docs/shared/**` (score 70)
5. Any other `.md` (score 10)

Reads up to `limit` (default 8) files. Extracts title from first `# ` heading,
falls back to file path.

**`import-graph.ts`** — `extractImports(worktreePath, filePaths): ImportEdge[]`

Processes `.ts`, `.tsx`, `.js`, `.jsx` files only. Extracts relative specifiers
via `/from\s+['"]([^'"]+)['"]/g`. Skips non-relative imports (no leading `.`).
Resolves paths relative to the importing file using `path.normalize`.
Strips extensions (`.ts`, `.tsx`, `.js`, `.jsx`) from resolved targets.

**`entry-files.ts`** — `readPackageMeta(worktreePath): PackageMeta` and `pickEntryFiles(filePaths, packageMeta): string[]`

`readPackageMeta` parses `package.json` at the worktree root. Returns safe
defaults (`name: path.basename(worktreePath)`, `version: "0.0.0"`,
`framework: null`) if `package.json` is missing or malformed. Detects framework
from `dependencies` and `devDependencies`: presence of `electron` → `"electron"`,
`next` → `"next"`, `vite` → `"vite"`, none matched → `"node"` if no browser
framework detected.

Resolution order:

1. `packageMeta.main` / `packageMeta.module` — if the path resolves to a source
   file in `filePaths` (not compiled output like `dist/`)
2. Framework-specific conventions:
   - `electron` → `electron/main/index.ts`, `src/main.ts`
   - `next` → `src/app/layout.tsx`, `pages/_app.tsx`
   - `vite` → `src/main.ts`, `src/main.tsx`
   - `node` → `src/index.ts`, `index.ts`
3. Common fallbacks: `src/index.ts`, `src/main.ts`, `src/main.tsx`, `index.ts`

Returns only paths that exist in `filePaths`. Caps at 8.

**`cache-store.ts`** — versioned read/write and fingerprinting

`buildRepoFingerprint(worktreePath): string`
Runs `git -C <worktreePath> rev-parse HEAD`. Returns the HEAD commit hash.
Throws `RepoIdentityError` if git fails (propagated from `indexer.ts`).

`writeCache(cache: RepoCache): void`
- Creates `~/.cache/ai-cortex/v1/<repoKey>/` if needed
- Writes `<worktreeKey>.json`

`readCacheForWorktree(repoKey, worktreeKey): RepoCache | null`
- Returns `null` if file does not exist
- Parses JSON, checks `schemaVersion`
- On version mismatch: deletes stale file, writes one line to `stderr`:
  `ai-cortex: cache schema updated, reindexing <worktreeKey>`
  Returns `null`

---

## Public API

`src/lib/index.ts` re-exports exactly two functions:

```ts
export function indexRepo(repoPath: string): RepoCache
```
Resolves identity, runs full pipeline, writes cache, returns result.
Throws `RepoIdentityError` if not a git repo.
Throws `IndexError` with message if pipeline fails.

```ts
export function getCachedIndex(repoPath: string): RepoCache | null
```
Resolves repo identity, reads the cache file, then calls `buildRepoFingerprint`
to compare against the stored fingerprint. Returns the cached index if it exists
and fingerprints match. Returns `null` if: no cache, schema mismatch (warns to
stderr), or fingerprint differs (stale). Note: always spawns one git subprocess
(`rev-parse HEAD`) to check freshness — this is intentional and cheap.
Never throws for missing or stale cache — only throws `RepoIdentityError` for
identity resolution failures.

Internal only (not exported):

```ts
function buildIndex(identity: RepoIdentity): RepoCache
```
Pure computation, no disk I/O. Called by `indexRepo`, also used directly in
unit tests to avoid disk writes.

---

## CLI

`src/cli.ts` is a thin wrapper with no business logic:

```
Usage:
  ai-cortex index [path]            Index repo at path (default: cwd)
  ai-cortex index --refresh [path]  Force reindex even if cache is fresh
```

Success output (stdout):
```
indexed ai-14all
  files: 165  docs: 8  imports: 312  entry files: 6
  cache: ~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.json
  duration: 54ms
```

Schema invalidation warning (stderr, one line):
```
ai-cortex: cache schema updated, reindexing <worktreeKey>
```

Exit codes:
- `0` — success
- `1` — not a git repo or git not found
- `2` — pipeline error (unreadable file, etc.)

No other commands in Phase 1. The spike commands (`baseline`, `cold-orient`,
`rehydrate`) remain in `src/spike/` until the spike is deleted post-Phase 1.

---

## Error Handling

Two named error classes, both in `models.ts`:

- `RepoIdentityError` — path not in a git repo, or git not installed
- `IndexError` — pipeline failure (file unreadable, JSON parse failure, etc.)

All other errors propagate as-is. No silent swallowing. Callers can catch
specifically or let it bubble to the CLI error handler.

---

## Testing

**Unit tests** (`tests/unit/lib/`) — one file per module, no disk I/O, no git
subprocesses. Mock `execFileSync` for git calls, `fs` for file reads where
needed.

| File | Key cases |
|------|-----------|
| `repo-identity.test.ts` | key derivation, git failure → RepoIdentityError, subdirectory input resolves to root |
| `indexable-files.test.ts` | git output parsing, fallback trigger on git failure, hidden dir exclusion |
| `doc-inputs.test.ts` | ranking order, title extraction, limit enforcement |
| `import-graph.test.ts` | relative vs non-relative, path normalization, extension stripping, no substring false positives |
| `entry-files.test.ts` | package.json field → framework convention → common fallback, non-existent paths excluded |
| `cache-store.test.ts` | schema mismatch warns + returns null, round-trip read/write, missing file returns null |

**Integration test** (`tests/integration/index.test.ts`) — one test, real disk,
real git:

```ts
it("indexes a real temp git repo and reads it back via getCachedIndex", () => {
  // git init temp dir, add README + TS files, commit
  // indexRepo(tmpDir) → verify RepoCache shape and field values
  // getCachedIndex(tmpDir) → verify returns equivalent data
  // make a new commit → getCachedIndex returns null (stale fingerprint)
  // cleanup tmpDir
})
```

Only test that touches disk or spawns real git subprocesses.

---

## Out of Scope for Phase 1

- `rehydrate` command — Phase 2
- `suggest` command — Phase 3
- Slim summary sidecar — Phase 2 optimization
- Stale auto-refresh — Phase 2
- Partial reindex — Phase 4
- Non-git repo fallback — Phase 4
- Multi-language support beyond TS/JS — Phase 4+
- Performance hardening for large repos — Phase 4
