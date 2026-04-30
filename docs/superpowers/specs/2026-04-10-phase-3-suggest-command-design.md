# Phase 3 — Suggest Command Design

**Date:** 2026-04-12
**Status:** revised after Phase 4 alignment
**Phase:** 3 of 5

---

## Goal

Add a `suggest` command that recommends likely relevant code files and docs for a
task, using only cached local repo signals already produced by `ai-cortex`.

The output must be:

- fast enough for repeated terminal use
- deterministic across runs on the same cache state
- useful for both human workflows and tool-driven consumers

Phase 3 delivers one new command: `suggest`. It must fit the current codebase as
it exists after Phase 4 hardening, not the pre-hardening architecture from the
original Phase 3 draft.

---

## Context

Current implemented foundation:

- Phase 1: durable indexing spine
- Phase 2: `rehydrate` flow and briefing generation
- Phase 4: incremental refresh via `diff-files.ts`, content hashes, and
  `buildIncrementalIndex`

`suggest` is therefore not a greenfield command. It must plug into the current
cache lifecycle and reuse the same freshness behavior already implemented for
`rehydrate`.

Key constraints:

- local-only
- cache-driven
- no embeddings
- no LLM reranking
- no broad repo scan outside the existing cache refresh path

Available ranking inputs today:

- `cache.files[]`
- `cache.docs[]`
- `cache.imports[]`
- `cache.entryFiles[]`
- `cache.packageMeta`

Known structural limitation:

- import targets are stored as extensionless, not-fully-resolved paths
- this is good enough for light structural boosts
- this is not good enough for perfect module resolution or deep graph scoring

Phase 3 must work within that limit rather than pretending it does not exist.

---

## Architecture

### Module Structure

Phase 3 adds two files to `src/lib/`:

```text
src/lib/
  suggest-ranker.ts   ← pure ranking logic: task + cache + options → ranked suggestions
  suggest.ts          ← orchestrator: ensure fresh cache → rank → format result
```

Design intent:

- `suggest-ranker.ts` stays pure and depends only on `models.ts`
- `suggest.ts` is the orchestration layer, like `rehydrate.ts`
- `suggest.ts` may import cache, identity, diff, and indexer modules

Existing modules are unchanged except for public exports and CLI wiring.
One small supporting refactor is allowed: shared dirty-worktree detection may be
extracted into an existing git/cache helper module so `rehydrate` and `suggest`
do not duplicate the same `git status --porcelain -unormal` logic.

### Public API Changes

`src/lib/index.ts` adds:

```ts
export { suggestRepo } from "./suggest.js";
export type { SuggestOptions, SuggestItem, SuggestResult } from "./suggest.js";
```

All existing exports remain unchanged.

---

## Data Model

No changes to `models.ts`.

Suggest-specific types live in `suggest.ts`:

```ts
export type SuggestOptions = {
	from?: string;
	limit?: number;
	stale?: boolean;
};

export type SuggestItem = {
	path: string;
	kind: "file" | "doc";
	score: number;
	reason: string;
};

export type SuggestResult = {
	cacheStatus: "fresh" | "reindexed" | "stale";
	task: string;
	from: string | null;
	results: SuggestItem[];
};
```

Notes:

- `from` is an optional anchor path, relative to repo root when possible
- `limit` defaults to `5`
- `kind` exists so callers can distinguish code hits from doc hits even when
  both refer to markdown files on disk

---

## Ranking Model

### Core Approach

Phase 3 uses a simple two-stage approach:

1. Build a candidate set from cache signals
2. Score and sort candidates using textual and structural heuristics

This keeps the MVP understandable and predictable while leaving room for later
call-graph work.

### Candidate Pool

Candidates come from two logical sources:

- code/file candidates from `cache.files[]`
- doc candidates from `cache.docs[]`

Important dedupe rule:

- if a path exists in `cache.docs[]`, it must not also appear as a `"file"`
  candidate
- markdown docs should be represented once, as `kind: "doc"`

Why this matters:

- current cache data includes markdown files in `files[]`
- without dedupe, `README.md` and similar files can appear twice
- Phase 3 should produce one suggestion item per path

### Task Tokenization

Task text is:

- lowercased
- split on non-alphanumeric boundaries
- emptied of blank tokens
- deduplicated

Short stopwords may remain unless they prove noisy in implementation. Phase 3
should start simple and only add filtering if tests show obvious harm.

