# Phase 1 — Core Indexing Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, versioned, worktree-aware local indexing library that replaces the Phase 0 spike and establishes the stable `RepoCache` contract for Phase 2 and 3.

**Architecture:** Lift proven spike algorithms into a clean `src/lib/` module structure with one job per file. `indexer.ts` is the only orchestrator — all other modules are independently testable. Build alongside `src/spike/` (do not touch it), then delete spike at the end.

**Tech Stack:** Node.js, TypeScript (NodeNext modules), Vitest, `git` CLI (via `execFileSync`), local JSON cache files.

---

## Planned File Structure

### Create

- `src/lib/models.ts` — types, error classes, SCHEMA_VERSION
- `src/lib/repo-identity.ts` — resolve git common dir + worktree key
- `src/lib/indexable-files.ts` — git ls-files + fs fallback
- `src/lib/doc-inputs.ts` — doc ranking + loading
- `src/lib/import-graph.ts` — TS/JS import extraction
- `src/lib/entry-files.ts` — package.json + framework + convention entry file detection
- `src/lib/cache-store.ts` — versioned read/write + fingerprint
- `src/lib/indexer.ts` — pipeline orchestrator + `buildIndex`, `indexRepo`, `getCachedIndex`
- `src/lib/index.ts` — public re-exports only
- `tests/unit/lib/repo-identity.test.ts`
- `tests/unit/lib/indexable-files.test.ts`
- `tests/unit/lib/doc-inputs.test.ts`
- `tests/unit/lib/import-graph.test.ts`
- `tests/unit/lib/entry-files.test.ts`
- `tests/unit/lib/cache-store.test.ts`
- `tests/unit/lib/indexer.test.ts`
- `tests/integration/index.test.ts`

### Modify

- `src/cli.ts` — point at `src/lib/index.ts`, replace spike commands with `index`

### Delete (Task 11)

- `src/spike/` — entire directory

---

## Task 1: Data Models

**Files:**

- Create: `src/lib/models.ts`

- [ ] **Step 1: Create the models file**

```ts
// src/lib/models.ts

export const SCHEMA_VERSION = "1";

export class RepoIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RepoIdentityError";
	}
}

export class IndexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IndexError";
	}
}

export type RepoIdentity = {
	repoKey: string;
	worktreeKey: string;
	gitCommonDir: string;
	worktreePath: string;
};

export type PackageMeta = {
	name: string;
	version: string;
	main?: string;
	module?: string;
	framework: "electron" | "next" | "vite" | "node" | null;
};

export type FileNode = {
	path: string;
	kind: "file" | "dir";
};

export type ImportEdge = {
	from: string;
	to: string;
};

export type DocInput = {
	path: string;
	title: string;
	body: string;
};

export type RepoCache = {
	schemaVersion: typeof SCHEMA_VERSION;
	repoKey: string;
	worktreeKey: string;
	worktreePath: string;
	indexedAt: string;
	fingerprint: string;
	packageMeta: PackageMeta;
	entryFiles: string[];
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
};
```

- [ ] **Step 2: Verify TypeScript accepts the file**

Run: `pnpm typecheck`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/models.ts
git commit -m "feat: add phase 1 data models"
```

---

## Task 2: Repo Identity

**Files:**

- Create: `src/lib/repo-identity.ts`
- Create: `tests/unit/lib/repo-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/repo-identity.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
import { RepoIdentityError } from "../../../src/lib/models.js";
import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";

const mockExec = vi.mocked(execFileSync);

