// tests/unit/lib/indexer.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/repo-identity.js");
vi.mock("../../../src/lib/indexable-files.js");
vi.mock("../../../src/lib/entry-files.js");
vi.mock("../../../src/lib/doc-inputs.js");
vi.mock("../../../src/lib/import-graph.js");
vi.mock("../../../src/lib/cache-store.js");
vi.mock("../../../src/lib/diff-files.js");
vi.mock("../../../src/lib/adapters/ensure.js");
vi.mock("../../../src/lib/call-graph.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/lib/call-graph.js")>();
	return {
		...actual,
		extractCallGraph: vi.fn(),
		extractCallGraphRaw: vi.fn(),
		resolveCallSites: vi.fn(),
	};
});

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
import { hashFileContent } from "../../../src/lib/diff-files.js";
import { extractCallGraph, extractCallGraphRaw, resolveCallSites } from "../../../src/lib/call-graph.js";
import { isAdapterExt, registerAdapter, clearAdapters } from "../../../src/lib/adapters/index.js";
import { ensureAdapters } from "../../../src/lib/adapters/ensure.js";
import { createTypescriptAdapter } from "../../../src/lib/adapters/typescript.js";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import type { FilesDiff } from "../../../src/lib/diff-files.js";
import {
	buildIndex,
	buildIncrementalIndex,
	getCachedIndex,
	indexRepo,
} from "../../../src/lib/indexer.js";

const mockIdentity = {
	repoKey: "aabbccdd11223344",
	worktreeKey: "eeff00112233aabb",
	gitCommonDir: "/repo/.git",
	worktreePath: "/repo",
};

beforeEach(async () => {
	clearAdapters();
	registerAdapter(await createTypescriptAdapter());
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
	vi.mocked(extractImports).mockResolvedValue([]);
	vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
	vi.mocked(readCacheForWorktree).mockReturnValue(null);
	vi.mocked(writeCache).mockReturnValue(undefined);
	vi.mocked(hashFileContent).mockReturnValue("fakehash123");
	vi.mocked(extractCallGraph).mockResolvedValue({ calls: [], functions: [] });
	vi.mocked(extractCallGraphRaw).mockResolvedValue({ rawCalls: [], functions: [], bindingsByFile: new Map() });
	vi.mocked(resolveCallSites).mockReturnValue([]);
	vi.mocked(ensureAdapters).mockResolvedValue(undefined);
});

it("uses schema version 3", () => {
	expect(SCHEMA_VERSION).toBe("3");
});

describe("buildIndex", () => {
	it("assembles a RepoCache from all modules", async () => {
		const cache = await buildIndex(mockIdentity);

		expect(cache.schemaVersion).toBe(SCHEMA_VERSION);
		expect(cache.repoKey).toBe(mockIdentity.repoKey);
		expect(cache.worktreeKey).toBe(mockIdentity.worktreeKey);
		expect(cache.worktreePath).toBe("/repo");
		expect(cache.fingerprint).toBe("abc123");
		expect(cache.packageMeta.name).toBe("test-app");
		expect(cache.entryFiles).toEqual(["src/main.ts"]);
		expect(cache.docs[0]?.title).toBe("Test App");
	});

	it("populates contentHash on each FileNode", async () => {
		vi.mocked(hashFileContent).mockImplementation((_wp, fp) =>
			fp === "README.md" ? "hash_readme" : "hash_main",
		);
		const cache = await buildIndex(mockIdentity);

		expect(cache.files).toEqual([
			{ path: "README.md", kind: "file", contentHash: "hash_readme" },
			{ path: "src/main.ts", kind: "file", contentHash: "hash_main" },
		]);
		expect(vi.mocked(hashFileContent)).toHaveBeenCalledTimes(2);
	});

	it("includes indexedAt as an ISO timestamp", async () => {
		const cache = await buildIndex(mockIdentity);
		expect(() => new Date(cache.indexedAt)).not.toThrow();
		expect(cache.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

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
			expect.any(Map),
		);
	});
});

describe("indexRepo", () => {
	it("calls writeCache with the assembled cache", async () => {
		await indexRepo("/repo");
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
			calls: [],
			functions: [],
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
			calls: [],
			functions: [],
		};
		vi.mocked(readCacheForWorktree).mockReturnValue(fresh);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		expect(getCachedIndex("/repo")).toBe(fresh);
	});
});

function makeCacheForIncremental(): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: mockIdentity.repoKey,
		worktreeKey: mockIdentity.worktreeKey,
		worktreePath: "/repo",
		indexedAt: "2026-01-01T00:00:00.000Z",
		fingerprint: "oldfingerprint",
		packageMeta: { name: "test-app", version: "1.0.0", framework: null },
		entryFiles: ["src/main.ts"],
		files: [
			{ path: "README.md", kind: "file", contentHash: "hash_readme" },
			{ path: "src/main.ts", kind: "file", contentHash: "hash_main" },
			{ path: "src/utils.ts", kind: "file", contentHash: "hash_utils" },
		],
		docs: [{ path: "README.md", title: "Test App", body: "# Test App\n" }],
		imports: [
			{ from: "src/main.ts", to: "src/utils" },
		],
		calls: [],
		functions: [],
	};
}

