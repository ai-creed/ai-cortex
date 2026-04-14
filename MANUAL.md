# ai-cortex Manual

## What it does

ai-cortex builds a local cache of project knowledge for AI agents. When an agent session starts on a project, it can call ai-cortex to get a fast, consistent briefing — file structure, key entry points, relevant files for a task, and call graph impact analysis — without scanning the repo from scratch.

It stores all data locally (`~/.cache/ai-cortex/`), never writes into the target repository, and works on any git repo that contains TypeScript or JavaScript.

---

## Installation

### Method A: Global install from GitHub (recommended)

Requires Node.js 20+ and npm.

```bash
npm install -g github:vuphanse/ai-cortex
```

npm will clone the repo, install dependencies, build the TypeScript, and link the `ai-cortex` binary globally.

Verify:
```bash
ai-cortex --help
```

### Method B: Clone, build, and link manually

Use this if you want to inspect or modify the source.

```bash
git clone git@github.com:vuphanse/ai-cortex.git
cd ai-cortex
pnpm install
pnpm build
npm install -g .
```

Verify:
```bash
ai-cortex --help
```

### Method C: Run without installing globally

If you only want to use it from the cloned directory:

```bash
git clone git@github.com:vuphanse/ai-cortex.git
cd ai-cortex
pnpm install
pnpm build
# Use via pnpm run cortex or node dist/src/cli.js
node dist/src/cli.js index /path/to/your/project
```

### Updating

**Method A:**
```bash
npm install -g github:vuphanse/ai-cortex
```

**Method B:**
```bash
cd ai-cortex
git pull
pnpm install
pnpm build
npm install -g .
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

### `mcp`

Start the MCP server on stdio transport. Used by MCP clients (Claude, etc.) — not called directly.

```bash
ai-cortex mcp
```

---

## MCP Server Integration

The MCP server lets AI agents use ai-cortex automatically during conversations without manual CLI invocations.

### Setting up with Claude Code

Run this once from the ai-cortex install directory (after building):

```bash
claude mcp add ai-cortex -- node /absolute/path/to/ai-cortex/dist/src/cli.js mcp
```

For a global install, find the path with:
```bash
which ai-cortex                       # e.g. /usr/local/bin/ai-cortex
# The actual script is at:
node -e "console.log(require.resolve('ai-cortex/dist/src/cli.js'))"
```

Or use the full node invocation directly:
```bash
claude mcp add ai-cortex -- node $(npm root -g)/ai-cortex/dist/src/cli.js mcp
```

### Available tools

#### `rehydrate_project`

Call once at the start of a session when working in a git repo. Returns a Markdown briefing covering project structure, key files, entry points, and recent changes.

**Parameters:**
- `path` (optional) — repo path (defaults to cwd)
- `stale` (optional, boolean) — skip staleness check

#### `suggest_files`

Call before reading the codebase for a specific task. Returns a ranked list of likely relevant files with short reasons.

**Parameters:**
- `task` (required) — what you're trying to do
- `path` (optional) — repo path (defaults to cwd)
- `from` (optional) — anchor file path to bias ranking
- `limit` (optional, integer) — max results (default 5)
- `stale` (optional, boolean) — skip staleness check

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
  "target": { "qualifiedName": "buildIndex", "file": "src/lib/indexer.ts", "exported": true },
  "totalAffected": 3,
  "confidence": "full",
  "unresolvedEdges": 0,
  "tiers": [
    {
      "hop": 1,
      "label": "direct callers",
      "hits": [
        { "qualifiedName": "indexRepo", "file": "src/lib/indexer.ts", "hop": 1, "exported": true }
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
npm install github:vuphanse/ai-cortex
# or
pnpm add github:vuphanse/ai-cortex
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
console.log(cache.files.length);       // tracked files
console.log(cache.functions.length);   // extracted functions
console.log(cache.calls.length);       // directed call edges
```

### `rehydrateRepo(worktreePath, options?): Promise<RehydrateResult>`

Load cache with staleness detection and generate a briefing.

```ts
const { cache, briefing, cacheStatus } = await rehydrateRepo("/path/to/repo");
// cacheStatus: "fresh" | "refreshed" | "stale"
// briefing: Markdown string
```

Options: `{ stale?: boolean }`

### `suggestRepo(worktreePath, options): Promise<SuggestResult>`

Rank files by relevance to a task.

```ts
const result = await suggestRepo("/path/to/repo", {
  task: "authentication middleware",
  from: "src/server.ts",   // optional anchor
  limit: 5,                // optional, default 5
});
// result.results: [{ path, kind, score, reason }]
```

### `queryBlastRadius(target, calls, functions, options?): BlastRadiusResult`

Synchronous BFS query over a call graph.

```ts
const cache = await indexRepo("/path/to/repo");

const result = queryBlastRadius(
  { qualifiedName: "myFunction", file: "src/lib/foo.ts" },
  cache.calls,
  cache.functions,
  { maxHops: 3 },  // optional
);

console.log(result.totalAffected);   // number of callers found
console.log(result.confidence);      // "full" | "partial"
result.tiers.forEach(tier => {
  console.log(`Hop ${tier.hop} (${tier.label}):`);
  tier.hits.forEach(hit => console.log(`  ${hit.file}::${hit.qualifiedName}`));
});
```

### Types

```ts
type CallEdge = {
  from: string;   // "file::qualifiedName"
  to: string;     // "file::qualifiedName"
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
registerAdapter(myCustomAdapter);  // implements LangAdapter interface
```

---

## Troubleshooting

**`ai-cortex: command not found`**
Run `npm install -g .` from the ai-cortex directory (Method B), or reinstall via Method A.

**`IndexError: Cannot find package 'web-tree-sitter'`**
Dependencies are missing. Run `npm install` (or `pnpm install`) in the ai-cortex directory, then rebuild with `pnpm build` and reinstall globally.

**Cache seems stale / blast_radius returns empty results**
Force a reindex: `ai-cortex index --refresh [path]`

**`confidence: "partial"` on blast_radius**
Some call edges could not be resolved statically (dynamic dispatch, higher-order functions, computed property names). The graph is still useful but may be missing some callers. `unresolvedEdges` in the response gives the count.