describe("resolveRepoIdentity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a 16-char repoKey and worktreeKey", () => {
		mockExec
			.mockReturnValueOnce("/home/user/project/.git\n" as any)
			.mockReturnValueOnce("/home/user/project\n" as any);

		const identity = resolveRepoIdentity("/home/user/project");

		expect(identity.repoKey).toHaveLength(16);
		expect(identity.worktreeKey).toHaveLength(16);
		expect(identity.gitCommonDir).toBe("/home/user/project/.git");
		expect(identity.worktreePath).toBe("/home/user/project");
	});

	it("two worktrees of the same repo share the same repoKey but differ in worktreeKey", () => {
		const sharedGit = "/home/user/project/.git";
		mockExec
			.mockReturnValueOnce(`${sharedGit}\n` as any)
			.mockReturnValueOnce("/home/user/project\n" as any);
		const a = resolveRepoIdentity("/home/user/project");

		mockExec
			.mockReturnValueOnce(`${sharedGit}\n` as any)
			.mockReturnValueOnce("/home/user/project-feature\n" as any);
		const b = resolveRepoIdentity("/home/user/project-feature");

		expect(a.repoKey).toBe(b.repoKey);
		expect(a.worktreeKey).not.toBe(b.worktreeKey);
	});

	it("throws RepoIdentityError when not a git repo", () => {
		mockExec.mockImplementation(() => {
			throw new Error("fatal: not a git repo");
		});
		expect(() => resolveRepoIdentity("/not/a/repo")).toThrow(RepoIdentityError);
	});

	it("throws RepoIdentityError when git is not installed", () => {
		const err = Object.assign(new Error("spawn git ENOENT"), {
			code: "ENOENT",
		});
		mockExec.mockImplementation(() => {
			throw err;
		});
		expect(() => resolveRepoIdentity("/any/path")).toThrow(RepoIdentityError);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/lib/repo-identity.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement repo-identity.ts**

```ts
// src/lib/repo-identity.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { RepoIdentityError } from "./models.js";
import type { RepoIdentity } from "./models.js";

function execGit(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trimEnd();
}

function sha16(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resolveRepoIdentity(inputPath: string): RepoIdentity {
	try {
		const resolved = path.resolve(inputPath);
		const gitCommonDir = path.resolve(
			execGit(resolved, ["rev-parse", "--git-common-dir"]),
		);
		const worktreePath = path.resolve(
			execGit(resolved, ["rev-parse", "--show-toplevel"]),
		);
		return {
			repoKey: sha16(gitCommonDir),
			worktreeKey: sha16(worktreePath),
			gitCommonDir,
			worktreePath,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new RepoIdentityError(
			`Cannot resolve git repo at ${inputPath}: ${msg}`,
		);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/unit/lib/repo-identity.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repo-identity.ts tests/unit/lib/repo-identity.test.ts
git commit -m "feat: add repo identity resolution with worktree-aware keys"
```

---

## Task 3: Indexable Files

**Files:**

- Create: `src/lib/indexable-files.ts`
- Create: `tests/unit/lib/indexable-files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/indexable-files.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
import { listIndexableFiles } from "../../../src/lib/indexable-files.js";

const mockExec = vi.mocked(execFileSync);

describe("listIndexableFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns sorted file paths from git ls-files", () => {
		mockExec.mockReturnValue("src/b.ts\nsrc/a.ts\nREADME.md\n" as any);
		expect(listIndexableFiles("/repo")).toEqual([
			"README.md",
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("calls git with the correct arguments", () => {
		mockExec.mockReturnValue("" as any);
		listIndexableFiles("/my/repo");
		expect(mockExec).toHaveBeenCalledWith(
			"git",
			[
				"-C",
				"/my/repo",
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
			],
			expect.objectContaining({ encoding: "utf8" }),
		);
	});

	it("filters empty lines from git output", () => {
		mockExec.mockReturnValue("\n\nREADME.md\n\n" as any);
		expect(listIndexableFiles("/repo")).toEqual(["README.md"]);
	});

	it("returns empty array when git returns no files", () => {
		mockExec.mockReturnValue("\n" as any);
		expect(listIndexableFiles("/repo")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/lib/indexable-files.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement indexable-files.ts**

```ts
// src/lib/indexable-files.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	"release",
]);

function walkFs(dir: string, root: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...walkFs(abs, root));
		} else {
			results.push(path.relative(root, abs));
		}
	}
	return results;
}

