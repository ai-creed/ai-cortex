# Phase 5 — Tree-Sitter Call Graph and Blast Radius

**Date:** 2026-04-13
**Status:** approved
**Phase:** 5

---

## Goal

Add function-level call graph extraction using tree-sitter so agents can
evaluate blast radius before modifying a function. Two surfaces: an MCP tool
(`blast_radius`) that returns tiered caller impact, and silent call graph
enrichment that improves `suggest` ranking when path-token matching alone is
weak.

---

## Context

Phases 1-4 established file-level import edges using regex extraction. This
tells us which files import which, but nothing about function-level
dependencies. When an agent is about to modify `rankFiles()` in
`suggest-ranker.ts`, it has no way to know what calls it, how many hops away
the callers are, or whether those callers are public API surface.

The high-level plan (Phase 3 design note) recommended tree-sitter AST parsing
for this purpose — accurate enough for navigation, fast enough for indexing
budgets, with unresolved dynamic dispatch as an accepted limitation.

Current state:

- `import-graph.ts` — 36 lines, regex-based, handles `.ts/.tsx/.js/.jsx`
- `suggest-ranker.ts` — 134 lines, scores files by path-token match, entry
  file status, and anchor-file proximity via imports
- `indexer.ts` — supports full and incremental index with stale-edge handling
  for import edges
- `RepoCache` schema v2 — no `calls` or `functions` fields yet

---

## Approach: Layered (Approach C)

Keep `import-graph.ts` untouched. New `call-graph.ts` builds on top using
tree-sitter for function-level edges. Separate `blast-radius.ts` handles
graph traversal queries. Language adapter interface enables future language
expansion.

Why layered:

- Zero risk to existing working code
- Call graph is purely additive — tree-sitter failure for a file leaves
  file-level import edges intact
- Graceful degradation: partial call graph is still useful
- Blast radius merging two edge types is trivial (union adjacency lists)

---

## Data Model

### New Types in `models.ts`

```typescript
/** Function-level call edge extracted by tree-sitter */
export type CallEdge = {
	from: string; // "src/lib/suggest.ts::rankFiles" (file::qualifiedName)
	to: string; // "src/lib/suggest-ranker.ts::Ranker.score" or "::unknownFn"
	kind: "call" | "new" | "method";
};

/** Function definition metadata */
export type FunctionNode = {
	qualifiedName: string; // "rankFiles" or "Ranker.score" (Class.method for methods)
	file: string; // "src/lib/suggest.ts"
	exported: boolean; // visible outside module (named export or default)
	isDefaultExport: boolean; // true if this is the file's default export
	line: number; // declaration line
};

/** Blast radius result for a single affected function */
export type BlastHit = {
	qualifiedName: string; // "rankFiles" or "Ranker.score"
	file: string;
	hop: number; // 1 = direct caller, 2+ = transitive
	exported: boolean;
};
```

**Function identity format:** Top-level functions use bare name (`rankFiles`).
Class methods use `ClassName.methodName` (`Ranker.score`). This prevents
`Foo.render` and `Bar.render` in the same file from collapsing into one node.
The full edge key is `file::qualifiedName` (e.g.,
`src/lib/ranker.ts::Ranker.score`).

### RepoCache Changes

```typescript
export type RepoCache = {
	// ... existing fields unchanged ...
	calls: CallEdge[]; // new — function-level call edges
	functions: FunctionNode[]; // new — function definitions index
};
```

Schema version bumps from `"2"` to `"3"`. Existing v2 caches trigger full
reindex on next access.

---

## Language Adapter Interface

### `src/lib/lang-adapter.ts`

