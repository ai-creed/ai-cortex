# ai-cortex

`ai-cortex` is a local project rehydration engine for AI agents.

Its purpose is to give new agent sessions fast, consistent cached knowledge
about a project without broad repo scans or writes into the target repository.

## Status

Beta — all core phases complete, in active personal workflow testing.

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Plausibility spike | complete |
| 1 | Core indexing spine | complete |
| 2 | Rehydration flow | complete |
| 3 | Suggest flow | complete |
| 4 | Hardening for real repos | complete |
| 5 | Call graph & blast radius | complete |

## Commands

```
ai-cortex index [path]                    # Index a repo into local cache
ai-cortex index --refresh [path]          # Force full reindex

ai-cortex rehydrate [path]                # Generate briefing from cache
ai-cortex rehydrate --stale [path]        # Use cached data even if stale
ai-cortex rehydrate --json [path]         # Machine-readable output

ai-cortex suggest "<task>" [path]              # Rank relevant files (fast mode)
ai-cortex suggest "<task>" --from <file>       # Anchor ranking to a known file
ai-cortex suggest "<task>" --limit <n>         # Return at most n results (default 5)
ai-cortex suggest "<task>" --stale             # Use cached data even if stale
ai-cortex suggest "<task>" --json              # Machine-readable output

ai-cortex suggest-deep "<task>" [path]         # Deep ranking (trigram + content scan)
ai-cortex suggest-deep "<task>" --pool <n>     # Candidate pool size (default 60)
ai-cortex suggest-deep "<task>" --from <file>  # Anchor ranking to a known file
ai-cortex suggest-deep "<task>" --limit <n>    # Return at most n results (default 5)
ai-cortex suggest-deep "<task>" --stale        # Use cached data even if stale
ai-cortex suggest-deep "<task>" --json         # Machine-readable output

ai-cortex mcp                                  # Start MCP server (stdio transport)
```

## MCP Server

ai-cortex exposes its capabilities as an MCP server so agents can use it automatically without manual CLI invocations.

**Registration (one-time, after installing globally):**

```bash
claude mcp add -s user ai-cortex -- ai-cortex mcp
```

**Tools:**

| Tool | When to call | What it returns |
|------|-------------|-----------------|
| `rehydrate_project` | Once at session start when working in a git repo | Markdown briefing: structure, key files, entry points, recent changes |
| `suggest_files` | Before reading the codebase for a specific task | Ranked top-5 files with deep ranking (path + fn + call-graph + trigram + content scan) |
| `suggest_files_deep` | When you need explicit `poolSize` control for tuning | Same as `suggest_files` plus configurable candidate pool size |
| `index_project` | After large structural changes to force a rebuild | Confirmation with file and doc counts |
| `blast_radius` | Before modifying a function, to assess impact | Callers organized by hop distance (direct, transitive) with export visibility |

The `rehydrate_project` and `index_project` tools accept an optional `path` argument (defaults to `cwd`). The `suggest_files` tool requires a `task` string and also accepts `path`, `from`, `limit`, and `stale`. The `suggest_files_deep` tool accepts the same arguments plus `poolSize` (candidate pool, default 60). The `blast_radius` tool requires `qualifiedName` and `file`, and also accepts `path`, `maxHops`, and `stale`.

Both suggest tools return `structuredContent` with typed JSON (`mode`, `results[]`, `cacheStatus`, `durationMs`) and include `contentHits` with line-level snippets.

## Library API

```ts
import { indexRepo, rehydrateRepo, suggestRepo, queryBlastRadius } from "ai-cortex";

const cache = await indexRepo("/path/to/repo");
// cache.functions — all extracted functions with file + line
// cache.calls     — directed call edges between functions

const fast = await suggestRepo("/path/to/repo", "persistence layer", { mode: "fast" });
// { mode: "fast", task, from, cacheStatus, durationMs, results: [{ path, kind, score, reason }] }

const deep = await suggestRepo("/path/to/repo", "persistence layer", { mode: "deep", poolSize: 60 });
// { mode: "deep", ..., poolSize, results: [{ path, kind, score, reason, contentHits? }] }

const blast = queryBlastRadius(
  { qualifiedName: "myFunction", file: "src/lib/foo.ts" },
  cache.calls,
  cache.functions,
);
// { target, totalAffected, confidence, tiers: [{ hop, label, hits }] }
```

