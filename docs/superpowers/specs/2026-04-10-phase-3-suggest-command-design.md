# Phase 3 — Suggest Command Design

**Date:** 2026-04-10
**Status:** approved
**Phase:** 3 of 4

---

## Goal

Add a `suggest` command that recommends likely relevant code files and docs for a
task, using only cached local repo signals. The output must be fast,
deterministic, and useful for both human terminal workflows and tool-driven
flows.

Phase 3 delivers one new command: `suggest`. Existing `index` and `rehydrate`
commands remain unchanged.

---

## Context

Phase 1 established the durable indexing spine (`RepoCache`). Phase 2 added an
agent-facing briefing via `rehydrate`. Phase 3 builds on same cache contract to
answer different question: "given this task, where should I look first?"

Key constraint: Phase 3 stays local-first and cache-driven. No embeddings, no
LLM reranking, no live full-repo scan. Ranking uses only signals already
available in `RepoCache`: file paths, docs, import graph, and entry files.

The design must also leave clean extension point for later function call graph
work without forcing Phase 3 rewrite.

---

## Architecture

### Module Structure

Phase 3 adds two files to `src/lib/`:

```text
src/lib/
  suggest-ranker.ts   ← pure ranking logic: task + cache + options → ranked suggestions
  suggest.ts          ← orchestrator: ensure fresh cache → rank → format result
```

`suggest-ranker.ts` is pure and depends only on `models.ts`.

`suggest.ts` is orchestrator module like `indexer.ts` and `rehydrate.ts`. It may
import multiple lib modules. Existing modules are otherwise unchanged.

### Public API Changes

`src/lib/index.ts` adds:

```ts
export { suggestRepo } from "./suggest.js";
export type {
  SuggestOptions,
  SuggestItem,
  SuggestResult,
} from "./suggest.js";
```

All existing exports remain unchanged.

---

## Data Model

### New Types

