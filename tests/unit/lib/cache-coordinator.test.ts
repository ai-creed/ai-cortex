// tests/unit/lib/cache-coordinator.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/repo-identity.js");
vi.mock("../../../src/lib/cache-store.js");
vi.mock("../../../src/lib/indexer.js");
vi.mock("../../../src/lib/diff-files.js");

import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";
import {
	buildRepoFingerprint,
	isWorktreeDirty,
	readCacheForWorktree,
	writeCache,
} from "../../../src/lib/cache-store.js";
import { diffChangedFiles } from "../../../src/lib/diff-files.js";
import { buildIncrementalIndex, indexRepo } from "../../../src/lib/indexer.js";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { resolveCacheWithFreshness } from "../../../src/lib/cache-coordinator.js";

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
		docs: [],
		imports: [],
		calls: [],
		functions: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveRepoIdentity).mockReturnValue(mockIdentity);
	vi.mocked(isWorktreeDirty).mockResolvedValue(false);
});

describe("resolveCacheWithFreshness", () => {
	it("returns reindexed and calls indexRepo when no cache exists", async () => {
		const freshCache = makeCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(null);
		vi.mocked(indexRepo).mockResolvedValue(freshCache);

		const result = await resolveCacheWithFreshness(mockIdentity, {});

		expect(result.cacheStatus).toBe("reindexed");
		expect(result.cache).toBe(freshCache);
		expect(vi.mocked(indexRepo)).toHaveBeenCalledOnce();
		expect(vi.mocked(buildIncrementalIndex)).not.toHaveBeenCalled();
	});

	it("returns reindexed via incremental path when fingerprint is stale", async () => {
		const cache = makeCache();
		const updated = { ...cache, fingerprint: "newfingerprint" };
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("newfingerprint");
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/app.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await resolveCacheWithFreshness(mockIdentity, {});

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
	});

	it("returns reindexed via incremental path when worktree is dirty", async () => {
		const cache = makeCache();
		const updated = { ...cache, dirtyAtIndex: true };
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(true);
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/new.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await resolveCacheWithFreshness(mockIdentity, {});

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(diffChangedFiles)).toHaveBeenCalledWith(
			mockIdentity,
			cache,
			{ forceHashCompare: false },
		);
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("forces hash-compare incremental when dirtyAtIndex flag set and worktree is now clean", async () => {
		const cache = makeCache({ dirtyAtIndex: true });
		const updated = { ...cache, dirtyAtIndex: false };
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/app.ts"],
			removed: [],
			method: "hash-compare",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await resolveCacheWithFreshness(mockIdentity, {});

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(diffChangedFiles)).toHaveBeenCalledWith(
			mockIdentity,
			cache,
			{ forceHashCompare: true },
		);
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("returns stale and no refresh when stale option is true and cache is stale", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("newfingerprint");

		const result = await resolveCacheWithFreshness(mockIdentity, {
			stale: true,
		});

		expect(result.cacheStatus).toBe("stale");
		expect(result.cache).toBe(cache);
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
		expect(vi.mocked(buildIncrementalIndex)).not.toHaveBeenCalled();
	});

	it("returns fresh when fingerprint matches and worktree is clean", async () => {
		const cache = makeCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");

		const result = await resolveCacheWithFreshness(mockIdentity, {});

		expect(result.cacheStatus).toBe("fresh");
		expect(result.cache).toBe(cache);
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
		expect(vi.mocked(buildIncrementalIndex)).not.toHaveBeenCalled();
	});
});
