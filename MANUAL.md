# ai-cortex Manual

## What it does

ai-cortex builds a local cache of project knowledge for AI agents. When an agent session starts on a project, it can call ai-cortex to get a fast, consistent briefing — file structure, key entry points, relevant files for a task, and call graph impact analysis — without scanning the repo from scratch.

It stores all data locally (`~/.cache/ai-cortex/`), never writes into the target repository, and works on any git repo that contains TypeScript or JavaScript.

---

## Installation

### Method A: Clone, build, and link (recommended)

Requires Node.js 20+ and pnpm.

```bash
git clone git@github.com:ai-creed/ai-cortex.git
cd ai-cortex
pnpm install
pnpm build
pnpm link --global
```

Verify:

```bash
ai-cortex --help
```

### Method B: Run without installing globally

If you only want to use it from the cloned directory:

```bash
git clone git@github.com:ai-creed/ai-cortex.git
cd ai-cortex
pnpm install
pnpm build
# Use via pnpm run cortex or node dist/src/cli.js
node dist/src/cli.js index /path/to/your/project
```

### Updating

```bash
cd ai-cortex
git pull
pnpm install
pnpm build
pnpm link --global
```

---

## CLI Reference

### `index`

Scan a repo and build a local cache.

```bash
ai-cortex index [path]           # Index the repo at path (default: cwd)
ai-cortex index --refresh [path] # Force a full reindex, ignoring existing cache
```

Run this once per repo. After that, `rehydrate` and `suggest` will auto-refresh when the repo changes.

**Output example:**

```
indexed my-project
  files: 64  docs: 8  imports: 134  functions: 88  calls: 649
  cache: ~/.cache/ai-cortex/v1/<key>/<fingerprint>.json
  duration: 164ms
```

---

### `rehydrate`

Generate an agent-ready briefing from the cache. Auto-refreshes stale data.

```bash
ai-cortex rehydrate [path]        # Briefing as Markdown (default: cwd)
ai-cortex rehydrate --stale [path] # Use cached data without refreshing
ai-cortex rehydrate --json [path]  # Machine-readable JSON output
```

**Use when:** Starting a new agent session on a project. The output tells the agent about project structure, key files, entry points, and recent changes.

---

### `suggest`

Rank files most likely relevant to a task.

```bash
ai-cortex suggest "<task>" [path]           # Top 5 relevant files (default: cwd)
ai-cortex suggest "<task>" --from <file>    # Anchor ranking to a known file
ai-cortex suggest "<task>" --limit <n>      # Return at most n results
ai-cortex suggest "<task>" --stale          # Skip staleness check
ai-cortex suggest "<task>" --json           # Machine-readable output
```

**Examples:**

```bash
ai-cortex suggest "authentication middleware"
ai-cortex suggest "database connection pooling" --from src/db/client.ts
ai-cortex suggest "error handling" --limit 10 --json
```

**Ranking signals:**

- Term frequency match between task and file content/path
- Import graph proximity (files importing or imported by the anchor)
- Call graph proximity (files call-connected to the anchor, +3 score)
- Fan-in signal (heavily-called files get +1)
- Top-result connection (files call-connected to the current top result, +2)

---

### `suggest-deep`

Deep file ranking with trigram fuzzy matching and content scan. Superset of `suggest`.

```bash
ai-cortex suggest-deep "<task>" [path]           # Top 5 relevant files (default: cwd)
ai-cortex suggest-deep "<task>" --from <file>    # Anchor ranking to a known file
ai-cortex suggest-deep "<task>" --limit <n>      # Return at most n results
ai-cortex suggest-deep "<task>" --pool <n>       # Candidate pool size (default 60)
ai-cortex suggest-deep "<task>" --stale          # Skip staleness check
ai-cortex suggest-deep "<task>" --json           # Machine-readable output
```

**Additional signals beyond `suggest`:**

- Per-token trigram Jaccard similarity (min 0.4) — catches morphological variants (e.g. `editing` matches `editor`, `assignment` matches `assignments`)
- Content scan of top candidates (400ms budget, 500KB cap, 3 hits/file) — returns line-level snippets

---

### `mcp`

Start the MCP server on stdio transport. Used by MCP clients (Claude, Codex, etc.) — not called directly.

```bash
ai-cortex mcp
```

---

## MCP Server Integration