export function listIndexableFiles(repoPath: string): string[] {
	try {
		const output = execFileSync(
			"git",
			[
				"-C",
				repoPath,
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return output
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.sort();
	} catch {
		return walkFs(repoPath, repoPath).sort();
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/unit/lib/indexable-files.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/indexable-files.ts tests/unit/lib/indexable-files.test.ts
git commit -m "feat: add indexable-files with git ls-files and fs fallback"
```

---

## Task 4: Doc Inputs

**Files:**

- Create: `src/lib/doc-inputs.ts`
- Create: `tests/unit/lib/doc-inputs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/doc-inputs.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import fs from "node:fs";
import { loadDocs, rankDocCandidates } from "../../../src/lib/doc-inputs.js";

const mockFs = vi.mocked(fs);

describe("rankDocCandidates", () => {
	it("ranks README first, then shared architecture, then shared plan, then shared, then other md", () => {
		const ranked = rankDocCandidates([
			"src/app.ts",
			"other.md",
			"docs/shared/high_level_plan.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/notes.md",
			"README.md",
		]);
		expect(ranked).toEqual([
			"README.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/high_level_plan.md",
			"docs/shared/notes.md",
			"other.md",
		]);
	});

	it("excludes non-markdown files", () => {
		const ranked = rankDocCandidates(["src/app.ts", "README.md"]);
		expect(ranked).toEqual(["README.md"]);
	});
});

describe("loadDocs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("loads ranked docs up to the limit", () => {
		mockFs.readFileSync.mockReturnValue("# My Project\nsome content\n" as any);
		const docs = loadDocs(
			"/repo",
			["README.md", "docs/shared/architecture.md"],
			1,
		);
		expect(docs).toHaveLength(1);
		expect(docs[0]?.path).toBe("README.md");
		expect(docs[0]?.title).toBe("My Project");
	});

	it("extracts title from first h1 heading", () => {
		mockFs.readFileSync.mockReturnValue(
			"intro line\n# The Title\nbody\n" as any,
		);
		const docs = loadDocs("/repo", ["docs/shared/notes.md"]);
		expect(docs[0]?.title).toBe("The Title");
	});

	it("falls back to file path when no h1 heading", () => {
		mockFs.readFileSync.mockReturnValue("no heading here\n" as any);
		const docs = loadDocs("/repo", ["docs/shared/notes.md"]);
		expect(docs[0]?.title).toBe("docs/shared/notes.md");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/lib/doc-inputs.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement doc-inputs.ts**

```ts
// src/lib/doc-inputs.ts
import fs from "node:fs";
import path from "node:path";
import type { DocInput } from "./models.js";

function scoreDoc(filePath: string): number {
	if (filePath === "README.md") return 100;
	if (filePath.startsWith("docs/shared/architecture")) return 90;
	if (filePath.startsWith("docs/shared/high_level_plan")) return 80;
	if (filePath.startsWith("docs/shared/")) return 70;
	if (filePath.endsWith(".md")) return 10;
	return 0;
}

export function rankDocCandidates(filePaths: string[]): string[] {
	return filePaths
		.filter((p) => p.endsWith(".md"))
		.sort((a, b) => scoreDoc(b) - scoreDoc(a) || a.localeCompare(b));
}

export function loadDocs(
	repoPath: string,
	filePaths: string[],
	limit = 8,
): DocInput[] {
	return rankDocCandidates(filePaths)
		.slice(0, limit)
		.map((filePath) => {
			const body = fs.readFileSync(path.join(repoPath, filePath), "utf8");
			const title =
				body
					.split("\n")
					.find((line) => line.startsWith("# "))
					?.slice(2)
					.trim() ?? filePath;
			return { path: filePath, title, body };
		});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/unit/lib/doc-inputs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/doc-inputs.ts tests/unit/lib/doc-inputs.test.ts
git commit -m "feat: add doc ranking and loading"
```

---

## Task 5: Import Graph

**Files:**

- Create: `src/lib/import-graph.ts`
- Create: `tests/unit/lib/import-graph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/import-graph.test.ts
import { describe, expect, it } from "vitest";
import { extractImportEdgesFromSource } from "../../../src/lib/import-graph.js";

describe("extractImportEdgesFromSource", () => {
	it("extracts relative imports and resolves paths", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b';\nimport c from '../shared/c';",
		);
		expect(edges).toEqual([
			{ from: "src/a.ts", to: "src/b" },
			{ from: "src/a.ts", to: "shared/c" },
		]);
	});

	it("skips non-relative imports", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import React from 'react';\nimport { x } from 'vitest';",
		);
		expect(edges).toHaveLength(0);
	});

	it("strips file extensions from resolved paths", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b.ts';\nimport c from './c.js';",
		);
		expect(edges[0]?.to).toBe("src/b");
		expect(edges[1]?.to).toBe("src/c");
	});

	it("does not match 'ui' as substring inside 'builder' (token-boundary check)", () => {
		// 'electron-builder.yml' path contains 'ui' as substring — must not score
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { build } from './electron-builder';",
		);
		// resolved path is "src/electron-builder" — valid relative import, will be included
		// but the scoring test belongs in suggest (Phase 3), not here
		expect(edges[0]?.to).toBe("src/electron-builder");
	});

	it("uses forward slashes on all platforms", () => {
		const edges = extractImportEdgesFromSource(
			"src/deep/a.ts",
			"import x from '../other';",
		);
		expect(edges[0]?.to).toBe("src/other");
		expect(edges[0]?.to).not.toContain("\\");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/lib/import-graph.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement import-graph.ts**

```ts
// src/lib/import-graph.ts
import fs from "node:fs";
import path from "node:path";
import type { ImportEdge } from "./models.js";

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;
const TS_EXTS = /\.(ts|tsx|js|jsx)$/u;

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
			.replace(TS_EXTS, "");
		edges.push({ from: filePath, to: resolved });
	}
	return edges;
}

export function extractImports(
	worktreePath: string,
	filePaths: string[],
): ImportEdge[] {
	return filePaths
		.filter((filePath) => TS_EXTS.test(filePath))
		.flatMap((filePath) => {
			const source = fs.readFileSync(path.join(worktreePath, filePath), "utf8");
			return extractImportEdgesFromSource(filePath, source);
		});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/unit/lib/import-graph.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/import-graph.ts tests/unit/lib/import-graph.test.ts
git commit -m "feat: add TS/JS import graph extraction"
```

---

## Task 6: Entry Files & Package Meta

**Files:**

- Create: `src/lib/entry-files.ts`
- Create: `tests/unit/lib/entry-files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/entry-files.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import fs from "node:fs";
import {
	pickEntryFiles,
	readPackageMeta,
} from "../../../src/lib/entry-files.js";

const mockFs = vi.mocked(fs);

describe("readPackageMeta", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reads name, version, and detects electron framework", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "my-app",
				version: "1.2.3",
				devDependencies: { electron: "^30.0.0" },
			}) as any,
		);
		const meta = readPackageMeta("/repo");
		expect(meta).toEqual({
			name: "my-app",
			version: "1.2.3",
			framework: "electron",
		});
	});

	it("detects next framework", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "app",
				version: "1.0.0",
				dependencies: { next: "^14.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("next");
	});

	it("detects vite framework", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "app",
				version: "1.0.0",
				devDependencies: { vite: "^5.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("vite");
	});

	it("returns safe defaults when package.json is missing", () => {
		mockFs.existsSync.mockReturnValue(false);
		const meta = readPackageMeta("/repo/my-project");
		expect(meta.name).toBe("my-project");
		expect(meta.version).toBe("0.0.0");
		expect(meta.framework).toBeNull();
	});

	it("returns safe defaults when package.json is malformed", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("not json{{{" as any);
		const meta = readPackageMeta("/repo/my-project");
		expect(meta.name).toBe("my-project");
	});
});

