# ai-cortex: Codebase Indexing and File-Suggestion Ranking

*Knowledge reference, 2026-07-07. Source: reading of ai-cortex v0.16.1 source (`src/lib/`).*

## Overview

ai-cortex indexes a git repository into a cache stored outside the repo, then answers "which files matter for this task" queries through three ranking tiers: a fast lexical/graph ranker, a deep ranker that adds fuzzy matching and content scanning, and a semantic ranker based on sentence embeddings. The MCP tools `suggest_files`, `suggest_files_deep`, and `suggest_files_semantic` expose these to agents.

## Indexing pipeline (`src/lib/indexer.ts`)

`buildIndex` scans git-tracked files via `listIndexableFiles`, reads all contents once, and extracts five artifacts into a single `RepoCache` object:

| Artifact | Source | Purpose |
|---|---|---|
| `files[]` | file list + content hash | change detection, candidate universe |
| `imports[]` | `import-graph.ts` | import-edge signals, incremental invalidation |
| `calls[]` + `functions[]` | `call-graph.ts` + language adapters | function-name scoring, call-connectivity, fan-in |
| `docs[]` | `doc-inputs.ts` (markdown title + body) | doc ranking |
| `entryFiles` + `packageMeta` | package.json bin/main/scripts | entry-point bonus |

Key properties:

- **Never writes into the target repository.** The cache lives in an external cache store (`cache-store.ts`), keyed by repo and worktree. This is a hard architectural rule.
- **Freshness via fingerprint.** `getCachedIndex` compares a repo fingerprint; a mismatch means the cache is stale. `rehydrate_project` refreshes automatically.
- **Incremental reindex** (`buildIncrementalIndex`). Only changed files are reparsed, plus their *importers* (unchanged files that import a changed file), because call edges from those callers into changed files would otherwise go stale. package.json, docs, and entry files are only recomputed when touched.

## Ranking tiers

### 1. Fast ranker (`src/lib/suggest-ranker.ts`)

Pure lexical + graph scoring over the cache. No file reads at query time. The task string is tokenized by the shared tokenizer (`tokenize.ts`): path-separator split, camelCase/PascalCase/ALLCAPS split, snake/kebab joined form, conservative plural stemming, and a stopword filter applied to task tokens only (paths keep words like "my" that can be domain-meaningful).

Additive score per file:

| Signal | Points |
|---|---|
| Path token match | 5 per matched token |
| Basename (minus extension) exactly equals a query token | +4 |
| Function-name token match | matches x (3 if exported, else 1), capped at 12 per file |
| `from` anchor: is the anchor file | +6 |
| `from` anchor: same directory | +2 |
| `from` anchor: direct import target / direct importer | +4 each |
| `from` anchor: call-connected to anchor | +3 |
| Call-graph fan-in > 5 distinct callers | +1 |
| Entry file | +2 |

A second pass gives +2 to every file call-connected to the current top-ranked file, and adds such files as new candidates if they scored zero. This pulls in the immediate neighborhood of the best hit.

Docs are scored separately: title matches x8, path matches x5, body matches x1 (body weight was deliberately reduced from 2 to 1 because body-heavy markdown was drowning out code files on large repos).

Tie-breaking: higher score, then files before docs, then shorter path, then alphabetical.

### 2. Deep ranker (`src/lib/suggest-ranker-deep.ts`), the default for MCP `suggest_files`

Three stages layered on the fast ranker:

1. **Enlarged pool.** Run the fast ranker with a pool of 60 candidates (default) instead of the user-facing limit, so files ranked below the cut can still be rescued.
2. **Trigram fuzzy rescue** (`trigram-index.ts`). Each file contributes its path tokens plus function-name tokens. For each task token, compute trigram Jaccard similarity against every file token and take the max per file; threshold 0.4, bonus = similarity x 4. Matching is per-token, not per-concatenated-blob, so "editor" matches a file containing `CardTitleEditor` at similarity 1.0. Catches morphology the exact matcher misses (e.g. "indexing" ~ "index" at 0.5).
3. **Content scan** (`content-scanner.ts`). A literal case-insensitive grep over the candidate pool: 400 ms time budget, at most 3 hits per file, files over 500 KB skipped. Bonus = 3 per unique matched token, capped at 9. Any leftover pool budget is filled with zero-scored files so content scan can rescue files that are invisible to path and function-name signals (essential for tiny repos or vocabulary-mismatch queries).

Results are re-sorted and sliced to the user-facing limit. With `verbose`, each result carries a reason string (e.g. `fn:rankSuggestions | trigram:suggestion~suggestion@1.00`) and line-numbered content snippets.

### 3. Semantic ranker (`src/lib/suggest-ranker-semantic.ts`), separate MCP tool

Sentence embeddings via Xenova/all-MiniLM-L6-v2 (384-dim), stored in a vector sidecar index, queried by brute-force cosine top-K. Intended for conceptual or fuzzy queries where keyword and graph ranking fail. The first call downloads the ~23 MB model and builds the vector index.

## Is it helpful to agents?

Yes, as a first-touch discovery tool, with known limits.

**Wins:**

- One call typically replaces 3-5 Grep/Glob rounds. Results come back with reason strings and line-numbered snippets, so the agent can jump directly to the right region of the right file. Significant token savings versus iterative grep exploration.
- Graph signals (fan-in, call-connectivity, importer/imported relationships) surface structurally relevant files that plain text search cannot, since grep sees only text, not "who calls this".
- The `from` anchor parameter directly answers "what relates to file X".
- High-confidence results attach `relatedMemories` pointers, bridging file discovery into the project memory layer in one round-trip.
- Scores are explainable; the agent can judge whether a hit is real relevance or token noise.
- Fast: deep ranking over a ~600-file repo completes in under 100 ms.

**Limits:**

- The core is lexical. Generic query tokens pollute results (a token like "file" matches half the codebase); the true target may rank #2 or #3 behind coincidental keyword hits. Good enough when the agent scans the top 5, but not surgical.
- The 400 ms content-scan budget can truncate on large repos (the response flags this).
- The semantic tier covers the concept gap but costs a model download and vector build on first use.

The project measures ranking quality honestly: `benchmarks/ranker-quality/` runs fast, deep, semantic, and deep+semantic (reciprocal rank fusion) modes against a corpus of real PRs and reports hit@5 / P@5 / R@5 against the files each PR actually touched, alongside a grep baseline. `docs/shared/adoption-metrics.md` defines the dials for whether agents actually convert suggestions and surfaced memories into use.

Net assessment: the deep ranker is a cheap, fast, explainable, graph-aware discovery layer that is genuinely useful as the first call of a session. It does not replace Grep when the agent already knows the exact symbol, and the tool description says so itself.