The MCP server lets AI agents use ai-cortex automatically during conversations without manual CLI invocations.

### Setting up with Claude Code

Run this once after installing globally:

```bash
claude mcp add -s user ai-cortex -- ai-cortex mcp
```

`-s user` makes it available in all your projects. Verify with `claude mcp get ai-cortex`.

### Setting up with Codex CLI

OpenAI's [Codex CLI](https://github.com/openai/codex) supports MCP servers via `~/.codex/config.toml`.

**Option A: CLI command (recommended)**

```bash
codex mcp add ai-cortex -- node /absolute/path/to/ai-cortex/dist/src/cli.js mcp
```

**Option B: Edit config.toml directly**

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ai-cortex]
command = "node"
args = ["/absolute/path/to/ai-cortex/dist/src/cli.js", "mcp"]
```

Optional fields:

| Field                 | Default | Description                                   |
| --------------------- | ------- | --------------------------------------------- |
| `enabled`             | `true`  | Set `false` to skip initialization            |
| `required`            | `false` | If `true`, Codex exits on init failure        |
| `startup_timeout_sec` | —       | Timeout for server init + tool listing        |
| `tool_timeout_sec`    | —       | Default timeout for tool calls                |
| `env`                 | —       | Env vars: `env = { NODE_ENV = "production" }` |
| `cwd`                 | —       | Working directory for the server process      |

**Manage servers:**

```bash
codex mcp list              # List all configured servers
codex mcp get ai-cortex     # Show details for one server
codex mcp remove ai-cortex  # Remove a server
```

### Available tools

#### `rehydrate_project`

Call once at the start of a session when working in a git repo. Returns a Markdown briefing covering project structure, key files, entry points, and recent changes.

**Parameters:**

- `path` (optional) — repo path (defaults to cwd)
- `stale` (optional, boolean) — skip staleness check

#### `suggest_files`

Call before reading the codebase for a specific task. Uses deep ranking by default (trigram fuzzy match + content scan). Returns a ranked list of relevant files with reasons, trigram match details, and content snippets.

**Parameters:**

- `task` (required) — what you're trying to do
- `path` (optional) — repo path (defaults to cwd)
- `from` (optional) — anchor file path to bias ranking
- `limit` (optional, integer) — max results (default 5)
- `stale` (optional, boolean) — skip staleness check

#### `suggest_files_deep`

Explicit deep search with pool size control. Same as `suggest_files` but accepts an additional `poolSize` parameter. Use when you need to tune the candidate pool (e.g. larger pool for broad queries on big repos).

**Parameters:**

- `task` (required) — what you're trying to do
- `path` (optional) — repo path (defaults to cwd)
- `from` (optional) — anchor file path to bias ranking
- `limit` (optional, integer) — max results (default 5)
- `stale` (optional, boolean) — skip staleness check
- `poolSize` (optional, integer) — candidate pool size (default 60, max 200)

#### `suggest_files_semantic`

Rank files by semantic similarity using sentence embeddings. Use when the task is conceptual or fuzzy and keyword/graph ranking (`suggest_files`) returns nothing useful. The first call downloads ~23 MB (`Xenova/all-MiniLM-L6-v2`, 384-dim) into `~/.cache/ai-cortex/models/`; subsequent calls are fast.

**Parameters:**

- `task` (required) — what you're trying to do
- `path` (optional) — repo path (defaults to cwd)
- `limit` (optional, integer) — max results (default 10, max 20)
- `stale` (optional, boolean) — skip staleness check

#### `search_history`

Search the compacted history of past agent sessions in this project. Use this to recover context lost to harness compaction (decisions, file paths, user corrections, prior discussion). Defaults to the current session and auto-broadens to the whole project if the current-session search returns nothing.

Captured sessions live under `~/.cache/ai-cortex/v1/<repo-key>/history/`; install hooks once with `ai-cortex history install-hooks` to populate them automatically. The installer wires hooks for both Claude Code (`~/.claude/settings.json`) and Codex CLI (`~/.codex/config.toml`), with timestamped `.bak.*` backups for any file it modifies.

**Parameters:**

- `query` (required) — text to match against summaries, user prompts, corrections, tool calls, and file paths
- `sessionId` (optional) — restrict to a specific session id
- `scope` (optional, `"session" | "project"`) — force a search scope; defaults to current session with auto-broadening
- `limit` (optional, integer) — max hits (max 50)
- `path` (optional) — repo path (defaults to cwd)

**Hit kinds and weights** (higher means stronger signal): `correction` 1.0, `userPrompt` 0.7, `filePath` 0.7, `summary` 0.6, `toolCall` 0.5, `rawChunk` 0.5.

#### `recall_memory`

Semantic + FTS recall. Use to retrieve relevant memories before starting work on a task.

**Parameters:**

- `query` (required) — natural-language query
- `type` (optional) — filter by type: `decision` | `gotcha` | `pattern` | `how-to`
- `limit` (optional, integer) — max results (default 10)
- `scopeFiles` (optional, string[]) — restrict to memories scoped to these files
- `tags` (optional, string[]) — filter by tags
- `path` (optional) — repo path (defaults to cwd)

#### `record_memory`

Record a new memory.

**Parameters:**

- `type` (required) — `decision` | `gotcha` | `pattern` | `how-to`
- `title` (required) — short title
- `body` (required) — markdown body
- `tags` (optional, string[]) — labels
- `scopeFiles` (optional, string[]) — files this memory pertains to
- `source` (optional) — originating session id or reference
- `path` (optional) — repo path (defaults to cwd)

#### `get_memory`

Fetch a single memory by ID.

**Parameters:**

- `id` (required) — memory ID
- `path` (optional) — repo path (defaults to cwd)

#### `list_memories`

List memories with optional filters.

**Parameters:**

- `type` (optional) — filter by type
- `status` (optional) — `active` | `deprecated` | `trashed`
- `scopeFile` (optional) — restrict to memories scoped to this file
- `limit` (optional, integer) — max results
- `path` (optional) — repo path (defaults to cwd)

#### `search_memories`

FTS-only search (no semantic ranking).

**Parameters:**

- `query` (required) — full-text query
- `limit` (optional, integer) — max results
- `path` (optional) — repo path (defaults to cwd)

#### `audit_memory`

View the audit trail for a memory.

**Parameters:**

- `id` (required) — memory ID
- `path` (optional) — repo path (defaults to cwd)

#### `update_memory`

Update body or title of a memory.

**Parameters:**

- `id` (required) — memory ID
- `title` (optional) — new title
- `body` (optional) — new markdown body
- `reason` (optional) — reason for the change (recorded in audit log)
- `path` (optional) — repo path (defaults to cwd)

#### `deprecate_memory`

Mark a memory as deprecated.

**Parameters:**

- `id` (required) — memory ID
- `reason` (required) — why deprecated
- `path` (optional) — repo path (defaults to cwd)

#### `restore_memory`

Restore a deprecated memory to active.

**Parameters:**

- `id` (required) — memory ID
- `path` (optional) — repo path (defaults to cwd)

#### `merge_memories`

Merge source memory into destination. Source is marked `merged_into`.

**Parameters:**

- `srcId` (required) — source memory ID
- `dstId` (required) — destination memory ID
- `body` (required) — new body for the merged destination memory
- `path` (optional) — repo path (defaults to cwd)

#### `trash_memory`

Move a memory to trash.

**Parameters:**

- `id` (required) — memory ID
- `reason` (required) — reason for trashing
- `path` (optional) — repo path (defaults to cwd)

#### `untrash_memory`

Restore a trashed memory to active.

**Parameters:**

- `id` (required) — memory ID
- `path` (optional) — repo path (defaults to cwd)

#### `purge_memory`

Permanently delete a memory. Irreversible.

**Parameters:**

- `id` (required) — memory ID
- `reason` (required) — reason for purge
- `yes` (required, boolean) — must be `true` to confirm
- `redact` (optional, boolean) — overwrite body with tombstone before deletion (privacy erasure)
- `path` (optional) — repo path (defaults to cwd)

#### `link_memories`

Create a typed edge between two memories.

**Parameters:**

- `srcId` (required) — source memory ID
- `dstId` (required) — destination memory ID
- `type` (required) — `supports` | `contradicts` | `refines` | `depends_on`
- `path` (optional) — repo path (defaults to cwd)

#### `unlink_memories`

Remove a typed edge between two memories.

**Parameters:**

- `srcId` (required) — source memory ID
- `dstId` (required) — destination memory ID
- `type` (required) — edge type to remove
- `path` (optional) — repo path (defaults to cwd)

#### `pin_memory`

Pin a memory so it appears in every rehydration briefing.

**Parameters:**

- `id` (required) — memory ID
- `force` (optional, boolean) — pin even if already at pin limit
- `path` (optional) — repo path (defaults to cwd)

#### `unpin_memory`

Remove a memory from the pinned set.

**Parameters:**

- `id` (required) — memory ID
- `path` (optional) — repo path (defaults to cwd)

#### `confirm_memory`

Confirm a candidate memory, promoting it to active.

**Parameters:**

- `id` (required) — memory ID
- `path` (optional) — repo path (defaults to cwd)

#### `add_evidence`

Attach evidence to an existing memory.

**Parameters:**

- `id` (required) — memory ID
- `evidence` (required) — evidence text or reference
- `path` (optional) — repo path (defaults to cwd)

#### `rebuild_index`

Reconcile the sqlite index from `.md` source files on disk. Use after manual edits or after restoring from backup.

**Parameters:**

- `path` (optional) — repo path (defaults to cwd)

---

## Memory layer

Project-scoped persistent memory. Stores decisions, gotchas, patterns, and how-tos as markdown files backed by a sqlite FTS5 index and vector embeddings sidecar.

**Storage layout** (`~/.cache/ai-cortex/v1/<repoKey>/memory/`):

| Path                                  | Contents                                    |
| ------------------------------------- | ------------------------------------------- |
| `memories/<id>.md`                    | Markdown source-of-record for each memory   |
| `memory.db`                           | sqlite index with FTS5 for full-text search |
| `.vectors.bin` / `.vectors.meta.json` | Embedding sidecar for semantic recall       |

### Memory types

| Type       | Description                      | Notes                                                 |
| ---------- | -------------------------------- | ----------------------------------------------------- |
| `decision` | Architectural or process choice  | Body permanently recorded in audit log at creation    |
| `gotcha`   | Warning or pitfall               | Requires `severity`: `minor` \| `major` \| `critical` |
| `pattern`  | Recurring code pattern           | —                                                     |
| `how-to`   | Step-by-step procedure or recipe | —                                                     |

### Lifecycle

```
active ──► deprecated ──► active        (restore)
active ──► merged_into                  (merge, terminal)
active ──► trashed ──► active           (untrash)
trashed ──► purged                      (purge, permanent)
```

### CLI reference

| Command                                                                                        | Description                                                    |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `memory recall "<query>" [--type T] [--limit N] [--scope-file F]... [--tag T]... [--json]`     | Semantic + FTS recall                                          |
| `memory search "<query>" [--limit N] [--json]`                                                 | FTS-only search                                                |
| `memory record --type T --title T --body-file F [--tag T]... [--scope-file F]... [--source S]` | Record a new memory                                            |
| `memory get <id> [--json]`                                                                     | Fetch memory by ID                                             |
| `memory list [--type T] [--status S] [--scope-file F] [--limit N] [--json]`                    | List with filters                                              |
| `memory update <id> [--title T] [--body-file F] [--reason R]`                                  | Update body or title                                           |
| `memory deprecate <id> --reason R`                                                             | Mark as deprecated                                             |
| `memory restore <id>`                                                                          | Restore deprecated to active                                   |
| `memory merge <src-id> <dst-id> --body-file F`                                                 | Merge src into dst                                             |
| `memory trash <id> --reason R`                                                                 | Move to trash                                                  |
| `memory untrash <id>`                                                                          | Restore from trash                                             |
| `memory purge <id> --reason R --yes [--redact]`                                                | Permanent delete (`--redact` for privacy erasure)              |
| `memory link <src-id> <dst-id> --type T`                                                       | Create typed edge (supports\|contradicts\|refines\|depends_on) |
| `memory unlink <src-id> <dst-id> --type T`                                                     | Remove typed edge                                              |
| `memory pin <id> [--force]`                                                                    | Pin to rehydration briefing                                    |
| `memory unpin <id>`                                                                            | Remove from pinned set                                         |
| `memory confirm <id>`                                                                          | Confirm a candidate memory                                     |
| `memory audit <id> [--json]`                                                                   | View audit trail                                               |
| `memory rebuild-index`                                                                         | Reconcile index from .md files                                 |
| `memory reconcile [--report]`                                                                  | Run reconciliation pass                                        |

### MCP tools

| Tool               | Description                    |
| ------------------ | ------------------------------ |
| `recall_memory`    | Semantic + FTS recall          |
| `get_memory`       | Fetch memory by ID             |
| `list_memories`    | List with filters              |
| `search_memories`  | FTS-only search                |
| `audit_memory`     | View audit trail               |
| `record_memory`    | Record a new memory            |
| `update_memory`    | Update body or title           |
| `update_scope`     | Update scope files             |
| `deprecate_memory` | Mark as deprecated             |
| `restore_memory`   | Restore deprecated to active   |
| `merge_memories`   | Merge src into dst             |
| `trash_memory`     | Move to trash                  |
| `untrash_memory`   | Restore from trash             |
| `purge_memory`     | Permanent delete               |
| `link_memories`    | Create typed edge              |
| `unlink_memories`  | Remove typed edge              |
| `pin_memory`       | Pin to rehydration briefing    |
| `unpin_memory`     | Remove from pinned set         |
| `confirm_memory`   | Confirm candidate memory       |
| `add_evidence`     | Attach evidence to memory      |
| `rebuild_index`    | Reconcile index from .md files |

---

#### `index_project`

Call after large structural changes to force a full reindex.

**Parameters:**

- `path` (optional) — repo path (defaults to cwd)

#### `blast_radius`

Call before modifying a function to understand what else might break. Returns callers organized by hop distance with export visibility.

**Parameters:**

- `qualifiedName` (required) — function name, or `Class.method` for methods
- `file` (required) — file path relative to repo root (e.g. `src/lib/indexer.ts`)
- `path` (optional) — repo path (defaults to cwd)
- `maxHops` (optional, integer) — BFS depth limit (default 5)
- `stale` (optional, boolean) — skip staleness check

**Example response:**

```json
{
	"target": {
		"qualifiedName": "buildIndex",
		"file": "src/lib/indexer.ts",
		"exported": true
	},
	"totalAffected": 3,
	"confidence": "full",
	"unresolvedEdges": 0,
	"tiers": [
		{
			"hop": 1,
			"label": "direct callers",
			"hits": [
				{
					"qualifiedName": "indexRepo",
					"file": "src/lib/indexer.ts",
					"hop": 1,
					"exported": true
				}
			]
		}
	]
}
```

`confidence: "full"` means all call edges resolved statically. `"partial"` means some dynamic call sites could not be resolved and the graph may be incomplete.

---

## Library API

Install as a dependency:

```bash
npm install github:ai-creed/ai-cortex
# or
pnpm add github:ai-creed/ai-cortex
```

```ts
import {
	indexRepo,
	rehydrateRepo,
	suggestRepo,
	queryBlastRadius,
} from "ai-cortex";
```

### `indexRepo(worktreePath): Promise<RepoCache>`

Build or refresh the cache for a repo.

```ts
const cache = await indexRepo("/path/to/repo");
console.log(cache.files.length); // tracked files
console.log(cache.functions.length); // extracted functions
console.log(cache.calls.length); // directed call edges
```

### `rehydrateRepo(worktreePath, options?): Promise<RehydrateResult>`

Load cache with staleness detection and generate a briefing.

```ts
const { cache, briefing, cacheStatus } = await rehydrateRepo("/path/to/repo");
// cacheStatus: "fresh" | "refreshed" | "stale"
// briefing: Markdown string
```

Options: `{ stale?: boolean }`

### `suggestRepo(worktreePath, task, options?): Promise<SuggestResult>`

Rank files by relevance to a task. Returns a discriminated union — `FastSuggestResult` or `DeepSuggestResult` — based on the `mode` option.

```ts
// Fast mode (default at library level) — path/fn/call-graph token matching
const fast = await suggestRepo("/path/to/repo", "authentication middleware", {
	mode: "fast",
	from: "src/server.ts", // optional anchor
	limit: 5, // optional, default 5
});
// fast.results: [{ path, kind, score, reason }]

