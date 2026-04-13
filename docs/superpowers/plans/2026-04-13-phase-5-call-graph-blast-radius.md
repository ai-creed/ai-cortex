# Phase 5 — Call Graph & Blast Radius Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tree-sitter-based function call graph extraction and a blast radius MCP tool so agents can evaluate impact before modifying functions. Also silently enrich `suggest` ranking with call graph signals.

**Architecture:** Layered on top of existing import graph. New `call-graph.ts` orchestrates tree-sitter extraction via a pluggable `LangAdapter` interface (only TS/JS adapter shipped). `blast-radius.ts` provides BFS query over the call graph. `indexer.ts` gains call graph extraction in both full and incremental paths. `server.ts` gains a `blast_radius` MCP tool. `suggest-ranker.ts` gets additive call graph scoring signals. Schema bumps v2 → v3.

**Tech Stack:** `web-tree-sitter` (WASM), `tree-sitter-typescript` grammar, Vitest, existing `zod`/MCP SDK

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `package.json` | add `web-tree-sitter`, `tree-sitter-typescript` dependencies |
| Modify | `src/lib/models.ts` | add `CallEdge`, `FunctionNode`, `BlastHit` types; bump `SCHEMA_VERSION` to `"3"` |
| Create | `src/lib/lang-adapter.ts` | `LangAdapter` interface, `FileExtractionResult`, `RawCallSite`, `ImportBinding` types |
| Create | `src/lib/adapters/index.ts` | adapter registry: `registerAdapter`, `adapterForFile` |
| Create | `src/lib/adapters/typescript.ts` | TS/JS/TSX/JSX adapter using web-tree-sitter WASM |
| Create | `src/lib/call-graph.ts` | extraction orchestrator + call resolution |
| Create | `src/lib/blast-radius.ts` | BFS query engine + confidence signal |
| Modify | `src/lib/indexer.ts` | call graph in full + incremental index paths |
| Modify | `src/lib/suggest-ranker.ts` | additive call graph scoring signals |
| Modify | `src/lib/index.ts` | export new public types and functions |
| Modify | `src/mcp/server.ts` | add `blast_radius` tool |
| Create | `tests/unit/lib/adapters/typescript.test.ts` | TS adapter extraction tests |
| Create | `tests/unit/lib/lang-adapter.test.ts` | adapter registry tests |
| Create | `tests/unit/lib/call-graph.test.ts` | call resolution tests |
| Create | `tests/unit/lib/blast-radius.test.ts` | BFS + confidence tests |
| Modify | `tests/unit/lib/suggest-ranker.test.ts` | call graph signal tests |
| Modify | `tests/unit/lib/indexer.test.ts` | call graph in index paths |
| Create | `tests/integration/call-graph.test.ts` | end-to-end call graph + blast radius |

---

## Task 1: Add tree-sitter dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install web-tree-sitter and grammar**

```bash
cd /Users/vuphan/Dev/ai-cortex && pnpm add web-tree-sitter tree-sitter-typescript tree-sitter-javascript
```

Expected: `pnpm-lock.yaml` updated, no errors.

- [ ] **Step 2: Verify build still passes**

```bash
pnpm run build
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Verify all existing tests pass**

```bash
pnpm test
```

Expected: 167 tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat: add web-tree-sitter and tree-sitter-typescript dependencies"
```

---

## Task 2: Add new types to models.ts and bump schema version

**Files:**
- Modify: `src/lib/models.ts:1-65`
- Test: `tests/unit/lib/indexer.test.ts:63`

- [ ] **Step 1: Write failing test — schema version is "3"**

In `tests/unit/lib/indexer.test.ts`, update the existing schema version test at line 63:

```typescript
it("uses schema version 3", () => {
	expect(SCHEMA_VERSION).toBe("3");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/lib/indexer.test.ts -t "uses schema version"
```

Expected: FAIL — `"2"` !== `"3"`

- [ ] **Step 3: Add types and bump schema version**

In `src/lib/models.ts`, change `SCHEMA_VERSION` and add new types after `DocInput`:

```typescript
export const SCHEMA_VERSION = "3";
```

Add after the `DocInput` type:

```typescript
export type CallEdge = {
	from: string;
	to: string;
	kind: "call" | "new" | "method";
};

export type FunctionNode = {
	qualifiedName: string;
	file: string;
	exported: boolean;
	isDefaultExport: boolean;
	line: number;
};

export type BlastHit = {
	qualifiedName: string;
	file: string;
	hop: number;
	exported: boolean;
};
```

Add `calls` and `functions` to `RepoCache`:

```typescript
export type RepoCache = {
	schemaVersion: typeof SCHEMA_VERSION;
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

- [ ] **Step 4: Fix all test files that construct RepoCache objects**

Every test that constructs a `RepoCache` literal needs `calls: []` and `functions: []`. Update these files:

In `tests/unit/lib/indexer.test.ts`, update `makeCacheForIncremental()` — add at the end before the closing brace:

```typescript
calls: [],
functions: [],
```

Also update `getCachedIndex` tests — the `stale` and `fresh` cache literals need the same two fields.

In `tests/unit/lib/suggest-ranker.test.ts`, update `makeCache()` — add:

```typescript
calls: [],
functions: [],
```

Search all other test files constructing `RepoCache` and add the fields. Files to check: `tests/unit/lib/rehydrate.test.ts`, `tests/unit/lib/suggest.test.ts`, `tests/unit/lib/cache-store.test.ts`, `tests/unit/lib/briefing.test.ts`.

- [ ] **Step 5: Fix buildIndex in indexer.ts**

In `src/lib/indexer.ts`, add `calls: []` and `functions: []` to the return object in `buildIndex()` at line 31:

```typescript
return {
	schemaVersion: SCHEMA_VERSION,
	repoKey: identity.repoKey,
	worktreeKey: identity.worktreeKey,
	worktreePath: identity.worktreePath,
	indexedAt: new Date().toISOString(),
	fingerprint,
	packageMeta,
	entryFiles,
	files,
	docs,
	imports,
	calls: [],
	functions: [],
};
```

Also add `calls: []` and `functions: []` to the return in `buildIncrementalIndex()` at line 116:

```typescript
return {
	schemaVersion: SCHEMA_VERSION,
	repoKey: identity.repoKey,
	worktreeKey: identity.worktreeKey,
	worktreePath: identity.worktreePath,
	indexedAt,
	fingerprint,
	dirtyAtIndex,
	packageMeta,
	entryFiles,
	files,
	docs,
	imports,
	calls: [],
	functions: [],
};
```

And in the empty-diff early return at line 69:

```typescript
return {
	...existingCache,
	fingerprint,
	indexedAt,
	dirtyAtIndex,
	calls: existingCache.calls ?? [],
	functions: existingCache.functions ?? [],
};
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
```

Expected: all tests pass, including "uses schema version 3".

- [ ] **Step 7: Run typecheck**

```bash
pnpm run typecheck
```

Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/models.ts src/lib/indexer.ts tests/
git commit -m "feat: add CallEdge, FunctionNode, BlastHit types and bump schema to v3"
```

---

## Task 3: Adapter interface and registry

**Files:**
- Create: `src/lib/lang-adapter.ts`
- Create: `src/lib/adapters/index.ts`
- Create: `tests/unit/lib/lang-adapter.test.ts`

- [ ] **Step 1: Write failing tests for adapter registry**

Create `tests/unit/lib/lang-adapter.test.ts`:

```typescript
// tests/unit/lib/lang-adapter.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { registerAdapter, adapterForFile, clearAdapters } from "../../../src/lib/adapters/index.js";
import type { LangAdapter } from "../../../src/lib/lang-adapter.js";

const stubAdapter: LangAdapter = {
	extensions: [".ts", ".tsx"],
	extractFile: () => ({ functions: [], rawCalls: [], importBindings: [] }),
};

describe("adapter registry", () => {
	beforeEach(() => {
		clearAdapters();
	});

	it("returns undefined for unregistered extension", () => {
		expect(adapterForFile("foo.py")).toBeUndefined();
	});

	it("returns registered adapter for matching extension", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("src/lib/foo.ts")).toBe(stubAdapter);
	});

	it("matches .tsx extension", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("src/App.tsx")).toBe(stubAdapter);
	});

	it("returns undefined when no adapter matches", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("styles.css")).toBeUndefined();
	});

	it("returns undefined for file with no extension", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("Makefile")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/lib/lang-adapter.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Create lang-adapter.ts**

Create `src/lib/lang-adapter.ts`:

```typescript
// src/lib/lang-adapter.ts
import type { FunctionNode, CallEdge } from "./models.js";

export type RawCallSite = {
	callerQualifiedName: string;
	callerFile: string;
	rawCallee: string;
	kind: "call" | "new" | "method";
};

export type ImportBinding = {
	localName: string;
	importedName: string;
	fromSpecifier: string;
	bindingKind: "named" | "default" | "namespace";
};

