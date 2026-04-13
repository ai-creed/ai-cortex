// tests/unit/lib/rehydrate.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/repo-identity.js");
vi.mock("../../../src/lib/cache-store.js");
vi.mock("../../../src/lib/indexer.js");
vi.mock("../../../src/lib/briefing.js");
vi.mock("../../../src/lib/diff-files.js");

import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";
import {
	buildRepoFingerprint,
	getCacheDir,
	isWorktreeDirty,
	readCacheForWorktree,
	writeCache,
} from "../../../src/lib/cache-store.js";
import { diffChangedFiles } from "../../../src/lib/diff-files.js";
import { indexRepo, buildIncrementalIndex } from "../../../src/lib/indexer.js";
import { renderBriefing } from "../../../src/lib/briefing.js";
import {
	SCHEMA_VERSION,
	IndexError,
	RepoIdentityError,
} from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { rehydrateRepo } from "../../../src/lib/rehydrate.js";

const mockIdentity = {
	repoKey: "aabbccdd11223344",
	worktreeKey: "eeff00112233aabb",
	gitCommonDir: "/repo/.git",
	worktreePath: "/repo",
};

function makeFreshCache(): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: mockIdentity.repoKey,
		worktreeKey: mockIdentity.worktreeKey,
		worktreePath: "/repo",
		indexedAt: "2026-04-10T00:00:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test-app", version: "1.0.0", framework: null },
		entryFiles: ["src/main.ts"],
		files: [{ path: "src/main.ts", kind: "file" }],
		docs: [{ path: "README.md", title: "Test", body: "# Test\n" }],
		imports: [],
		calls: [],
		functions: [],
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-rehydrate-test-"));
	vi.clearAllMocks();
	vi.mocked(resolveRepoIdentity).mockReturnValue(mockIdentity);
	vi.mocked(renderBriefing).mockReturnValue("# test-app\n");
	vi.mocked(getCacheDir).mockReturnValue(
		path.join(tmpDir, ".cache", "ai-cortex", "v1", mockIdentity.repoKey),
	);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("rehydrateRepo", () => {
	it("returns fresh when fingerprint matches and worktree is clean", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(false);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("fresh");
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
	});

	it("reindexes when fingerprint is stale", () => {
		const cache = makeFreshCache();
		const updated = { ...cache, fingerprint: "newfingerprint" };
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: [],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("reindexes when worktree has modified tracked files", () => {
		const cache = makeFreshCache();
		const updated = { ...cache };
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(true);
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("reindexes when worktree has new untracked files", () => {
		const cache = makeFreshCache();
		const updated = { ...cache };
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(true);
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["newfile.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("uses stale data when stale option is set", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");

		const result = rehydrateRepo("/repo", { stale: true });

		expect(result.cacheStatus).toBe("stale");
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
	});

	it("indexes from scratch when no cache exists", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(null);
		vi.mocked(indexRepo).mockReturnValue(cache);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(indexRepo)).toHaveBeenCalledOnce();
	});

	it("writes .md file to the correct path", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(false);

		const result = rehydrateRepo("/repo");

		expect(result.briefingPath).toContain(mockIdentity.worktreeKey + ".md");
		expect(fs.existsSync(result.briefingPath)).toBe(true);
		expect(fs.readFileSync(result.briefingPath, "utf8")).toBe("# test-app\n");
	});

	it("wraps non-identity errors in IndexError", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(false);
		vi.mocked(renderBriefing).mockImplementation(() => {
			throw new Error("disk full");
		});

		expect(() => rehydrateRepo("/repo")).toThrow(IndexError);
	});

	it("wraps fs.writeFileSync failure in IndexError", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(false);
		vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
			throw new Error("ENOSPC: no space left on device");
		});

		expect(() => rehydrateRepo("/repo")).toThrow(IndexError);
	});

	it("passes through RepoIdentityError without wrapping", () => {
		vi.mocked(resolveRepoIdentity).mockImplementation(() => {
			throw new RepoIdentityError("not a git repo");
		});

		expect(() => rehydrateRepo("/repo")).toThrow(RepoIdentityError);
	});

	it("returns the cache in the result", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(false);

		const result = rehydrateRepo("/repo");

		expect(result.cache).toBe(cache);
	});
});

describe("rehydrateRepo — incremental path", () => {
	it("uses incremental index when cache exists and fingerprint is stale", () => {
		const cache = makeFreshCache();
		cache.files = [
			{ path: "src/main.ts", kind: "file", contentHash: "hash1" },
		];
		const updated = { ...cache, fingerprint: "newfingerprint" };

		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
		expect(vi.mocked(writeCache)).toHaveBeenCalledWith(updated);
	});

	it("uses incremental index when worktree is dirty", () => {
		const cache = makeFreshCache();
		cache.files = [
			{ path: "src/main.ts", kind: "file", contentHash: "hash1" },
		];
		const updated = { ...cache };

		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123");
		vi.mocked(isWorktreeDirty).mockReturnValue(true);
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
	});

	it("still uses full indexRepo when no cache exists", () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockReturnValue(null);
		vi.mocked(indexRepo).mockReturnValue(cache);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(indexRepo)).toHaveBeenCalledOnce();
		expect(vi.mocked(buildIncrementalIndex)).not.toHaveBeenCalled();
	});

	it("treats dirty-reverted cache as stale (dirtyAtIndex + clean worktree)", () => {
		const cache = makeFreshCache();
		cache.dirtyAtIndex = true; // was built from dirty worktree
		const updated = { ...cache, dirtyAtIndex: false };

		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123"); // same fingerprint
		vi.mocked(isWorktreeDirty).mockReturnValue(false); // clean worktree
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "hash-compare",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		const result = rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
		// Must force hash-compare to detect delta between dirty cache and clean disk
		expect(vi.mocked(diffChangedFiles)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{ forceHashCompare: true },
		);
	});

	it("passes dirtyAtIndex=true when refresh triggered by dirty worktree", () => {
		const cache = makeFreshCache();
		const updated = { ...cache, dirtyAtIndex: true };

		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("abc123"); // same fingerprint
		vi.mocked(isWorktreeDirty).mockReturnValue(true); // dirty
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		rehydrateRepo("/repo");

		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true, // dirtyAtIndex
		);
	});

	it("passes dirtyAtIndex=false when refresh triggered by fingerprint change only", () => {
		const cache = makeFreshCache();
		const updated = { ...cache, fingerprint: "newfingerprint" };

		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");
		vi.mocked(isWorktreeDirty).mockReturnValue(false); // clean worktree
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: [],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		rehydrateRepo("/repo");

		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			false, // dirtyAtIndex
		);
	});

	it("passes dirtyAtIndex=true when fingerprint is stale AND worktree is dirty", () => {
		const cache = makeFreshCache();
		const updated = { ...cache, fingerprint: "newfingerprint", dirtyAtIndex: true };

		vi.mocked(readCacheForWorktree).mockReturnValue(cache);
		vi.mocked(buildRepoFingerprint).mockReturnValue("newfingerprint");
		vi.mocked(isWorktreeDirty).mockReturnValue(true); // dirty
		vi.mocked(diffChangedFiles).mockReturnValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockReturnValue(updated);
		vi.mocked(writeCache).mockReturnValue(undefined);

		rehydrateRepo("/repo");

		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true, // dirtyAtIndex — worktree is dirty even though fingerprint also changed
		);
	});
});
