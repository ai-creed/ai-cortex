# Semantic ranker (embedding-based third mode)

**Date:** 2026-04-18
**Project:** ai-cortex
**Status:** Design approved, ready for implementation plan

---

## 1. Context & problem

`suggest_files_deep` ranks by literal overlap: path tokens, function names, trigram fuzzy match, content scan. It misses files whose concept matches the query but whose vocabulary does not.

Concrete failures seen on real-world PR-title bench runs: deep misses when the path-and-function-name vocabulary diverges from how a human (or agent) phrases the task. Examples of miss patterns:

- query "... include a card ID in the URL" → truth path under `.../navigation.ts` (the word `url` never appears in the path)
- query "... cards not closing on mobile ..." → truth path under `.../events.client.ts` (no `mobile` or `card` token)
- query `"Don't remind me again" box ...` → truth path under `.../mentions.ts` (`remind` ≢ `mentions`)

Pattern: trigram fuzzy matches sub-strings, not concepts.

Target: raise deep's hit@5 on such queries via semantic similarity without regressing PRs that deep already hits.

## 2. Goals & non-goals

**Goals**

- Add a third mode `semantic` that ranks by sentence-embedding cosine similarity between query and per-file text.
- Local embedding model bundled as default; API-provider opt-in via config.
- Re-bench against the same PR-title sample. Success: `semantic hit@5 ≥ deep hit@5 + 10pts` AND deep's existing hits preserved.
- Reversible: ships as its own mode, does not alter `deep` or `fast`. Fold into `deep` via fusion only after bench wins.
- Incremental-index compatible: per-file embeddings, no cross-file graph invalidation.

**Non-goals**

