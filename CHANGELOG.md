# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.1] — 2026-05-02

Patch release tightening the auto-extractor, plugging a benchmark-test data-loss bug, and aligning MANUAL.md with the actual project surface.

### Fixed

- **Auto-extractor noise** — skill bodies, slash-command output templates, system reminders, and shell I/O wrappers were being captured as user prompts because their text hits `IMPERATIVE_RE` / `SYMPTOM_RE` on words like "must"/"should"/"errors". Added `isHarnessInjection(text)` predicate matching known harness markers (`Base directory for this skill:`, `<command-*>`, `<local-command-*>`, `<system-reminder>`, `<bash-*>`, `The user just ran /`, and `# <Title> Skill` first-line skill bodies via `SKILL_HEADING_RE`). Filter applies at compaction (clean source going forward) and defensively in `filterEvidenceAfterTurn` (cleans existing v2 sessions on re-extract, no re-capture needed).
- **Trivial-prompt extraction** — added structural floor `BASE_CONFIDENCE_MIN_BODY_CHARS = 25`: candidates that score exactly at `BASE` (no boost fired) and have <25 char bodies are rejected. Catches throwaway prompts like "okay good" while letting boost-lifted short feedback (correction-prefix or ack snippet) through.
- **Benchmark wiped real cache** — `perf-suite.clearCache()` resolves the real `ai-cortex` `repoKey` when run with `--repo ai-cortex` and `fs.rmSync`'d the cache dir between scenarios. The smoke test spawned the bench without setting `AI_CORTEX_CACHE_HOME`, so every full `pnpm vitest run` wiped `~/.cache/ai-cortex/v1/<ai-cortex-repoKey>/history/` and `memory/`. Smoke test now isolates an `AI_CORTEX_CACHE_HOME` per run; `clearCache()` throws if the env var is unset (running the bench CLI directly against the real cache is now a hard error rather than silent data loss).

### Docs

- **MANUAL.md alignment** — audited and fixed 13 misalignments: storage layout (`index.sqlite` not `memory.db`; `extractor-runs/`, `trash/`, `types.json`); memory CLI table missing `bootstrap` / `extract` / `extractor-log` / `sweep` / `promote` / `install/uninstall-prompt-guide`; MCP tools table missing `extract_session` / `list_memories_pending_rewrite` / `rewrite_memory` / `promote_to_global` / `sweep_aging`; 20 memory tool param blocks said `path (optional)` but actual schemas require `repoKey: string`; `recall_memory` `tags` → `scopeTags` and missing `source` param; new `history` CLI section; bootstrap section now documents `--re-extract` / `--cwd` / `--repo-key`; cache storage layout shows full subdirectory tree; architecture documents the History + Memory data flow (hook → compact → evidence → extractor → dedup → recall); language support lists TS/JS, Python, C/C++ adapters (was "Phase 5 ships TS/JS only"); gotcha severity enum is `info | warning | critical` (was `minor | major | critical`); library API notes that history/memory layers are CLI/MCP-only.

---

## [0.5.0] — 2026-05-02

The memory layer release. ai-cortex grows from "fast project rehydration" into a three-layer local-first intelligence layer: structural (rehydrate / suggest / blast-radius), continuity (history + memory), and integration (MCP + briefing + adoption tooling). The memory layer ships end-to-end — full lifecycle, two-tier storage, auto-extraction from session evidence, aging sweeps, and subagent-driven cleanup. Plus npm distribution, opt-in adoption tooling for Claude / Codex, and a refreshed product narrative.

### Added

#### Memory layer — foundation