```typescript
/** Per-file extraction result from a language adapter */
export type FileExtractionResult = {
	functions: FunctionNode[];
	/** Raw unresolved call edges — to field is raw callee token, not yet resolved */
	rawCalls: RawCallSite[];
	/** Import bindings needed for cross-file call resolution */
	importBindings: ImportBinding[];
};

/** Raw call site before resolution */
export type RawCallSite = {
	callerQualifiedName: string; // "rankFiles" or "Ranker.score"
	callerFile: string;
	rawCallee: string; // raw token as written: "foo", "bar.baz", "new Qux"
	kind: "call" | "new" | "method";
};

/** Binding from an import statement */
export type ImportBinding = {
	localName: string; // name used in this file: "foo", "baz", "Bar", "utils"
	importedName: string; // original exported name: "foo", "foo", "default", "*"
	fromSpecifier: string; // relative specifier: "./bar"
	bindingKind: "named" | "default" | "namespace";
};

export interface LangAdapter {
	/** File extensions this adapter handles */
	extensions: string[];

	/** Extract functions, raw call sites, and import bindings from source */
	extractFile(source: string, filePath: string): FileExtractionResult;
}
```

The adapter returns a single `FileExtractionResult` per file rather than
separate function/call/binding arrays. This makes the contract explicit: all
three are needed together for resolution, and the adapter is responsible for
extracting them in one tree-sitter pass.

`RawCallSite` stores the raw callee token as written in source. Resolution
(in `call-graph.ts`, not the adapter) converts raw call sites into resolved
`CallEdge[]` using `ImportBinding[]` and the full `FunctionNode[]` index.
This separation means:

- Adapters are simple: parse source, report what you see
- Resolution logic is language-agnostic and shared across adapters
- Raw data survives adapter extraction, enabling re-resolution during
  incremental refresh without re-storing it in `CallEdge`

### Adapter Registry — `src/lib/adapters/index.ts`

```typescript
const adapters: Map<string, LangAdapter> = new Map();

export function registerAdapter(adapter: LangAdapter): void;
export function adapterForFile(filePath: string): LangAdapter | undefined;
```

No adapter for a file extension = skip silently. Call graph is best-effort.

### TS/JS Adapter — `src/lib/adapters/typescript.ts`

Single adapter shipped. Handles `.ts`, `.tsx`, `.js`, `.jsx`. Uses
`web-tree-sitter` WASM bindings with `tree-sitter-typescript` and
`tree-sitter-javascript` grammars.

**Function definitions extracted:**

| Pattern                   | Example                         | `qualifiedName`            | `exported`                |
| ------------------------- | ------------------------------- | -------------------------- | ------------------------- |
| Function declaration      | `function foo()`                | `foo`                      | checks `export` keyword   |
| Arrow/function expression | `const foo = () =>`             | `foo`                      | checks `export` keyword   |
| Class method              | `class Foo { bar() {} }`        | `Foo.bar`                  | true if class is exported |
| Named default export      | `export default function foo()` | `foo`                      | true                      |
| Anonymous default export  | `export default () => {}`       | `default`                  | true                      |
| Default-exported class    | `export default class Foo {}`   | `Foo` (methods: `Foo.bar`) | true                      |

**Default export rules:** If the default export has a name (`function foo`,
`class Foo`), `qualifiedName` uses that name — it's more useful for blast
radius lookups than the generic `default`. If the default export is anonymous
(arrow, unnamed function expression), `qualifiedName` is the synthetic name
`default`. For default-exported classes, the class name is used and methods
follow normal `ClassName.method` format. This ensures resolution of
`import Bar from "./baz"` can always find a `FunctionNode` to land on.

**Raw call sites extracted (via `RawCallSite`):**

The adapter extracts raw callee tokens exactly as written in source. No
resolution happens in the adapter — that is `call-graph.ts`'s job.

| Source pattern    | `rawCallee`       | `kind`     |
| ----------------- | ----------------- | ---------- |
| `foo()`           | `"foo"`           | `"call"`   |
| `new Foo()`       | `"Foo"`           | `"new"`    |
| `obj.method()`    | `"obj.method"`    | `"method"` |
| `utils.doThing()` | `"utils.doThing"` | `"method"` |
| `this.bar()`      | `"this.bar"`      | `"method"` |

The `rawCallee` preserves the full member expression. Resolution uses
`ImportBinding[]` to determine if `obj` / `utils` is an import binding
and extracts the member portion for cross-file lookup. `this.bar` is
resolved within the same class if the caller is a class method.

**Import bindings extracted (via `ImportBinding`):**