export type FileExtractionResult = {
	functions: FunctionNode[];
	rawCalls: RawCallSite[];
	importBindings: ImportBinding[];
};

export interface LangAdapter {
	extensions: string[];
	extractFile(source: string, filePath: string): FileExtractionResult;
}
```

- [ ] **Step 4: Create adapters/index.ts**

Create directory and file `src/lib/adapters/index.ts`:

```typescript
// src/lib/adapters/index.ts
import path from "node:path";
import type { LangAdapter } from "../lang-adapter.js";

const adapters: Map<string, LangAdapter> = new Map();

export function registerAdapter(adapter: LangAdapter): void {
	for (const ext of adapter.extensions) {
		adapters.set(ext, adapter);
	}
}

export function adapterForFile(filePath: string): LangAdapter | undefined {
	const ext = path.extname(filePath);
	if (!ext) return undefined;
	return adapters.get(ext);
}

export function clearAdapters(): void {
	adapters.clear();
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run tests/unit/lib/lang-adapter.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 6: Run typecheck**

```bash
pnpm run typecheck
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/lang-adapter.ts src/lib/adapters/index.ts tests/unit/lib/lang-adapter.test.ts
git commit -m "feat: add LangAdapter interface and adapter registry"
```

---

## Task 4: TypeScript/JavaScript adapter

**Files:**
- Create: `src/lib/adapters/typescript.ts`
- Create: `tests/unit/lib/adapters/typescript.test.ts`

- [ ] **Step 1: Write failing tests for TS adapter extraction**

Create `tests/unit/lib/adapters/typescript.test.ts`:

```typescript
// tests/unit/lib/adapters/typescript.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { createTypescriptAdapter } from "../../../../src/lib/adapters/typescript.js";
import type { LangAdapter } from "../../../../src/lib/lang-adapter.js";

let adapter: LangAdapter;

beforeAll(async () => {
	adapter = await createTypescriptAdapter();
});

describe("typescript adapter — function extraction", () => {
	it("extracts named function declaration", () => {
		const result = adapter.extractFile(
			`function foo() { return 1; }`,
			"src/foo.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "foo",
				file: "src/foo.ts",
				exported: false,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts exported function declaration", () => {
		const result = adapter.extractFile(
			`export function bar() {}`,
			"src/bar.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "bar",
				exported: true,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts arrow function assigned to const", () => {
		const result = adapter.extractFile(
			`const baz = () => {};`,
			"src/baz.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "baz",
				exported: false,
			}),
		);
	});

	it("extracts exported arrow function", () => {
		const result = adapter.extractFile(
			`export const qux = () => {};`,
			"src/qux.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "qux",
				exported: true,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts class method with qualified name", () => {
		const result = adapter.extractFile(
			`class Foo { bar() {} render() {} }`,
			"src/foo.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.bar" }),
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.render" }),
		);
	});

	it("marks methods of exported class as exported", () => {
		const result = adapter.extractFile(
			`export class Svc { run() {} }`,
			"src/svc.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Svc.run",
				exported: true,
			}),
		);
	});

	it("does not collapse same-name methods in different classes", () => {
		const result = adapter.extractFile(
			`class A { render() {} }\nclass B { render() {} }`,
			"src/ab.ts",
		);
		const names = result.functions.map((f) => f.qualifiedName);
		expect(names).toContain("A.render");
		expect(names).toContain("B.render");
	});

	it("extracts named default export function", () => {
		const result = adapter.extractFile(
			`export default function doThing() {}`,
			"src/do.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "doThing",
				exported: true,
				isDefaultExport: true,
			}),
		);
	});

	it("synthesizes 'default' name for anonymous default export", () => {
		const result = adapter.extractFile(
			`export default () => {};`,
			"src/anon.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "default",
				exported: true,
				isDefaultExport: true,
			}),
		);
	});

	it("extracts default-exported class with methods", () => {
		const result = adapter.extractFile(
			`export default class Ctrl { handle() {} }`,
			"src/ctrl.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Ctrl",
				isDefaultExport: true,
			}),
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Ctrl.handle",
				exported: true,
			}),
		);
	});

	it("reports accurate line numbers", () => {
		const source = `// comment\n\nfunction foo() {}\n`;
		const result = adapter.extractFile(source, "src/foo.ts");
		const foo = result.functions.find((f) => f.qualifiedName === "foo");
		expect(foo?.line).toBe(3);
	});
});

describe("typescript adapter — raw call site extraction", () => {
	it("extracts direct function call", () => {
		const result = adapter.extractFile(
			`function a() { foo(); }`,
			"src/a.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "foo",
				kind: "call",
				callerFile: "src/a.ts",
			}),
		);
	});

	it("extracts new expression", () => {
		const result = adapter.extractFile(
			`function a() { new Foo(); }`,
			"src/a.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "Foo",
				kind: "new",
			}),
		);
	});

	it("extracts method call with receiver", () => {
		const result = adapter.extractFile(
			`function a() { obj.method(); }`,
			"src/a.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "obj.method",
				kind: "method",
			}),
		);
	});

	it("extracts this.method call", () => {
		const result = adapter.extractFile(
			`class Foo { bar() { this.baz(); } baz() {} }`,
			"src/foo.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "this.baz",
				kind: "method",
				callerQualifiedName: "Foo.bar",
			}),
		);
	});

	it("sets callerQualifiedName to enclosing function", () => {
		const result = adapter.extractFile(
			`function outer() { inner(); }\nfunction inner() {}`,
			"src/x.ts",
		);
		const call = result.rawCalls.find((c) => c.rawCallee === "inner");
		expect(call?.callerQualifiedName).toBe("outer");
	});
});

describe("typescript adapter — import binding extraction", () => {
	it("extracts named import", () => {
		const result = adapter.extractFile(
			`import { foo } from "./bar";`,
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "foo",
			importedName: "foo",
			fromSpecifier: "./bar",
			bindingKind: "named",
		});
	});

	it("extracts aliased import", () => {
		const result = adapter.extractFile(
			`import { foo as baz } from "./bar";`,
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "baz",
			importedName: "foo",
			fromSpecifier: "./bar",
			bindingKind: "named",
		});
	});

	it("extracts default import", () => {
		const result = adapter.extractFile(
			`import Bar from "./bar";`,
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "Bar",
			importedName: "default",
			fromSpecifier: "./bar",
			bindingKind: "default",
		});
	});

	it("extracts namespace import", () => {
		const result = adapter.extractFile(
			`import * as utils from "./utils";`,
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "utils",
			importedName: "*",
			fromSpecifier: "./utils",
			bindingKind: "namespace",
		});
	});

	it("ignores non-relative imports", () => {
		const result = adapter.extractFile(
			`import { readFileSync } from "node:fs";`,
			"src/a.ts",
		);
		expect(result.importBindings).toHaveLength(0);
	});
});

