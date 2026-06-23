# Design: Library (cross-project document retrieval)

status: proposed
date: 2026-06-23
related:
- seed: docs/ideas/cortex-knowledge-base.md
- deliberation: docs/superpowers/deliberations/2026-06-22-cortex-knowledge-base.md
- memory: mem-2026-06-23-doc-kb-o6-utility-metric-must-measure-b6f971 (O6 must measure visibility + downstream-touch, never consumption)
- memory: mem-2026-05-02 (ai-cortex never writes into the target repository)
- memory: mem-2026-05-19 (proactive surfacing push-only, precision-first)

## Summary

The library is a user-global, source-based document retrieval primitive for ai-cortex. It lets an agent ask "what do we know about topic X" and get cited passages drawn from documents across all of the developer's projects, ranked so that material from the project the agent is currently working in surfaces first. It is the raw-document counterpart to the memory layer: where memory captures the why (curated decisions and rationale), the library serves the how and what (the actual document passages, with provenance).

Retrieval is hybrid (lexical full-text plus semantic embeddings, fused and reranked). The store is decoupled from git: the organizing unit is an owner-registered source (a directory), not a repository. A repository's docs directory is just one kind of source. The current worktree is used only as a ranking signal (origin affinity), never as a partition.

The design honors every durable ai-cortex principle: cache-only with no writes to source repositories or directories, rebuildable derived indexes, freshness-aware results, no daemon, no LLM in the substrate, and an agent-agnostic MCP surface.

## Goals and non-goals

Goals (mapped to the ratified deliberation objectives):

- O1: make document content answerable by intent at passage granularity with provenance (cited file, line span, heading path).
- O2: serve retrieval across the developer's project set, not a single repository. This is the headline capability and is in scope from v1.
- O3: position the library against the memory layer, not on top of it. The library stores raw passages and curatorial metadata; it never writes rationale into the memory store.
- O4: index the corpus as it actually is, heterogeneous and partly gitignored, by walking the filesystem rather than deferring to git.
- O5: honor the trust and architecture contract (cache-only, rebuildable, freshness-aware, no LLM in substrate, agent-agnostic MCP, no daemon).
- O6: instrument utility (visibility plus a downstream-touch proxy) so future scaling decisions rest on evidence, never on a consumption signal.

Non-goals:

- No chat-over-docs product and no LLM inside the substrate.
- No team or cloud-shared knowledge base. The library is local and user-owned.
- No automatic writing into any source directory or repository.
- No background daemon or file watcher shipped by ai-cortex.

## Key decisions

| Area | Decision |
|---|---|
| Name | library (CLI `cortex library ...`, MCP `library_search` and friends) |
| Gitignored docs | Include valuable ones via a new filesystem doc-walker; discriminate by location and file type, not by gitignore status |
| Scope | Cross-project from v1 |
| Taxonomy | Source/collection-based, user-global; provenance per document (origin, topic, value, content); origin-affinity ranking |
| Retrieval engine | Hybrid: lexical (FTS5 BM25) plus semantic (embeddings), fused with Reciprocal Rank Fusion, then reranked |
| Embedding model | bge-small-en-v1.5 or gte-small (384-dim, 512-token cap), drop-in via embed-provider; index records modelId and dim; chunker is model-aware |
| Vector store and scaling | Vectors resident in SQLite, queried on demand; bounded per-source top-K, bounded fan-out, no whole-matrix load, no monolith memoization; ANN backend (sqlite-vec) deferred behind an interface |
| Doc identity | Hybrid: path-based id primary, content-hash relink hint on reindex |
| Freshness | Lazy staleness flag on returned results plus explicit reindex; no daemon, no auto-reindex on query |
| Authority/value (F2) | Minimal intrinsic signal in v1 (docType, Status/version header, mtime, owner pin); active conflict detection and annotation-derived value deferred |
| Curation | Seam designed now (stable id, annotations survive reindex, retriever reads when present); annotate tool and librarian cron deferred |
| Code structure | Self-contained module at src/lib/library with a single public entrypoint and a sealed store layer |
| O6 telemetry | Visibility plus downstream-touch proxy; never consultation-gated; quantitative gate threshold set before use |

## Architecture overview

```
register source -> walk -> chunk -> index (FTS + embeddings + provenance/value)
                                          |
query -> [lexical FTS] + [semantic vector] -> fuse (RRF) -> rerank (origin-affinity + value) -> cited passages
```