```ts
// suggest.ts

export type SuggestOptions = {
  from?: string;     // optional anchor file path, relative to repo root when possible
  limit?: number;    // default 5
  stale?: boolean;   // if true, skip re-indexing even if cache is stale
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

No changes to `models.ts`. Suggest-specific types stay in `suggest.ts`.

### Why `kind` Exists

Docs are still files on disk, but Phase 3 must distinguish between:

- code file recommendation
- doc recommendation

This allows CLI and future tools to prioritize code without losing strong doc
hits.

---

## Ranking Model

### Core Approach

Phase 3 uses two-stage ranking:

1. **Recall** — find plausible candidates from cached signals
2. **Rerank** — apply structural boosts and code-vs-doc balancing

This keeps MVP simple while giving clean place to add function call graph later.

### Candidate Pool

Candidates come from:

- all file paths in `cache.files[]` with `kind: "file"`
- all docs in `cache.docs[]`

For ranking, docs are treated as separate candidates with `kind: "doc"`.

### Text Signals

Task text is lowercased and tokenized on non-alphanumeric boundaries. Ignore
empty tokens and duplicates.

Each candidate gets base score from:

- path segment match against task tokens
- filename match against task tokens
- doc title/body token match
- doc path match
- entry-file boost if candidate path appears in `entryFiles[]`

### Structural Signals

If `options.from` is provided, boost:

- exact anchor file match
- same-directory files
- direct import neighbors in `imports[]`
- import targets/importers one hop away from anchor

If `options.from` does not resolve to known file in cache, no error. Treat as
plain task-only suggest.

### Code vs Doc Balancing

Phase 3 should prefer code files when code and doc matches are similarly strong,
but docs may still rank when match is materially better.

Rule:

- code candidates rank ahead of doc candidates on score ties
- docs remain eligible and can outrank code when score is clearly stronger

This produces "code first, docs allowed when strong" behavior.

### Sorting

Final sort order:

1. score descending
2. `kind === "file"` before `kind === "doc"`
3. path alphabetical

### Reasons

Each returned suggestion includes one short human-readable reason derived from
highest-value signals, for example:

- `matched task terms in path: persistence, restore`
- `near anchor file via imports`
- `entry file with matching repo context`
- `doc title/body strongly matches task`

Reason text is explanation only. It is not parsed by callers.

---

## Freshness Model

`suggest` uses same freshness model as `rehydrate`:

- missing cache → reindex
- stale fingerprint or dirty worktree → reindex by default
- `--stale` / `stale: true` → allow stale cache

Dirty worktree detection includes untracked files via:

```bash
git status --porcelain -unormal
```

This keeps `suggest` behavior aligned with `rehydrate` and avoids stale
recommendations after local edits.

---

## Suggest Orchestrator

`suggest.ts` exports:

```ts
export function suggestRepo(
  repoPath: string,
  task: string,
  options?: SuggestOptions
): SuggestResult
```

### Flow

1. Validate `task.trim()` is non-empty
   - Empty task throws `IndexError` with clear message
2. `resolveRepoIdentity(repoPath)` → identity
3. `readCacheForWorktree(identity.repoKey, identity.worktreeKey)` → cached or
   `null`
4. Freshness check:
   - no cache → `indexRepo(repoPath)`, status = `"reindexed"`
   - stale/dirty + `stale: true` → use cached, status = `"stale"`
   - stale/dirty + no `stale` → `indexRepo(repoPath)`, status = `"reindexed"`
   - clean → use cached, status = `"fresh"`
5. `rankSuggestions(task, cache, { from, limit })`
6. Return `{ cacheStatus, task, from: normalizedFromOrNull, results }`

No `.md` file is written in Phase 3. `suggest` is read-only apart from possible
cache refresh.

---

## CLI

`src/cli.ts` adds:

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

### CLI Flag Semantics

- `--from <file>` — optional anchor path
- `--limit <n>` — optional positive integer, default 5
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

Same as Phase 1/2:

- `0` — success
- `1` — not a git repo or git not found
- `2` — pipeline / argument / ranking error

---

## Error Handling

No new error classes.

`suggestRepo` follows same pattern as `rehydrateRepo`:

- `RepoIdentityError` passes through
- all other errors are wrapped in `IndexError`

Examples:

- empty task
- invalid `limit`
- filesystem or git failures during freshness check

CLI continues using same existing error handler.

---

## Testing

### Unit Tests

**`tests/unit/lib/suggest-ranker.test.ts`**

- task token path match boosts correct files
- doc title/body matches can create doc candidates
- code outranks doc on equal score
- docs can outrank code on materially stronger match
- entry files receive boost
- `from` boosts same-directory files
- `from` boosts direct import neighbors
- limit truncates result set
- stable sort on ties

**`tests/unit/lib/suggest.test.ts`**

- fresh cache → no reindex, status = `"fresh"`
- stale fingerprint → reindex, status = `"reindexed"`
- dirty worktree with untracked file → reindex, status = `"reindexed"`
- stale + `stale: true` → status = `"stale"`
- empty task throws `IndexError`
- invalid limit throws `IndexError`
- passes normalized `from` and `limit` into ranker
- wraps non-identity errors in `IndexError`

### Integration Tests

Extend integration coverage with:

- `suggestRepo(tmpDir, "persistence")` returns ranked results
- untracked file causes auto-reindex before suggest
- `from` anchor changes ranking in expected direction
- CLI text output shape
- CLI JSON output shape
- CLI invalid task / invalid limit exit code path

---

## Out of Scope for Phase 3

- function call graph scoring
- embeddings / semantic vector search
- LLM reranking
- multi-hop graph scoring beyond direct one-hop import relationships
- snippet extraction or file body previews in output
- interactive TUI selection
- non-TS/JS structural graph support beyond existing import extraction

These belong to later expansion, with function call graph as first intended
extension point.