| Source pattern                       | `localName` | `importedName` | `bindingKind` |
| ------------------------------------ | ----------- | -------------- | ------------- |
| `import { foo } from "./bar"`        | `"foo"`     | `"foo"`        | `"named"`     |
| `import { foo as baz } from "./bar"` | `"baz"`     | `"foo"`        | `"named"`     |
| `import Bar from "./bar"`            | `"Bar"`     | `"default"`    | `"default"`   |
| `import * as utils from "./bar"`     | `"utils"`   | `"*"`          | `"namespace"` |

**Known limitation and unresolved method format:** Method calls on variables
(`obj.foo()`) where `obj` is not an import binding cannot be resolved to a
specific class. The adapter extracts raw callee `"obj.foo"`. During
resolution, when the receiver (`obj`) does not match any import binding or
same-file identifier, the resolution step **strips the receiver and keeps
the bare method name only**: `CallEdge.to` = `"::foo"`.

This is intentional — it enables the confidence signal in blast radius to
work correctly. When querying blast radius for `Ranker.score`, unresolved
`::score` edges match on the method portion, producing a `"partial"`
confidence rather than a false `"full"`. The trade-off is that `::foo` may
over-match across unrelated classes, but over-matching is the safe direction.

Acceptable at MVP — same trade-off documented in `high_level_plan.md`.

### WASM Strategy

- `web-tree-sitter` — no native compilation, no node-gyp, clean `pnpm install`
- Grammar `.wasm` files bundled in package (~500KB each for TS and JS)
- Parser initialized lazily once, cached for session duration
- Performance: ~5-10K lines/sec. Sub-second for typical projects, ~15-20s for
  100K-line repos (one-time full index only)

---

## Call Graph Extraction — `src/lib/call-graph.ts`

**Responsibility:** Orchestrate tree-sitter parsing across files using
adapters. Produces `CallEdge[]` and `FunctionNode[]`.

```typescript
export function extractCallGraph(
	worktreePath: string,
	filePaths: string[],
	imports: ImportEdge[],
): { calls: CallEdge[]; functions: FunctionNode[] };
```

### Extraction Flow

1. For each file, look up adapter via `adapterForFile(path)`
2. No adapter found → skip file
3. Read source, call `adapter.extractFile(source, filePath)`
4. Collect all `FunctionNode[]`, `RawCallSite[]`, and `ImportBinding[]`
   per file

### Call Resolution (Separate Step)

Resolution runs after all files are extracted. It converts `RawCallSite[]`
into resolved `CallEdge[]` using `ImportBinding[]` and `FunctionNode[]`.
This is handled by `call-graph.ts`, not the adapter.

```typescript
function resolveCallSites(
	rawCalls: RawCallSite[],
	allFunctions: FunctionNode[],
	bindingsByFile: Map<string, ImportBinding[]>,
	imports: ImportEdge[],
): CallEdge[];
```

**Resolution algorithm per raw call site:**

1. **Binding lookup:** Check if `rawCallee` matches a `localName` in the
   caller file's `ImportBinding[]`.
   - **Named/aliased:** binding found → target file is the resolved import
     specifier, target name is `importedName`. Look up matching
     `FunctionNode` in target file → resolve to `targetFile::qualifiedName`.
   - **Default:** binding found with `importedName: "default"` → look up
     `FunctionNode` in target file where `isDefaultExport: true`. If found
     and `qualifiedName` is a real name (e.g., `doThing` from
     `export default function doThing()`), resolve to
     `targetFile::doThing`. If `qualifiedName` is the synthetic `"default"`
     (anonymous export), resolve to `targetFile::default`. This ensures
     `import Bar from "./baz"` where `baz` has `export default function
doThing()` resolves to `baz::doThing`, not `baz::default`.
   - **Namespace:** if `rawCallee` is `utils.foo` and `utils` is a namespace
     binding → target file from binding, target name is `foo` → resolve to
     `targetFile::foo`.
2. **Same-file lookup:** If no binding match, check if `rawCallee` matches
   exactly one `FunctionNode.qualifiedName` in the same file → resolve to
   `callerFile::qualifiedName`.
