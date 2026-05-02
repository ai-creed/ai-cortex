# ai-cortex Architecture Assessment

**Date:** 2026-04-29

**Scope:** current repository shape before Python support is added

## Overall Assessment

The codebase is in decent beta shape, but it is not yet fully hardened for
larger-repo scale or broader language support.

Current architecture score: **7/10**

Why this is a positive score:

- the top-level product split is clean
- the library surface is small and understandable
- indexing, suggestion, MCP, and history are distinct capabilities
- there is already meaningful investment in tests and incremental indexing

Why it is not higher yet:

- cache lifecycle logic is duplicated across flows
- the hot path is still dominated by synchronous I/O
- parsing and indexing work is repeated more than necessary
- release/build consistency is weaker than the source layout suggests
- some internals are starting to become shared gravity wells rather than clear services

## What Is Working Well

### 1. Clear top-level product boundary

The repo has a good high-level split between:

- CLI in `src/cli.ts`
- MCP server in `src/mcp/server.ts`
- core library exports in `src/lib/index.ts`

That is the right shape for a tool that needs multiple delivery surfaces over
the same core behavior.

### 2. Useful internal capability separation

The repo already separates major concerns reasonably well:

- indexing
- suggestion and ranking
- call graph extraction
- embedding and vector sidecars
- session history capture/search

For a single-package project at this size, this is a good tradeoff. It keeps
the repo understandable without premature package splitting.

### 3. Incremental indexing already exists

`buildIncrementalIndex()` is a strong architectural decision. It shows the
codebase is already moving toward scalable refresh behavior instead of forcing
full reindex on every query path.

### 4. The codebase is test-oriented

This is not a throwaway tool. The presence of unit, integration, benchmark, and
eval coverage means the project already has the right instinct for change
safety.

## Main Structural Weaknesses

### 1. Cache lifecycle logic is duplicated

`suggestRepo()` and `rehydrateRepo()` each implement their own cache freshness,
dirty-worktree, stale, and incremental-refresh logic.

This is the clearest maintainability issue in the current architecture.

Risks:

- behavior drift between commands
- harder future changes for Python support
- more regression risk when cache policy evolves

Recommendation:

- extract one shared cache coordinator or repo-state service
- make all user-facing flows consume the same freshness policy

### 2. Too much synchronous I/O in hot paths

A large part of the request path relies on blocking operations:

- git shell calls
- cache reads and writes
- content scanning
- file discovery
- history storage and retrieval

This is still acceptable for a local beta tool on modest repos, but it will
become a visible bottleneck as file counts, session counts, and embedding work
grow.

Recommendation:

- move toward async I/O on repo scan, cache, history, and query-time scan paths
- treat synchronous code as an implementation shortcut, not the long-term model

### 3. Repeated work during indexing

The indexing pipeline is not yet organized around a single parse pass per file.
Today the system does multiple passes that re-read and re-process files for
imports, call graph extraction, hashing, and content access.

This is the biggest performance architecture gap.

Recommendation:

- introduce a shared per-file analysis result
- compute imports, functions, calls, and metadata from one source parse where possible
- keep hashing and content metadata close to the file-read boundary

### 4. Internal modules are growing as utility hubs

Some files are already large enough to show early pressure:

- `src/cli.ts`
- `src/mcp/server.ts`
- `src/lib/suggest.ts`
- `src/lib/suggest-ranker.ts`
- `src/lib/call-graph.ts`
- `src/lib/history/store.ts`

This is not yet a crisis, but it is a signal. The codebase is still organized,
yet several modules are starting to own too much orchestration logic.

Recommendation:

- split orchestration from formatting and transport
- move toward service-style modules instead of accumulation in utility files

## Scalability Assessment

## Repo Scale

The architecture should handle small to medium repositories reasonably well in
its current form.

The current design will start to strain when any of the following increase:

- total file count
- markdown/doc volume
- number of supported languages
- session history size
- frequency of repeated MCP queries in one session

## Language Scale

The current design is still TypeScript/JavaScript-first with C/C++ added via
adapter loading. That is fine for the present stage.

However, Python support will increase pressure on three areas:

- adapter lifecycle and parser capability loading
- cache schema evolution
- cross-language ranking consistency

The right next move is not package splitting. It is stronger internal contracts
for language adapters and a more centralized indexing pipeline.

## Session History Scale

History search is conceptually useful but structurally still simple. It scans
sessions sequentially and repeatedly re-reads stored data.

That is fine for early usage but will not age well for large personal history
stores.

Recommendation:

- add a lightweight session manifest/index layer
- avoid full scans for common query paths
- treat embeddings as an acceleration layer, not the only search strategy

## Performance Assessment

## Good current decisions

- incremental refresh exists
- sidecar vector storage avoids bloating the main repo cache
- deep ranking uses bounded candidate pools and a content-scan budget

These are good performance instincts.

## Main performance costs

### 1. Blocking repo operations

Git commands and file reads are synchronous throughout the core path.

### 2. Serial embedding work

Vector building and refresh embed file paths one item at a time. This keeps the
logic simple but leaves throughput on the table.

### 3. Repeated parse and scan work

The same repo data is touched in multiple stages instead of flowing through one
analysis pipeline.

### 4. Query-time history and content scanning

Both content scan and history lookup remain straightforward scans. This keeps
implementation simple, but the performance ceiling is lower.

## Operational and Release Concerns

The current repo shape has at least two operational signals that matter:

### 1. Built output can drift from source

The current `dist` output in this workspace does not match the source CLI
behavior. That means release confidence is currently weaker than the source tree
suggests.

### 2. Version metadata is manually duplicated

The MCP server version is hardcoded and already out of sync with
`package.json`.

Recommendation:

- make build freshness part of test or release gates
- derive version metadata from one source of truth
- treat packaging/runtime consistency as part of architecture quality

## Recommended Improvement Order

### Priority 1

- extract a shared cache lifecycle coordinator used by `rehydrate`, `suggest`,
  and future Python-aware flows

### Priority 2

- reorganize indexing around a single per-file analysis pipeline

### Priority 3

- reduce synchronous I/O across cache, scan, history, and git interaction paths

### Priority 4

- harden adapter loading and graceful degradation for optional language support

### Priority 5

- add release/build consistency checks so `src` and `dist` cannot drift silently

### Priority 6

- introduce lightweight indexing for history search rather than full session scans

## Recommendation For Python Support

Python support should be added on top of stronger internal contracts, not by
copying the current C/C++ integration pattern directly.

Before or alongside Python support, the project should:

- define a stricter adapter contract
- centralize parse/output flow for all languages
- separate language capability loading from query orchestration
- keep cache evolution explicit and versioned

If Python is added before those boundaries improve, the codebase will still
work, but complexity will start compounding faster than the current structure
can absorb cleanly.

## Final Judgement

The project has a solid product architecture and a decent repository shape for a
beta local-first tool. The main weaknesses are not conceptual. They are
execution-shape issues:

- duplicated lifecycle logic
- too much synchronous I/O
- repeated indexing work
- insufficient release/runtime hardening

This is a good foundation to keep building on. The next step is internal
hardening for scale, not a broad structural rewrite.