- No full-file-body embedding (stays grep's niche; would inflate cache by 10–100×).
- No ANN index (HNSW / IVF). Dense cosine over 8K × 384 f32 is ~5ms — ANN is premature.
- No multi-language extractor (TS/JS only, same as current).
- No replacement of `fast` or `deep`. Semantic is additive.
- No auto-fallback from one mode to another. Agent-driven escalation only, same model as fast → deep.

## 3. Architecture

Three modes, three tools, shared library entry:

```
CLI (src/cli.ts)                 MCP (src/mcp/server.ts)
  suggest           | fast        suggest_files            | default deep
  suggest-deep      | deep        suggest_files_deep       | deep + poolSize
  suggest-semantic  | semantic    suggest_files_semantic   | semantic
        \                               /
         Library API: src/lib/index.ts
                       |
          suggestRepo(mode: "fast" | "deep" | "semantic")
                       |
         +-------------+-------------+
         |             |             |
       fast          deep          semantic (new)
      ranker        ranker           |
                              suggest-ranker-semantic.ts
                                     |
                    +----------------+----------------+
                    |                                 |
           embedding-model.ts              vector-index.ts
           @xenova/transformers            binary sidecar (f32)
           Xenova/all-MiniLM-L6-v2         cosineTopK dense scan
           384-dim, L2-normalized          ~12MB @ 8K files
```

Cache layout:
- `RepoCache` schema is **unchanged**. `SCHEMA_VERSION` stays at `"3"`. No new fields. Fast/deep/rehydrate/index paths are untouched, cannot trigger model download, cannot invalidate each other's caches.
- Vectors live in two sidecar files next to the main cache, fully self-describing:
  - `~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.vectors.bin` — f32 contiguous, `count × dim × 4` bytes, L2-normalized.
  - `~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.vectors.meta.json` — sidecar schema version, model name, dim, count, fingerprint, entries[]{path,hash}, builtAt.
- Sidecar is **lazily materialized**: built on first `semantic` call if missing or stale vs the main cache fingerprint. Non-semantic commands never read, write, or invalidate it.

Model file:
- Downloaded on **first `semantic` call** (not at install, not at `index`) to `~/.cache/ai-cortex/models/` by `@xenova/transformers` (its built-in cache). No npm-tarball inclusion. One-time ~23 MB download behind a single stderr progress message.
- Subsequent `semantic` calls: fully offline.
- `index`, `rehydrate`, `suggest` (fast), `suggest-deep` never load the model or touch the cache dir.

## 4. Module layout

```
src/lib/
  embedding-model.ts          (new) lazy singleton pipeline, embed(), embedQuery()
  vector-index.ts             (new) binary + meta sidecar read/write, cosineTopK
  semantic-sidecar.ts         (new) lazy build/refresh logic for sidecar vs RepoCache
  suggest-ranker-semantic.ts  (new) semantic ranker entrypoint
  suggest.ts                  (mod) add mode:"semantic" branch; triggers lazy sidecar build; extend outer catch passthrough list to include ModelLoadError, VectorIndexCorruptError, EmbeddingInferenceError so they are not rewrapped as IndexError (see `suggest.ts:174`)
  models.ts                   (mod) add ModelLoadError, VectorIndexCorruptError, EmbeddingInferenceError
  index.ts                    (mod) re-export semantic types

  indexer.ts                  UNCHANGED — no embedding at full or incremental index time

src/cli.ts                    (mod) add `suggest-semantic` command;
                                    extend catch block (cli.ts:255) to format
                                    ModelLoadError, VectorIndexCorruptError,
                                    EmbeddingInferenceError with distinct exit codes
src/mcp/server.ts             (mod) add `suggest_files_semantic` tool

benchmarks/ranker-quality/    (new) in-repo bench harness
  corpus-example.json           (new) schema example: title + truth paths (user supplies their own)
  run.mjs                       (new) runs 4 modes, emits aggregate.md + per-pr.md
  README.md                     (new) usage + env vars
```

4 new + 3 modified = 7 source files + 1 bench harness. **Exceeds the 3-file threshold (user rule 9).** Implementation plan will decompose into smaller steps. `indexer.ts`, `cache-store.ts`, and `models.ts` existing error classes are not touched beyond additive changes.

## 5. Embedding input per file

```
buildEmbeddingInput(file, functions) =
  `${file} :: ${
    functions
      .filter(f => f.file === file)
      .map(f => f.qualifiedName)
      .join(", ")
  }`
```

Uses `FunctionNode.qualifiedName` verbatim from `src/lib/models.ts:57` (e.g. `"Ranker.score"`, not `"score"`). The class-qualified form preserves a useful semantic signal (method belongs to a domain class).

Example: `"MainApp/lib/mywork/client/navigation.ts :: navigateToCard, MyWorkRouter.refresh, MyWorkRouter.close"`.

Rationale: mirrors what `fast`/`deep` already index (paths + exported names). No file-body leak. Keeps layering clean — if later bench shows doc text helps, extend in a follow-up.

Query input: `task` string verbatim. If `from` anchor is provided, prepend path-tokens extracted via the existing `tokenize` helper in `src/lib/tokenize.ts` as a weighted prefix (e.g. `"${tokenize(from).join(' ')} | ${task}"`). Single embedding call per query.

## 6. Sidecar format (two files, out-of-band from main cache)

**A. `<worktreeKey>.vectors.bin`** — binary, contiguous L2-normalized f32 matrix.

```
Offset  Bytes            Field
------  ---------------  ----------------------------------
0       count × dim × 4  vectorsBlock (f32 LE, row-major)
```

No header — header info lives in the meta file next to it. File size is self-checked against meta `count × dim × 4`.

**B. `<worktreeKey>.vectors.meta.json`** — sidecar metadata, human-readable.

```ts
type SidecarEntry = {
  path: string;   // indexable path, same as RepoCache.files[*].path
  hash: string;   // RepoCache.files[*].contentHash at sidecar build time (sha256)
};

type SidecarMeta = {
  sidecarVersion: 1;          // bump independently of RepoCache SCHEMA_VERSION
  model: string;              // "Xenova/all-MiniLM-L6-v2"
  provider: "local" | "openai" | "voyage";
  dim: number;                // 384
  count: number;              // must equal entries.length; must match .bin size
  entries: SidecarEntry[];    // row i of .bin corresponds to entries[i]
  fingerprint: string;        // RepoCache.fingerprint at sidecar build time (informational)
  builtAt: string;            // ISO timestamp
};
```

**Why per-entry hashes, not just paths:** delta refresh (§7.3) needs to detect modified-in-place files. `RepoCache.files[*].contentHash` only reflects *current* content. Without a hash-per-row stored in the sidecar, we cannot tell which rows in `.bin` are stale. Storing hashes lets the delta path diff sidecar's snapshot against current cache hashes — the same mechanism `diff-files.ts` uses.

**Location:** `~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.vectors.{bin,meta.json}` — same dir as main cache JSON.

**No changes to `RepoCache` or `SCHEMA_VERSION`.** Fast/deep cache loader in `cache-store.ts:40` is untouched. Sidecar liveness is determined by comparing `SidecarMeta.fingerprint` against the current `RepoCache.fingerprint`, independently from the main cache's freshness check.

## 7. Data flow

### 7.1 Index-time (full) — unchanged

Full index pipeline does **no embedding**. `indexRepo()` / `buildIndex()` produce `RepoCache` exactly as today. No sidecar is created.

### 7.2 Index-time (incremental) — unchanged

`buildIncrementalIndex()` unchanged. Sidecar is not touched during regular incremental updates; staleness is detected lazily at query time (see §7.4).

### 7.3 Lazy sidecar materialization (first `semantic` call, or stale sidecar)

Triggered from `suggest.ts` when `mode === "semantic"` and sidecar is missing or stale vs `cache.fingerprint`.

```
ensureSidecar(cache, identity):
  meta = readMeta(metaPath)          // null if missing/invalid
  if meta === null:
    → full build: embed every cache.files[i], write .bin + .meta.json
    return

  if meta.model !== currentProvider.model || meta.dim !== currentProvider.dim:
    → full build (model changed)
    return

  if !Array.isArray(meta.entries):    // legacy sidecar written before entries[]
    → full build (can't delta without per-row hashes)
    return

  // Delta build: diff sidecar.entries vs cache.files by hash
  sidecarByPath = Map(meta.entries.map(e => [e.path, e.hash]))
  cacheByPath   = Map(cache.files.map(f => [f.path, f.contentHash]))

  added    = cacheByPath keys − sidecarByPath keys
  removed  = sidecarByPath keys − cacheByPath keys
  modified = paths in both where sidecarByPath[p] !== cacheByPath[p]

  if added.size + removed.size + modified.size === 0:
    → no-op (fingerprint may have advanced but no indexable-file change)
    return

  embed(added ∪ modified) → Float32Array[] (batched)
  build new matrix:
    - keep rows for unchanged paths (same hash)
    - drop rows for removed
    - insert/overwrite rows for added + modified
  rewrite .bin + .meta.json atomically (write *.tmp, fsync, rename)
```

**Atomicity:** both files are written via `*.tmp` + `fsync` + `rename`. `.bin` is written before `.meta.json` — a crash between the two leaves an orphan `.bin` that `readMeta` treats as missing meta, forcing full rebuild.

Full build on an 8K-file repo: ~120 s one-time cost, behind a single stderr progress message. Delta build on ~50 changed files: <1 s.

### 7.4 Query-time

```
suggestRepo(path, task, { mode: "semantic", limit, from, stale })
                             ↓
resolveRepoIdentity + readCache (same as fast/deep — shared path)
                             ↓
ensureSidecar(cache, identity)   // §7.3, builds if missing/stale unless options.stale
                             ↓
readVectorIndex(metaPath, binPath) → { paths, matrix, dim }
                             ↓
queryText = `${from ? tokenize(from).join(' ') + ' | ' : ''}${task}`
                             ↓
embedQuery(queryText) → Float32Array (L2-normalized)
                             ↓
cosineTopK(matrix, queryVec, limit) → [{ index, score }, ...]
                             ↓
map → SemanticSuggestResult with per-item reason = `semantic:${score.toFixed(2)}`
```

`options.stale`: if `true` AND sidecar exists (even stale), use it as-is; skip rebuild. If `true` AND sidecar missing, hard error (`VectorIndexCorruptError` with "no sidecar available; run without --stale to build").

### 7.4 Fusion (bench-only in first ship)

```
run deep    → rankedListA (top poolSize=60)
run semantic → rankedListB (top poolSize=60)
                             ↓
RRF: score(p) = Σ_r 1 / (k + rank_r(p)), k = 60
                             ↓
sort desc, take top limit → final
```

Fusion is implemented inside the bench harness only — not a user-facing mode in v0.3.0. Promoted to `deep` internals only if bench shows strict improvement.

## 8. API provider (opt-in)

**Default:** local `@xenova/transformers` pipeline.

**Opt-in via config:** env var `AI_CORTEX_EMBED_PROVIDER=openai|voyage` + `AI_CORTEX_EMBED_API_KEY=...`. Optional `AI_CORTEX_EMBED_MODEL=text-embedding-3-small` (provider-specific default otherwise).

**Scope for v0.3.0: local provider only.** Provider adapter interface is defined and shipped, but `openai` and `voyage` adapters land in v0.4.0.

`AI_CORTEX_EMBED_PROVIDER` env var is **accepted but validated early** in v0.3.0: if set to any value other than `"local"`, `embedding-model.ts` throws `ModelLoadError("provider '<value>' is not supported in this version; only 'local' is available")` before attempting any network call. This surfaces a clear message rather than silent ignore or unexpected runtime failure.

The Goal (§2) "API-provider opt-in via config" refers to the interface being designed for provider pluggability in v0.3.0, not that all providers ship in v0.3.0. Sidecar `model` string is future-proofed regardless.

Provider adapter interface:

```ts
type EmbedProvider = {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
};
```

Adapter swap is transparent to ranker; sidecar stores `model` string for mismatch detection at query time.

## 8.1 Result shape (extends existing `SuggestResult`)

Extends the existing discriminated union in `src/lib/suggest.ts`:

```ts
export type SemanticSuggestItem = SuggestItem;  // { path, kind, score, reason }

export type SemanticSuggestResult = SuggestResultCommon & {
  mode: "semantic";
  results: SemanticSuggestItem[];
  model: string;                // echoes sidecar model name
};

export type SuggestResult = FastSuggestResult | DeepSuggestResult | SemanticSuggestResult;
```

- `reason` on each item is `"semantic:<cosine>"`, e.g. `"semantic:0.72"`. No silent-fallback marker — failures throw instead (§9).
- Zod schema `SemanticSuggestResultSchema` exported alongside `FastSuggestResultSchema` / `DeepSuggestResultSchema`.
- `SuggestOptions.mode` widens to `"fast" | "deep" | "semantic"`. Existing validation in `suggest.ts:94` extends the whitelist.
- MCP `suggest_files_semantic` tool's `outputSchema` uses `SemanticSuggestResultSchema.shape`. Mode-match assertion (`server.ts:106`-style) throws on mismatch, same as today.

## 9. Error handling

| Scenario | Behavior | Error class |
|---|---|---|
| Model download fails (no network, first `semantic` call) | Hard error with actionable message "network required on first semantic call; subsequent calls are offline" | `ModelLoadError` |
| Model cache corrupt | Delete cached model dir + retry once; if retry fails, hard error | `ModelLoadError` |
| Sidecar missing at `semantic` call | Lazy full build (§7.3); stderr progress message | — |
| Sidecar stale (fingerprint mismatch) | Lazy delta build (§7.3); stderr progress message | — |
| Sidecar `.bin` size does not match `.meta.json` count·dim | Delete both files + rebuild; if second build fails same check, hard error | `VectorIndexCorruptError` |
| Sidecar `.meta.json` invalid JSON or missing required fields | Delete both files + rebuild; if second build fails, hard error | `VectorIndexCorruptError` |
| Model name or dim mismatch between sidecar and current provider | Rebuild sidecar from scratch | — |
| Query embedding throws (model loaded but inference error) | **Hard error — no silent fallback.** Agent is expected to retry with `suggest_files_deep` explicitly (same escalation model as fast → deep). | `EmbeddingInferenceError` |
| Empty query string | Throws `IndexError("suggest task must not be empty")` — identical to fast/deep (`suggest.ts:73`). MCP boundary zod `.min(1)` rejects earlier. | `IndexError` |
| Empty repo (no indexable files) | Return `SemanticSuggestResult` with `results: []`, `cacheStatus` reflects state | — |
| API provider: network error | `ModelLoadError`, retry once | `ModelLoadError` |
| API provider: auth error (401/403) | Hard error, no retry | `ModelLoadError` |
| `options.stale = true` with no sidecar present | Hard error (cannot serve semantic without vectors) | `VectorIndexCorruptError` |
| Any above at CLI boundary | `cli.ts:255` catch extended: `ModelLoadError` → exit 3; `VectorIndexCorruptError` → exit 4; `EmbeddingInferenceError` → exit 5. Each prefixed `ai-cortex: <name>: <message>`. Existing `IndexError` (exit 2) and `RepoIdentityError` (exit 1) behavior unchanged. | (as shown) |

**New error classes in `src/lib/models.ts`:**

```ts
export class ModelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelLoadError";
  }
}

export class VectorIndexCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorIndexCorruptError";
  }
}

export class EmbeddingInferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingInferenceError";
  }
}
```

Follows exact convention of `IndexError` (`models.ts:12`) and `RepoIdentityError` (`models.ts:5`). No `AiCortexError` base class — `models.ts` does not currently define one and this spec does not introduce one. Tests assert `instanceof Error` + `.name === "<ClassName>"`, matching existing `models-contract` test patterns.

**No silent fallback to deep.** Matches existing non-goal in §2 ("No auto-fallback from one mode to another") and the mode-match assertion in `server.ts:106`. Semantic tool always returns semantic-shape results or throws. Agent handles escalation.

## 10. Testing

### 10.1 Unit tests (TDD order)

1. `vector-index.test.ts` — round-trip bit-exact (`.bin` + `.meta.json`); cosineTopK against hand-crafted matrix; `.bin` size-vs-count mismatch throws `VectorIndexCorruptError`; invalid `.meta.json` throws `VectorIndexCorruptError`; dim mismatch throws.
2. `embedding-model.test.ts` — `@xenova/transformers` mocked; lazy-load-once invariant (two calls → single pipeline init); output shape `(n, 384)`; L2-norm ≈ 1.0 per row.
3. `semantic-sidecar.test.ts` — `ensureSidecar` behavior matrix:
   - missing meta → full build
   - model or dim mismatch → full build
   - `entries` missing (legacy) → full build
   - all hashes match → no-op
   - added / removed / modified subsets detected by hash diff (not fingerprint); only affected rows re-embedded
   - atomic write: simulate crash between `.bin` and `.meta.json` rename, next call recovers via full rebuild
4. `suggest-ranker-semantic.test.ts` — in-memory fixture (3 files, 3 pre-computed vectors); known-query expected order; `from` anchor prepending.

`indexer.test.ts` is NOT extended — `indexer.ts` does not write a sidecar in this design.

### 10.2 Integration tests

- `tests/integration/suggest-semantic.test.ts` — uses existing `deep-repo` fixture. Query with concept-adjacent vocabulary (no literal path overlap) must rank the target file in top-5.
- `tests/integration/mcp-server.test.ts` — extend: `suggest_files_semantic` tool schema, arg validation, structuredContent shape.
- `tests/unit/lib/models.test.ts` — **new file**. Asserts `ModelLoadError`, `VectorIndexCorruptError`, `EmbeddingInferenceError` each: `instanceof Error`, `.name === "<ClassName>"`, `.message` is preserved, and behaves consistently with the existing `IndexError` / `RepoIdentityError` classes (verified by reading `src/lib/models.ts`).

### 10.3 Bench harness (non-CI, manual against a user-supplied repo)

- Corpus: `benchmarks/ranker-quality/corpus-example.json` shows the schema; user supplies their own corpus via `--corpus`.
- Runner: `benchmarks/ranker-quality/run.mjs --repo "$BENCH_RANKER_REPO"`.
  - Warms cache (one index build).
  - Runs `fast`, `deep`, `semantic`, `deep+semantic` (RRF) per PR.
  - Emits `out/aggregate.md` (hit@5, P@5, R@5 per mode) + `out/per-pr.md` (side-by-side top-5).
- Success gate (for promoting fusion into `deep`):
  - `semantic hit@5 ≥ deep hit@5 + 10pts`, AND
  - `semantic` or `deep+semantic` keeps all PRs that deep already hit.

### 10.4 Not tested

- No quality regression test in CI — a real monorepo clone is not in CI. Bench is manual.
- No perf benchmark in CI for embedding — first-index cost is one-time and user-visible.

## 11. Rollout

- Version bump: `0.3.0-beta.1`.
- `rehydrate_project` briefing gains a one-line note: "Semantic mode available via `suggest_files_semantic`. First call triggers model download (~23 MB) + one-time per-repo embedding build."
- MANUAL.md update: new tool, new CLI command, env vars for API provider.
- README status table: new row "Phase 6 | Semantic ranker | complete".
- **No cache schema bump. No migration.** Fast/deep/rehydrate behavior is byte-identical pre- and post-install. Upgrading from 0.2.x to 0.3.0 reuses existing `.json` caches unmodified. Sidecar is opt-in: only created on first `semantic` call.

## 12. Open questions

None blocking. Deferred for follow-up:

- Whether to fold `semantic` into `deep` by default after bench. Requires bench numbers first.
- Whether to embed doc-first-heading + top JSDoc as part of per-file input. Requires bench showing (c)-level input beats (b)-level input.
- OpenAI and Voyage adapters land in v0.4.0 (scope bounded per §8). Decision on which provider first will be driven by user demand post-v0.3.0 ship.