The library is a user-global primitive. It lives in the global cache, not under any repoKey, paralleling the existing global memory tier which is already a non-repo-keyed cross-project store.

### Components

1. source-registry. Register, list, remove, and update sources. Persists source config. Opt-in lives here: nothing is indexed until a source is registered.
2. doc-walker. Filesystem walk with a prune heuristic plus owner override globs. Emits doc-type files. Decoupled from the git-based indexable-files.
3. doc-chunker. Section-parse markdown into passages (heading-window) with citation anchors. Model-aware (max passage size bounded by the embedding model token cap).
4. indexer. Build and refresh per-source index sidecars (FTS5 plus metadata, passage embeddings, manifest). Incremental by content hash and mtime. Rebuildable from source.
5. retriever. Hybrid query: lexical plus semantic, RRF fusion, origin-affinity and value rerank, freshness flagging. Precision-first.
6. library-mcp. Thin MCP tool handlers that delegate to the module public API. Passes worktreePath as origin-affinity context only.
7. telemetry. O6 instrumentation: visibility plus downstream-touch proxy.

## Module structure

```
src/lib/library/
  index.ts            # PUBLIC API barrel; the only path the rest of the app imports
  types.ts            # SourceRecord, Passage, LibraryHit, Annotation, ValueSignal, ...
  source-registry.ts  # component 1
  doc-walker.ts       # component 2
  doc-chunker.ts      # component 3
  indexer.ts          # component 4
  retriever.ts        # component 5 (plus fusion/rerank helpers)
  telemetry.ts        # component 7
  store/
    schema.ts         # FTS5 and metadata table defs
    index-store.ts    # index.sqlite (FTS5 + resident vectors), manifest.json
    annotation-store.ts  # annotations.sqlite, survives reindex, keyed by docId
  library.test.ts     # colocated tests (or __tests__/)
```

Boundary rules:

- One entrypoint. The rest of the codebase imports only from library/index.ts. Internals may move freely.
- One-way dependency. The module consumes shared infrastructure through their public APIs (embed-provider for embeddings, the repo-identity derivation for repoKey, session-history for the O6 downstream-touch proxy). Nothing reaches back into library internals.
- Thin MCP and CLI. Tool handlers and CLI subcommands validate arguments and delegate; no logic lives in the harness layer.
- Sealed store. Only the module components touch store/. SQLite and vector details never leak past the module boundary.

## Storage layout

```
~/.cache/ai-cortex/v1/library/
  sources.json            # registry
  <sourceId>/
    index.sqlite          # FTS5 rows + passage metadata + vector BLOBs (resident, queried on demand)
    manifest.json         # file -> {contentHash, mtime, completed}; records {modelId, dim}
    annotations.sqlite    # docId -> annotation; NOT dropped on reindex
  taxonomy/               # reserved for future cross-source librarian reorg; unused in v1
```

## Data model

SourceRecord:

- id: stable source id
- rootPath: absolute path
- kind: repo or dir
- origin: { repoKey? (when kind is repo), name }
- includeGlobs: string[]
- excludeGlobs: string[]
- addedAt, lastIndexedAt
- status: ok or errored, with a reason

Passage:

- docId: stable document id (see Doc identity)
- ordinal: passage index within the doc
- headingPath: string[] (the chain of headings above this passage)
- text
- lineStart, lineEnd
- contentHash (of the doc, for change detection and relink)

LibraryHit (returned to callers):

- snippet
- citation: { sourceId, filePath, lineStart, lineEnd, headingPath }
- origin: { repoKey?, name }
- value: ValueSignal
- freshness: fresh or stale

ValueSignal (v1, intrinsic):

- docType: derived from path (for example specs and deliberations outrank ideas and drafts)
- statusHeader: parsed Status or version header if present
- mtime
- pinned: boolean (owner pin)

Annotation (written by an external agent, deferred tool):

- docId
- summary
- labels: string[]
- topics: string[]
- value: an override or supplement to the intrinsic ValueSignal
- relatedDocs: docId[] (dedup or supersession hints)
- provenance: { author, model, timestamp }

## Doc identity

docId is path-based primary, with a content-hash relink hint.

- Primary: docId = hash(sourceId + relativePath). Simple and predictable. Content edits never change the id, so annotations survive edits.
- Relink: the manifest also stores each doc content hash. On reindex, if a path disappears and an identical content hash appears at a new path, the indexer relinks annotations from the old docId to the new one. This recovers annotations across a pure rename or move.
- The relink is best-effort. If both the path and content change substantially, the doc is treated as new and prior annotations are dropped. The future librarian can re-link manually.