3. **Fallback:** Ambiguous or no match. For method-kind calls with a dotted
   `rawCallee` (e.g., `"obj.foo"`), strip the receiver and use bare method
   name: `CallEdge.to` = `"::foo"`. For plain call-kind, use as-is:
   `CallEdge.to` = `"::rawCallee"`.

**Import target normalization:** `ImportBinding.fromSpecifier` is a relative
path (e.g., `"./suggest-ranker"`). Resolution must normalize it to match
actual file paths: resolve relative to caller file's directory, strip known
extensions (`.ts/.tsx/.js/.jsx`), and handle `/index` suffix (e.g.,
`"./lib"` matches `src/lib/index.ts`). Use same normalization logic as
existing `import-graph.ts` and `suggest-ranker.ts::stripKnownExt`.

**Key design point:** Resolution depends only on the collected
`RawCallSite[]`, `ImportBinding[]`, `FunctionNode[]`, and `ImportEdge[]`.
All four are available during both full index and incremental refresh. During
incremental refresh, affected caller files are reparsed (see Incremental
Refresh section), so fresh `RawCallSite[]` and `ImportBinding[]` are
available for re-resolution without needing to store raw data in `CallEdge`.

### Failure Handling

- WASM parser fails to load → log warning, return empty `calls`/`functions`
- Individual file parse error → log warning, skip file, continue with others
- Never blocks the indexing pipeline

---

## Blast Radius Query Engine — `src/lib/blast-radius.ts`

**Responsibility:** Given a target function, traverse the call graph to find
all callers organized by hop distance.

```typescript
export function queryBlastRadius(
	target: { qualifiedName: string; file: string },
	calls: CallEdge[],
	functions: FunctionNode[],
	options?: { maxHops?: number },
): BlastRadiusResult;

export type BlastRadiusResult = {
	target: { qualifiedName: string; file: string; exported: boolean };
	totalAffected: number;
	unresolvedEdges: number;
	confidence: "full" | "partial";
	tiers: BlastTier[];
};

export type BlastTier = {
	hop: number;
	label: string; // "direct callers", "transitive callers (2 hops)", etc.
	hits: BlastHit[];
};
```

### Algorithm

1. Build reverse adjacency map from `CallEdge[]` — key is callee
   (`file::function`), values are callers
2. BFS from target, tracking hop count
3. Each visited caller becomes a `BlastHit` with its hop distance
4. Look up `exported` from `FunctionNode[]` for each hit
5. Deduplicate — if a function appears via multiple paths, keep lowest hop
6. Sort: hop ascending, then file path alphabetically
7. Cap at `maxHops` (default 5)

### Confidence Signal

`unresolvedEdges` = count of call edges with unresolved `to` (`"::rawCallee"`)
that could plausibly refer to the target. Matching rules:

- Target is a top-level function (e.g., `rankFiles`): unresolved `::rankFiles`
  matches directly.
- Target is a class method (e.g., `Ranker.score`): unresolved `::score`
  matches on the method portion (everything after the last `.`). This is
  because unresolved method calls store bare method names — `obj.score()`
  becomes `::score`. Since we can't tell which class `obj` is, any
  unresolved `::score` is a potential match for `Ranker.score`.

This means `unresolvedEdges` may over-count (unresolved `::score` could be
calling a completely different `score` method), but it will never under-count.
Over-counting is the safe direction — agent sees "partial" confidence and
investigates further rather than assuming full coverage.

`confidence`: `"full"` if `unresolvedEdges === 0`, `"partial"` otherwise.

### Performance

BFS on pre-computed edges. O(V+E) to build reverse map, O(V+E) for traversal.
Sub-millisecond on any realistic codebase. All parsing cost is at index time,
not query time.

---

## MCP Tool — `blast_radius`

Added to `src/mcp/server.ts`.

### Tool Definition

```typescript
server.tool(
  "blast_radius",
  "Analyze what functions and files are affected if a given function is changed. "
  + "Returns callers organized by hop distance (direct, transitive) with export "
  + "visibility. Use before modifying a function to understand risk and plan testing. "
  + "For class methods, use Class.method format (e.g., 'Ranker.score').",
  {
    qualifiedName: z.string().min(1),
    file: z.string().min(1),
    path: z.string().optional(),
    maxHops: z.number().int().positive().optional(),
    stale: z.boolean().optional(),
  },
  async ({ qualifiedName, file, path, maxHops, stale }) => { ... },
);
```

