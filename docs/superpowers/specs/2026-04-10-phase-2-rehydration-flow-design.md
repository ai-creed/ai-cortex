# Phase 2 — Rehydration Flow Design

**Date:** 2026-04-10
**Status:** approved
**Phase:** 2 of 4

---

## Goal

Make `rehydrate` genuinely useful for starting a new agent session. The command
produces a cached markdown briefing file that an agent reads on demand — no
prompt bloat, no manual scanning.

Phase 2 delivers one new command: `rehydrate`. The existing `index` command is
unchanged.

---

## Context

Phase 1 established the durable indexing spine: schema-versioned `RepoCache`,
worktree-aware identity, and a clean module structure in `src/lib/`. Phase 2
builds on that foundation to produce the first user-facing output — a project
briefing an agent can consume to orient itself without broad cold scanning.

The key design insight: the briefing lives as a cached `.md` file alongside the
cache JSON. The agent gets a path to read, not a wall of text in the prompt.
This removes prompt budget pressure and lets the briefing be as detailed as
needed.

---

## Architecture

### Module Structure

Phase 2 adds two files to `src/lib/`:

```
src/lib/
  briefing.ts      ← RepoCache → markdown string (pure, no I/O)
  rehydrate.ts     ← orchestrator: ensure fresh cache → generate briefing → write .md
```

Existing modules are unchanged. `briefing.ts` depends only on `models.ts`
(types). `rehydrate.ts` imports `repo-identity.ts`, `cache-store.ts`, and
`indexer.ts` — same orchestrator pattern as Phase 1. Like `indexer.ts`, it is
allowed to import multiple lib modules.

### Public API Changes

`src/lib/index.ts` adds one export:

```ts
export { rehydrateRepo } from "./rehydrate.js";
export type { RehydrateOptions, RehydrateResult } from "./rehydrate.js";
```

All existing exports are unchanged.

---

## Data Model

### New Types

```ts
// rehydrate.ts

export type RehydrateOptions = {
  stale?: boolean;  // if true, skip re-indexing even if cache is stale
};

export type RehydrateResult = {
  briefingPath: string;     // absolute path to the .md file
  cacheStatus: "fresh" | "reindexed" | "stale";
  cache: RepoCache;
};
```

No changes to `models.ts`. The new types live in `rehydrate.ts` because they
are specific to the rehydration flow and do not affect the indexing contract.

### Briefing File Location

The `.md` file lives alongside the cache JSON:

```
~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.md
```

Written by `rehydrate.ts` on every `rehydrateRepo` call. Overwrites the
previous briefing — no versioning, no history. The file is a derived view of
the cache, not a source of truth.

---

## Briefing Content

`briefing.ts` exports `renderBriefing(cache: RepoCache): string` — a pure
function with no I/O.

Output format:

```markdown
# ai-14all

**Framework:** Electron · **Version:** 2.1.0 · **Files:** 165 · **Indexed:** 2026-04-10T09:30:00Z

## Key Docs

- `README.md` — ai-14all
- `docs/shared/architecture_decisions.md` — Architecture Decisions
- `docs/shared/high_level_plan.md` — High-Level Plan

## Entry Files

- `electron/main/index.ts`
- `src/main.tsx`
- `src/app/App.tsx`

## Directory Structure

electron/
  main/
  preload/
src/
  app/
  features/
  components/
shared/
  models/
tests/
docs/

## Import Hot Spots

Files with the most inbound imports (likely core modules):

- `shared/models/worktree` (12 importers)
- `src/app/hooks/use-workspace` (9 importers)
- `electron/main/ipc` (8 importers)
```

### Section Details

**Header:** Project name from `packageMeta.name`. Framework (or `null` →
omitted), version, file count, and `indexedAt` timestamp on one line.

**Key Docs:** Top 3 from `docs[]` (already ranked by `doc-inputs.ts`). Shows
path and title. No doc bodies — the agent reads the files itself if it needs
depth.

**Entry Files:** Up to 6 from `entryFiles[]` (already computed at index time).

**Directory Structure:** Top 2 levels of directories only, derived from
`files[]` at render time. Excludes `node_modules`, `dist`, `out`, `build`,
`release`, `.git`. Sorted alphabetically.

**Import Hot Spots:** Count inbound edges per target in `imports[]`, show top 5
by count. Tells the agent which files are structural load-bearers. If no
imports exist, this section is omitted. Import targets are shown extensionless
as stored by Phase 1's import-graph (e.g. `shared/models/worktree`, not
`shared/models/worktree.ts`).

---

## Rehydrate Orchestrator

`rehydrate.ts` exports:

```ts
export function rehydrateRepo(
  repoPath: string,
  options?: RehydrateOptions
): RehydrateResult
```

### Flow

1. `resolveRepoIdentity(repoPath)` → identity
2. `readCacheForWorktree(identity.repoKey, identity.worktreeKey)` → cached or
   null
3. If no cache → `indexRepo(repoPath)`, status = `"reindexed"`
4. If cache exists → check freshness:
   a. `buildRepoFingerprint(identity.worktreePath)` — compare HEAD hash
   b. `isWorktreeDirty(identity.worktreePath)` — run
      `git status --porcelain -unormal`; if output is non-empty, there are
      uncommitted changes to tracked files or new untracked files
   - Both clean (fingerprint matches + not dirty) → status = `"fresh"`
   - Either stale + `stale` option set → status = `"stale"` (use stale data
     as-is)
   - Either stale + no `stale` option → `indexRepo(repoPath)`, status =
     `"reindexed"`