describe("typescript adapter — edge cases", () => {
	it("returns empty result for empty file", () => {
		const result = adapter.extractFile("", "src/empty.ts");
		expect(result.functions).toHaveLength(0);
		expect(result.rawCalls).toHaveLength(0);
		expect(result.importBindings).toHaveLength(0);
	});

	it("handles file with syntax errors gracefully", () => {
		const result = adapter.extractFile(
			`function foo( { bar(); }`,
			"src/broken.ts",
		);
		// Should not throw — tree-sitter does partial parsing
		expect(result).toBeDefined();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/lib/adapters/typescript.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the TypeScript adapter**

Create `src/lib/adapters/typescript.ts`. This is the largest single file in Phase 5. The adapter must:

1. Initialize `web-tree-sitter` WASM parser lazily
2. Load TS, TSX, and JS grammars from their respective packages
3. Parse source into tree-sitter AST
4. Walk the tree to extract `FunctionNode[]`, `RawCallSite[]`, `ImportBinding[]`

```typescript
// src/lib/adapters/typescript.ts
import { createRequire } from "node:module";
import path from "node:path";
import type { FunctionNode } from "../models.js";
import type {
	LangAdapter,
	FileExtractionResult,
	RawCallSite,
	ImportBinding,
} from "../lang-adapter.js";

// createRequire needed because repo is "type": "module" — no bare require()
const require = createRequire(import.meta.url);

// Lazy-initialized parser state
let Parser: typeof import("web-tree-sitter").default | null = null;
let tsParser: import("web-tree-sitter").default | null = null;
let tsxParser: import("web-tree-sitter").default | null = null;
let jsParser: import("web-tree-sitter").default | null = null;

type SyntaxNode = import("web-tree-sitter").default.SyntaxNode;

async function initParsers(): Promise<void> {
	if (Parser) return;
	const TreeSitter = (await import("web-tree-sitter")).default;
	await TreeSitter.init();

	// tree-sitter-typescript ships TS and TSX grammars
	const tsGrammarPath = require.resolve(
		"tree-sitter-typescript/tree-sitter-typescript.wasm",
	);
	const tsxGrammarPath = require.resolve(
		"tree-sitter-typescript/tree-sitter-tsx.wasm",
	);
	// tree-sitter-javascript ships JS grammar (handles JSX too)
	const jsGrammarPath = require.resolve(
		"tree-sitter-javascript/tree-sitter-javascript.wasm",
	);

	const tsLang = await TreeSitter.Language.load(tsGrammarPath);
	const tsxLang = await TreeSitter.Language.load(tsxGrammarPath);
	const jsLang = await TreeSitter.Language.load(jsGrammarPath);

	tsParser = new TreeSitter();
	tsParser.setLanguage(tsLang);

	tsxParser = new TreeSitter();
	tsxParser.setLanguage(tsxLang);

	jsParser = new TreeSitter();
	jsParser.setLanguage(jsLang);

	Parser = TreeSitter;
}

function parserForExt(ext: string): import("web-tree-sitter").default | null {
	if (ext === ".tsx") return tsxParser;
	if (ext === ".ts") return tsParser;
	if (ext === ".jsx" || ext === ".js") return jsParser;
	return null;
}

function extractFunctions(root: SyntaxNode, filePath: string): FunctionNode[] {
	const functions: FunctionNode[] = [];

	function walk(node: SyntaxNode, className: string | null, classExported: boolean): void {
		switch (node.type) {
			case "function_declaration": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) break;
				const isExport = node.parent?.type === "export_statement";
				const isDefault = isExport && node.parent?.children.some(
					(c) => c.type === "default",
				);
				functions.push({
					qualifiedName: nameNode.text,
					file: filePath,
					exported: !!isExport,
					isDefaultExport: !!isDefault,
					line: node.startPosition.row + 1,
				});
				break;
			}
			case "lexical_declaration": {
				// const foo = () => {} or const foo = function() {}
				const isExport = node.parent?.type === "export_statement";
				for (const declarator of node.children) {
					if (declarator.type !== "variable_declarator") continue;
					const nameNode = declarator.childForFieldName("name");
					const valueNode = declarator.childForFieldName("value");
					if (!nameNode || !valueNode) continue;
					if (
						valueNode.type === "arrow_function" ||
						valueNode.type === "function_expression"
					) {
						functions.push({
							qualifiedName: nameNode.text,
							file: filePath,
							exported: !!isExport,
							isDefaultExport: false,
							line: node.startPosition.row + 1,
						});
					}
				}
				break;
			}
			case "class_declaration": {
				const nameNode = node.childForFieldName("name");
				const name = nameNode?.text ?? null;
				const isExport = node.parent?.type === "export_statement";
				const isDefault = isExport && node.parent?.children.some(
					(c) => c.type === "default",
				);
				if (name) {
					functions.push({
						qualifiedName: name,
						file: filePath,
						exported: !!isExport,
						isDefaultExport: !!isDefault,
						line: node.startPosition.row + 1,
					});
				}
				// Walk class body for methods
				const body = node.childForFieldName("body");
				if (body && name) {
					walk(body, name, !!isExport);
					return; // Don't walk children again
				}
				break;
			}
			case "method_definition": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode || !className) break;
				functions.push({
					qualifiedName: `${className}.${nameNode.text}`,
					file: filePath,
					exported: classExported,
					isDefaultExport: false,
					line: node.startPosition.row + 1,
				});
				break;
			}
			case "export_statement": {
				// Handle: export default () => {} and export default class Foo {}
				// Named exports are handled by the child node's own case
				const defaultToken = node.children.find((c) => c.type === "default");
				if (!defaultToken) break;
				const valueChild = node.children.find(
					(c) =>
						c.type === "arrow_function" ||
						c.type === "function_expression",
				);
				if (valueChild) {
					functions.push({
						qualifiedName: "default",
						file: filePath,
						exported: true,
						isDefaultExport: true,
						line: valueChild.startPosition.row + 1,
					});
					return; // Don't walk children — we handled it
				}
				break;
			}
		}

		for (const child of node.children) {
			walk(child, className, classExported);
		}
	}

	walk(root, null, false);
	return functions;
}

function findEnclosingFunction(
	node: SyntaxNode,
	functions: FunctionNode[],
	filePath: string,
): string | null {
	let current = node.parent;
	while (current) {
		if (current.type === "method_definition") {
			const methodName = current.childForFieldName("name")?.text;
			const classNode = current.parent?.parent;
			const className =
				classNode?.type === "class_declaration"
					? classNode.childForFieldName("name")?.text
					: null;
			if (className && methodName) return `${className}.${methodName}`;
		}
		if (
			current.type === "function_declaration" ||
			current.type === "arrow_function" ||
			current.type === "function_expression"
		) {
			// For function_declaration, name is a direct child
			if (current.type === "function_declaration") {
				const name = current.childForFieldName("name")?.text;
				if (name) return name;
			}
			// For arrow/expression assigned to variable
			if (current.parent?.type === "variable_declarator") {
				const name = current.parent.childForFieldName("name")?.text;
				if (name) return name;
			}
		}
		current = current.parent;
	}
	return null;
}

function extractRawCalls(
	root: SyntaxNode,
	filePath: string,
	functions: FunctionNode[],
): RawCallSite[] {
	const calls: RawCallSite[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "call_expression") {
			const funcNode = node.childForFieldName("function");
			if (!funcNode) { walkChildren(node); return; }

			let rawCallee: string;
			let kind: RawCallSite["kind"];

			if (funcNode.type === "member_expression") {
				const obj = funcNode.childForFieldName("object")?.text ?? "";
				const prop = funcNode.childForFieldName("property")?.text ?? "";
				rawCallee = `${obj}.${prop}`;
				kind = "method";
			} else {
				rawCallee = funcNode.text;
				kind = "call";
			}

			const caller = findEnclosingFunction(node, functions, filePath);
			if (caller) {
				calls.push({
					callerQualifiedName: caller,
					callerFile: filePath,
					rawCallee,
					kind,
				});
			}
		} else if (node.type === "new_expression") {
			const ctorNode = node.childForFieldName("constructor");
			if (ctorNode) {
				const caller = findEnclosingFunction(node, functions, filePath);
				if (caller) {
					calls.push({
						callerQualifiedName: caller,
						callerFile: filePath,
						rawCallee: ctorNode.text,
						kind: "new",
					});
				}
			}
		}
		walkChildren(node);
	}

	function walkChildren(node: SyntaxNode): void {
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(root);
	return calls;
}

function extractImportBindings(root: SyntaxNode): ImportBinding[] {
	const bindings: ImportBinding[] = [];

	for (const node of root.children) {
		if (node.type !== "import_statement") continue;

		const sourceNode = node.childForFieldName("source");
		if (!sourceNode) continue;
		const specifier = sourceNode.text.replace(/['"]/g, "");
		// Only track relative imports
		if (!specifier.startsWith(".")) continue;

		for (const child of node.children) {
			// Default import: import Foo from "./bar"
			if (child.type === "identifier") {
				bindings.push({
					localName: child.text,
					importedName: "default",
					fromSpecifier: specifier,
					bindingKind: "default",
				});
			}
			// Named imports: import { foo, bar as baz } from "./mod"
			if (child.type === "import_clause") {
				for (const clauseChild of child.children) {
					if (clauseChild.type === "identifier") {
						// Default import in clause
						bindings.push({
							localName: clauseChild.text,
							importedName: "default",
							fromSpecifier: specifier,
							bindingKind: "default",
						});
					}
					if (clauseChild.type === "named_imports") {
						for (const spec of clauseChild.children) {
							if (spec.type !== "import_specifier") continue;
							const nameNode = spec.childForFieldName("name");
							const aliasNode = spec.childForFieldName("alias");
							if (!nameNode) continue;
							bindings.push({
								localName: aliasNode?.text ?? nameNode.text,
								importedName: nameNode.text,
								fromSpecifier: specifier,
								bindingKind: "named",
							});
						}
					}
					if (clauseChild.type === "namespace_import") {
						const nameNode = clauseChild.children.find(
							(c) => c.type === "identifier",
						);
						if (nameNode) {
							bindings.push({
								localName: nameNode.text,
								importedName: "*",
								fromSpecifier: specifier,
								bindingKind: "namespace",
							});
						}
					}
				}
			}
		}
	}

	return bindings;
}

export async function createTypescriptAdapter(): Promise<LangAdapter> {
	await initParsers();

	return {
		extensions: [".ts", ".tsx", ".js", ".jsx"],
		extractFile(source: string, filePath: string): FileExtractionResult {
			const ext = path.extname(filePath);
			const parser = parserForExt(ext);
			if (!parser) return { functions: [], rawCalls: [], importBindings: [] };

			const tree = parser.parse(source);
			const root = tree.rootNode;

			const functions = extractFunctions(root, filePath);
			const rawCalls = extractRawCalls(root, filePath, functions);
			const importBindings = extractImportBindings(root);

			return { functions, rawCalls, importBindings };
		},
	};
}
```

**WASM loading note:** The adapter uses `createRequire(import.meta.url)` because the repo is `"type": "module"`. The `tree-sitter-javascript` package may ship the grammar as `tree-sitter-javascript.wasm` at its package root — verify the exact path after `pnpm install` and adjust `require.resolve` if needed.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/unit/lib/adapters/typescript.test.ts
```

Expected: all tests pass. If WASM loading fails, debug the grammar path resolution first.

- [ ] **Step 5: Run typecheck**

```bash
pnpm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adapters/typescript.ts tests/unit/lib/adapters/typescript.test.ts
git commit -m "feat: add TypeScript/JavaScript tree-sitter adapter"
```

---

## Task 5: Call graph extraction and resolution

**Files:**
- Create: `src/lib/call-graph.ts`
- Create: `tests/unit/lib/call-graph.test.ts`

- [ ] **Step 1: Write failing tests for call resolution**

Create `tests/unit/lib/call-graph.test.ts`:

```typescript
// tests/unit/lib/call-graph.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../src/lib/adapters/index.js");

import { adapterForFile } from "../../../src/lib/adapters/index.js";
import type { LangAdapter, RawCallSite, ImportBinding } from "../../../src/lib/lang-adapter.js";
import type { FunctionNode } from "../../../src/lib/models.js";
import { resolveCallSites, extractCallGraph } from "../../../src/lib/call-graph.js";

describe("resolveCallSites", () => {
	const functions: FunctionNode[] = [
		{ qualifiedName: "foo", file: "src/a.ts", exported: true, isDefaultExport: false, line: 1 },
		{ qualifiedName: "bar", file: "src/b.ts", exported: true, isDefaultExport: false, line: 1 },
		{ qualifiedName: "Svc.run", file: "src/b.ts", exported: true, isDefaultExport: false, line: 5 },
		{ qualifiedName: "doThing", file: "src/c.ts", exported: true, isDefaultExport: true, line: 1 },
	];

	it("resolves same-file call", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "foo",
			kind: "call",
		}];
		// foo calls itself in same file — should resolve
		// Actually let's add a helper in same file
		const funcsWithHelper = [
			...functions,
			{ qualifiedName: "helper", file: "src/a.ts", exported: false, isDefaultExport: false, line: 10 },
		];
		const rawCallsFixed: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "helper",
			kind: "call",
		}];
		const edges = resolveCallSites(
			rawCallsFixed,
			funcsWithHelper,
			new Map(),
		);
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/a.ts::helper",
			kind: "call",
		});
	});

	it("resolves named import binding", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "bar",
			kind: "call",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "bar",
				importedName: "bar",
				fromSpecifier: "./b",
				bindingKind: "named",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings);
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "call",
		});
	});

	it("resolves aliased import binding", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "myBar",
			kind: "call",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "myBar",
				importedName: "bar",
				fromSpecifier: "./b",
				bindingKind: "named",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings);
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "call",
		});
	});

	it("resolves default import to named default export", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "Thing",
			kind: "call",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "Thing",
				importedName: "default",
				fromSpecifier: "./c",
				bindingKind: "default",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings);
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/c.ts::doThing",
			kind: "call",
		});
	});

	it("resolves namespace import member access", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "b.bar",
			kind: "method",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "b",
				importedName: "*",
				fromSpecifier: "./b",
				bindingKind: "namespace",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings);
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "method",
		});
	});

	it("falls back to ::bareMethod for unresolvable method call", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "obj.unknown",
			kind: "method",
		}];
		const edges = resolveCallSites(rawCalls, functions, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "::unknown",
			kind: "method",
		});
	});

	it("falls back to ::rawCallee for unresolvable plain call", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "mystery",
			kind: "call",
		}];
		const edges = resolveCallSites(rawCalls, functions, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "::mystery",
			kind: "call",
		});
	});
});