// Deep mode — adds trigram fuzzy match + content scan
const deep = await suggestRepo("/path/to/repo", "authentication middleware", {
	mode: "deep",
	poolSize: 60, // optional, candidate pool size
});
// deep.results: [{ path, kind, score, reason, contentHits? }]
// deep.poolSize: 60
```

Note: The MCP `suggest_files` tool defaults to deep mode. The library API defaults to fast — pass `mode: "deep"` explicitly when needed.

### `queryBlastRadius(target, calls, functions, options?): BlastRadiusResult`

Synchronous BFS query over a call graph.

```ts
const cache = await indexRepo("/path/to/repo");

const result = queryBlastRadius(
	{ qualifiedName: "myFunction", file: "src/lib/foo.ts" },
	cache.calls,
	cache.functions,
	{ maxHops: 3 }, // optional
);

console.log(result.totalAffected); // number of callers found
console.log(result.confidence); // "full" | "partial"
result.tiers.forEach((tier) => {
	console.log(`Hop ${tier.hop} (${tier.label}):`);
	tier.hits.forEach((hit) =>
		console.log(`  ${hit.file}::${hit.qualifiedName}`),
	);
});
```

### Types

```ts
type CallEdge = {
	from: string; // "file::qualifiedName"
	to: string; // "file::qualifiedName"
	kind: "call" | "new" | "method";
};

