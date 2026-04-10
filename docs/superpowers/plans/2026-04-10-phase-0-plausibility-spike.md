# Phase 0 Plausibility Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that `ai-cortex` can build enough cached project knowledge to make new agent sessions faster and more consistent than broad cold repo scanning.

**Architecture:** Build a minimal local-only spike, not the final product. The spike should index one repo into a simple cache, generate a compact `rehydrate` briefing, generate `suggest` results, and capture repeatable measurements against a cold-scan baseline. Keep the code intentionally small, file-oriented, and easy to delete or reshape after the proof.

**Tech Stack:** Node.js, TypeScript, local JSON cache files, CLI entrypoint, Vitest for focused tests

---

## Planned File Structure

### Root Setup

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

### Spike Source

- Create: `src/cli.ts`
- Create: `src/spike/run-phase-0.ts`
- Create: `src/spike/models.ts`
- Create: `src/spike/repo-id.ts`
- Create: `src/spike/file-tree.ts`
- Create: `src/spike/doc-inputs.ts`
- Create: `src/spike/ts-import-graph.ts`
- Create: `src/spike/cache-store.ts`
- Create: `src/spike/build-cache.ts`
- Create: `src/spike/rehydrate.ts`
- Create: `src/spike/suggest.ts`
- Create: `src/spike/cold-scan-baseline.ts`
- Create: `src/spike/measure.ts`

### Tests

- Create: `tests/unit/repo-id.test.ts`
- Create: `tests/unit/doc-inputs.test.ts`
- Create: `tests/unit/suggest.test.ts`
- Create: `tests/integration/rehydrate-spike.test.ts`

### Proof Output

- Create: `docs/shared/phase_0_results.md`

### Existing References

- Review existing: `docs/shared/phase_0_plausibility_checklist.md`

## Task 1: Create Minimal Spike Workspace

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Write the failing workspace smoke test**

Create `tests/integration/rehydrate-spike.test.ts` with this initial test:

```ts
import { describe, expect, it } from "vitest";

describe("phase 0 spike workspace", () => {
	it("loads the spike entrypoint", async () => {
		const mod = await import("../../src/spike/run-phase-0.js");
		expect(typeof mod.runPhase0).toBe("function");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: FAIL because `src/spike/run-phase-0.ts` does not exist yet.

- [ ] **Step 3: Add minimal project setup**

Create `package.json`:

```json
{
	"name": "ai-cortex",
	"version": "0.0.0-phase0",
	"private": true,
	"type": "module",
	"scripts": {
		"build": "tsc -p tsconfig.json",
		"test": "vitest run",
		"typecheck": "tsc --noEmit -p tsconfig.json",
		"phase0": "tsx src/cli.ts"
	},
	"devDependencies": {
		"@types/node": "^22.15.17",
		"tsx": "^4.20.3",
		"typescript": "^5.8.3",
		"vitest": "^3.2.4"
	}
}
```

Create `tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"noEmit": false,
		"outDir": "dist",
		"rootDir": ".",
		"types": ["node"]
	},
	"include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
.cache/
```

- [ ] **Step 4: Add minimal spike entrypoint**

Create `src/spike/run-phase-0.ts`:

```ts
export async function runPhase0(): Promise<void> {
	// Phase 0 orchestration will be added in later tasks.
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore src/spike/run-phase-0.ts tests/integration/rehydrate-spike.test.ts
git commit -m "chore: scaffold phase 0 spike workspace"
```

## Task 2: Define Phase 0 Data Model And Repo Identity

**Files:**

- Create: `src/spike/models.ts`
- Create: `src/spike/repo-id.ts`
- Test: `tests/unit/repo-id.test.ts`

- [ ] **Step 1: Write the failing repo identity test**

Create `tests/unit/repo-id.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getRepoKey } from "../../src/spike/repo-id.js";