### Response Shape (JSON)

```json
{
	"target": {
		"qualifiedName": "rankFiles",
		"file": "src/lib/suggest.ts",
		"exported": true
	},
	"totalAffected": 8,
	"unresolvedEdges": 2,
	"confidence": "partial",
	"tiers": [
		{
			"hop": 1,
			"label": "direct callers",
			"hits": [
				{
					"qualifiedName": "suggestRepo",
					"file": "src/lib/suggest.ts",
					"exported": true,
					"hop": 1
				},
				{
					"qualifiedName": "handleSuggest",
					"file": "src/mcp/server.ts",
					"exported": false,
					"hop": 1
				}
			]
		},
		{
			"hop": 2,
			"label": "transitive callers (2 hops)",
			"hits": [
				{
					"qualifiedName": "runCli",
					"file": "src/cli.ts",
					"exported": true,
					"hop": 2
				}
			]
		}
	]
}
```

### Cache Behavior

Same as other MCP tools. Reads existing cache, triggers incremental refresh
if stale (unless `stale: true`). If cache exists but has no `calls` field
(v2 cache), triggers full reindex with tree-sitter.

---

## Suggest Enrichment

Silent call graph integration into existing `suggest-ranker.ts` scoring.

### Existing Scoring (Unchanged)

| Signal                         | Weight       | Source  |
| ------------------------------ | ------------ | ------- |
| Path token match               | +5 per token | Phase 3 |
| Entry file                     | +2           | Phase 3 |
| Anchor file (exact match)      | +6           | Phase 3 |
| Same directory as anchor       | +2           | Phase 3 |
| Direct import target of anchor | +4           | Phase 3 |
| Direct importer of anchor      | +4           | Phase 3 |

### New Call Graph Signals

| Signal                             | Weight | Rationale                                                                                                                     |
| ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Call-connected to anchor file      | +3     | File has call edges to/from `--from` anchor. One logical step away — strong but weaker than direct name match                 |
| Call-connected to top-scoring file | +2     | After initial scoring pass, files with call edges to/from current top-ranked file. Inferred relevance — two hops of inference |
| High fan-in file                   | +1     | File contains functions with >5 direct callers. Small tiebreaker favoring hub code over leaf code                             |

### Design Principles

- Call graph signals stay below path-token matching (+5) so they cannot promote
  an unrelated-but-connected file above a name-matched one
- Each weight reflects confidence distance from the task: direct name match >
  explicit anchor context > inferred call context > structural popularity
- No signal if `calls` array is empty or missing — suggest works exactly as
  today. Zero regression risk for repos without tree-sitter data or for
  non-TS/JS files

---

## Incremental Refresh Integration

Plugs into Phase 4's existing `buildIncrementalIndex()` in `indexer.ts`.

### Full Index Path

After existing steps (file listing, imports, docs, entries), run
`extractCallGraph()` over all TS/JS/TSX/JSX files. Store `calls` and
`functions` in `RepoCache`.

### Incremental Refresh Path

1. `diffChangedFiles()` returns changed file paths (existing).
2. **Identify affected callers:** Using `ImportEdge[]`, find all unchanged
   files that import any changed file. These are "affected callers" — their
   call edges into the changed files may be stale and cannot be re-resolved
   from stored `CallEdge` data alone (the resolved `to` field loses the raw
   callee token, alias, and binding information needed for re-resolution).
3. **Stale-edge cleanup (outbound):** Remove all `CallEdge[]` where the file
   portion of `from` matches any changed file path. These edges will be
   re-extracted from changed source.
4. **Stale-edge cleanup (affected callers):** Remove all `CallEdge[]` where
   the file portion of `from` matches any affected caller file. These edges
   will be re-extracted from unchanged-but-affected source.