- **Markdown-of-record + SQLite + vector sidecar** — memories are typed (`decision`, `gotcha`, `pattern`, `how-to`), scoped (files + tags), versioned with full audit trail, and lifecycle-managed (`candidate` → `active` → `deprecated`/`merged_into`/`trashed` → `purged`). Markdown is the source of truth; SQL index and vector sidecar are derived and rebuildable.
- **Type registry** — extensible JSON config (`types.json`); built-in seed for the four standard types with bodySection + extraFrontmatter validation.
- **Lifecycle functions** — `createMemory`, `updateMemory`, `updateScope`, `deprecateMemory`/`restoreMemory`, `mergeMemories`, `trashMemory`/`untrashMemory`, `purgeMemory` (default + redact modes), `linkMemories`/`unlinkMemories`, `pinMemory`/`unpinMemory`, `confirmMemory`, `addEvidence`, `bumpConfidence`, `bumpReExtract`, `rewriteMemory`. All write through a 3-step protocol: markdown → audit → SQL+FTS+vectors.
- **Retrieval pipeline** — two-stage: SQL scope filter → cosine + recency + confidence linear ranker. Plus FTS-only `searchMemories`, `getMemory`, `listMemories`, `auditMemory`.
- **`reconcileStore` startup recovery** — on-first-call per-repoKey caching detects orphan files, phantom rows, and body-hash drift; `rebuild_index` regenerates the SQL index from `.md` files.
- **Layered config loader** — defaults → user → repo, with extractor / aging / ranking sections.

#### Memory layer — auto-extraction & bootstrap

- **Auto-extractor** — heuristic extraction from session evidence produces candidate memories using regex cues (imperative for decision, symptom for gotcha, how-question + tool-call sequence for how-to, cross-session co-occurrence for pattern). Confidence model is additive: `0.35 base + 0.10 if assistant ACK + 0.10 if user-prompt has correction-prefix`. Default `minConfidence: 0.4` floor.
- **Cross-session deduplication** — cosine ≥ 0.85 + same type + tag overlap collapses near-duplicates. Re-extraction stability bumps existing memory's `confidence` by `+0.10` and `reExtractCount` by 1.
- **`bootstrapFromHistory`** — one-shot extraction over all captured sessions; idempotent on re-run. CLI `memory bootstrap`.
- **Auto-trigger on capture** — `history capture` runs the extractor immediately after compaction; new candidates land within seconds of session end.
- **MCP `extract_session` tool** + CLI `memory extract` / `memory extractor-log` for explicit extraction control.

#### Memory layer — aging & global tier (Phase 2b)

- **`sweepAging`** core — `candidate` → `trashed` after 90d, `deprecated` → `trashed` after 180d, `merged_into` → `trashed` after 90d, `trashed` → `purged` after 90d. `stale_reference` never auto-aged. Dry-run mode previews actions without applying.
- **Low-confidence detection** — emits a more specific reason in audit when `confidence < cfg.aging.lowConfidenceThreshold`.
- **Two-tier storage** — `repoKey="global"` resolves to `~/.cache/ai-cortex/global/memory/`, parallel to project stores. `openGlobalLifecycle` and `promoteToGlobal` (with `promotedFrom` backref + auto `merged_into` on the original).
- **Cross-tier recall** — `recallMemoryCrossTier` runs both stores in parallel and merges results with a `+0.10` source boost for project results so local context outranks global on identical matches.
- **MCP tools** — `sweep_aging`, `promote_to_global`. Plus `record_memory.globalScope` parameter and `recall_memory.source: "project" | "global" | "all"` for tier control.
- **CLI** — `memory sweep`, `memory promote`, `memory recall --source`, `memory record --global-scope` (added later for CLI parity with MCP).

#### Memory layer — utility (Phase 3, this release's headline)