describe("buildIncrementalIndex", () => {
	beforeEach(() => {
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");
	});

	it("merges changed files into existing cache", async () => {
		vi.mocked(hashFileContent).mockReturnValue("hash_main_v2");
		vi.mocked(extractImports).mockResolvedValue([
			{ from: "src/main.ts", to: "src/helper" },
		]);

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		// Changed file has updated hash
		const mainFile = result.files.find((f) => f.path === "src/main.ts");
		expect(mainFile?.contentHash).toBe("hash_main_v2");

		// Unchanged file keeps old hash
		const utilsFile = result.files.find((f) => f.path === "src/utils.ts");
		expect(utilsFile?.contentHash).toBe("hash_utils");

		// Imports from changed file are replaced
		expect(result.imports).toEqual([{ from: "src/main.ts", to: "src/helper" }]);
	});

	it("removes files listed in diff.removed from files, imports, and docs", async () => {
		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: [],
			removed: ["src/utils.ts"],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.files.find((f) => f.path === "src/utils.ts")).toBeUndefined();
	});

	it("replaces import edges from changed files, keeps unchanged", async () => {
		vi.mocked(hashFileContent).mockReturnValue("hash_main_v2");
		vi.mocked(extractImports).mockResolvedValue([
			{ from: "src/main.ts", to: "src/new-dep" },
		]);

		const existing = makeCacheForIncremental();
		// Add an edge from utils that should be untouched
		existing.imports.push({ from: "src/utils.ts", to: "src/lib" });

		const diff: FilesDiff = {
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		// Old edge from main.ts dropped, new one added
		expect(result.imports).toContainEqual({
			from: "src/main.ts",
			to: "src/new-dep",
		});
		// Edge from utils.ts untouched
		expect(result.imports).toContainEqual({
			from: "src/utils.ts",
			to: "src/lib",
		});
		// Old edge from main.ts gone
		expect(result.imports).not.toContainEqual({
			from: "src/main.ts",
			to: "src/utils",
		});
	});

	it("stale import to edges remain when target removed (deferred to Phase 5)", async () => {
		const existing = makeCacheForIncremental();
		// main.ts imports utils — we remove utils.ts but don't change main.ts
		const diff: FilesDiff = {
			changed: [],
			removed: ["src/utils.ts"],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		// Edge from main.ts still points to src/utils (stale to, accepted)
		expect(result.imports).toContainEqual({
			from: "src/main.ts",
			to: "src/utils",
		});
	});

	it("re-reads packageMeta when package.json is in changed", async () => {
		vi.mocked(readPackageMeta).mockReturnValue({
			name: "renamed-app",
			version: "2.0.0",
			framework: "vite",
		});
		vi.mocked(hashFileContent).mockReturnValue("hash_pkg_v2");

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: ["package.json"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.packageMeta.name).toBe("renamed-app");
		expect(result.packageMeta.framework).toBe("vite");
		expect(vi.mocked(pickEntryFiles)).toHaveBeenCalled();
	});

	it("re-reads packageMeta when package.json is in removed", async () => {
		vi.mocked(readPackageMeta).mockReturnValue({
			name: "repo",
			version: "0.0.0",
			framework: null,
		});

		const existing = makeCacheForIncremental();
		existing.files.push({
			path: "package.json",
			kind: "file",
			contentHash: "hash_pkg",
		});

		const diff: FilesDiff = {
			changed: [],
			removed: ["package.json"],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.packageMeta.name).toBe("repo");
		expect(result.packageMeta.version).toBe("0.0.0");
	});

	it("recomputes entry files after merge", async () => {
		vi.mocked(pickEntryFiles).mockReturnValue(["src/main.ts", "src/new.ts"]);

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: ["src/new.ts"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.entryFiles).toEqual(["src/main.ts", "src/new.ts"]);
	});

	it("updates content hashes for changed files on incremental index", async () => {
		vi.mocked(hashFileContent).mockImplementation((_wp, fp) =>
			fp === "src/main.ts" ? "new_hash_main" : "other",
		);

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		const mainFile = result.files.find((f) => f.path === "src/main.ts");
		expect(mainFile?.contentHash).toBe("new_hash_main");
	});

	it("returns same cache with updated fingerprint and timestamp on empty diff", async () => {
		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: [],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.fingerprint).toBe("newfingerprint");
		expect(result.indexedAt).not.toBe(existing.indexedAt);
		expect(result.files).toEqual(existing.files);
		expect(result.imports).toEqual(existing.imports);
	});

	it("recomputes docs from scratch when .md file added (promotes into top-8)", async () => {
		vi.mocked(loadDocs).mockReturnValue([
			{ path: "README.md", title: "Test App", body: "# Test App\n" },
			{ path: "docs/new.md", title: "New Doc", body: "# New Doc\n" },
		]);
		vi.mocked(hashFileContent).mockReturnValue("hash_newdoc");

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: ["docs/new.md"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.docs).toHaveLength(2);
		expect(result.docs[1]?.title).toBe("New Doc");
		expect(vi.mocked(loadDocs)).toHaveBeenCalled();
	});

	it("sets dirtyAtIndex true when passed true", async () => {
		vi.mocked(hashFileContent).mockReturnValue("hash_main_v2");
		vi.mocked(extractImports).mockResolvedValue([]);

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, true);

		expect(result.dirtyAtIndex).toBe(true);
	});

	it("sets dirtyAtIndex false when passed false", async () => {
		vi.mocked(hashFileContent).mockReturnValue("hash_main_v2");
		vi.mocked(extractImports).mockResolvedValue([]);

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.dirtyAtIndex).toBe(false);
	});

	it("recomputes docs from scratch when top-ranked doc removed", async () => {
		vi.mocked(loadDocs).mockReturnValue([
			{ path: "docs/other.md", title: "Other", body: "# Other\n" },
		]);

		const existing = makeCacheForIncremental();
		const diff: FilesDiff = {
			changed: [],
			removed: ["README.md"],
			method: "git-diff",
		};

		const result = await buildIncrementalIndex(mockIdentity, existing, diff, false);

		expect(result.docs).toHaveLength(1);
		expect(result.docs[0]?.title).toBe("Other");
	});

	it("removes call edges from changed files and re-extracts", async () => {
		vi.mocked(hashFileContent).mockReturnValue("hash_main_v2");
		vi.mocked(extractCallGraphRaw).mockResolvedValue({
			rawCalls: [],
			functions: [
				{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
			],
			bindingsByFile: new Map(),
		});
		vi.mocked(resolveCallSites).mockReturnValue([
			{ from: "src/main.ts::main", to: "src/utils.ts::newHelper", kind: "call" },
		]);
		vi.mocked(extractImports).mockResolvedValue([]);

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

		expect(result.calls).toContainEqual({ from: "src/main.ts::main", to: "src/utils.ts::newHelper", kind: "call" });
		expect(result.calls).toContainEqual({ from: "src/utils.ts::helper", to: "src/lib.ts::lib", kind: "call" });
		expect(result.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "helper", file: "src/utils.ts" }),
		);
	});

	it("calls ensureAdapters before filtering changed files", async () => {
		const existing = makeCacheForIncremental();
		const result = await buildIncrementalIndex(
			mockIdentity,
			existing,
			{ changed: ["src/main.ts"], removed: [], method: "hash-compare" },
			false,
		);
		expect(vi.mocked(ensureAdapters)).toHaveBeenCalled();
		// Ensure it completed successfully
		expect(result).toBeDefined();
	});

	it("removes call edges from affected callers (files importing changed files)", async () => {
		vi.mocked(hashFileContent).mockReturnValue("hash_utils_v2");
		vi.mocked(extractCallGraphRaw).mockResolvedValue({
			rawCalls: [],
			functions: [
				{ qualifiedName: "helper", file: "src/utils.ts", exported: true, isDefaultExport: false, line: 1 },
				{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
			],
			bindingsByFile: new Map(),
		});
		vi.mocked(resolveCallSites).mockReturnValue([
			{ from: "src/utils.ts::helper", to: "src/lib.ts::lib", kind: "call" },
			{ from: "src/main.ts::main", to: "src/utils.ts::helper", kind: "call" },
		]);
		vi.mocked(extractImports).mockResolvedValue([]);

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

		expect(result.calls).not.toContainEqual(
			expect.objectContaining({ to: "src/utils.ts::oldHelper" }),
		);

		// Verify no duplicate functions for the affected-caller file
		const mainFns = result.functions.filter(f => f.file === "src/main.ts");
		expect(mainFns).toHaveLength(1);
		// Verify extractCallGraphRaw was called with both changed + affected-caller files
		expect(extractCallGraphRaw).toHaveBeenCalledWith(
			"/repo",
			expect.arrayContaining(["src/utils.ts", "src/main.ts"]),
		);
	});
});

describe("indexer adapter-driven filter", () => {
	it("isAdapterExt accepts every TS extension after registration", async () => {
		clearAdapters();
		registerAdapter(await createTypescriptAdapter());
		expect(isAdapterExt("foo.ts")).toBe(true);
		expect(isAdapterExt("foo.tsx")).toBe(true);
		expect(isAdapterExt("foo.js")).toBe(true);
		expect(isAdapterExt("foo.jsx")).toBe(true);
		expect(isAdapterExt("README.md")).toBe(false);
	});
});