### Base Text Signals

Each candidate gets score from:

- filename token match
- path segment token match
- full path substring/token overlap
- doc title token match
- doc body token match
- entry-file boost if candidate path appears in `cache.entryFiles[]`

Bias:

- code should usually win when code and doc evidence are similar
- docs can still outrank code when textual evidence is materially stronger

### Structural Signals From `from`

If `options.from` is provided and normalizes to a known cached file, boost:

- exact anchor file
- same-directory files
- direct importers of the anchor
- direct import targets of the anchor
- one-hop structural neighbors reachable through one additional import edge

If `from` does not resolve to a known cached file:

- do not throw
- treat request as task-only suggest
- return `from: null` in the result if normalization fails

### Anchor/Import Normalization Rules

Current import graph stores unresolved extensionless `to` paths such as
`src/foo`, not guaranteed concrete files such as `src/foo.ts` or
`src/foo/index.ts`.

Phase 3 must therefore define a conservative matching rule:

1. Normalize the anchor path to forward-slash repo-relative form
2. Exact `from`-field matches are authoritative
3. For `to`-field matches, try only cheap path candidates:
   - exact candidate path without extension
   - candidate path with extension stripped
   - candidate path ending in `/index` after extension stripping
4. If multiple files could match the same unresolved import target, treat that
   structural signal as ambiguous and do not apply that specific boost

This keeps scoring honest and deterministic without inventing a resolver Phase 4
explicitly deferred.

### Sorting

Final sort order:

1. score descending
2. `kind === "file"` before `kind === "doc"`
3. path alphabetical

### Reasons

Each returned suggestion includes one short human-readable reason derived from
the strongest signals, for example:

- `matched task terms in path: persistence, restore`
- `near anchor file via imports`
- `entry file with matching repo context`
- `doc title/body strongly matches task`

Reason strings are explanatory only. They are not part of a stable machine API.

---

## Freshness Model

`suggest` must use the current Phase 4 freshness model, matching `rehydrate`.

Rules:

- no cache → full `indexRepo(repoPath)` → `"reindexed"`
- cache exists and is fresh → use cached → `"fresh"`
- cache is stale and `stale: true` → use cached → `"stale"`
- cache is stale and `stale` not set → incremental refresh when possible →
  `"reindexed"`

Staleness is defined the same way as current `rehydrate`:

- fingerprint mismatch
- dirty worktree detected via `git status --porcelain -unormal`
- dirty-revert case: cache has `dirtyAtIndex: true` but worktree is now clean

Refresh path must mirror `rehydrate`:

- call `diffChangedFiles(identity, cached, { forceHashCompare })`
- use `forceHashCompare` for dirty-revert cases
- call `buildIncrementalIndex(identity, cached, diff, dirty)`
- persist updated cache with `writeCache`

This is required to stay aligned with the current implementation. Phase 3 must
not reintroduce unconditional full reindex on every stale/dirty condition.

---

## Suggest Orchestrator

`suggest.ts` exports:

```ts
export function suggestRepo(
	repoPath: string,
	task: string,
	options?: SuggestOptions,
): SuggestResult;
```

### Flow

1. Validate `task.trim()` is non-empty
   - empty task throws `IndexError`
2. Validate `limit`
   - if provided, it must be a positive integer
   - invalid `limit` throws `IndexError`
3. `resolveRepoIdentity(repoPath)` → identity
4. `readCacheForWorktree(identity.repoKey, identity.worktreeKey)` → cached or
   `null`
5. Apply current freshness logic:
   - no cache → `indexRepo(repoPath)`
   - stale + `stale: true` → use cached
   - stale + no `stale` → incremental refresh via `diffChangedFiles` +
     `buildIncrementalIndex` + `writeCache`
   - fresh → use cached
6. Normalize `from`
7. `rankSuggestions(task, cache, { from, limit })`
8. Return `{ cacheStatus, task, from, results }`

No `.md` file is written. `suggest` is read-only except for cache refresh.

### Error Handling

No new error classes.

Behavior matches existing library conventions:

- `RepoIdentityError` passes through
- all other failures are wrapped in `IndexError`

Examples:

- empty task
- invalid limit
- filesystem or git failures during freshness check
- ranking logic errors

---

## CLI

### Parsing Requirement