describe("extractCallGraph", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("skips files with no adapter", async () => {
		vi.mocked(adapterForFile).mockReturnValue(undefined);
		const result = await extractCallGraph("/repo", ["src/styles.css"]);
		expect(result.calls).toHaveLength(0);
		expect(result.functions).toHaveLength(0);
	});

	it("collects functions and resolved calls from adapter", async () => {
		const mockAdapter: LangAdapter = {
			extensions: [".ts"],
			extractFile: vi.fn().mockReturnValue({
				functions: [
					{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
					{ qualifiedName: "helper", file: "src/main.ts", exported: false, isDefaultExport: false, line: 5 },
				],
				rawCalls: [{
					callerQualifiedName: "main",
					callerFile: "src/main.ts",
					rawCallee: "helper",
					kind: "call",
				}],
				importBindings: [],
			}),
		};
		vi.mocked(adapterForFile).mockReturnValue(mockAdapter);

		const result = await extractCallGraph("/repo", ["src/main.ts"]);
		expect(result.functions).toHaveLength(2);
		expect(result.calls).toContainEqual({
			from: "src/main.ts::main",
			to: "src/main.ts::helper",
			kind: "call",
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/lib/call-graph.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement call-graph.ts**

Create `src/lib/call-graph.ts`:

```typescript
// src/lib/call-graph.ts
import fs from "node:fs";
import path from "node:path";
import { adapterForFile } from "./adapters/index.js";
import type { RawCallSite, ImportBinding } from "./lang-adapter.js";
import type { CallEdge, FunctionNode } from "./models.js";

function stripKnownExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx)$/u, "");
}

function resolveSpecifier(
	fromSpecifier: string,
	callerFile: string,
): string {
	return path
		.normalize(path.join(path.dirname(callerFile), fromSpecifier))
		.replace(/\\/g, "/");
}

function findTargetFile(
	normalizedSpecifier: string,
	allFiles: Map<string, FunctionNode[]>,
): string | null {
	// Try exact extensionless match
	for (const file of allFiles.keys()) {
		if (stripKnownExt(file) === normalizedSpecifier) return file;
	}
	// Try index suffix
	for (const file of allFiles.keys()) {
		if (stripKnownExt(file) === `${normalizedSpecifier}/index`) return file;
	}
	return null;
}

export function resolveCallSites(
	rawCalls: RawCallSite[],
	allFunctions: FunctionNode[],
	bindingsByFile: Map<string, ImportBinding[]>,
): CallEdge[] {
	// Build function lookup: file -> qualifiedName -> FunctionNode
	const funcsByFile = new Map<string, Map<string, FunctionNode>>();
	for (const fn of allFunctions) {
		let fileMap = funcsByFile.get(fn.file);
		if (!fileMap) {
			fileMap = new Map();
			funcsByFile.set(fn.file, fileMap);
		}
		fileMap.set(fn.qualifiedName, fn);
	}

	// Build file set for target resolution
	const allFileNodes = new Map<string, FunctionNode[]>();
	for (const fn of allFunctions) {
		const list = allFileNodes.get(fn.file) ?? [];
		list.push(fn);
		allFileNodes.set(fn.file, list);
	}

	const edges: CallEdge[] = [];

	for (const raw of rawCalls) {
		const fromKey = `${raw.callerFile}::${raw.callerQualifiedName}`;
		const bindings = bindingsByFile.get(raw.callerFile) ?? [];

		// 1. Binding lookup
		let resolved = false;

		// For method-kind calls like "obj.method", check if "obj" is a binding
		const dotIndex = raw.rawCallee.indexOf(".");
		if (dotIndex !== -1) {
			const receiver = raw.rawCallee.slice(0, dotIndex);
			const member = raw.rawCallee.slice(dotIndex + 1);

			const binding = bindings.find((b) => b.localName === receiver);
			if (binding) {
				const specifier = resolveSpecifier(binding.fromSpecifier, raw.callerFile);
				const targetFile = findTargetFile(specifier, allFileNodes);

				if (targetFile) {
					if (binding.bindingKind === "namespace") {
						// Namespace: utils.foo -> targetFile::foo
						// Only emit file-qualified edge if function actually exists
						const targetFunc = funcsByFile.get(targetFile)?.get(member);
						if (targetFunc) {
							edges.push({
								from: fromKey,
								to: `${targetFile}::${targetFunc.qualifiedName}`,
								kind: raw.kind,
							});
							resolved = true;
						}
						// If member not found in target file, fall through to
						// unresolved fallback below (::member) — don't invent
						// a resolved-looking edge to a nonexistent function
					}
				}
			}

			if (!resolved) {
				// Unresolvable method: strip receiver, keep bare method
				edges.push({ from: fromKey, to: `::${member}`, kind: raw.kind });
				resolved = true;
			}
		}

		if (resolved) continue;

		// Check simple binding match (non-dotted)
		const binding = bindings.find((b) => b.localName === raw.rawCallee);
		if (binding) {
			const specifier = resolveSpecifier(binding.fromSpecifier, raw.callerFile);
			const targetFile = findTargetFile(specifier, allFileNodes);

			if (targetFile) {
				if (binding.bindingKind === "default") {
					// Find the default export in target file
					const defaultFunc = allFunctions.find(
						(f) => f.file === targetFile && f.isDefaultExport,
					);
					if (defaultFunc) {
						edges.push({
							from: fromKey,
							to: `${targetFile}::${defaultFunc.qualifiedName}`,
							kind: raw.kind,
						});
						resolved = true;
					}
				} else {
					// Named/aliased: importedName is the target function name
					const targetFunc = funcsByFile.get(targetFile)?.get(binding.importedName);
					if (targetFunc) {
						edges.push({
							from: fromKey,
							to: `${targetFile}::${targetFunc.qualifiedName}`,
							kind: raw.kind,
						});
						resolved = true;
					}
				}
			}
		}

		if (resolved) continue;

		// 2. Same-file lookup
		const sameFile = funcsByFile.get(raw.callerFile);
		if (sameFile) {
			const match = sameFile.get(raw.rawCallee);
			if (match) {
				edges.push({
					from: fromKey,
					to: `${raw.callerFile}::${match.qualifiedName}`,
					kind: raw.kind,
				});
				continue;
			}
		}

		// 3. Fallback
		edges.push({ from: fromKey, to: `::${raw.rawCallee}`, kind: raw.kind });
	}

	return edges;
}

// Lazy adapter registration — called once on first extractCallGraph
let adapterInitialized = false;
async function ensureAdapters(): Promise<void> {
	if (adapterInitialized) return;
	const { createTypescriptAdapter } = await import("./adapters/typescript.js");
	const { registerAdapter } = await import("./adapters/index.js");
	const adapter = await createTypescriptAdapter();
	registerAdapter(adapter);
	adapterInitialized = true;
}

export async function extractCallGraph(
	worktreePath: string,
	filePaths: string[],
): Promise<{ calls: CallEdge[]; functions: FunctionNode[] }> {
	await ensureAdapters();
	const allFunctions: FunctionNode[] = [];
	const allRawCalls: RawCallSite[] = [];
	const bindingsByFile = new Map<string, ImportBinding[]>();

	for (const filePath of filePaths) {
		const adapter = adapterForFile(filePath);
		if (!adapter) continue;

		let source: string;
		try {
			source = fs.readFileSync(path.join(worktreePath, filePath), "utf8");
		} catch {
			continue;
		}

		try {
			const result = adapter.extractFile(source, filePath);
			allFunctions.push(...result.functions);
			allRawCalls.push(...result.rawCalls);
			if (result.importBindings.length > 0) {
				bindingsByFile.set(filePath, result.importBindings);
			}
		} catch {
			// Tree-sitter parse failure for this file — skip silently
			continue;
		}
	}

	const calls = resolveCallSites(allRawCalls, allFunctions, bindingsByFile);
	return { calls, functions: allFunctions };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/unit/lib/call-graph.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run typecheck**

```bash
pnpm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/call-graph.ts tests/unit/lib/call-graph.test.ts
git commit -m "feat: add call graph extraction with import-aware resolution"
```

---

## Task 6: Blast radius query engine

**Files:**
- Create: `src/lib/blast-radius.ts`
- Create: `tests/unit/lib/blast-radius.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/lib/blast-radius.test.ts`:

```typescript
// tests/unit/lib/blast-radius.test.ts
import { describe, expect, it } from "vitest";
import { queryBlastRadius } from "../../../src/lib/blast-radius.js";
import type { CallEdge, FunctionNode } from "../../../src/lib/models.js";

const functions: FunctionNode[] = [
	{ qualifiedName: "main", file: "src/cli.ts", exported: true, isDefaultExport: false, line: 1 },
	{ qualifiedName: "suggestRepo", file: "src/suggest.ts", exported: true, isDefaultExport: false, line: 1 },
	{ qualifiedName: "rankFiles", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 1 },
	{ qualifiedName: "scoreItem", file: "src/ranker.ts", exported: false, isDefaultExport: false, line: 10 },
	{ qualifiedName: "Ranker.score", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 20 },
];

const calls: CallEdge[] = [
	{ from: "src/cli.ts::main", to: "src/suggest.ts::suggestRepo", kind: "call" },
	{ from: "src/suggest.ts::suggestRepo", to: "src/ranker.ts::rankFiles", kind: "call" },
	{ from: "src/ranker.ts::rankFiles", to: "src/ranker.ts::scoreItem", kind: "call" },
];

describe("queryBlastRadius", () => {
	it("returns direct callers at hop 1", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "rankFiles", file: "src/ranker.ts" },
			calls,
			functions,
		);
		expect(result.tiers[0]?.hop).toBe(1);
		expect(result.tiers[0]?.hits).toContainEqual(
			expect.objectContaining({
				qualifiedName: "suggestRepo",
				file: "src/suggest.ts",
				hop: 1,
			}),
		);
	});

	it("returns transitive callers at hop 2+", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "rankFiles", file: "src/ranker.ts" },
			calls,
			functions,
		);
		expect(result.tiers).toHaveLength(2);
		expect(result.tiers[1]?.hop).toBe(2);
		expect(result.tiers[1]?.hits).toContainEqual(
			expect.objectContaining({
				qualifiedName: "main",
				hop: 2,
			}),
		);
	});

	it("reports totalAffected count", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "rankFiles", file: "src/ranker.ts" },
			calls,
			functions,
		);
		expect(result.totalAffected).toBe(2); // suggestRepo + main
	});

	it("reports exported status from FunctionNode", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "scoreItem", file: "src/ranker.ts" },
			calls,
			functions,
		);
		expect(result.tiers[0]?.hits[0]).toMatchObject({
			qualifiedName: "rankFiles",
			exported: true,
		});
	});

	it("respects maxHops", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "rankFiles", file: "src/ranker.ts" },
			calls,
			functions,
			{ maxHops: 1 },
		);
		expect(result.tiers).toHaveLength(1);
		expect(result.totalAffected).toBe(1);
	});

	it("returns empty tiers for function with no callers", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "main", file: "src/cli.ts" },
			calls,
			functions,
		);
		expect(result.tiers).toHaveLength(0);
		expect(result.totalAffected).toBe(0);
	});

	it("handles circular calls without infinite loop", () => {
		const circularCalls: CallEdge[] = [
			{ from: "src/a.ts::foo", to: "src/b.ts::bar", kind: "call" },
			{ from: "src/b.ts::bar", to: "src/a.ts::foo", kind: "call" },
		];
		const circularFuncs: FunctionNode[] = [
			{ qualifiedName: "foo", file: "src/a.ts", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "bar", file: "src/b.ts", exported: true, isDefaultExport: false, line: 1 },
		];
		const result = queryBlastRadius(
			{ qualifiedName: "foo", file: "src/a.ts" },
			circularCalls,
			circularFuncs,
		);
		// bar calls foo (hop 1), foo calls bar which calls foo — but foo is already visited
		expect(result.totalAffected).toBe(1);
	});

	it("deduplicates — keeps lowest hop when reached via multiple paths", () => {
		const multiPathCalls: CallEdge[] = [
			{ from: "src/a.ts::a", to: "src/target.ts::t", kind: "call" },
			{ from: "src/b.ts::b", to: "src/target.ts::t", kind: "call" },
			{ from: "src/a.ts::a", to: "src/b.ts::b", kind: "call" },
		];
		const multiPathFuncs: FunctionNode[] = [
			{ qualifiedName: "t", file: "src/target.ts", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "a", file: "src/a.ts", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "b", file: "src/b.ts", exported: true, isDefaultExport: false, line: 1 },
		];
		const result = queryBlastRadius(
			{ qualifiedName: "t", file: "src/target.ts" },
			multiPathCalls,
			multiPathFuncs,
		);
		// Both a and b call t directly at hop 1
		const hop1 = result.tiers.find((t) => t.hop === 1);
		expect(hop1?.hits).toHaveLength(2);
	});

	it("reports confidence full when no unresolved edges match target", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "rankFiles", file: "src/ranker.ts" },
			calls,
			functions,
		);
		expect(result.confidence).toBe("full");
		expect(result.unresolvedEdges).toBe(0);
	});

	it("reports confidence partial when unresolved edges match target name", () => {
		const callsWithUnresolved: CallEdge[] = [
			...calls,
			{ from: "src/other.ts::something", to: "::rankFiles", kind: "call" },
		];
		const result = queryBlastRadius(
			{ qualifiedName: "rankFiles", file: "src/ranker.ts" },
			callsWithUnresolved,
			functions,
		);
		expect(result.confidence).toBe("partial");
		expect(result.unresolvedEdges).toBe(1);
	});

	it("matches unresolved ::method against Class.method target on method portion", () => {
		const callsWithUnresolved: CallEdge[] = [
			...calls,
			{ from: "src/other.ts::something", to: "::score", kind: "method" },
		];
		const result = queryBlastRadius(
			{ qualifiedName: "Ranker.score", file: "src/ranker.ts" },
			callsWithUnresolved,
			functions,
		);
		expect(result.confidence).toBe("partial");
		expect(result.unresolvedEdges).toBe(1);
	});

	it("populates target.exported from FunctionNode", () => {
		const result = queryBlastRadius(
			{ qualifiedName: "rankFiles", file: "src/ranker.ts" },
			calls,
			functions,
		);
		expect(result.target.exported).toBe(true);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/lib/blast-radius.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement blast-radius.ts**

Create `src/lib/blast-radius.ts`:

```typescript
// src/lib/blast-radius.ts
import type { BlastHit, CallEdge, FunctionNode } from "./models.js";

export type BlastRadiusResult = {
	target: { qualifiedName: string; file: string; exported: boolean };
	totalAffected: number;
	unresolvedEdges: number;
	confidence: "full" | "partial";
	tiers: BlastTier[];
};

export type BlastTier = {
	hop: number;
	label: string;
	hits: BlastHit[];
};

export function queryBlastRadius(
	target: { qualifiedName: string; file: string },
	calls: CallEdge[],
	functions: FunctionNode[],
	options?: { maxHops?: number },
): BlastRadiusResult {
	const maxHops = options?.maxHops ?? 5;
	const targetKey = `${target.file}::${target.qualifiedName}`;

	// Look up target's exported status
	const targetFunc = functions.find(
		(f) => f.file === target.file && f.qualifiedName === target.qualifiedName,
	);

	// Build reverse adjacency: callee -> callers
	const reverseAdj = new Map<string, Set<string>>();
	for (const edge of calls) {
		if (edge.to.startsWith("::")) continue; // Skip unresolved
		let callers = reverseAdj.get(edge.to);
		if (!callers) {
			callers = new Set();
			reverseAdj.set(edge.to, callers);
		}
		callers.add(edge.from);
	}

	// BFS from target
	const visited = new Set<string>();
	visited.add(targetKey);
	const hitsByHop = new Map<number, BlastHit[]>();
	let frontier = [targetKey];
	let hop = 0;

	while (frontier.length > 0 && hop < maxHops) {
		hop++;
		const nextFrontier: string[] = [];
		for (const key of frontier) {
			const callers = reverseAdj.get(key);
			if (!callers) continue;
			for (const caller of callers) {
				if (visited.has(caller)) continue;
				visited.add(caller);
				nextFrontier.push(caller);

				// Parse caller key: "file::qualifiedName"
				const sepIdx = caller.indexOf("::");
				const callerFile = caller.slice(0, sepIdx);
				const callerName = caller.slice(sepIdx + 2);

				const callerFunc = functions.find(
					(f) => f.file === callerFile && f.qualifiedName === callerName,
				);

				const hit: BlastHit = {
					qualifiedName: callerName,
					file: callerFile,
					hop,
					exported: callerFunc?.exported ?? false,
				};

				const hitsAtHop = hitsByHop.get(hop) ?? [];
				hitsAtHop.push(hit);
				hitsByHop.set(hop, hitsAtHop);
			}
		}
		frontier = nextFrontier;
	}

	// Build tiers
	const tiers: BlastTier[] = [];
	for (const [h, hits] of [...hitsByHop.entries()].sort((a, b) => a[0] - b[0])) {
		const sorted = hits.sort(
			(a, b) => a.file.localeCompare(b.file) || a.qualifiedName.localeCompare(b.qualifiedName),
		);
		tiers.push({
			hop: h,
			label: h === 1 ? "direct callers" : `transitive callers (${h} hops)`,
			hits: sorted,
		});
	}

	const totalAffected = tiers.reduce((sum, t) => sum + t.hits.length, 0);

	// Count unresolved edges that could plausibly match target
	const targetMethodPortion = target.qualifiedName.includes(".")
		? target.qualifiedName.slice(target.qualifiedName.lastIndexOf(".") + 1)
		: null;

	let unresolvedEdges = 0;
	for (const edge of calls) {
		if (!edge.to.startsWith("::")) continue;
		const unresolvedName = edge.to.slice(2);
		if (unresolvedName === target.qualifiedName) {
			unresolvedEdges++;
		} else if (targetMethodPortion && unresolvedName === targetMethodPortion) {
			unresolvedEdges++;
		}
	}

	return {
		target: {
			qualifiedName: target.qualifiedName,
			file: target.file,
			exported: targetFunc?.exported ?? false,
		},
		totalAffected,
		unresolvedEdges,
		confidence: unresolvedEdges === 0 ? "full" : "partial",
		tiers,
	};
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/unit/lib/blast-radius.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run typecheck**

```bash
pnpm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/blast-radius.ts tests/unit/lib/blast-radius.test.ts
git commit -m "feat: add blast radius query engine with BFS and confidence signal"
```

---

## Task 7: Wire call graph into indexer (full + incremental)

**Files:**
- Modify: `src/lib/indexer.ts:17-129`
- Modify: `tests/unit/lib/indexer.test.ts`

- [ ] **Step 1: Write failing tests for call graph in full index**

Add to `tests/unit/lib/indexer.test.ts`. First add the mock for `call-graph.ts` at the top with other mocks:

```typescript
vi.mock("../../../src/lib/call-graph.js");
```

And the import:

```typescript
import { extractCallGraph } from "../../../src/lib/call-graph.js";
```

In `beforeEach`, add:

```typescript
vi.mocked(extractCallGraph).mockResolvedValue({ calls: [], functions: [] });
```

Add test in `describe("buildIndex")`:

```typescript
it("includes call graph from extractCallGraph", async () => {
	vi.mocked(extractCallGraph).mockResolvedValue({
		calls: [{ from: "src/main.ts::main", to: "src/utils.ts::helper", kind: "call" }],
		functions: [
			{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
		],
	});
	const cache = await buildIndex(mockIdentity);
	expect(cache.calls).toHaveLength(1);
	expect(cache.functions).toHaveLength(1);
	expect(extractCallGraph).toHaveBeenCalledWith(
		"/repo",
		["README.md", "src/main.ts"],
	);
});
```

- [ ] **Step 2: Write failing tests for call graph in incremental index**

Add tests in `describe("buildIncrementalIndex")`:

```typescript
it("removes call edges from changed files and re-extracts", async () => {
	vi.mocked(hashFileContent).mockReturnValue("hash_main_v2");
	vi.mocked(extractCallGraph).mockResolvedValue({
		calls: [{ from: "src/main.ts::main", to: "src/utils.ts::newHelper", kind: "call" }],
		functions: [
			{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
		],
	});
	vi.mocked(extractImports).mockReturnValue([]);

	const existing = makeCacheForIncremental();
	existing.calls = [
		{ from: "src/main.ts::main", to: "src/utils.ts::helper", kind: "call" },
		{ from: "src/utils.ts::helper", to: "src/lib.ts::lib", kind: "call" },
	];
	existing.functions = [
		{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
		{ qualifiedName: "helper", file: "src/utils.ts", exported: true, isDefaultExport: false, line: 1 },
	];

	const diff: FilesDiff = {
		changed: ["src/main.ts"],
		removed: [],
		method: "git-diff",
	};

	const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

	// Old edge from main.ts removed, new one from extractCallGraph added
	expect(result.calls).toContainEqual({
		from: "src/main.ts::main",
		to: "src/utils.ts::newHelper",
		kind: "call",
	});
	// Edge from utils.ts kept (unchanged file)
	expect(result.calls).toContainEqual({
		from: "src/utils.ts::helper",
		to: "src/lib.ts::lib",
		kind: "call",
	});
	// functions: main reparsed, helper kept from unchanged utils.ts
	expect(result.functions).toContainEqual(
		expect.objectContaining({ qualifiedName: "helper", file: "src/utils.ts" }),
	);
});

it("removes call edges from affected callers (files importing changed files)", async () => {
	vi.mocked(hashFileContent).mockReturnValue("hash_utils_v2");
	vi.mocked(extractCallGraph).mockResolvedValue({
		calls: [
			{ from: "src/utils.ts::helper", to: "src/lib.ts::lib", kind: "call" },
			{ from: "src/main.ts::main", to: "src/utils.ts::helper", kind: "call" },
		],
		functions: [
			{ qualifiedName: "helper", file: "src/utils.ts", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
		],
	});
	vi.mocked(extractImports).mockReturnValue([]);

	const existing = makeCacheForIncremental();
	existing.calls = [
		{ from: "src/main.ts::main", to: "src/utils.ts::oldHelper", kind: "call" },
		{ from: "src/utils.ts::oldHelper", to: "src/lib.ts::lib", kind: "call" },
	];
	existing.functions = [
		{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
		{ qualifiedName: "oldHelper", file: "src/utils.ts", exported: true, isDefaultExport: false, line: 1 },
	];

	const diff: FilesDiff = {
		changed: ["src/utils.ts"],
		removed: [],
		method: "git-diff",
	};

	const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

	// main.ts imports utils.ts, so it's an affected caller — its edges are re-extracted too
	// Old edge from main.ts -> utils.ts::oldHelper should be gone
	expect(result.calls).not.toContainEqual(
		expect.objectContaining({ to: "src/utils.ts::oldHelper" }),
	);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/lib/indexer.test.ts
```

Expected: FAIL — extractCallGraph not called in buildIndex.

- [ ] **Step 4: Wire extractCallGraph into indexer.ts**

Modify `src/lib/indexer.ts`. Add import at top:

```typescript
import { extractCallGraph } from "./call-graph.js";
```

**Critical: async boundary starts here.** `extractCallGraph` is async (WASM init),
so `buildIndex`, `buildIncrementalIndex`, `indexRepo`, `rehydrateRepo`, and
`suggestRepo` must all become async in this task. Update their signatures to
`async function ... (): Promise<...>` and add `await` at all call sites:

- `src/lib/indexer.ts`: `buildIndex` → async, `indexRepo` → async, `buildIncrementalIndex` → async
- `src/lib/rehydrate.ts`: `rehydrateRepo` → async (already returns via try/catch, just add async + await)
- `src/lib/suggest.ts`: `suggestRepo` → async
- `src/cli.ts`: already has async main — add `await` to `indexRepo`/`rehydrateRepo`/`suggestRepo` calls
- `src/mcp/server.ts`: handlers already async — add `await` to lib calls
- **All test files** that call these functions must `await` them

In `buildIndex()`, after `const imports = extractImports(...)`, add:

```typescript
const { calls, functions: functionNodes } = await extractCallGraph(
	identity.worktreePath,
	filePaths,
);
```

Update the return to include `calls` and `functions: functionNodes`.

In `buildIncrementalIndex()`, add the incremental call graph logic after the imports section. The full incremental path:

```typescript
// --- calls[] + functions[] ---
const existingCalls = existingCache.calls ?? [];
const existingFunctions = existingCache.functions ?? [];

// Identify affected callers: unchanged files that import changed files
const affectedCallers = new Set<string>();
for (const edge of existingCache.imports) {
	if (touchedSet.has(edge.from)) continue; // already in changed set
	for (const changed of touchedSet) {
		const changedStripped = stripKnownExt(changed);
		if (edge.to === changedStripped || edge.to === changedStripped.replace(/\/index$/, "")) {
			affectedCallers.add(edge.from);
		}
	}
}

// Remove call edges from changed files and affected callers
const callCleanSet = new Set([...touchedSet, ...affectedCallers]);
const keptCalls = existingCalls.filter((e) => {
	const fromFile = e.from.slice(0, e.from.indexOf("::"));
	return !callCleanSet.has(fromFile);
});
const keptFunctions = existingFunctions.filter(
	(f) => !changedSet.has(f.file) && !removedSet.has(f.file),
);

// Reparse changed files + affected callers
const filesToReparse = [
	...changedTsFiles,
	...[...affectedCallers].filter((p) => /\.(ts|tsx|js|jsx)$/.test(p)),
];
const { calls: newCalls, functions: newFunctions } = await extractCallGraph(
	identity.worktreePath,
	filesToReparse,
);

const calls = [...keptCalls, ...newCalls];
const functionNodes = [...keptFunctions, ...newFunctions];
```

Add `calls` and `functions: functionNodes` to the return object.

Also add the `stripKnownExt` helper at the top of the file (or import from a shared location):

```typescript
function stripKnownExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx)$/u, "");
}
```

For the empty-diff early return, preserve existing call graph data:

```typescript
return {
	...existingCache,
	fingerprint,
	indexedAt,
	dirtyAtIndex,
	calls: existingCache.calls ?? [],
	functions: existingCache.functions ?? [],
};
```

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run tests/unit/lib/indexer.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/indexer.ts tests/unit/lib/indexer.test.ts
git commit -m "feat: wire call graph extraction into full and incremental index"
```

---

## Task 8: Suggest ranker call graph enrichment

**Files:**
- Modify: `src/lib/suggest-ranker.ts:1-134`
- Modify: `tests/unit/lib/suggest-ranker.test.ts`

- [ ] **Step 1: Write failing tests for call graph scoring**

Add to `tests/unit/lib/suggest-ranker.test.ts`:

```typescript
describe("call graph enrichment", () => {
	it("boosts file call-connected to anchor", () => {
		const cache = makeCache({
			files: [
				{ path: "src/server.ts", kind: "file" },
				{ path: "src/ranker.ts", kind: "file" },
			],
			calls: [
				{ from: "src/server.ts::handle", to: "src/ranker.ts::rank", kind: "call" },
			],
			functions: [
				{ qualifiedName: "handle", file: "src/server.ts", exported: true, isDefaultExport: false, line: 1 },
				{ qualifiedName: "rank", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 1 },
			],
		});
		const result = rankSuggestions("ranking", cache, { from: "src/server.ts" });
		const ranker = result.find((r) => r.path === "src/ranker.ts");
		expect(ranker).toBeDefined();
		expect(ranker!.score).toBeGreaterThan(0);
	});

	it("boosts file call-connected to top-scoring file", () => {
		const cache = makeCache({
			files: [
				{ path: "src/ranker.ts", kind: "file" },
				{ path: "src/scorer.ts", kind: "file" },
			],
			calls: [
				{ from: "src/ranker.ts::rank", to: "src/scorer.ts::score", kind: "call" },
			],
			functions: [
				{ qualifiedName: "rank", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 1 },
				{ qualifiedName: "score", file: "src/scorer.ts", exported: true, isDefaultExport: false, line: 1 },
			],
		});
		// "ranker" matches src/ranker.ts by path token — scorer.ts is call-connected
		const result = rankSuggestions("ranker", cache);
		const scorer = result.find((r) => r.path === "src/scorer.ts");
		expect(scorer).toBeDefined();
		expect(scorer!.score).toBeGreaterThan(0);
	});

	it("adds fan-in bonus for files with heavily-called functions", () => {
		const calls = Array.from({ length: 6 }, (_, i) => ({
			from: `src/caller${i}.ts::fn${i}`,
			to: "src/hub.ts::process",
			kind: "call" as const,
		}));
		const cache = makeCache({
			files: [
				{ path: "src/hub.ts", kind: "file" },
				{ path: "src/other.ts", kind: "file" },
			],
			calls,
			functions: [
				{ qualifiedName: "process", file: "src/hub.ts", exported: true, isDefaultExport: false, line: 1 },
			],
		});
		const resultHub = rankSuggestions("hub", cache);
		const hub = resultHub.find((r) => r.path === "src/hub.ts");
		// hub has 6 callers for "process" (>5 threshold) — gets fan-in bonus
		expect(hub).toBeDefined();
	});

	it("works correctly when calls array is empty (no regression)", () => {
		const cache = makeCache({ calls: [], functions: [] });
		const result = rankSuggestions("persistence store", cache);
		expect(result[0]?.path).toBe("src/persistence/store.ts");
	});

	it("works correctly when calls field is undefined (v2 cache)", () => {
		const cache = makeCache();
		// Simulate v2 cache without calls/functions
		delete (cache as Record<string, unknown>).calls;
		delete (cache as Record<string, unknown>).functions;
		const result = rankSuggestions("persistence store", cache);
		expect(result[0]?.path).toBe("src/persistence/store.ts");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/lib/suggest-ranker.test.ts
```

Expected: FAIL — call graph signals not applied yet.

- [ ] **Step 3: Add call graph scoring to suggest-ranker.ts**

In `src/lib/suggest-ranker.ts`, add call graph helper functions and modify `rankSuggestions`:

Add these helper functions before `rankSuggestions`:

```typescript
function fileFromCallKey(key: string): string {
	const idx = key.indexOf("::");
	return idx === -1 ? key : key.slice(0, idx);
}

function buildCallConnectedFiles(
	calls: { from: string; to: string }[],
): Map<string, Set<string>> {
	// file -> set of files it has call edges to/from
	const connected = new Map<string, Set<string>>();
	for (const edge of calls) {
		if (edge.to.startsWith("::")) continue;
		const fromFile = fileFromCallKey(edge.from);
		const toFile = fileFromCallKey(edge.to);
		if (fromFile === toFile) continue;
		let fromSet = connected.get(fromFile);
		if (!fromSet) { fromSet = new Set(); connected.set(fromFile, fromSet); }
		fromSet.add(toFile);
		let toSet = connected.get(toFile);
		if (!toSet) { toSet = new Set(); connected.set(toFile, toSet); }
		toSet.add(fromFile);
	}
	return connected;
}

function buildFanInCounts(
	calls: { from: string; to: string }[],
): Map<string, number> {
	// file -> max direct caller count for any function in that file
	const callersByTarget = new Map<string, Set<string>>();
	for (const edge of calls) {
		if (edge.to.startsWith("::")) continue;
		let callers = callersByTarget.get(edge.to);
		if (!callers) { callers = new Set(); callersByTarget.set(edge.to, callers); }
		callers.add(edge.from);
	}
	const fanInByFile = new Map<string, number>();
	for (const [target, callers] of callersByTarget) {
		const file = fileFromCallKey(target);
		const current = fanInByFile.get(file) ?? 0;
		fanInByFile.set(file, Math.max(current, callers.size));
	}
	return fanInByFile;
}
```

In `rankSuggestions`, after building existing data, add:

```typescript
const calls = cache.calls ?? [];
const callConnected = calls.length > 0 ? buildCallConnectedFiles(calls) : new Map();
const fanInCounts = calls.length > 0 ? buildFanInCounts(calls) : new Map();
```

In the file scoring loop, after the existing import-based scoring, add:

```typescript
// Call graph: connected to anchor
if (normalizedFrom && normalizedPath !== normalizedFrom) {
	const anchorConnections = callConnected.get(normalizedFrom);
	if (anchorConnections?.has(normalizedPath)) {
		score += 3;
	}
}

// Call graph: fan-in bonus
const maxFanIn = fanInCounts.get(normalizedPath) ?? 0;
if (maxFanIn > 5) {
	score += 1;
}
```

After the initial scoring loop, add a second pass for top-result connection bonus:

```typescript
// Second pass: boost files call-connected to the current top-scoring file
if (calls.length > 0 && candidates.length > 0) {
	const sorted = [...candidates].sort((a, b) => b.score - a.score);
	const topPath = normalizePath(sorted[0].path);
	const topConnections = callConnected.get(topPath);
	if (topConnections) {
		for (const candidate of candidates) {
			const candPath = normalizePath(candidate.path);
			if (candPath !== topPath && topConnections.has(candPath)) {
				candidate.score += 2;
			}
		}
	}
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/unit/lib/suggest-ranker.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/suggest-ranker.ts tests/unit/lib/suggest-ranker.test.ts
git commit -m "feat: add call graph scoring signals to suggest ranker"
```

---

## Task 9: Public exports and MCP blast_radius tool

**Files:**
- Modify: `src/lib/index.ts`
- Modify: `src/mcp/server.ts:1-92`
- Modify: `tests/integration/mcp-server.test.ts`

- [ ] **Step 1: Update public exports**

In `src/lib/index.ts`, add exports:

```typescript
export { queryBlastRadius } from "./blast-radius.js";
export type { BlastRadiusResult, BlastTier } from "./blast-radius.js";
export { extractCallGraph } from "./call-graph.js";
export type { LangAdapter, FileExtractionResult, RawCallSite, ImportBinding } from "./lang-adapter.js";
export type {
	RepoCache,
	RepoIdentity,
	PackageMeta,
	FileNode,
	ImportEdge,
	DocInput,
	CallEdge,
	FunctionNode,
	BlastHit,
} from "./models.js";
```

- [ ] **Step 2: Write failing test for blast_radius MCP tool**

Update `tests/integration/mcp-server.test.ts` — add `blast_radius` to expected tools:

```typescript
expect(names).toContain("blast_radius");
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm run build && pnpm vitest run tests/integration/mcp-server.test.ts
```

Expected: FAIL — `blast_radius` not in tool list.

- [ ] **Step 4: Add blast_radius tool to MCP server**

In `src/mcp/server.ts`, add imports:

```typescript
import {
	indexRepo,
	rehydrateRepo,
	suggestRepo,
	queryBlastRadius,
} from "../lib/index.js";
```

After the `index_project` tool definition, add:

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
	async ({ qualifiedName, file, path, maxHops, stale }) => {
		const repoPath = path ?? process.cwd();
		const { cache } = rehydrateRepo(repoPath, { stale });
		const result = queryBlastRadius(
			{ qualifiedName, file },
			cache.calls ?? [],
			cache.functions ?? [],
			maxHops ? { maxHops } : undefined,
		);
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
		};
	},
);
```

- [ ] **Step 5: Build and run tests**

```bash
pnpm run build && pnpm vitest run tests/integration/mcp-server.test.ts
```

Expected: test passes — `blast_radius` now in tool list.

- [ ] **Step 6: Run full test suite + typecheck**

```bash
pnpm test && pnpm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/index.ts src/mcp/server.ts tests/integration/mcp-server.test.ts
git commit -m "feat: add blast_radius MCP tool and update public exports"
```

---

## Task 10: Call graph integration test

**Files:**
- Create: `tests/integration/call-graph.test.ts`

> **Note:** Adapter registration (`ensureAdapters`) and the async pipeline cascade
> were already implemented in Tasks 5 and 7. This task only adds the end-to-end
> integration test that exercises real tree-sitter parsing against a temp git repo.

- [ ] **Step 1: Write integration test**

Create `tests/integration/call-graph.test.ts`:

```typescript
// tests/integration/call-graph.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { indexRepo } from "../../src/lib/indexer.js";
import { queryBlastRadius } from "../../src/lib/blast-radius.js";

let tmpDir: string;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", tmpDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-callgraph-"));
	git("init");
	git("config", "user.email", "test@test.com");
	git("config", "user.name", "Test");

	// Create a mini project with cross-file calls
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ name: "test-proj", version: "1.0.0" }),
	);

	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });

	fs.writeFileSync(
		path.join(tmpDir, "src/utils.ts"),
		[
			'export function helper() { return 1; }',
			'export function unused() { return 2; }',
		].join("\n"),
	);

	fs.writeFileSync(
		path.join(tmpDir, "src/main.ts"),
		[
			'import { helper } from "./utils";',
			'export function main() { return helper(); }',
		].join("\n"),
	);

	fs.writeFileSync(
		path.join(tmpDir, "src/cli.ts"),
		[
			'import { main } from "./main";',
			'function run() { main(); }',
		].join("\n"),
	);

	git("add", ".");
	git("commit", "-m", "init");
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("call graph integration", () => {
	it("extracts call edges and functions from real files", async () => {
		const cache = await indexRepo(tmpDir);

		expect(cache.functions.length).toBeGreaterThan(0);
		expect(cache.calls.length).toBeGreaterThan(0);

		// main calls helper (cross-file, resolved via import binding)
		expect(cache.calls).toContainEqual(
			expect.objectContaining({
				from: expect.stringContaining("main"),
				to: expect.stringContaining("helper"),
				kind: "call",
			}),
		);
	});

	it("blast radius returns tiered callers", async () => {
		const cache = await indexRepo(tmpDir);

		const result = queryBlastRadius(
			{ qualifiedName: "helper", file: "src/utils.ts" },
			cache.calls,
			cache.functions,
		);

		expect(result.target.qualifiedName).toBe("helper");
		expect(result.totalAffected).toBeGreaterThanOrEqual(1);

		// main is a direct caller
		const directCallers = result.tiers.find((t) => t.hop === 1);
		expect(directCallers?.hits).toContainEqual(
			expect.objectContaining({ qualifiedName: "main" }),
		);
	});
});
```

- [ ] **Step 2: Build and run full test suite**

```bash
pnpm run build && pnpm test
```

Expected: all tests pass including new integration test.

- [ ] **Step 3: Run typecheck**

```bash
pnpm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/call-graph.test.ts
git commit -m "test: add call graph end-to-end integration test"
```

---

## Task 11: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass (original 167 + new tests).

- [ ] **Step 2: Run typecheck**

```bash
pnpm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Run lint**

```bash
pnpm run lint
```

Expected: zero errors (fix any if needed).

- [ ] **Step 4: Self-hosting test — index ai-cortex itself**

```bash
pnpm run cortex -- index .
```

Expected: completes in under 3 seconds. Cache now contains `calls` and `functions`.

- [ ] **Step 5: Self-hosting test — blast radius on a known function**

```bash
pnpm run cortex -- suggest "ranking algorithm" --from src/mcp/server.ts --json
```

Verify `suggest-ranker.ts` appears in results (call graph enrichment working).

- [ ] **Step 6: Verify MCP server lists blast_radius**

```bash
pnpm run build
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | node dist/src/cli.js mcp | head -1
```

Expected: response includes initialization. Then verify tool list includes `blast_radius`.

- [ ] **Step 7: Commit any remaining fixes**

If any fixes were needed:

```bash
git add -A && git commit -m "fix: address verification findings"
```