5. Remove all `FunctionNode[]` where `file` matches any changed file path.
   (Affected caller files keep their `FunctionNode[]` — their definitions
   didn't change, only their outbound call targets may have.)
6. **Reparse changed files + affected callers:** Run adapter on each changed
   TS/JS file AND each affected caller file. This is the only correct way
   to re-resolve cross-file calls — the adapter re-extracts raw call sites
   and import bindings from source, which the resolution step needs.
7. **Merge:** Append new edges and nodes to cleaned arrays.
8. **Run call resolution:** Normal resolution pass on all newly extracted
   edges using full `ImportEdge[]` and `FunctionNode[]` arrays.

**Cost of reparsing affected callers:** Bounded by the number of files that
directly import a changed file — typically 3-10 files for a focused change.
Tree-sitter parses at ~5-10K lines/sec, so reparsing a handful of extra files
adds sub-second overhead. This is much cheaper than a full reindex and avoids
the alternative of bloating every `CallEdge` with raw resolution metadata.

Existing import edge refresh runs independently — no changes to current
incremental import logic.

### Schema Migration

`SCHEMA_VERSION` bumps `"2"` → `"3"`. Cache loader detects v2 cache and
triggers full reindex. Same pattern as existing v1→v2 migration. No manual
migration step.

---

## New Module Layout

```text
src/lib/
  lang-adapter.ts         ← adapter interface
  call-graph.ts           ← extraction orchestrator
  blast-radius.ts         ← query engine
  adapters/
    index.ts              ← adapter registry
    typescript.ts         ← TS/JS/TSX/JSX adapter (web-tree-sitter)
```

Existing modules modified:

```text
src/lib/
  models.ts               ← CallEdge, FunctionNode, BlastHit types; schema v3
  indexer.ts               ← extractCallGraph in full + incremental paths
  suggest-ranker.ts        ← call graph scoring signals
  index.ts                 ← export new public API
src/mcp/
  server.ts               ← blast_radius tool
```

### New Dependencies

```
web-tree-sitter            ← WASM tree-sitter runtime
tree-sitter-typescript     ← TS/TSX grammar WASM
tree-sitter-javascript     ← JS/JSX grammar WASM (if separate from TS grammar)
```

All WASM-based. No native compilation. Clean `pnpm install`.

---

## Testing Strategy

### Unit Tests

- `tests/unit/lib/lang-adapter.test.ts` — adapter registry lookup, missing
  extension returns undefined
- `tests/unit/lib/adapters/typescript.test.ts` — function extraction
  (declarations, arrows, class methods, export detection), call extraction
  (direct calls, `new`, method calls), line number accuracy
- `tests/unit/lib/call-graph.test.ts` — orchestration across multiple files,
  import-aware resolution, ambiguous call handling, parse failure graceful skip
- `tests/unit/lib/blast-radius.test.ts` — BFS correctness, hop counting,
  deduplication, maxHops cap, unresolvedEdges counting, confidence flag,
  empty graph returns empty result
- `tests/unit/lib/suggest-ranker.test.ts` — new call graph signals: anchor
  connection, top-result connection, fan-in bonus, no regression when calls
  array is empty

### Integration Tests

- `tests/integration/call-graph.test.ts` — end-to-end: create temp repo with
  multiple TS files calling each other, run full index, verify `calls` and
  `functions` in cache, query blast radius, verify tiered results
- `tests/integration/mcp-server.test.ts` — extend existing MCP integration
  test with `blast_radius` tool call

### Edge Cases

- File with syntax errors → tree-sitter partial parse, extract what's possible
- Empty file → no functions, no calls
- Circular call chains → BFS naturally handles (visited set)
- Function name shadowing across files → resolution picks import-connected one
- No adapter for file type → skip silently, no error
- v2 cache loaded → triggers full reindex with call graph

---

## Success Gates

1. `blast_radius` MCP tool returns correct tiered callers for ai-cortex's
   own codebase (self-hosting test)
2. `suggest` with call graph enrichment surfaces files that path-token
   matching alone misses (e.g., task "ranking algorithm" surfaces
   `suggest-ranker.ts` even from an anchor in `mcp/server.ts`)
3. Incremental refresh correctly cleans stale call edges when a file changes
4. All existing 167 tests continue to pass (no regressions)
5. Full index of ai-cortex completes in under 3 seconds
6. Tree-sitter parse failure for one file does not block indexing of others
