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

it("uses schema version 2", () => {
	expect(SCHEMA_VERSION).toBe("2");
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