- **Opinionated MCP tool descriptions** — six memory tools rewritten to teach *when* to call, not just *what* they do. Centerpiece: **the cardinal pattern** — `recall_memory` is browse-only and does not signal usage; `get_memory(id)` is the use signal that drives cleanup eligibility.
- **Briefing memory digest** — `renderMemoryDigest` injects a "Memory available — N active, N candidates, N pinned" section + per-type top-5 + "How to consult" guidance into the rehydration briefing. Type-agnostic: queries `DISTINCT type` from SQL rather than iterating a hardcoded list, so user-registered custom types appear too.
- **Access counters** — four new SQL columns (`get_count`, `last_accessed_at`, `re_extract_count`, `rewritten_at`) added via the codebase's first idempotent ALTER TABLE migration. `get_memory` bumps `get_count` and `last_accessed_at`; `recall_memory` does not. Counter columns gate cleanup eligibility and lay the data shape for a future closed feedback loop.
- **`rewriteMemory` lifecycle function** — auto-promotes `candidate → active` (confidence 1.0); errors on terminal states (`merged_into`, `trashed`, `purged_redacted`); validates registry whenever `type` or `typeFields` change; respects `shouldPreserveBody` for audit; audits as `update` with reason `"rewrite"`. The agent's investment in rewriting is the endorsement signal.
- **Subagent-driven cleanup MCP tools** — `list_memories_pending_rewrite(repoKey, limit?, since?)` returns candidates passing the eligibility predicate (`status='candidate' AND rewritten_at IS NULL AND re_extract_count >= 1 AND (pinned = 1 OR get_count > 0)`); `since` filters on `(updated_at OR last_accessed_at)` to catch access-only eligibility. `rewrite_memory(repoKey, id, fields)` applies the cleaned rule card. **MCP-only** — no CLI parity, since manual cleanup would require a user-supplied LLM (contradicts the no-LLM-in-substrate stance).
- **`rewrittenAt` field** — new optional `string | null` on `MemoryFrontmatter`, round-tripping through markdown YAML and SQL.

#### Adoption tooling

- **`memory install-prompt-guide`** + **`memory uninstall-prompt-guide`** — write a versioned guidance block (`<!-- ai-cortex:memory-rule:start v1 -->`) to `CLAUDE.md` and/or `AGENTS.md` so the agent's system context teaches the recall→get pattern from the start. Idempotent on re-install; auto-replaces older versions; surgically removes on uninstall. Default `--scope global` (writes to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`); `--scope project` requires `--yes` to protect repo state. Default `--agent all`; `--agent claude|codex` for explicit control.

#### CLI — meta commands

- **`ai-cortex --version` / `-v` / `version`** — prints `ai-cortex <version>` reading from the bundled `package.json`.
- **`ai-cortex --help` / `-h` / `help`** — top-level command list with one-line descriptions.
- **Update-available notice** — cached daily background check against `https://registry.npmjs.org/ai-cortex/latest`. Non-blocking (runs in detached subprocess); cache at `~/.cache/ai-cortex/update-check.json`. Skips for `mcp` (would corrupt JSON-RPC), version/help (low value), `!isTTY` (CI / pipes), `CI` env var, and `AI_CORTEX_NO_UPDATE_CHECK=1` (escape hatch).

#### Documentation

- **`MEMORY_LAYER.md`** — user-facing technical reference for the memory layer (~430 lines): cardinal pattern, mental model, core loop walked through with CLI/MCP commands at each stage, common flows, storage layout, architectural decisions (pull-only, agent-agnostic, no LLM in substrate), configuration, and limitations.
- **Refreshed `README.md`** — tagline now leads with "local-first intelligence layer"; `npm install -g ai-cortex` as the primary install path; commands section gains memory subcommands and meta commands; MCP tools split into three subtables (project / memory / history) reflecting the actual 30-tool surface; architecture diagram redrawn as three-layer (structural / continuity / integration); Beta tag dropped.
- **Strategy v4** (`docs/misc/ai-cortex-strategy-v4.md`, gitignored) — competitive positioning, three explicit strategic bets (pull-only > push, agent-agnostic, no-LLM-in-substrate), wow-loop with honest gap framing.
- **Product brief v2 + high-level plan v2** (`docs/shared/`) — current-state docs replacing the v1 MVP-era originals (archived to `docs/misc/`).
- **Memory layer design specs** — `2026-04-30-memory-schema-design.md` (Phase 1 schema, lifecycle, extractor) and `2026-05-01-memory-utility-design.md` (pull-only architecture decision, briefing awareness, subagent-driven cleanup).

### Changed