describe("getRepoKey", () => {
	it("returns a stable key for the same repo path", () => {
		const a = getRepoKey("/tmp/example-repo");
		const b = getRepoKey("/tmp/example-repo");
		expect(a).toBe(b);
	});

	it("changes when the repo path changes", () => {
		const a = getRepoKey("/tmp/example-repo-a");
		const b = getRepoKey("/tmp/example-repo-b");
		expect(a).not.toBe(b);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/unit/repo-id.test.ts`

Expected: FAIL because `repo-id.ts` does not exist yet.

- [ ] **Step 3: Define core Phase 0 models**

Create `src/spike/models.ts`:

```ts
export type DocInput = {
	path: string;
	title: string;
	body: string;
};

export type FileNode = {
	path: string;
	kind: "file" | "dir";
};

export type ImportEdge = {
	from: string;
	to: string;
};

export type RepoCache = {
	repoPath: string;
	repoKey: string;
	indexedAt: string;
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
};

export type RehydrateResult = {
	summary: string;
	priorityDocs: string[];
	priorityFiles: string[];
};

export type SuggestResult = {
	path: string;
	reason: string;
};
```

- [ ] **Step 4: Implement stable repo key generation**

Create `src/spike/repo-id.ts`:

```ts
import { createHash } from "node:crypto";
import path from "node:path";

export function getRepoKey(repoPath: string): string {
	const normalized = path.resolve(repoPath);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run tests/unit/repo-id.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/spike/models.ts src/spike/repo-id.ts tests/unit/repo-id.test.ts
git commit -m "feat: add phase 0 repo identity model"
```

## Task 3: Ingest Docs And File Tree Inputs

**Files:**

- Create: `src/spike/file-tree.ts`
- Create: `src/spike/doc-inputs.ts`
- Test: `tests/unit/doc-inputs.test.ts`

- [ ] **Step 1: Write the failing doc input test**

Create `tests/unit/doc-inputs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rankDocCandidates } from "../../src/spike/doc-inputs.js";

describe("rankDocCandidates", () => {
	it("prefers README and shared planning docs", () => {
		const ranked = rankDocCandidates([
			"src/app.ts",
			"README.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/high_level_plan.md",
		]);

		expect(ranked.slice(0, 3)).toEqual([
			"README.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/high_level_plan.md",
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/unit/doc-inputs.test.ts`

Expected: FAIL because `doc-inputs.ts` does not exist yet.

- [ ] **Step 3: Implement file tree collection**

Create `src/spike/file-tree.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { FileNode } from "./models.js";

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "out", "build"]);

export function collectFileTree(repoPath: string): FileNode[] {
	const out: FileNode[] = [];

	function walk(current: string): void {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
			const abs = path.join(current, entry.name);
			const rel = path.relative(repoPath, abs);
			out.push({ path: rel, kind: entry.isDirectory() ? "dir" : "file" });
			if (entry.isDirectory()) walk(abs);
		}
	}

	walk(repoPath);
	return out;
}
```

- [ ] **Step 4: Implement doc candidate ranking and loading**

Create `src/spike/doc-inputs.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { DocInput } from "./models.js";

export function rankDocCandidates(paths: string[]): string[] {
	const score = (filePath: string): number => {
		if (filePath === "README.md") return 100;
		if (filePath.startsWith("docs/shared/architecture")) return 90;
		if (filePath.startsWith("docs/shared/high_level_plan")) return 80;
		if (filePath.startsWith("docs/shared/")) return 70;
		if (filePath.endsWith(".md")) return 10;
		return 0;
	};

	return [...paths]
		.filter((filePath) => filePath.endsWith(".md"))
		.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

export function loadDocs(
	repoPath: string,
	paths: string[],
	limit = 8,
): DocInput[] {
	const ranked = rankDocCandidates(paths).slice(0, limit);
	return ranked.map((filePath) => {
		const body = fs.readFileSync(path.join(repoPath, filePath), "utf8");
		const title =
			body
				.split("\n")
				.find((line) => line.startsWith("# "))
				?.slice(2) || filePath;
		return { path: filePath, title, body };
	});
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run tests/unit/doc-inputs.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/spike/file-tree.ts src/spike/doc-inputs.ts tests/unit/doc-inputs.test.ts
git commit -m "feat: add phase 0 file tree and doc inputs"
```

## Task 4: Extract Minimal TypeScript Import Graph

**Files:**

- Create: `src/spike/ts-import-graph.ts`
- Test: `tests/integration/rehydrate-spike.test.ts`

- [ ] **Step 1: Extend the failing integration test**

Update `tests/integration/rehydrate-spike.test.ts` to include:

```ts
import { describe, expect, it } from "vitest";
import { extractImportEdgesFromSource } from "../../src/spike/ts-import-graph.js";

describe("phase 0 spike workspace", () => {
	it("loads the spike entrypoint", async () => {
		const mod = await import("../../src/spike/run-phase-0.js");
		expect(typeof mod.runPhase0).toBe("function");
	});

	it("extracts relative import edges from TypeScript source", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b';\nimport c from '../shared/c';\nimport x from 'react';",
		);

		expect(edges).toEqual([
			{ from: "src/a.ts", to: "src/b" },
			{ from: "src/a.ts", to: "shared/c" },
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: FAIL because `ts-import-graph.ts` does not exist yet.

- [ ] **Step 3: Implement minimal relative import extraction**

Create `src/spike/ts-import-graph.ts`:

```ts
import path from "node:path";
import type { ImportEdge } from "./models.js";

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

export function extractImportEdgesFromSource(
	filePath: string,
	source: string,
): ImportEdge[] {
	const edges: ImportEdge[] = [];
	for (const match of source.matchAll(IMPORT_RE)) {
		const specifier = match[1];
		if (!specifier.startsWith(".")) continue;
		const resolved = path
			.normalize(path.join(path.dirname(filePath), specifier))
			.replace(/\\/g, "/")
			.replace(/\.(ts|tsx|js|jsx)$/u, "");
		edges.push({ from: filePath, to: resolved });
	}
	return edges;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/spike/ts-import-graph.ts tests/integration/rehydrate-spike.test.ts
git commit -m "feat: add minimal ts import extraction for phase 0"
```

## Task 5: Build And Persist Minimal Repo Cache

**Files:**

- Create: `src/spike/cache-store.ts`
- Create: `src/spike/build-cache.ts`
- Test: `tests/integration/rehydrate-spike.test.ts`

- [ ] **Step 1: Extend the failing integration test**

Append this test to `tests/integration/rehydrate-spike.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCache } from "../../src/spike/build-cache.js";

it("builds a repo cache with files and docs", () => {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-phase0-"));
	fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example Repo\n");
	fs.mkdirSync(path.join(repoRoot, "src"));
	fs.writeFileSync(
		path.join(repoRoot, "src", "main.ts"),
		"export const x = 1;\n",
	);

	// This spike currently writes cache files into the real user cache dir.
	// That is acceptable for Phase 0, but test runs will leave cache artifacts behind.
	const cache = buildCache(repoRoot);
	expect(cache.repoPath).toBe(repoRoot);
	expect(cache.files.some((node) => node.path === "README.md")).toBe(true);
	expect(cache.docs[0]?.path).toBe("README.md");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: FAIL because `build-cache.ts` does not exist yet.

- [ ] **Step 3: Implement local cache persistence**

Create `src/spike/cache-store.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoCache } from "./models.js";

export function getCacheDir(): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "phase0");
}

export function writeCache(cache: RepoCache): string {
	const dir = getCacheDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${cache.repoKey}.json`);
	fs.writeFileSync(filePath, JSON.stringify(cache, null, 2) + "\n");
	return filePath;
}

export function readCache(cacheFile: string): RepoCache {
	return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as RepoCache;
}
```

- [ ] **Step 4: Implement cache building**

Create `src/spike/build-cache.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { writeCache } from "./cache-store.js";
import { loadDocs } from "./doc-inputs.js";
import { collectFileTree } from "./file-tree.js";
import type { RepoCache } from "./models.js";
import { getRepoKey } from "./repo-id.js";
import { extractImportEdgesFromSource } from "./ts-import-graph.js";

export function buildCache(repoPath: string): RepoCache {
	const files = collectFileTree(repoPath);
	const filePaths = files
		.filter((node) => node.kind === "file")
		.map((node) => node.path);
	const docs = loadDocs(repoPath, filePaths);
	const imports = filePaths
		.filter((filePath) => /\.(ts|tsx|js|jsx)$/u.test(filePath))
		.flatMap((filePath) => {
			const source = fs.readFileSync(path.join(repoPath, filePath), "utf8");
			return extractImportEdgesFromSource(filePath, source);
		});

	const cache: RepoCache = {
		repoPath,
		repoKey: getRepoKey(repoPath),
		indexedAt: new Date().toISOString(),
		files,
		docs,
		imports,
	};

	writeCache(cache);
	return cache;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/spike/cache-store.ts src/spike/build-cache.ts tests/integration/rehydrate-spike.test.ts
git commit -m "feat: add phase 0 repo cache builder"
```

## Task 6: Generate Rehydration Output

**Files:**

- Create: `src/spike/rehydrate.ts`
- Modify: `src/spike/run-phase-0.ts`
- Test: `tests/integration/rehydrate-spike.test.ts`

- [ ] **Step 1: Extend the failing integration test**

Append this test to `tests/integration/rehydrate-spike.test.ts`:

```ts
import { rehydrateFromCache } from "../../src/spike/rehydrate.js";

it("produces a compact rehydration summary", async () => {
	const cache = {
		repoPath: "/tmp/example",
		repoKey: "abc123",
		indexedAt: "2026-04-10T00:00:00.000Z",
		files: [
			{ path: "README.md", kind: "file" as const },
			{ path: "src/app.ts", kind: "file" as const },
			{ path: "src/session/store.ts", kind: "file" as const },
		],
		docs: [
			{
				path: "README.md",
				title: "Example Repo",
				body: "# Example Repo\nSession-first workflow\n",
			},
		],
		imports: [{ from: "src/app.ts", to: "src/session/store" }],
	};

	const result = rehydrateFromCache(cache);
	expect(result.summary).toContain("Example Repo");
	expect(result.priorityFiles).toContain("src/app.ts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: FAIL because `rehydrate.ts` does not exist yet.

- [ ] **Step 3: Implement compact rehydration generation**

Create `src/spike/rehydrate.ts`:

```ts
import type { RehydrateResult, RepoCache } from "./models.js";

export function rehydrateFromCache(cache: RepoCache): RehydrateResult {
	const priorityDocs = cache.docs.slice(0, 3).map((doc) => doc.path);
	const priorityFiles = cache.imports
		.slice(0, 8)
		.flatMap((edge) => [edge.from, edge.to])
		.filter((value, index, arr) => arr.indexOf(value) === index)
		.slice(0, 6);
	const summaryLines = [
		`Project: ${cache.docs[0]?.title || cache.repoPath}`,
		`Indexed: ${cache.indexedAt}`,
		`Top docs: ${priorityDocs.join(", ") || "none"}`,
		`Likely entry files: ${priorityFiles.join(", ") || "none"}`,
	];

	return {
		summary: summaryLines.join("\n"),
		priorityDocs,
		priorityFiles,
	};
}
```

- [ ] **Step 4: Update Phase 0 runner to call rehydration**

Update `src/spike/run-phase-0.ts`:

```ts
import { buildCache } from "./build-cache.js";
import { rehydrateFromCache } from "./rehydrate.js";

export async function runPhase0(repoPath = process.cwd()): Promise<void> {
	const cache = buildCache(repoPath);
	const result = rehydrateFromCache(cache);
	process.stdout.write(result.summary + "\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/spike/rehydrate.ts src/spike/run-phase-0.ts tests/integration/rehydrate-spike.test.ts
git commit -m "feat: add phase 0 rehydration output"
```

## Task 7: Generate Suggest Output

**Files:**

- Create: `src/spike/suggest.ts`
- Test: `tests/unit/suggest.test.ts`

- [ ] **Step 1: Write the failing suggest test**

Create `tests/unit/suggest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { suggestFiles } from "../../src/spike/suggest.js";

describe("suggestFiles", () => {
	it("prefers files that match task words and doc titles", () => {
		const results = suggestFiles(
			"inspect persistence logic",
			{
				repoPath: "/tmp/example",
				repoKey: "abc",
				indexedAt: "2026-04-10T00:00:00.000Z",
				files: [
					{ path: "src/persistence/store.ts", kind: "file" },
					{ path: "src/viewer/FileViewer.tsx", kind: "file" },
					{ path: "docs/shared/architecture_decisions.md", kind: "file" },
				],
				docs: [
					{
						path: "docs/shared/architecture_decisions.md",
						title: "Architecture Decisions",
						body: "Persistence boundary and restore behavior.",
					},
				],
				imports: [],
			},
			3,
		);

		expect(results[0]?.path).toBe("src/persistence/store.ts");
		expect(results[0]?.reason).toContain("persistence");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/unit/suggest.test.ts`

Expected: FAIL because `suggest.ts` does not exist yet.

- [ ] **Step 3: Implement lightweight suggestion ranking**

Create `src/spike/suggest.ts`:

```ts
import type { RepoCache, SuggestResult } from "./models.js";

function tokenize(input: string): string[] {
	return input
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

export function suggestFiles(
	task: string,
	cache: RepoCache,
	limit = 5,
): SuggestResult[] {
	const terms = tokenize(task);
	const docText = cache.docs
		.map((doc) => `${doc.path} ${doc.title} ${doc.body}`.toLowerCase())
		.join("\n");

	return cache.files
		.filter((node) => node.kind === "file")
		.map((node) => {
			const pathLower = node.path.toLowerCase();
			let score = 0;
			for (const term of terms) {
				if (pathLower.includes(term)) score += 3;
				if (docText.includes(term) && pathLower.includes(term)) score += 2;
			}
			return {
				path: node.path,
				score,
				reason: terms
					.filter((term) => pathLower.includes(term))
					.slice(0, 2)
					.join(", "),
			};
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit)
		.map((item) => ({
			path: item.path,
			reason: item.reason
				? `matched task terms: ${item.reason}`
				: "matched repo context",
		}));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run tests/unit/suggest.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/spike/suggest.ts tests/unit/suggest.test.ts
git commit -m "feat: add phase 0 suggest output"
```

## Task 8: Add CLI Surface And Measurement Harness

**Files:**

- Create: `src/cli.ts`
- Create: `src/spike/cold-scan-baseline.ts`
- Create: `src/spike/measure.ts`
- Modify: `src/spike/run-phase-0.ts`
- Test: `tests/integration/rehydrate-spike.test.ts`

- [ ] **Step 1: Extend the failing integration test**

Append this test to `tests/integration/rehydrate-spike.test.ts`:

```ts
import { measure } from "../../src/spike/measure.js";

it("measures operation duration", async () => {
	const result = await measure("noop", async () => {
		return 42;
	});

	expect(result.label).toBe("noop");
	expect(result.durationMs).toBeGreaterThanOrEqual(0);
	expect(result.value).toBe(42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: FAIL because `measure.ts` does not exist yet.

- [ ] **Step 3: Implement measurement helpers and cold baseline**

Create `src/spike/measure.ts`:

```ts
export async function measure<T>(
	label: string,
	fn: () => Promise<T> | T,
): Promise<{ label: string; durationMs: number; value: T }> {
	const start = performance.now();
	const value = await fn();
	return {
		label,
		durationMs: performance.now() - start,
		value,
	};
}
```

Create `src/spike/cold-scan-baseline.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { collectFileTree } from "./file-tree.js";

export function coldScanBaseline(repoPath: string): {
	filesTouched: number;
	markdownFilesRead: number;
} {
	const files = collectFileTree(repoPath).filter(
		(node) => node.kind === "file",
	);
	let markdownFilesRead = 0;

	for (const file of files) {
		if (!file.path.endsWith(".md")) continue;
		fs.readFileSync(path.join(repoPath, file.path), "utf8");
		markdownFilesRead++;
	}

	return {
		filesTouched: files.length,
		markdownFilesRead,
	};
}
```

- [ ] **Step 4: Implement CLI entrypoint**

Create `src/cli.ts`:

```ts
import { coldScanBaseline } from "./spike/cold-scan-baseline.js";
import { measure } from "./spike/measure.js";
import { runPhase0 } from "./spike/run-phase-0.js";

const [, , command = "phase0", repoPath = process.cwd()] = process.argv;

if (command === "phase0") {
	await runPhase0(repoPath);
} else if (command === "baseline") {
	const result = await measure("cold-baseline", () =>
		coldScanBaseline(repoPath),
	);
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
	process.stderr.write(`Unknown command: ${command}\n`);
	process.exit(1);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run tests/integration/rehydrate-spike.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/spike/cold-scan-baseline.ts src/spike/measure.ts tests/integration/rehydrate-spike.test.ts
git commit -m "feat: add phase 0 cli and measurement helpers"
```

## Task 9: Run Proof Experiments Against One Real Repo

**Files:**

- Modify: `docs/shared/phase_0_results.md`

- [ ] **Step 1: Choose the proof repo and record it**

Create `docs/shared/phase_0_results.md` with this initial structure:

```md
# ai-cortex Phase 0 Results

## Proof Repo

- Repo path: `<fill after selecting repo>`
- Repo type: `<fill after selecting repo>`
- Approximate file count: `<fill after measuring>`

## Baseline

- Cold scan command:
- Cold scan duration:
- Files touched:
- Markdown files read:

## Cached Rehydration

- Rehydrate command:
- Rehydrate duration:
- Summary quality notes:

## Architecture Questions

- Question 1:
- Answer quality:

## Suggest Checks

- Task 1:
- Top suggestions:
- Quality notes:

## Decision

- Continue / revise / stop:
- Why:
```

- [ ] **Step 2: Run cold baseline on the chosen repo**

Run: `pnpm phase0 baseline /absolute/path/to/proof-repo`

Expected: JSON output containing `durationMs`, `filesTouched`, and `markdownFilesRead`

- [ ] **Step 3: Run cached rehydration on the same repo**

Run: `pnpm phase0 phase0 /absolute/path/to/proof-repo`

Expected: compact text summary with project title, top docs, and likely entry files

- [ ] **Step 4: Evaluate architecture-question quality**

Ask at least these questions against the cached output and record the result:

```text
1. What kind of project is this?
2. What are the major subsystems?
3. Which docs should a fresh agent read first?
4. Which files should a fresh agent likely inspect first?
```

Expected: most answers are good enough to orient a fresh session without broad repo scanning

- [ ] **Step 5: Evaluate suggest quality**

Run the spike against at least three task prompts and record the top suggestions:

```text
1. inspect persistence logic
2. trace worktree lifecycle behavior
3. review the main UI shell flow
```

Expected: top results are plausible first reads with short reasons

- [ ] **Step 6: Fill in `phase_0_results.md`**

Replace every placeholder in `docs/shared/phase_0_results.md` with real values, observations, and a go/no-go decision.

- [ ] **Step 7: Commit**

```bash
git add docs/shared/phase_0_results.md
git commit -m "docs: record phase 0 plausibility results"
```

## Task 10: Make The Go / No-Go Call

**Files:**

- Modify: `docs/shared/phase_0_results.md`
- Review existing: `docs/shared/phase_0_plausibility_checklist.md`

- [ ] **Step 1: Compare results to Phase 0 exit criteria**

Check the results against:

- cached rehydration is materially faster than broad cold scanning
- the briefing is useful enough to orient a fresh session
- cached knowledge can answer basic architecture questions
- file suggestions are useful often enough to change workflow
- the proof is credible on at least one real repo beyond a toy example

- [ ] **Step 2: Record explicit decision**

Add one of these final decisions to `docs/shared/phase_0_results.md`:

```md
## Final Decision

- Decision: continue
- Rationale: cached rehydration proved materially faster and useful enough to justify deeper architecture work
```

or

```md
## Final Decision

- Decision: revise
- Rationale: some proof signals were promising, but one or more hard gates failed and the spike needs reshaping
```

or

```md
## Final Decision

- Decision: stop
- Rationale: the product thesis did not hold strongly enough in Phase 0
```

- [ ] **Step 3: Commit**

```bash
git add docs/shared/phase_0_results.md
git commit -m "docs: record phase 0 go-no-go decision"
```

## Self-Review

- Spec coverage: This plan covers the Phase 0 proof path from spike scaffold, through cache building, through rehydration and suggestion experiments, through explicit go/no-go evaluation.
- Placeholder scan: The only placeholders are in `phase_0_results.md`, where they are intentional runtime inputs to be replaced during execution.
- Type consistency: The same Phase 0 vocabulary is used throughout: `RepoCache`, `rehydrate`, `suggest`, repo key, local cache, and proof results.