type FunctionNode = {
	qualifiedName: string;
	file: string;
	exported: boolean;
	isDefaultExport: boolean;
	line: number;
};

type BlastHit = {
	qualifiedName: string;
	file: string;
	hop: number;
	exported: boolean;
};

type BlastRadiusResult = {
	target: { qualifiedName: string; file: string; exported: boolean };
	totalAffected: number;
	unresolvedEdges: number;
	confidence: "full" | "partial";
	tiers: BlastTier[];
};
```

---

## Architecture

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

---

## Cache Storage

All data is stored in `~/.cache/ai-cortex/`. The directory is organized as:

```
~/.cache/ai-cortex/
  v1/
    <repo-key>/          # hash of the repo's absolute path
      <fingerprint>.json # cache file, keyed by git state + dirty flag
```

Each cache file is a JSON snapshot (`RepoCache`, schema v3) containing:

- File tree with hashes
- Import edges
- Function nodes (name, file, line, exported)
- Call edges (from, to, kind)
- Package metadata
- Docs

Cache files are automatically invalidated and rebuilt when the repo's git state changes. The `--stale` flag skips this check and returns the most recent cache as-is.

**To clear the cache for a repo:**

```bash
rm -rf "~/.cache/ai-cortex/v1/$(node -e "
  const crypto = require('crypto');
  const path = require('path');
  const p = path.resolve('/path/to/your/repo');
  console.log(crypto.createHash('sha256').update(p).digest('hex').slice(0, 16));
