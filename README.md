# ai-cortex

`ai-cortex` is a local project rehydration and context-recovery engine for AI agents.

It gives new agent sessions fast, consistent cached knowledge about a project
without broad repo scans or writes into the target repository, and lets agents
search the compacted history of past sessions to recover context lost to harness
compaction (decisions, file paths, user corrections, prior discussion).

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

ai-cortex suggest-semantic "<task>" [path]     # Semantic embedding ranker (sentence embeddings)
ai-cortex suggest-semantic "<task>" --limit <n>  # Return at most n results (default 10)
ai-cortex suggest-semantic "<task>" --stale      # Use cached data even if stale
ai-cortex suggest-semantic "<task>" --json       # Machine-readable output

ai-cortex history install-hooks                # Install Claude Code + Codex hooks for auto-capture
ai-cortex history uninstall-hooks              # Remove the installed hooks (both agents)
ai-cortex history on | off                     # Enable / disable history capture globally
ai-cortex history capture --session <id>       # Manually capture a session transcript
ai-cortex history list                         # List captured sessions for the current repo
ai-cortex history prune --before <YYYY-MM-DD>  # Drop sessions older than the cutoff

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

| Tool                     | When to call                                                                           | What it returns                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `rehydrate_project`      | Once at session start when working in a git repo                                       | Markdown briefing: structure, key files, entry points, recent changes                                          |
| `suggest_files`          | Before reading the codebase for a specific task                                        | Ranked top-5 files with deep ranking (path + fn + call-graph + trigram + content scan)                         |
| `suggest_files_deep`     | When you need explicit `poolSize` control for tuning                                   | Same as `suggest_files` plus configurable candidate pool size                                                  |
| `suggest_files_semantic` | When keyword/graph ranking misses the conceptual or fuzzy match                        | Files ranked by sentence-embedding similarity (Xenova/all-MiniLM-L6-v2)                                        |
| `search_history`         | When prior-session context (decisions, corrections, file paths) was lost to compaction | Hits across captured sessions, weighted by kind (corrections, user prompts, tool calls, file paths, summaries) |
| `index_project`          | After large structural changes to force a rebuild                                      | Confirmation with file and doc counts                                                                          |
| `blast_radius`           | Before modifying a function, to assess impact                                          | Callers organized by hop distance (direct, transitive) with export visibility                                  |

See [MANUAL.md](./MANUAL.md#mcp-server-integration) for full parameter reference.

## History capture

ai-cortex captures compacted summaries of past agent sessions so that the
`search_history` MCP tool can recover context lost to harness compaction.
Both Claude Code and Codex CLI are supported.

```bash
ai-cortex history install-hooks   # one-time setup; wires Claude Code + Codex hooks
ai-cortex history list            # list captured sessions for the current repo
ai-cortex history off             # disable capture globally
```

`install-hooks` edits `~/.claude/settings.json` (Claude Code SessionStart / Stop
hooks) and `~/.codex/config.toml` (Codex equivalents) and creates timestamped
`.bak.*` backups for any file it modifies. Captures land under
`~/.cache/ai-cortex/v1/<repo-key>/history/` and never write into the target
repo. Search defaults to the current session and auto-broadens to the whole
project when the current-session search returns nothing.

## Memory

```
ai-cortex memory record --type decision --title "Always use pnpm" --body-file body.md
ai-cortex memory recall "package manager"
ai-cortex memory list --status active --json
ai-cortex memory pin <id>
```

Persistent project-scoped memory layer. Records decisions, gotchas, patterns, and how-tos as markdown files indexed by sqlite + vector embeddings. Pinned memories appear automatically in the rehydration briefing.

**Types:** `decision` · `gotcha` (severity: minor/major/critical) · `pattern` · `how-to`

**Lifecycle:** `active` → `deprecated` | `merged_into` | `trashed` → `purged`

**Storage:** `~/.cache/ai-cortex/v1/<repoKey>/memory/`

MCP tools: `record_memory`, `recall_memory`, `list_memories`, `search_memories`, `get_memory`, `audit_memory`, and 11 write tools.

See `ai-cortex memory --help` for all subcommands.

### Auto-extractor

Every session captured via the `SessionEnd` / `PreCompact` hooks runs the
auto-extractor immediately after compaction. Extracted memories land as
`candidate` (status), with `source: extracted` and `confidence ≤ 0.6`.
Promote them via `confirm_memory(id)` once you've verified them; otherwise
they age out per the configured policy (Phase 2b).

### Bootstrap

To extract from existing history (one-shot):

    ai-cortex memory bootstrap [--limit-sessions N] [--min-confidence X]

The command iterates every captured session and runs the extractor over
each. Idempotent — re-running appends evidence to existing candidates
rather than duplicating.

## Library API

```ts
import {
	indexRepo,
	rehydrateRepo,
	suggestRepo,
	queryBlastRadius,
} from "ai-cortex";

const cache = await indexRepo("/path/to/repo");
// cache.functions — all extracted functions with file + line
// cache.calls     — directed call edges between functions

const fast = await suggestRepo("/path/to/repo", "persistence layer", {
	mode: "fast",
});
// { mode: "fast", task, from, cacheStatus, durationMs, results: [{ path, kind, score, reason }] }

const deep = await suggestRepo("/path/to/repo", "persistence layer", {
	mode: "deep",
	poolSize: 60,
});
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
    cfamily        |
    python      tokenize.ts
        |       trigram-index.ts
    (tree-sitter   content-scanner.ts
     WASM parse)
        |
   Cache: ~/.cache/ai-cortex/v1/<repoKey>/
   (JSON, schema v3, per-repo keyed by path;
    history/ subdir holds captured sessions)
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

- **TypeScript, JavaScript, Python, C, and C++.** Tree-sitter adapters cover `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.c`, `.cpp`, `.cc`, `.cxx`, `.c++`, `.h`, `.hpp`, `.hh`, `.hxx`, `.h++`. Go/Rust repos will index but yield no call graph.
- **Semantic ranker embeds file paths, not file bodies.** Good for "which file is about X"; not a replacement for grep on file content.
- **First semantic call downloads ~23 MB** (`Xenova/all-MiniLM-L6-v2`) into `~/.cache/ai-cortex/models/`.
- **Cache is local** — not shared across machines or users. Worktree-keyed.
- **MCP tool discovery:** in Claude Code, ai-cortex tools are deferred. Agents may default to Grep/Glob unless nudged. If adoption stays low, add a rule to your `CLAUDE.md` preferring `suggest_files` for file discovery.
- **Python: no type inference for attribute calls.** `obj.method()` where `obj` is not `self`/`cls` emits an unresolved `::method` edge. Self/cls calls resolve correctly. `from pkg import submodule; submodule.func()` also produces a missed edge — use `import pkg.submodule as submodule` or `from pkg.submodule import func` instead.
- **Python: no `__all__` awareness.** All top-level names are treated as exported.
- **Python: dynamic imports not tracked.** `importlib.import_module(...)` and `__import__(...)` produce no edges.