5. `renderBriefing(cache)` → markdown string
6. Write markdown to `getCacheDir(identity.repoKey)/<worktreeKey>.md`
7. Return `{ briefingPath, cacheStatus, cache }`

`rehydrateRepo` is a one-call API. Callers do not need to worry about indexing,
freshness, or file writing.

**Why the dirty check matters:** Phase 1's `getCachedIndex` intentionally uses
commit-only freshness — cheap and acceptable for a library API. But `rehydrate`
is the agent-facing product. If the user edited README.md, added a new doc, or
created a new source file since the last commit, the briefing must reflect that
or it undercuts the "orient without cold scanning" value proposition. The extra
`git status` call is cheap (~2-5ms) and only runs in the rehydrate path.

`isWorktreeDirty` is a helper in `rehydrate.ts` (not exported). It runs
`execFileSync("git", ["-C", worktreePath, "status", "--porcelain", "-unormal"])`
and returns `true` if the output is non-empty. The `-unormal` flag explicitly
includes untracked files, matching the indexer's `git ls-files --others`
behavior. Without this, newly added files would be invisible to the freshness
check despite being indexed.

---

## CLI

`src/cli.ts` adds a `rehydrate` command:

```
Usage:
  ai-cortex index [path]                Index repo (default: cwd)
  ai-cortex index --refresh [path]      Force reindex
  ai-cortex rehydrate [path]            Generate briefing (auto-refreshes stale cache)
  ai-cortex rehydrate --stale [path]    Use stale cache without reindexing
  ai-cortex rehydrate --json [path]     Output result as JSON
```

### Text Output (default)

```
rehydrated ai-14all (fresh, 165 files, 8 docs)
  briefing: ~/.cache/ai-cortex/v1/23e4.../869e...md
```

Status word reflects `cacheStatus`: `fresh`, `reindexed`, or `stale`.

### JSON Output (`--json`)

```json
{
  "briefingPath": "/Users/vuphan/.cache/ai-cortex/v1/23e4.../869e...md",
  "cacheStatus": "reindexed",
  "packageName": "ai-14all",
  "fileCount": 165,
  "docCount": 8
}
```

Slim summary — not the full `RepoCache`. Enough for a tool to know the path
and what happened.

### Exit Codes

Same as Phase 1:

- `0` — success
- `1` — not a git repo or git not found
- `2` — pipeline error

---

## Error Handling

No new error classes. `rehydrateRepo` wraps the entire flow in try/catch —
same pattern as `indexer.ts`:

- `RepoIdentityError` passes through (identity resolution failure)
- All other errors (including `.md` write failures from disk full, permissions,
  etc.) are wrapped in `IndexError`

This keeps the CLI's existing error handler working: `RepoIdentityError` → exit
1, `IndexError` → exit 2. No unhandled exceptions leak outside the documented
exit-code contract.

---

## Testing

### Unit Tests

**`tests/unit/lib/briefing.test.ts`:**

- Renders correct header with project name, framework, version, file count,
  timestamp
- Renders key docs section with paths and titles (top 3)
- Renders entry files section (up to 6)
- Derives directory structure from files[] (top 2 levels, directories only)
- Computes import hot spots from imports[] (top 5 by inbound count)
- Omits import hot spots section when imports is empty
- Handles edge cases: no docs, no entry files, no files
- Framework `null` is omitted from header

Pure function — no mocks needed. Pass a `RepoCache` directly.

**`tests/unit/lib/rehydrate.test.ts`:**

- Fresh cache (fingerprint matches + clean worktree) → no re-index, status =
  `"fresh"`
- Stale fingerprint → auto re-indexes, status = `"reindexed"`
- Dirty worktree — modified tracked file (fingerprint matches but uncommitted
  changes) → auto re-indexes, status = `"reindexed"`
- Dirty worktree — new untracked file (fingerprint matches but untracked file
  present) → auto re-indexes, status = `"reindexed"`
- Stale + `stale: true` → uses stale data, status = `"stale"`
- Missing cache → indexes from scratch, status = `"reindexed"`
- Writes `.md` file to correct path
- Returns correct `briefingPath`

Mocks lib modules same as `indexer.test.ts`.

### Integration Test

Extend `tests/integration/index.test.ts`:

- `rehydrateRepo(tmpDir)` → writes `.md` file, verify it exists and contains
  project name
- New commit → `rehydrateRepo(tmpDir)` auto-reindexes, returns
  `cacheStatus: "reindexed"`
- Another new commit + `rehydrateRepo(tmpDir, { stale: true })` → returns
  `cacheStatus: "stale"`

No new integration test file — extends the existing one which already has the
temp git repo setup.

---

## Out of Scope for Phase 2

- Doc body summaries in the briefing — agent reads the files itself
- Slim summary sidecar — not needed at current repo scale, revisit in Phase 4
- `suggest` command — Phase 3
- Function call graph — Phase 3
- CLAUDE.md integration — can be wired manually or by a future `ai-*` tool
- Watch / auto-rehydrate — deferred past MVP
