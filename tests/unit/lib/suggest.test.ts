// tests/unit/lib/suggest.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/repo-identity.js");
vi.mock("../../../src/lib/cache-store.js");
vi.mock("../../../src/lib/indexer.js");
vi.mock("../../../src/lib/diff-files.js");
vi.mock("../../../src/lib/suggest-ranker.js");

import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";
import {
	buildRepoFingerprint,
	isWorktreeDirty,
	readCacheForWorktree,
	writeCache,
} from "../../../src/lib/cache-store.js";
import { diffChangedFiles } from "../../../src/lib/diff-files.js";
import { buildIncrementalIndex, indexRepo } from "../../../src/lib/indexer.js";
import { rankSuggestions } from "../../../src/lib/suggest-ranker.js";
import {
	SCHEMA_VERSION,
	IndexError,
	RepoIdentityError,
} from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { suggestRepo } from "../../../src/lib/suggest.js";
import { suggestRepo as exportedSuggestRepo } from "../../../src/lib/index.js";

const mockIdentity = {
	repoKey: "repokey1234567890",
	worktreeKey: "worktree12345678",
	gitCommonDir: "/repo/.git",
	worktreePath: "/repo",
};

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: mockIdentity.repoKey,
		worktreeKey: mockIdentity.worktreeKey,
		worktreePath: "/repo",
		indexedAt: "2026-04-12T00:00:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test-app", version: "1.0.0", framework: null },
		entryFiles: ["src/app.ts"],
		files: [{ path: "src/app.ts", kind: "file", contentHash: "hash1" }],
		docs: [{ path: "README.md", title: "Test App", body: "# Test App\n" }],
		imports: [],
		calls: [],
		functions: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveRepoIdentity).mockReturnValue(mockIdentity);
	vi.mocked(isWorktreeDirty).mockReturnValue(false);
	vi.mocked(rankSuggestions).mockReturnValue([
		{
			path: "src/app.ts",
			kind: "file",
			score: 8,
			reason: "matched task terms in path: app",
		},
	]);
});

describe("suggestRepo", () => {
	it("returns fresh when cache is current and worktree is clean", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");

		const result = await suggestRepo("/repo", "app");

		expect(result.cacheStatus).toBe("fresh");
		expect(result.results[0]?.path).toBe("src/app.ts");
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
		expect(vi.mocked(buildIncrementalIndex)).not.toHaveBeenCalled();
	});

	it("indexes from scratch when no cache exists", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(null);
		vi.mocked(indexRepo).mockResolvedValue(cache);

		const result = await suggestRepo("/repo", "app");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(indexRepo)).toHaveBeenCalledOnce();
	});

	it("uses incremental refresh when fingerprint is stale", async () => {
		const cache = makeCache();
		const updated = { ...cache, fingerprint: "newfingerprint" };
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/app.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = await suggestRepo("/repo", "app");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("uses incremental refresh when the worktree is dirty at the same fingerprint", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(true);
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/new.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue({
			...cache,
			dirtyAtIndex: true,
		});
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = await suggestRepo("/repo", "new");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(diffChangedFiles)).toHaveBeenCalledWith(
			mockIdentity,
			cache,
			{ forceHashCompare: false },
		);
	});

	it("forces hash compare when cache was built dirty and worktree is now clean", async () => {
		const cache = makeCache({ dirtyAtIndex: true });
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/app.ts"],
			removed: [],
			method: "hash-compare",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue({
			...cache,
			dirtyAtIndex: false,
		});
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = await suggestRepo("/repo", "app");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(diffChangedFiles)).toHaveBeenCalledWith(
			mockIdentity,
			cache,
			{ forceHashCompare: true },
		);
	});

	it("uses stale cache when stale is requested", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");

		const result = await suggestRepo("/repo", "app", { stale: true });

		expect(result.cacheStatus).toBe("stale");
	});

	it("throws IndexError for an empty task", async () => {
		await expect(suggestRepo("/repo", "   ")).rejects.toThrow(IndexError);
	});

	it("throws IndexError for invalid limit", async () => {
		await expect(suggestRepo("/repo", "app", { limit: 0 })).rejects.toThrow(IndexError);
	});

	it("normalizes unknown from values to null", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");

		const result = await suggestRepo("/repo", "app", { from: "missing.ts" });

		expect(result.from).toBeNull();
	});

	it("wraps non-identity errors in IndexError", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockImplementation(() => {
			throw new Error("git exploded");
		});

		await expect(suggestRepo("/repo", "app")).rejects.toThrow(IndexError);
	});

	it("passes through RepoIdentityError", async () => {
		vi.mocked(resolveRepoIdentity).mockImplementation(() => {
			throw new RepoIdentityError("not a repo");
		});

		await expect(suggestRepo("/repo", "app")).rejects.toThrow(RepoIdentityError);
	});

	it("re-exports suggestRepo from the library entrypoint", () => {
		expect(exportedSuggestRepo).toBe(suggestRepo);
	});
});

describe("suggestRepo — option validation", () => {
	beforeEach(() => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
	});

	it("rejects non-integer poolSize", async () => {
		await expect(
			suggestRepo("/repo", "task", { poolSize: 1.5 }),
		).rejects.toThrow(IndexError);
	});

	it("rejects NaN poolSize (regression: CLI Number('foo'))", async () => {
		await expect(
			suggestRepo("/repo", "task", { poolSize: Number.NaN }),
		).rejects.toThrow(IndexError);
	});

	it("rejects poolSize > 200", async () => {
		await expect(
			suggestRepo("/repo", "task", { poolSize: 201 }),
		).rejects.toThrow(IndexError);
	});

	it("rejects poolSize < 1", async () => {
		await expect(
			suggestRepo("/repo", "task", { poolSize: 0 }),
		).rejects.toThrow(IndexError);
	});

	it("rejects unknown mode string", async () => {
		await expect(
			suggestRepo("/repo", "task", { mode: "turbo" as "fast" }),
		).rejects.toThrow(IndexError);
	});
});