")"
```

Or just delete the entire cache:

```bash
rm -rf ~/.cache/ai-cortex/
```

---

## Language Support

Phase 5 ships with a TypeScript/JavaScript adapter covering `.ts`, `.tsx`, `.js`, `.jsx` files.

The adapter extracts:

- Named function declarations
- Arrow functions assigned to variables or exported directly
- Class methods
- Cross-file call edges resolved through import bindings (named, default, namespace imports)

Dynamic calls (higher-order functions, computed method names) are not resolved; they contribute to `unresolvedEdges` and set `confidence: "partial"`.

Other language adapters can be registered programmatically:

```ts
import { registerAdapter } from "ai-cortex";
registerAdapter(myCustomAdapter); // implements LangAdapter interface
```

---

## Troubleshooting

**`ai-cortex: command not found`**
Run `pnpm link --global` from the ai-cortex directory (Method A).

**`IndexError: Cannot find package 'web-tree-sitter'`**
Dependencies are missing. Run `pnpm install` in the ai-cortex directory, then rebuild with `pnpm build` and relink with `pnpm link --global`.

**Cache seems stale / blast_radius returns empty results**
Force a reindex: `ai-cortex index --refresh [path]`

**`confidence: "partial"` on blast_radius**
Some call edges could not be resolved statically (dynamic dispatch, higher-order functions, computed property names). The graph is still useful but may be missing some callers. `unresolvedEdges` in the response gives the count.

---

## Benchmarking

The benchmark suite measures both **performance** (latency regression detection) and **quality** (correctness of suggest and blast radius results). It runs locally against real repos on your machine and a committed synthetic fixture repo.

### Quick start

```bash
pnpm bench                    # Run all suites (perf + quality), full protocol
pnpm bench --fast             # Smoke run: 1 warmup, 3 measured runs instead of 3/20
pnpm bench:perf               # Performance suite only
pnpm bench:quality            # Quality suite only
```

### CLI flags

| Flag                    | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `--suite perf\|quality` | Run only one suite (default: both)                           |
| `--repo <name>`         | Filter to a single repo by name (e.g. `ai-cortex`)           |
| `--fast`                | Reduce iterations for quick smoke tests (warmup: 1, runs: 3) |
| `--json`                | Write full results to `benchmarks/results.json`              |
| `--update-baseline`     | Save current p50 values to `benchmarks/baselines.json`       |

### Performance suite

Measures 5 scenarios across all discovered repos:

| Scenario           | What it measures                      | Cache precondition                        |
| ------------------ | ------------------------------------- | ----------------------------------------- |
| `index:cold`       | Full indexing from scratch            | Cache cleared before each run             |
| `rehydrate:warm`   | Rehydration with valid cache          | Cache pre-built                           |
| `rehydrate:stale`  | Incremental reindex on dirty worktree | Clean cache built, then marker file added |
| `suggest:warm`     | File suggestion ranking               | Cache pre-built                           |
| `blastRadius:warm` | Call graph BFS query only             | Cache + target captured in setup          |

Each scenario runs the configured number of iterations (default: 3 warmup + 20 measured) and reports p50, p95, min, and max timings.

**Regression detection** compares the current p50 against a saved baseline:

- **>10% slower** — warning
- **>20% slower** — fail
- **No baseline** — skip (pass with note)

**SLO enforcement** checks the current p50 against per-scenario, per-size-bucket absolute thresholds. A result that passes regression but exceeds the SLO still fails.

### Quality suite

Runs against a committed 50-file synthetic TypeScript repo (`benchmarks/fixtures/synthetic/repo/`) with known call chains across 4 modules (auth, api, db, utils).

**Golden set tests** — 5 suggest queries and 2 blast radius queries with known expected results:

- Suggest: checks precision@k and recall@k (threshold: 0.6 each)
- Blast radius: checks that expected (qualifiedName, file, hop) tuples are found

**Ranking assertions** — verifies relative ordering on real repos (e.g. `suggest-ranker.ts` should rank higher than `README.md` for "fix the suggest ranker scoring").

### Setting up baselines

Baselines are per-machine (gitignored). On a fresh clone:

```bash
# 1. Copy the template
cp benchmarks/baselines.example.json benchmarks/baselines.json