## Retrieval pipeline

Inputs: query string, context { currentRepoKey?, sourceFilter? }, topN.

1. Lexical. FTS5 BM25 query across the selected sources, producing ranked list L over passages (text plus headingPath are indexed).
2. Semantic. Embed the query with the configured model. For each selected source, run a bounded top-K nearest-neighbour search against that source vectors resident in SQLite (a streaming cosine scan with a small top-K heap in v1, never loading the whole vector set into the heap), then merge the per-source top-K into ranked list S. See Performance and scalability.
3. Fuse. Reciprocal Rank Fusion of L and S. RRF is parameter-light and needs no score normalization across the two retrievers.
4. Rerank. Apply an origin boost when passage origin repoKey equals currentRepoKey (mirrors the existing cross-tier memory boost idiom), plus a value weight derived from annotations when present, otherwise from the intrinsic ValueSignal.
5. Freshness guard. Stat only the files behind the returned topN passages, compare to manifest mtime, and flag any as stale. Stale passages are flagged, never silently dropped.
6. Return topN LibraryHit objects with snippet, citation, origin, value, and freshness.

Precision-first. Per the surfacing precision lesson, the retriever uses conservative thresholds, caps results, and prefers fewer strong hits. Cross-source bleed (surfacing one project convention into another) is mitigated by origin transparency on every hit and by thresholding, not by hiding cross-source results.

## Embedding model and chunking

- Default model: bge-small-en-v1.5 or gte-small. 384-dim (no storage or fan-out penalty versus the current model), 512-token input cap (twice the prior MiniLM-L6 cap), better retrieval quality, drop-in behind embed-provider.
- The index is model-aware. manifest.json records modelId and dim. Changing the model invalidates and rebuilds that source vectors; vectors from different models are never mixed.
- The chunker is model-aware. Maximum passage size is bounded by the model token cap so passages are never silently truncated. Long sections split with a small overlap.
- Upgrading to a 768-dim or longer-context model later is supported without architectural change. The decision should rest on a quality and throughput benchmark on the actual corpus (folded into the open build-cost item below).

## Performance and scalability

Context: today the semantic ranker reads an entire vector sidecar into one Float32Array and brute-force scans it (vector-sidecar.ts readVectorIndex, suggest-ranker-semantic.ts cosineTopK). At file granularity for a single repo this is fine. The library changes two things that make a naive port a known scaling risk (see memory mem-2026-05-30-structural-cache-is-loaded-whole-into-75693b): embeddings move to passage granularity (roughly 4k to 12k vectors per source instead of one per file), and retrieval fans out across N sources. Loading every source whole-matrix per query would allocate tens to hundreds of MB into the JS heap per call with GC churn, which is exactly that structural-cache ceiling. The compute (brute-force cosine) is cheap; the cost is the load and heap spike.

Design rules that avoid it:

- Vectors are resident in SQLite, queried on demand. There is no monolithic vectors.bin loaded whole. This is the prescribed ceiling-remover from the memory.
- Bounded per-source top-K. The retriever scans each source vectors with a small top-K heap and never materializes the full set in the JS heap. Per-query memory is bounded by K and dim, not by corpus size.
- Bounded fan-out. Only registered sources are queried; sourceFilter narrows further; origin-affinity lets the current source be prioritised. The lexical FTS5 half is disk-backed and indexed, so it is bounded regardless of corpus size.
- No long-lived monolith memoization. Per the trap in the memory: the STDIO one-process-per-client model means transient per-call work. We must not cache a global vector matrix in a long-lived process, which would convert transient spikes into a sustained N-source resident heap.
- ANN upgrade path. The vector store sits behind an interface. If a corpus benchmark shows the streaming top-K scan is too slow, an approximate-nearest-neighbour backend (for example the sqlite-vec loadable extension, feasible via better-sqlite3 loadExtension) drops in without touching callers. Deferred until a benchmark justifies the added native-extension packaging cost.

## Freshness model (no daemon)

- Lazy staleness on results. Queries stat only the returned topN files, not the whole corpus, and flag stale hits.
- Explicit reindex. library_reindex (and the CLI equivalent) runs the full incremental manifest diff: new and changed files are re-chunked and re-embedded, deleted files are purged, unchanged files are skipped, and annotations are re-attached by docId. A user may wire this to their own opt-in cron later; ai-cortex ships no daemon.
- Status reporting. library_list_sources can report per-source staleness counts via an opt-in stat pass.