describe("pickEntryFiles", () => {
	it("prefers package.json main field when it points to source", () => {
		const files = ["src/main.ts", "src/index.ts", "index.ts"];
		const meta = {
			name: "app",
			version: "1.0.0",
			main: "src/main.ts",
			framework: null as null,
		};
		expect(pickEntryFiles(files, meta)[0]).toBe("src/main.ts");
	});

	it("excludes package.json main when it points to dist/", () => {
		const files = ["dist/index.js", "src/index.ts"];
		const meta = {
			name: "app",
			version: "1.0.0",
			main: "dist/index.js",
			framework: null as null,
		};
		const entries = pickEntryFiles(files, meta);
		expect(entries).not.toContain("dist/index.js");
	});

	it("uses electron conventions when framework is electron", () => {
		const files = ["electron/main/index.ts", "src/renderer.tsx"];
		const meta = {
			name: "app",
			version: "1.0.0",
			framework: "electron" as const,
		};
		expect(pickEntryFiles(files, meta)).toContain("electron/main/index.ts");
	});

	it("falls back to common conventions when no other match", () => {
		const files = ["src/index.ts", "lib/helper.ts"];
		const meta = { name: "app", version: "1.0.0", framework: null as null };
		expect(pickEntryFiles(files, meta)).toContain("src/index.ts");
	});

	it("returns only paths present in the provided file list", () => {
		const files = ["lib/helper.ts"];
		const meta = { name: "app", version: "1.0.0", framework: null as null };
		expect(pickEntryFiles(files, meta)).toEqual([]);
	});

	it("caps results at 8", () => {
		const files = Array.from({ length: 20 }, (_, i) => `src/index${i}.ts`);
		const meta = {
			name: "app",
			version: "1.0.0",
			framework: null as null,
			main: "src/index0.ts",
		};
		expect(pickEntryFiles(files, meta).length).toBeLessThanOrEqual(8);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/lib/entry-files.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement entry-files.ts**

```ts
// src/lib/entry-files.ts
import fs from "node:fs";
import path from "node:path";
import type { PackageMeta } from "./models.js";

const FRAMEWORK_CONVENTIONS: Record<
	NonNullable<PackageMeta["framework"]>,
	string[]
> = {
	electron: ["electron/main/index.ts", "src/main.ts", "src/main.tsx"],
	next: [
		"src/app/layout.tsx",
		"src/app/page.tsx",
		"pages/_app.tsx",
		"pages/index.tsx",
	],
	vite: ["src/main.ts", "src/main.tsx", "src/index.ts"],
	node: ["src/index.ts", "src/main.ts", "index.ts"],
};

const COMMON_FALLBACKS = [
	"src/index.ts",
	"src/main.ts",
	"src/main.tsx",
	"index.ts",
	"src/index.tsx",
];

export function readPackageMeta(worktreePath: string): PackageMeta {
	const pkgPath = path.join(worktreePath, "package.json");
	const fallback: PackageMeta = {
		name: path.basename(worktreePath),
		version: "0.0.0",
		framework: null,
	};

	if (!fs.existsSync(pkgPath)) return fallback;

	try {
		const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<
			string,
			unknown
		>;
		const deps: Record<string, string> = {
			...((raw.dependencies as Record<string, string>) ?? {}),
			...((raw.devDependencies as Record<string, string>) ?? {}),
		};
		return {
			name: typeof raw.name === "string" ? raw.name : fallback.name,
			version: typeof raw.version === "string" ? raw.version : "0.0.0",
			main: typeof raw.main === "string" ? raw.main : undefined,
			module: typeof raw.module === "string" ? raw.module : undefined,
			framework: detectFramework(deps),
		};
	} catch {
		return fallback;
	}
}

function detectFramework(
	deps: Record<string, string>,
): PackageMeta["framework"] {
	if ("electron" in deps) return "electron";
	if ("next" in deps) return "next";
	if ("vite" in deps) return "vite";
	return null;
}

export function pickEntryFiles(
	filePaths: string[],
	packageMeta: PackageMeta,
): string[] {
	const fileSet = new Set(filePaths);
	const candidates: string[] = [];

	for (const field of [packageMeta.main, packageMeta.module]) {
		if (field && !field.startsWith("dist/") && fileSet.has(field)) {
			candidates.push(field);
		}
	}

	if (packageMeta.framework) {
		for (const p of FRAMEWORK_CONVENTIONS[packageMeta.framework]) {
			if (fileSet.has(p)) candidates.push(p);
		}
	}

	for (const p of COMMON_FALLBACKS) {
		if (fileSet.has(p)) candidates.push(p);
	}

	return [...new Set(candidates)].slice(0, 8);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/unit/lib/entry-files.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/entry-files.ts tests/unit/lib/entry-files.test.ts
git commit -m "feat: add entry file detection and package meta reading"
```

---

## Task 7: Cache Store

**Files:**

- Create: `src/lib/cache-store.ts`
- Create: `tests/unit/lib/cache-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/cache-store.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
import {
	buildRepoFingerprint,
	readCacheForWorktree,
	writeCache,
} from "../../../src/lib/cache-store.js";

const mockExec = vi.mocked(execFileSync);

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/repo",
		indexedAt: "2026-04-10T00:00:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test", version: "1.0.0", framework: null },
		entryFiles: [],
		files: [],
		docs: [],
		imports: [],
		...overrides,
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cache-test-"));
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeCache + readCacheForWorktree", () => {
	it("writes and reads back a cache", () => {
		const cache = makeCache();
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

		writeCache(cache);
		const result = readCacheForWorktree(cache.repoKey, cache.worktreeKey);

		expect(result).not.toBeNull();
		expect(result?.fingerprint).toBe("abc123");
		expect(result?.packageMeta.name).toBe("test");
	});

	it("returns null when no cache file exists", () => {
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		expect(readCacheForWorktree("unknown", "key")).toBeNull();
	});

	it("returns null and warns to stderr on schema version mismatch", () => {
		const cache = makeCache({ schemaVersion: "0" as any });
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		writeCache(cache);
		const result = readCacheForWorktree(cache.repoKey, cache.worktreeKey);

		expect(result).toBeNull();
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("cache schema updated"),
		);
	});
});

describe("buildRepoFingerprint", () => {
	it("returns trimmed HEAD commit hash from git", () => {
		mockExec.mockReturnValue("abc123def456\n" as any);
		expect(buildRepoFingerprint("/repo")).toBe("abc123def456");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/lib/cache-store.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement cache-store.ts**

```ts
// src/lib/cache-store.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION } from "./models.js";
import type { RepoCache } from "./models.js";

export function getCacheDir(repoKey: string): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "v1", repoKey);
}

export function getCacheFilePath(repoKey: string, worktreeKey: string): string {
	return path.join(getCacheDir(repoKey), `${worktreeKey}.json`);
}

export function buildRepoFingerprint(worktreePath: string): string {
	return execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trimEnd();
}

export function writeCache(cache: RepoCache): void {
	const dir = getCacheDir(cache.repoKey);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = getCacheFilePath(cache.repoKey, cache.worktreeKey);
	fs.writeFileSync(filePath, JSON.stringify(cache, null, 2) + "\n");
}

export function readCacheForWorktree(
	repoKey: string,
	worktreeKey: string,
): RepoCache | null {
	const filePath = getCacheFilePath(repoKey, worktreeKey);
	if (!fs.existsSync(filePath)) return null;

	const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RepoCache;
	if (raw.schemaVersion !== SCHEMA_VERSION) {
		fs.rmSync(filePath, { force: true });
		process.stderr.write(
			`ai-cortex: cache schema updated, reindexing ${worktreeKey}\n`,
		);
		return null;
	}
	return raw;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/unit/lib/cache-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cache-store.ts tests/unit/lib/cache-store.test.ts
git commit -m "feat: add versioned cache store with worktree-aware paths"
```

---

## Task 8: Indexer + Public API

**Files:**

- Create: `src/lib/indexer.ts`
- Create: `src/lib/index.ts`
- Create: `tests/unit/lib/indexer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/indexer.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/repo-identity.js");
vi.mock("../../../src/lib/indexable-files.js");
vi.mock("../../../src/lib/entry-files.js");
vi.mock("../../../src/lib/doc-inputs.js");
vi.mock("../../../src/lib/import-graph.js");
vi.mock("../../../src/lib/cache-store.js");

import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";
import { listIndexableFiles } from "../../../src/lib/indexable-files.js";
import {
	readPackageMeta,
	pickEntryFiles,
} from "../../../src/lib/entry-files.js";
import { loadDocs } from "../../../src/lib/doc-inputs.js";
import { extractImports } from "../../../src/lib/import-graph.js";
import {
	buildRepoFingerprint,
	readCacheForWorktree,
	writeCache,
} from "../../../src/lib/cache-store.js";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import {
	buildIndex,
	getCachedIndex,
	indexRepo,
} from "../../../src/lib/indexer.js";

const mockIdentity = {
	repoKey: "aabbccdd11223344",
	worktreeKey: "eeff00112233aabb",
	gitCommonDir: "/repo/.git",
	worktreePath: "/repo",
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveRepoIdentity).mockReturnValue(mockIdentity);
	vi.mocked(listIndexableFiles).mockReturnValue(["README.md", "src/main.ts"]);
	vi.mocked(readPackageMeta).mockReturnValue({
		name: "test-app",
		version: "1.0.0",
		framework: null,
	});
	vi.mocked(pickEntryFiles).mockReturnValue(["src/main.ts"]);
	vi.mocked(loadDocs).mockReturnValue([
		{ path: "README.md", title: "Test App", body: "# Test App\n" },
	]);
	vi.mocked(extractImports).mockReturnValue([]);
	vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
	vi.mocked(readCacheForWorktree).mockReturnValue(null);
	vi.mocked(writeCache).mockReturnValue(undefined);
});

describe("buildIndex", () => {
	it("assembles a RepoCache from all modules", () => {
		const cache = buildIndex(mockIdentity);

		expect(cache.schemaVersion).toBe(SCHEMA_VERSION);
		expect(cache.repoKey).toBe(mockIdentity.repoKey);
		expect(cache.worktreeKey).toBe(mockIdentity.worktreeKey);
		expect(cache.worktreePath).toBe("/repo");
		expect(cache.fingerprint).toBe("abc123");
		expect(cache.packageMeta.name).toBe("test-app");
		expect(cache.entryFiles).toEqual(["src/main.ts"]);
		expect(cache.docs[0]?.title).toBe("Test App");
	});

	it("includes indexedAt as an ISO timestamp", () => {
		const cache = buildIndex(mockIdentity);
		expect(() => new Date(cache.indexedAt)).not.toThrow();
		expect(cache.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("indexRepo", () => {
	it("calls writeCache with the assembled cache", () => {
		indexRepo("/repo");
		expect(vi.mocked(writeCache)).toHaveBeenCalledOnce();
		const written = vi.mocked(writeCache).mock.calls[0]?.[0] as RepoCache;
		expect(written.packageMeta.name).toBe("test-app");
	});
});

describe("getCachedIndex", () => {
	it("returns null when no cache exists", () => {
		vi.mocked(readCacheForWorktree).mockReturnValue(null);
		expect(getCachedIndex("/repo")).toBeNull();
	});

	it("returns null when fingerprint is stale", () => {
		const stale: RepoCache = {
			schemaVersion: SCHEMA_VERSION,
			repoKey: mockIdentity.repoKey,
			worktreeKey: mockIdentity.worktreeKey,
			worktreePath: "/repo",
			indexedAt: "2026-01-01T00:00:00.000Z",
			fingerprint: "oldfingerprint",
			packageMeta: { name: "test-app", version: "1.0.0", framework: null },
			entryFiles: [],
			files: [],
			docs: [],
			imports: [],
		};
		vi.mocked(readCacheForWorktree).mockReturnValue(stale);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");
		expect(getCachedIndex("/repo")).toBeNull();
	});

	it("returns cached data when fingerprint matches", () => {
		const fresh: RepoCache = {
			schemaVersion: SCHEMA_VERSION,
			repoKey: mockIdentity.repoKey,
			worktreeKey: mockIdentity.worktreeKey,
			worktreePath: "/repo",
			indexedAt: "2026-01-01T00:00:00.000Z",
			fingerprint: "abc123",
			packageMeta: { name: "test-app", version: "1.0.0", framework: null },
			entryFiles: [],
			files: [],
			docs: [],
			imports: [],
		};
		vi.mocked(readCacheForWorktree).mockReturnValue(fresh);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		expect(getCachedIndex("/repo")).toBe(fresh);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/lib/indexer.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement indexer.ts**

```ts
// src/lib/indexer.ts
import {
	buildRepoFingerprint,
	readCacheForWorktree,
	writeCache,
} from "./cache-store.js";
import { loadDocs } from "./doc-inputs.js";
import { readPackageMeta, pickEntryFiles } from "./entry-files.js";
import { extractImports } from "./import-graph.js";
import { listIndexableFiles } from "./indexable-files.js";
import { SCHEMA_VERSION, IndexError, RepoIdentityError } from "./models.js";
import type { RepoCache, RepoIdentity } from "./models.js";
import { resolveRepoIdentity } from "./repo-identity.js";

export function buildIndex(identity: RepoIdentity): RepoCache {
	try {
		const filePaths = listIndexableFiles(identity.worktreePath);
		const packageMeta = readPackageMeta(identity.worktreePath);
		const entryFiles = pickEntryFiles(filePaths, packageMeta);
		const docs = loadDocs(identity.worktreePath, filePaths);
		const imports = extractImports(identity.worktreePath, filePaths);
		const fingerprint = buildRepoFingerprint(identity.worktreePath);
		const files = filePaths.map((p) => ({ path: p, kind: "file" as const }));

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
		};
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}

export function indexRepo(repoPath: string): RepoCache {
	const identity = resolveRepoIdentity(repoPath);
	const cache = buildIndex(identity);
	writeCache(cache);
	return cache;
}

export function getCachedIndex(repoPath: string): RepoCache | null {
	const identity = resolveRepoIdentity(repoPath);
	const cached = readCacheForWorktree(identity.repoKey, identity.worktreeKey);
	if (!cached) return null;
	const currentFingerprint = buildRepoFingerprint(identity.worktreePath);
	if (cached.fingerprint !== currentFingerprint) return null;
	return cached;
}
```

- [ ] **Step 4: Implement index.ts**

```ts
// src/lib/index.ts
export { indexRepo, getCachedIndex } from "./indexer.js";
export { RepoIdentityError, IndexError } from "./models.js";
export type {
	RepoCache,
	RepoIdentity,
	PackageMeta,
	FileNode,
	ImportEdge,
	DocInput,
} from "./models.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- tests/unit/lib/indexer.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/indexer.ts src/lib/index.ts tests/unit/lib/indexer.test.ts
git commit -m "feat: add indexer orchestrator and public api"
```

---

## Task 9: Update CLI

**Files:**

- Modify: `src/cli.ts`

- [ ] **Step 1: Replace cli.ts**

```ts
// src/cli.ts
import { getCachedIndex, indexRepo } from "./lib/index.js";
import { IndexError, RepoIdentityError } from "./lib/models.js";

const [, , command = "index", ...args] = process.argv;

if (command === "index") {
	const refresh = args.includes("--refresh");
	const repoPath = args.find((arg) => arg !== "--refresh") ?? process.cwd();
	const start = performance.now();

	try {
		const existing = refresh ? null : getCachedIndex(repoPath);
		const cache = existing ?? indexRepo(repoPath);
		const duration = Math.round(performance.now() - start);

		process.stdout.write(
			`indexed ${cache.packageMeta.name}\n` +
				`  files: ${cache.files.length}  docs: ${cache.docs.length}  imports: ${cache.imports.length}  entry files: ${cache.entryFiles.length}\n` +
				`  cache: ~/.cache/ai-cortex/v1/${cache.repoKey}/${cache.worktreeKey}.json\n` +
				`  duration: ${duration}ms\n`,
		);
	} catch (err) {
		if (err instanceof RepoIdentityError) {
			process.stderr.write(`ai-cortex: ${err.message}\n`);
			process.exit(1);
		}
		if (err instanceof IndexError) {
			process.stderr.write(`ai-cortex: index failed: ${err.message}\n`);
			process.exit(2);
		}
		throw err;
	}
} else {
	process.stderr.write(`ai-cortex: unknown command: ${command}\n`);
	process.exit(1);
}
```

- [ ] **Step 2: Update the phase0 script in package.json**

```json
{
	"scripts": {
		"build": "tsc -p tsconfig.json",
		"test": "vitest run",
		"typecheck": "tsc --noEmit -p tsconfig.json",
		"cortex": "tsx src/cli.ts"
	}
}
```

- [ ] **Step 3: Smoke test against the real proof repo**

Run: `pnpm build && node dist/src/cli.js index /Users/vuphan/Dev/ai-14all`

Expected output similar to:

```
indexed ai-14all
  files: 165  docs: 8  imports: 312  entry files: 6
  cache: ~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.json
  duration: 54ms
```

- [ ] **Step 4: Verify `--refresh` flag works**

Run: `node dist/src/cli.js index --refresh /Users/vuphan/Dev/ai-14all`

Expected: same output shape, slightly longer duration (rebuilds cache).

- [ ] **Step 5: Verify error handling**

Run: `node dist/src/cli.js index /tmp`

Expected: exits with code 1, stderr contains "Cannot resolve git repo".

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts package.json
git commit -m "feat: update cli to use phase 1 library"
```

---

## Task 10: Integration Test

**Files:**

- Create: `tests/integration/index.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/index.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCachedIndex, indexRepo } from "../../src/lib/index.js";
import { SCHEMA_VERSION } from "../../src/lib/models.js";

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-integration-"));

	// Set up a minimal git repo
	execFileSync("git", ["init", tmpDir]);
	execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", tmpDir, "config", "commit.gpgsign", "false"]);

	// Add files
	fs.writeFileSync(
		path.join(tmpDir, "README.md"),
		"# Test Repo\nA minimal test repo.\n",
	);
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(tmpDir, "src", "main.ts"),
		"export const x = 1;\n",
	);
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ name: "test-repo", version: "0.0.1" }),
	);

	execFileSync("git", ["-C", tmpDir, "add", "."]);
	execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("indexRepo + getCachedIndex (real disk + real git)", () => {
	it("builds a RepoCache with correct shape", () => {
		const cache = indexRepo(tmpDir);

		expect(cache.schemaVersion).toBe(SCHEMA_VERSION);
		expect(cache.repoKey).toHaveLength(16);
		expect(cache.worktreeKey).toHaveLength(16);
		expect(cache.worktreePath).toBe(tmpDir);
		expect(cache.fingerprint).toHaveLength(40);
		expect(cache.packageMeta.name).toBe("test-repo");
		expect(cache.files.some((f) => f.path === "README.md")).toBe(true);
		expect(cache.docs[0]?.path).toBe("README.md");
		expect(cache.docs[0]?.title).toBe("Test Repo");
	});

	it("getCachedIndex returns the cache when fingerprint is fresh", () => {
		const result = getCachedIndex(tmpDir);
		expect(result).not.toBeNull();
		expect(result?.packageMeta.name).toBe("test-repo");
	});

	it("getCachedIndex returns null after a new commit (stale fingerprint)", () => {
		fs.appendFileSync(path.join(tmpDir, "README.md"), "\nchange\n");
		execFileSync("git", ["-C", tmpDir, "add", "README.md"]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "update"]);

		expect(getCachedIndex(tmpDir)).toBeNull();
	});
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm test -- tests/integration/index.test.ts`

Expected: PASS (all three cases).

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass, including existing spike tests in `tests/unit/` and `tests/integration/rehydrate-spike.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/index.test.ts
git commit -m "test: add integration test for indexRepo and getCachedIndex"
```

---

## Task 11: Delete Spike

**Files:**

- Delete: `src/spike/` (all files)
- Delete: `tests/unit/repo-id.test.ts`
- Delete: `tests/unit/doc-inputs.test.ts`
- Delete: `tests/unit/suggest.test.ts`
- Delete: `tests/integration/rehydrate-spike.test.ts`

- [ ] **Step 1: Delete the spike source directory**

```bash
rm -rf src/spike
```

- [ ] **Step 2: Delete the spike test files**

```bash
rm tests/unit/repo-id.test.ts
rm tests/unit/doc-inputs.test.ts
rm tests/unit/suggest.test.ts
rm tests/integration/rehydrate-spike.test.ts
```

- [ ] **Step 3: Run the full test suite to verify nothing breaks**

Run: `pnpm test`

Expected: all remaining tests pass. No references to `src/spike/` remain.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete phase 0 spike after phase 1 library is complete"
```

---

## Self-Review

**Spec coverage:**

- Repo identity + worktree key: Task 2 ✓
- git common dir resolution: Task 2 ✓
- Storage layout `v1/<repoKey>/<worktreeKey>.json`: Task 7 ✓
- Schema version invalidation + stderr warning: Task 7 ✓
- `listIndexableFiles` with git + fs fallback: Task 3 ✓
- Doc ranking heuristics: Task 4 ✓
- TS/JS import extraction: Task 5 ✓
- `readPackageMeta` + `pickEntryFiles`: Task 6 ✓
- `buildIndex` (pure orchestration): Task 8 ✓
- `indexRepo` (build + write): Task 8 ✓
- `getCachedIndex` (read + fingerprint check): Task 8 ✓
- CLI `index` command with `--refresh`: Task 9 ✓
- Exit codes 0/1/2: Task 9 ✓
- Integration test (real git + real disk): Task 10 ✓
- Spike deletion: Task 11 ✓

**Placeholder scan:** None found.

**Type consistency:**

- `RepoCache` defined in Task 1, used in Tasks 7, 8, 10 — consistent.
- `RepoIdentity` defined in Task 1, produced in Task 2, consumed in Task 8 — consistent.
- `PackageMeta` defined in Task 1, produced in Task 6, stored in Task 8 — consistent.
- `buildIndex(identity: RepoIdentity)` defined and tested in Task 8 — consistent.
- `getCachedIndex` exported from Task 8, re-exported in `index.ts` Task 8, used in CLI Task 9 and integration Task 10 — consistent.