## Architecture

```
CLI (src/cli.ts)           MCP Server (src/mcp/server.ts)
         \                        /
          ---- Library API -------
                    |
            src/lib/index.ts
           /        |        \
     indexer     suggest    blast-radius
        |        ranker          |
   call-graph   /     \     (BFS query
    extractor  fast   deep   over calls)
        |       |      |
    adapters/  path  trigram+
    typescript fn+cg  content scan
        |              |
    (tree-sitter    tokenize.ts
     WASM parse)   trigram-index.ts
        |          content-scanner.ts
   Cache: ~/.cache/ai-cortex/
   (JSON, schema v3, per-repo keyed by path)
```

**Data flow:**

1. `index` — tree-sitter parses TS/JS files, extracts functions and call edges, stores `RepoCache` as JSON
2. `rehydrate` — loads cache, detects staleness, generates a Markdown briefing
3. `suggest` (fast) — ranks files by path/function token overlap + import graph + call graph proximity to the task and anchor
4. `suggest-deep` — extends fast with per-token trigram fuzzy matching (Jaccard ≥ 0.4) and query-time content scan (400 ms budget, 500 KB cap, 3 hits/file)
5. `blast_radius` — BFS reverse traversal of call edges, returns callers by hop tier

**Call graph:**
- Extracts named functions, arrow functions, and class methods
- Resolves cross-file calls through import bindings (named, default, namespace)
- `CallEdge.from` / `to` use `"file::qualifiedName"` keys
- `confidence: "full"` when all edges resolve statically; `"partial"` when dynamic call sites remain

## Releasing

```bash
pnpm run release 0.2.0-beta.1
```

Bumps the version in `package.json`, commits, tags, and pushes. Must be on `master` with a clean working tree.

## Benchmarking

```bash
pnpm bench                          # Run all suites (perf + quality)
pnpm bench:perf                     # Performance only
pnpm bench:quality                  # Quality only
pnpm bench --fast                   # Smoke run (1 warmup, 3 measured runs)
pnpm bench --update-baseline        # Save current p50 values as baselines
pnpm bench --repo ai-cortex --fast  # Single repo, fast mode
```

See [MANUAL.md](./MANUAL.md#benchmarking) for full details on scenarios, baselines, SLOs, and the quality suite.

## Installation

Requires Node ≥ 20, pnpm, and a git repository to analyze.

### From source (until npm publish)

```bash
git clone git@github.com:ai-creed/ai-cortex.git
cd ai-cortex
pnpm install
pnpm build
pnpm link --global      # makes `ai-cortex` available on PATH
```

### Register as MCP server

```bash
claude mcp add -s user ai-cortex -- ai-cortex mcp
```

`-s user` makes it available in all your projects. Verify with `claude mcp get ai-cortex`.

### First use

```bash
ai-cortex index /path/to/your/repo
```

From an agent session, call `rehydrate_project` or `suggest_files` — no manual step needed.

See [MANUAL.md](./MANUAL.md) for advanced configuration and integration details.

## Known limitations

- **TypeScript / JavaScript only.** Tree-sitter adapters cover `.ts`, `.tsx`, `.js`, `.jsx`. Python/Go/Rust repos will index but yield no call graph.
- **Semantic ranker embeds file paths, not file bodies.** Good for "which file is about X"; not a replacement for grep on file content.
- **First semantic call downloads ~23 MB** (`Xenova/all-MiniLM-L6-v2`) into `~/.cache/ai-cortex/models/`.
- **Cache is local** — not shared across machines or users. Worktree-keyed.
- **MCP tool discovery:** in Claude Code, ai-cortex tools are deferred. Agents may default to Grep/Glob unless nudged. If adoption stays low, add a rule to your `CLAUDE.md` preferring `suggest_files` for file discovery.

## Primary references

- `docs/shared/product_brief.md`
- `docs/shared/high_level_plan.md`
- `docs/superpowers/specs/2026-04-15-ranker-fast-deep-design.md` — fast + deep ranker design spec
- `benchmarks/ranker-quality/README.md` — ranker quality bench harness (grep vs fast vs deep vs semantic)