Current `src/cli.ts` parsing is built around one positional repo path plus a
small flag list. `suggest` needs a richer shape:

- required task argument
- optional repo path
- optional `--from`
- optional `--limit`
- optional `--stale`
- optional `--json`

Phase 3 should therefore explicitly refactor CLI parsing rather than bolting
this onto the current `parseArgs(flags)` helper.

Minimum acceptable parser behavior:

- first positional after `suggest` is the task
- second positional, if present, is the repo path
- default repo path remains `process.cwd()`

### Usage

```text
Usage:
  ai-cortex index [path]
  ai-cortex index --refresh [path]
  ai-cortex rehydrate [path]
  ai-cortex rehydrate --stale [path]
  ai-cortex rehydrate --json [path]
  ai-cortex suggest "<task>" [path]
  ai-cortex suggest "<task>" --from <file> [path]
  ai-cortex suggest "<task>" --limit <n> [path]
  ai-cortex suggest "<task>" --stale [path]
  ai-cortex suggest "<task>" --json [path]
```

### Flag Semantics

- `--from <file>` — optional anchor path
- `--limit <n>` — optional positive integer, default `5`
- `--stale` — use stale cache if present
- `--json` — machine-readable output

### Default Text Output

```text
suggested files for: inspect persistence logic

1. src/persistence/store.ts
   reason: matched task terms in path: persistence

2. src/features/restore/restore-session.ts
   reason: near anchor file via imports

3. docs/shared/architecture_decisions.md
   reason: doc title/body strongly matches task
```

Rules:

- one header line
- blank line
- numbered flat list
- each item shows path, then one indented reason line
- do not show numeric score in human output

### JSON Output

```json
{
	"task": "inspect persistence logic",
	"from": "src/app/App.tsx",
	"cacheStatus": "fresh",
	"results": [
		{
			"path": "src/persistence/store.ts",
			"kind": "file",
			"score": 14,
			"reason": "matched task terms in path: persistence"
		}
	]
}
```

### Exit Codes

Same as current CLI behavior:

- `0` — success
- `1` — not a git repo or git not found
- `2` — pipeline / argument / ranking error

---

## Testing

### Unit Tests

**`tests/unit/lib/suggest-ranker.test.ts`**

- task token path match boosts correct files
- doc title/body matches create doc candidates
- doc/file dedupe prevents duplicate path results
- code outranks doc on equal score
- docs outrank code on materially stronger match
- entry files receive boost
- valid `from` boosts same-directory files
- valid `from` boosts direct import neighbors
- ambiguous unresolved import targets do not apply unstable boosts
- limit truncates result set
- stable sort on ties

**`tests/unit/lib/suggest.test.ts`**

- fresh cache → no refresh, status = `"fresh"`
- stale fingerprint → incremental refresh, status = `"reindexed"`
- dirty worktree with untracked file → incremental refresh, status =
  `"reindexed"`
- dirty-revert cache state forces hash-compare path and returns `"reindexed"`
- stale + `stale: true` → status = `"stale"`
- empty task throws `IndexError`
- invalid limit throws `IndexError`
- normalized `from` passed into ranker
- invalid or unknown `from` becomes `null`
- wraps non-identity errors in `IndexError`

### Integration Tests

Extend integration coverage with:

- `suggestRepo(tmpDir, "persistence")` returns ranked results
- untracked file causes auto-refresh before suggest
- dirty-revert scenario refreshes before suggest
- `from` anchor changes ranking in expected direction
- doc/file dedupe preserved in final results
- CLI text output shape
- CLI JSON output shape
- CLI invalid task / invalid limit exit-code path

---

## Out of Scope for Phase 3

- function call graph scoring
- embeddings or vector search
- LLM reranking
- deep module resolution beyond today's lightweight normalization
- snippet extraction or file previews
- interactive TUI selection
- non-TS/JS graph expansion beyond current import extraction

These belong to later phases. The first intended extension remains function call
graph support once import/call resolution becomes stronger.

---

## Implementation Notes

This spec intentionally aligns with the current codebase:

- Phase 4 incremental refresh is already implemented and must be reused
- `suggest` should follow `rehydrate` orchestration patterns where possible
- current import-graph limitations are accepted and bounded, not ignored

Success for Phase 3 is not "perfect task understanding." Success is a useful,
deterministic first-pass targeting tool that fits the existing cache model and
does not regress current hardening work.
