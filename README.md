# ai-cortex

`ai-cortex` is a local project rehydration engine for AI agents.

Its purpose is to give new agent sessions fast, consistent cached knowledge
about a project without broad repo scans or writes into the target repository.

> Beta — actively used in personal workflow.

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

`-s user` makes it available in all your projects. Verify with `claude mcp get ai-cortex`.

For Codex CLI setup, see [MANUAL.md](./MANUAL.md#setting-up-with-codex-cli).

**Tools:**

| Tool | When to call | What it returns |
|------|-------------|-----------------|
| `rehydrate_project` | Once at session start when working in a git repo | Markdown briefing: structure, key files, entry points, recent changes |
| `suggest_files` | Before reading the codebase for a specific task | Ranked top-5 files with deep ranking (path + fn + call-graph + trigram + content scan) |
| `suggest_files_deep` | When you need explicit `poolSize` control for tuning | Same as `suggest_files` plus configurable candidate pool size |
| `index_project` | After large structural changes to force a rebuild | Confirmation with file and doc counts |
| `blast_radius` | Before modifying a function, to assess impact | Callers organized by hop distance (direct, transitive) with export visibility |

See [MANUAL.md](./MANUAL.md#mcp-server-integration) for full parameter reference.

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

See [MANUAL.md](./MANUAL.md#library-api) for full API reference.

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
