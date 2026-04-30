# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.4.0] — 2026-04-30

First stable release. Drops the beta designation.

### Added

- **Python language adapter** — full import graph, call graph, and function extraction
  for `.py` files via tree-sitter-python. Supports flat layouts, src-layouts, and
  multi-root `pyproject.toml` projects. Resolves relative imports, package-root
  discovery via `setup.cfg`/`pyproject.toml`, and qualified method calls.
- **History session manifest** — append-only `manifest.jsonl` alongside sessions
  directory enables O(1) session ID enumeration and optional date-range narrowing
  before full session loads. Falls back to directory scan for existing history stores.
- **Adapter capability registry** — formal `LanguageAdapter` interface with
  `AdapterCapabilities` flags; `getAdapterForFile` and `adapterSupports` registry
  functions replace ad-hoc extension checks in `import-graph.ts` and `call-graph.ts`.

### Fixed

- **Linux adapter race condition** — concurrent `Parser.init()` calls from parallel
  adapter factories produced multiple Emscripten instances, leaving grammar data
  relocations unapplied (ABI version 0). Fixed by serializing `Parser.init()` before
  the parallel factory `Promise.all`.
- **Python phantom edges** — nested function definitions no longer emit call edges
  from uncollected caller nodes; multi-root `pyproject.toml` discovery no longer
  over-matches inline comments in `setup.cfg` `package_dir`.

### Changed

- **Async I/O throughout hot paths** — `cache-store`, `entry-files`, `import-graph`,
  `vector-builder`, `vector-sidecar`, `indexable-files`, and `history/store` fully
  migrated from sync `fs.*` calls to `fs.promises.*`. `getCachedIndex` is now async
  (the one public signature change in this release).
- **Cache lifecycle coordinator** — duplicated cache freshness logic extracted from
  `suggestRepo` and `rehydrateRepo` into a shared `resolveCacheWithFreshness`
  function, eliminating policy drift between the two callers.
- **Single-pass content buffer** — `buildIndex` now reads each source file once via
  `readFileContents` and passes the content map to `extractImports`, `extractCallGraph`,
  and `hashFileContent`, reducing per-file I/O from 2–3 reads to 1.
- **Version drift detection** — `SERVER_VERSION` in `mcp/server.ts` now imports from
  `src/version.ts`; a CI test asserts the module value matches `package.json` on every
  run, making silent version drift a build failure.

---

## [0.3.0-beta.6] — 2026-04-10

### Added

- **C/C++ language adapter** — function extraction, `#include` import graph, and
  call graph resolution for `.c`, `.cpp`, `.h`, `.hpp` files via tree-sitter-c and
  tree-sitter-cpp. Namespace and class-qualified method calls supported.
- **`blast_radius` MCP tool** — BFS traversal of the call graph from a changed
  function; surfaces affected callers with confidence signals.
- **Overload aggregation** — `blast_radius` aggregates overloaded function callers
  and surfaces `overloadCount`.
- **Adapter-driven import graph** — `import-graph.ts` refactored to route through
  the `LangAdapter` registry; canonical path resolution shared across languages.
- **`isAdapterExt` / `adapterExtensions`** — registry helpers for extension-based
  adapter lookup.

### Fixed

- C/C++ include edge lookup gated to cfamily adapter; cross-file resolution
  requires exported declarations.
- Function-pointer variables excluded from C/C++ declaration extraction.
- Incremental reindex calls `ensureAdapters` before extension filtering.
- TS import candidate strips `.ts` extension for correct `resolveSite` lookup.

---

## [0.3.0-beta.5] — 2026-03-28

### Added

- **Session history capture** — Claude Code and Codex hook integration that records
  conversation turns, extracts rule-based evidence, embeds chunk vectors, and persists
  sessions to `~/.cache/ai-cortex/v1/<repoKey>/history/`.
- **`search_history` MCP tool** — lexical and semantic search across captured sessions
  with scope resolution and auto-broadening.
- **Per-session lock** with stale recovery for concurrent capture safety.
- **`history` CLI subcommands** — `capture`, `list`, `prune`, `on`, `off`, `hooks`.
- Hook install/uninstall for Claude Code hooks shape.

### Fixed

- Session ID validation to prevent path traversal.
- Hook capture reads `session_id` from stdin JSON rather than env assumptions.

---

## [0.3.0-beta.4] — 2026-03-15

### Fixed

- Excluded `dist/tests` from npm package `files` field.
- CI: skips redundant pnpm build in `beforeAll` when `dist` already exists.

---

## [0.3.0-beta.3] — 2026-03-12

### Added

- **CI workflow** — GitHub Actions build and test on push/PR.
- npm publish workflow on version tags.

---

## [0.3.0-beta.2] — 2026-03-08

### Added

- **`suggest_files_semantic` MCP tool** — embedding-based semantic file ranking.
- **`suggest-semantic` CLI subcommand**.
- MCP tool descriptions updated to prefer ai-cortex for discovery tasks.

---

## [0.3.0-beta.1] — 2026-03-01

### Added

- **Semantic ranker** (`mode: semantic`) — `@xenova/transformers` embedding provider
  with L2 normalization, vector sidecar I/O, and singleton cache.
- **`suggest_files_deep` MCP tool** and `suggest-deep` CLI subcommand — superset
  ranker combining trigram index, content scan, and call graph signals.
- **Trigram index** — on-demand Jaccard similarity index for deep ranking pool.
- **Content scanner** — query-time grep with hit cap and budget guard.
- Ranker quality benchmark harness with 20-PR target-repo corpus.

### Changed

- `suggest_files` MCP tool defaults to deep mode.
- Call graph scoring signals wired into suggest ranker.
- Shared camelCase/snake tokenizer with stopwords.

---

## [0.1.0-beta.1] — 2026-02-01

Initial release.

### Added

- Core indexing pipeline: `indexRepo`, `getCachedIndex`, `buildIncrementalIndex`.
- Rehydration: `rehydrateRepo` with dirty worktree detection and briefing renderer.
- Suggest: `suggestRepo` with fast ranker, anchor file (`--from`), call graph signals.
- MCP server with `index_project`, `rehydrate_project`, `suggest_files` tools.
- Git-aware cache with fingerprinting, incremental diff, and schema versioning.
- TypeScript/JavaScript tree-sitter adapter with import graph and call graph.
- SHA-256 content hashing for changed-file detection.
- Evaluation harness for A/B ranking experiments.
- Benchmark suite with performance and quality scenarios.