- **MCP tool count** — 12 → 30. New: 21 memory tools (read, write, lifecycle, Phase 2b ops, subagent cleanup), `extract_session`. Existing memory-domain tools got opinionated descriptions teaching the recall→get distinction.
- **`MemoryFrontmatter` type** — gained `rewrittenAt: string | null` (required field). Internal API; no public-API consumers known. Lifecycle constructor sites (`createMemory`, `promoteToGlobal`) initialize to `null`; spread-based update sites carry the existing value forward.
- **`MemoryRow` type** (SQL row mirror) — gained `get_count`, `last_accessed_at`, `re_extract_count`, `rewritten_at` columns.
- **Auto-extractor heuristics** (post-implementation correction) — correction-prefix changed from a hard gate (drop the candidate if the user prompt doesn't start with `actually|wait|no|...`) to a `+0.10` confidence boost. Recovered approximately 30× of previously-dropped signal in real session captures (1.4% → ~35% of available imperative/symptom matches passing the 0.4 floor).
- **`package.json` `homepage`** — `https://github.com/ai-creed/ai-cortex` → `https://ai-creed.dev/projects/ai-cortex/` (the npm "Homepage" link now points at the landing page).
- **`docs/shared/` reorganized** — only durable project-wide knowledge stays (`product_brief.md`, `high_level_plan.md`); historical / point-in-time documents moved to `docs/misc/` (architecture assessment, phase 0 artifacts, project spike, archived v1 docs, gitignored marketing strategy).

### Fixed

- **Aging sweep `prepare<>` generic types** — `better-sqlite3`'s `Statement.all` rejected the `prepare<[], Row>` typing pattern; replaced with `prepare(sql).all(...) as Row[]` matching the rest of the codebase.
- **Misleading low-confidence test** — original test asserted "trashes a low-confidence candidate" but passed for the wrong reason (age, not confidence). Removed alongside dead `confidence` column from aging-sweep query; later re-added with proper low-confidence reason-string detection.
- **`SOURCE_BOOST` scope** — moved from function-local to module-level constant in `retrieve.ts` for testability and readability.
- **CLI `--source` flag validation** — rejected invalid values with clear error message rather than silently casting to a fallback enum value.
- **Promote CLI static import** — `runMemoryPromote` was using a dynamic `import("../reconcile.js")` inconsistent with the rest of the CLI; switched to top-level static import to match codebase convention.
- **Aging test fixture migration** — earlier extractor fix changed the iteration source from `corrections` to `userPrompts`; `tests/integration/memory-extract-cli.test.ts` fixture wasn't migrated and was producing 0 candidates instead of the expected 1.
- **Spec-review fixes during memory utility shipping** — `rewrite_memory` now validates registry on `type` change AND on `typeFields` change (not only `type`); `since` filter on the pending-rewrite queue checks `(updated_at >= ? OR last_accessed_at >= ?)` so months-old candidates accessed today via `get_memory` aren't excluded; `rewriteMemory` auto-promotes `candidate → active` (was leaving status as `candidate`, making rewrite cosmetic — recalled and aged out anyway).

### Internal

- **First SQLite migration in the codebase** — idempotent `ALTER TABLE ADD COLUMN` pattern in `openMemoryIndex`, swallowing only `duplicate column name` errors. Sets the convention for future schema extensions.
- **`logged()` middleware** wraps every MCP tool handler — call telemetry already captured, ready for adoption-aggregation work in v0.6.
- **913 → 939 tests passing** on master. One pre-existing flake (`readPackageVersion` worktree-path bug) — only visible when running tests inside a git worktree; unaffected in production CLI use.

### Known limitations (new this release)

- **Memory extractor is heuristic.** Regex-based; misses well-phrased decisions that don't match imperative/symptom cues even after the boost-not-gate fix recovered ~30× of dropped signal. An LLM-based extractor (running in user's subagent, no LLM in substrate) is a deferred future direction.
- **Memory recall on short / abbreviation-heavy queries can be weak.** Default `Xenova/all-MiniLM-L6-v2` (22M, 384-dim) handles general-English thematic matches but struggles with `cxx` ≠ `c++` and multi-hop semantic chains. Larger models (`bge-small`, `e5-small`) are deferred.
- **Closed feedback loop is foundational only.** Counters in place; reconciliation logic ("did the agent violate this rule after recalling it?") is deferred until adoption telemetry validates demand.
- **Cosmetic zsh warning during `$()` capture on macOS.** Worker threads from `@xenova/transformers` interact with zsh job control during command substitution, emitting a benign `failed to change group ID` warning. Direct invocations are unaffected. Workaround: pipe to file or `2>/dev/null` the substitution.

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