Rationale: a search never triggers a heavy rebuild, so query latency stays predictable, and the no-daemon principle holds.

## Authority and value (F2)

v1 ships a minimal, intrinsic, deterministic value signal (docType, Status or version header, mtime, owner pin), surfaced as metadata on each hit so the agent can judge. There is no LLM and no active conflict detection in the substrate.

Deferred (designed via the seams, not built in v1):

- Active cross-reference to superseding memories: when surfacing a passage, check whether a memory deprecates or contradicts the source document.
- Annotation-derived value from the librarian.

## Curation seam (designed now, built later)

The librarian is a future external agent (for example a nightly cheap-LLM cron) that calls an MCP tool to write annotations. It is not substrate logic, which keeps the no-LLM-in-substrate rule intact: the substrate only stores what an agent hands it, exactly as memory works today.

Three seams make it possible without retrofitting:

1. Stable document identity (see Doc identity). Everything curated keys off docId, so re-walking and re-embedding never orphan annotations.
2. Annotations stored separately from the rebuildable index, in annotations.sqlite keyed by docId. A reindex rebuilds index.sqlite and vectors.bin and re-attaches annotations by docId; it never drops them.
3. The retriever reads annotations when present and falls back to intrinsic signals when absent. The library works fully on day one with zero annotations and improves as curation accrues. No hard dependency.

Reserved and not built in v1: the MCP tool library_annotate_document(docId, {...}) and the librarian cron. Schema reserved, write path designed, implementation deferred.

Boundary: library annotations are curatorial document metadata (summary, topics, value, dedup and related hints). They are not rationale and never enter the memory store. The librarian organizes the library; it does not write memory.

## O6 instrumentation

Per the recorded gotcha, the library never measures consumption and never gates an action on a consult. It measures:

- Visibility: per search, the query, the number of sources queried, the number of hits, and whether anything was returned.
- Downstream-touch proxy: by correlating with the existing session-history capture, whether a returned doc file was opened, edited, or cited later in the same session.

Metrics: retrieval fired rate, returned-nonempty rate, downstream-touch rate, and in-repo versus cross-source hit ratio. A quantitative gate threshold (for example a downstream-touch rate over a window of sessions) is set before any scaling decision rests on it. The instrumentation is also designed to distinguish in-repo from cross-source utility so the cross-project value is measured, not assumed.

## MCP and CLI surface

MCP tools (handlers thin, logic in the module):

- library_search(query, { sources?, topN? }). Main retrieval. worktreePath is mapped to currentRepoKey for origin affinity only, never as a partition or a gate. Read-only.
- library_register_source(rootPath, { label?, include?, exclude? }). Opt-in registration.
- library_list_sources(). Sources plus status (lastIndexed, docCount, staleness).
- library_reindex({ sourceId? }). Rebuild or refresh, all sources or one.
- library_annotate_document(docId, {...}). Reserved, deferred.

Tool schemas are deferred-loaded, consistent with the rest of the ai-cortex MCP surface.

CLI: cortex library register, list, reindex, and search subcommands as thin wrappers over the module public API.

## Doc-walker rules

- Prune directories: a built-in denylist (node_modules, dist, build, out, .next, .svelte-kit, .turbo, coverage, vendor, .venv, venv, target, .cache, .git, tmp) plus the source excludeGlobs.
- Include: doc extensions (.md, .mdx, .markdown, .txt, .rst, .adoc) plus the source includeGlobs.
- Default secret excludes: a conservative built-in exclude for obvious secret-bearing patterns (.env*, *secret*, *.key, *credential*), which an owner may override.
- Guards: skip files over a size cap to avoid giant generated files; do not follow symlinks out of the source root to avoid cycles and escapes into pruned directories.
- The walker is read-only and never writes into the source.

## Error handling

- Source path missing or unreadable: mark the source errored in the registry, skip it in search, surface it in list_sources. Search never crashes.
- Embedding model load failure: the retriever falls back to lexical-only (FTS still works) and warns. Hybrid degrades rather than dies.
- Corrupt or locked index.sqlite: rebuild from source (the rebuildable invariant). Annotations live in a separate store and are never lost.
- Interrupted build: the manifest tracks per-file completion, so a reindex resumes. Search works on whatever is already indexed.
- No sources or empty corpus: search returns empty plus a hint to register a source.
- Oversized, binary, non-utf8, or symlink-cycle files: the walker skips them with a recorded reason.

