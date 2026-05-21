# Library API Reference

Use this page when embedding ai-cortex's structural indexing layer in Node.js code.

The public library API currently covers indexing, rehydration, file suggestion, call graph extraction, and blast-radius analysis. History and memory are not public library APIs; use the CLI or MCP tools for those.

## Install

From npm:

```bash
npm install ai-cortex
```

For local development against the repository:

```bash
pnpm add github:ai-creed/ai-cortex
```

## Imports

```ts
import {
	indexRepo,
	getCachedIndex,
	rehydrateRepo,
	suggestRepo,
	queryBlastRadius,
	extractCallGraph,
} from "ai-cortex";
```

Common exported types:

```ts
import type {
	RepoCache,
	RehydrateResult,
	SuggestOptions,
	SuggestResult,
	FastSuggestResult,
	DeepSuggestResult,
	BlastRadiusResult,
	CallEdge,
	FunctionNode,
	LangAdapter,
} from "ai-cortex";
```

## `indexRepo(repoPath)`

Build or refresh the structural cache for a git repository.

```ts
const cache = await indexRepo("/path/to/repo");

console.log(cache.files.length);
console.log(cache.functions.length);
console.log(cache.calls.length);
```

Returns `Promise<RepoCache>`.

The cache includes:

- files and hashes
- docs
- package metadata
- imports
- functions
- call edges

## `getCachedIndex(repoPath)`

Load an existing cached index when available.

Use this when you explicitly want cached structural data and do not need a fresh index.

## `rehydrateRepo(repoPath, options?)`

Load cache with freshness detection and generate a rehydration briefing.

```ts
const result = await rehydrateRepo("/path/to/repo");

console.log(result.cacheStatus);
console.log(result.briefingPath);
console.log(result.cache.files.length);
```

Options:

```ts
type RehydrateOptions = {
	stale?: boolean;
	notice?: string | null;
};
```

Returns:

```ts
type RehydrateResult = {
	briefingPath: string;
	cacheStatus: "fresh" | "reindexed" | "stale";
	cache: RepoCache;
};
```

## `suggestRepo(repoPath, task, options?)`

Rank files by relevance to a task.

```ts
const result = await suggestRepo(
	"/path/to/repo",
	"authentication middleware",
	{
		mode: "deep",
		from: "src/server.ts",
		limit: 5,
	},
);
```

Options:

```ts
type SuggestOptions = {
	from?: string;
	limit?: number;
	stale?: boolean;
	mode?: "fast" | "deep" | "semantic";
	poolSize?: number;
	verbose?: boolean;
};
```

Modes:

| Mode | Use |
|---|---|
| `fast` | Path, symbol, import, and call graph ranking |
| `deep` | Adds trigram fuzzy matching and content snippets |
| `semantic` | Uses local embeddings for conceptual path matching |

The library default is `fast`. The MCP `suggest_files` tool defaults to deep ranking.

## `queryBlastRadius(target, calls, functions, options?)`

Run a synchronous reverse call-graph traversal from a target function or method.

```ts
const cache = await indexRepo("/path/to/repo");

const result = queryBlastRadius(
	{ qualifiedName: "loadConfig", file: "src/config.ts" },
	cache.calls,
	cache.functions,
	{ maxHops: 3 },
);

console.log(result.totalAffected);
console.log(result.confidence);
```

Target format:

```ts
{
	qualifiedName: "Class.method",
	file: "src/file.ts"
}
```

Returns:

```ts
type BlastRadiusResult = {
	target: { qualifiedName: string; file: string; exported: boolean };
	totalAffected: number;
	unresolvedEdges: number;
	confidence: "full" | "partial";
	tiers: BlastTier[];
	overloadCount?: number;
};
```

## `extractCallGraph(...)`

Lower-level call graph extraction utility used by the indexer.

Most consumers should use `indexRepo` and then inspect `cache.calls` and `cache.functions` rather than calling this directly.

## Core Types

```ts
type RepoCache = {
	schemaVersion: number;
	repoKey: string;
	worktreeKey: string;
	worktreePath: string;
	indexedAt: string;
	fingerprint: string;
	dirtyAtIndex?: boolean;
	packageMeta: PackageMeta;
	entryFiles: string[];
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
	calls: CallEdge[];
	functions: FunctionNode[];
};
```

```ts
type CallEdge = {
	from: string;
	to: string;
	kind: "call" | "new" | "method";
};
```

```ts
type FunctionNode = {
	qualifiedName: string;
	file: string;
	exported: boolean;
	isDefaultExport: boolean;
	line: number;
	isDeclarationOnly?: boolean;
};
```

## Error Types

The library exports:

```ts
RepoIdentityError
IndexError
```

Use `RepoIdentityError` for invalid or non-git paths. Use `IndexError` for indexing, parsing, and command-level failures.

## Boundary

The library API is intentionally smaller than the CLI and MCP surfaces.

Use CLI or MCP for:

- session history capture
- `search_history`
- memory recall and lifecycle operations
- memory extraction and cleanup
- prompt guide installation
- stats dashboard

## Related Docs

- [CLI reference](./cli.md): command-line surface.
- [MCP tools](./mcp-tools.md): agent-facing tool surface.
- [Language support](./language-support.md): parser-backed language coverage and call graph limits.
- [Benchmarking](./benchmarking.md): performance and ranking-quality benchmark suites.
- [Architecture overview](../architecture/overview.md): where the library fits.
- [Storage reference](./storage.md): cache layout and derived state.