# 2. Run the suite and save measurements
pnpm bench --update-baseline

# 3. Verify regression detection works
pnpm bench:perf
```

Subsequent runs compare against these saved p50 values. Re-run with `--update-baseline` after intentional performance changes.

### Repo discovery

The suite always benchmarks the ai-cortex repo itself (derived from the git root at runtime). It also looks for optional repos:

- `~/Dev/ai-samantha`, `~/Dev/ai-14all`, `~/Dev/ai-whisper` — checked by default, skipped if absent
- `BENCH_REPOS` env var — comma-separated paths to additional repos

Use `--repo <name>` to run against a single repo.

### Directory structure

```
benchmarks/
  runner.ts                  # CLI entry point
  config.ts                  # Repo discovery, SLO table, ranking assertions
  baselines.example.json     # Template (committed)
  baselines.json             # Your machine's baselines (gitignored)
  results.json               # JSON output from --json (gitignored)
  tsconfig.json              # Type checking config for benchmark code
  smoke.test.ts              # E2E vitest smoke test
  lib/
    types.ts                 # Shared types
    measure.ts               # Timing harness (warmup + percentiles)
    compare.ts               # Regression + SLO checks, baseline I/O
  suites/
    perf-suite.ts            # 5 performance scenarios
    quality-suite.ts         # Golden sets + ranking assertions
  reporters/
    terminal.ts              # Table output to stdout
    json.ts                  # JSON file output
  fixtures/
    synthetic/
      generate.ts            # Generator script for the synthetic repo
      golden-sets.json       # Expected results for quality tests
      repo/                  # 50-file TypeScript fixture (committed)
```

### Calibrating SLOs

If SLO values are too tight or too loose after hardware changes, recalibrate:

```bash
# Run and observe actual p50 values
pnpm bench:perf --fast

# Edit benchmarks/config.ts SLO_TABLE
# Set each SLO to ~3-5x the observed p50

# Verify no false failures
pnpm bench:perf
```