## Edge cases

- Two documents with identical content in different sources: both returned, origin distinguishes them; future librarian dedup via annotations.
- Same path across reindex with changed content: docId stable (path-based), content-hash triggers re-embed, annotations survive.
- Rename or move within a source: handled by the content-hash relink hint.
- Nested sources (a source inside another already-registered source): the registry detects the overlap and warns to avoid double-indexing.
- Secret-bearing docs in gitignored space: gated by opt-in registration, the default secret excludes, and owner excludeGlobs.
- Large monorepo source: indexer reports progress and is resumable.
- Non-English or code-heavy docs: the English embedding model is weaker, but the lexical half compensates.
- Query language differs from doc language: semantic recall is weaker; acceptable for v1.

## Testing strategy

Test-driven, unit per component with fixtures, then integration.

- doc-walker: temporary directory trees with node_modules, dist, .git, symlinks, oversize files, and real docs. Assert prune and include correctness and secret excludes.
- doc-chunker: markdown fixtures with nested headings, long sections, and non-markdown. Assert passage boundaries, line spans, heading paths, and model-aware size bounding.
- indexer: build asserts FTS rows, vector count, and manifest including modelId and dim. Incremental change, add, and delete assert minimal rework and annotation re-attach. Model change asserts full vector rebuild.
- retriever: seeded index asserts lexical-only, semantic-only, fusion order, origin boost (same-repo ranks above), value rerank, freshness flag, and the precision cap.
- source-registry: register, list, remove, update, repo-kind detection, and opt-in (nothing indexed until registered).
- annotation-store: write an annotation, reindex, assert it survives and is re-attached by docId; assert relink across a simulated rename.
- telemetry: search asserts visibility recorded; downstream-touch proxy correlation with a mocked session-history.
- Integration: register, index, and search across two sources. Assert cross-source results, origin-affinity ordering, and citations.

Cache isolation: tests set AI_CORTEX_CACHE_HOME and never touch the real cache or any repository. Run CI=true pnpm test before any release.

## Build order

v1 (in scope):

1. types and store schema (index-store, annotation-store, manifest with modelId and dim).
2. source-registry (opt-in, repo-kind detection).
3. doc-walker (prune heuristic, includes, secret excludes, guards).
4. doc-chunker (model-aware heading-window, citation anchors).
5. indexer (build, incremental, content-hash relink, embed via embed-provider with the new default model, vectors written resident in SQLite).
6. retriever (lexical FTS, semantic bounded per-source top-K over resident vectors, RRF fusion, origin-affinity and value rerank, freshness flag).
7. library-mcp and CLI (thin handlers).
8. telemetry (visibility plus downstream-touch proxy).
9. integration tests across two sources.

Deferred (designed, not built):

- library_annotate_document tool and the librarian cron.
- Active conflict detection against superseding memories.
- Cross-source taxonomy and reorg.
- Step-up to a 768-dim or longer-context embedding model, pending a corpus benchmark.
- ANN vector backend (sqlite-vec) behind the vector-store interface, pending a latency benchmark.

## Open and unverified items

- Embedding build cost on the corpus is unverified (roughly 4k to 12k chunks on CPU). Benchmark quality and throughput across MiniLM, bge-small, and bge-base before committing to a heavier model. The indexer must show progress and be resumable regardless.
- Vector-search latency at passage scale across N sources is unverified. Benchmark the streaming top-K SQLite scan; if too slow, evaluate an ANN backend (sqlite-vec) behind the vector-store interface.
- The O6 gate threshold (the downstream-touch rate that justifies further investment) is set from early telemetry, not guessed up front.

## Principle compliance checklist (O5)

- Cache-only: all state under ~/.cache/ai-cortex/v1/library. No writes to any source. Confirmed by the read-only walker and the no-write memory.
- Rebuildable: index.sqlite (including resident vectors) rebuilds from source at any time. Annotations are the only non-rebuildable state and are isolated.
- Freshness-aware: stale passages are flagged on results, never served as fresh.
- No LLM in substrate: embeddings are local; any LLM (the librarian) is an external agent calling a tool.
- Agent-agnostic MCP: standard deferred-loaded MCP tools.
- No daemon: freshness is lazy plus explicit reindex; no watcher shipped.
