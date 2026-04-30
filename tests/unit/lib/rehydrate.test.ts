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
vi.mock("../../../src/lib/memory/briefing-pinned.js");

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
import { renderPinnedSection } from "../../../src/lib/memory/briefing-pinned.js";
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
	vi.mocked(renderPinnedSection).mockResolvedValue(null);
	vi.mocked(getCacheDir).mockReturnValue(
		path.join(tmpDir, ".cache", "ai-cortex", "v1", mockIdentity.repoKey),
	);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("rehydrateRepo", () => {
	it("returns fresh when fingerprint matches and worktree is clean", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("fresh");
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
	});

	it("reindexes when fingerprint is stale", async () => {
		const cache = makeFreshCache();
		const updated = { ...cache, fingerprint: "newfingerprint" };
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("newfingerprint");
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: [],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("reindexes when worktree has modified tracked files", async () => {
		const cache = makeFreshCache();
		const updated = { ...cache };
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(true);
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("reindexes when worktree has new untracked files", async () => {
		const cache = makeFreshCache();
		const updated = { ...cache };
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(true);
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["newfile.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
	});

	it("uses stale data when stale option is set", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("newfingerprint");

		const result = await rehydrateRepo("/repo", { stale: true });

		expect(result.cacheStatus).toBe("stale");
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
	});

	it("indexes from scratch when no cache exists", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(null);
		vi.mocked(indexRepo).mockResolvedValue(cache);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(indexRepo)).toHaveBeenCalledOnce();
	});

	it("writes .md file to the correct path", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);

		const result = await rehydrateRepo("/repo");

		expect(result.briefingPath).toContain(mockIdentity.worktreeKey + ".md");
		expect(fs.existsSync(result.briefingPath)).toBe(true);
		expect(fs.readFileSync(result.briefingPath, "utf8")).toBe("# test-app\n");
	});

	it("wraps non-identity errors in IndexError", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);
		vi.mocked(renderBriefing).mockImplementation(() => {
			throw new Error("disk full");
		});

		await expect(rehydrateRepo("/repo")).rejects.toThrow(IndexError);
	});

	it("wraps fs.writeFileSync failure in IndexError", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);
		vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
			throw new Error("ENOSPC: no space left on device");
		});

		await expect(rehydrateRepo("/repo")).rejects.toThrow(IndexError);
	});

	it("passes through RepoIdentityError without wrapping", async () => {
		vi.mocked(resolveRepoIdentity).mockImplementation(() => {
			throw new RepoIdentityError("not a git repo");
		});

		await expect(rehydrateRepo("/repo")).rejects.toThrow(RepoIdentityError);
	});

	it("returns the cache in the result", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);

		const result = await rehydrateRepo("/repo");

		expect(result.cache).toBe(cache);
	});
});

describe("rehydrateRepo — incremental path", () => {
	it("uses incremental index when cache exists and fingerprint is stale", async () => {
		const cache = makeFreshCache();
		cache.files = [{ path: "src/main.ts", kind: "file", contentHash: "hash1" }];
		const updated = { ...cache, fingerprint: "newfingerprint" };

		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("newfingerprint");
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
		expect(vi.mocked(writeCache)).toHaveBeenCalledWith(updated);
	});

	it("uses incremental index when worktree is dirty", async () => {
		const cache = makeFreshCache();
		cache.files = [{ path: "src/main.ts", kind: "file", contentHash: "hash1" }];
		const updated = { ...cache };

		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(true);
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
		expect(vi.mocked(indexRepo)).not.toHaveBeenCalled();
	});

	it("still uses full indexRepo when no cache exists", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(null);
		vi.mocked(indexRepo).mockResolvedValue(cache);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(indexRepo)).toHaveBeenCalledOnce();
		expect(vi.mocked(buildIncrementalIndex)).not.toHaveBeenCalled();
	});

	it("treats dirty-reverted cache as stale (dirtyAtIndex + clean worktree)", async () => {
		const cache = makeFreshCache();
		cache.dirtyAtIndex = true; // was built from dirty worktree
		const updated = { ...cache, dirtyAtIndex: false };

		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123"); // same fingerprint
		vi.mocked(isWorktreeDirty).mockResolvedValue(false); // clean worktree
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "hash-compare",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		const result = await rehydrateRepo("/repo");

		expect(result.cacheStatus).toBe("reindexed");
		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledOnce();
		// Must force hash-compare to detect delta between dirty cache and clean disk
		expect(vi.mocked(diffChangedFiles)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{ forceHashCompare: true },
		);
	});

	it("passes dirtyAtIndex=true when refresh triggered by dirty worktree", async () => {
		const cache = makeFreshCache();
		const updated = { ...cache, dirtyAtIndex: true };

		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123"); // same fingerprint
		vi.mocked(isWorktreeDirty).mockResolvedValue(true); // dirty
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		await rehydrateRepo("/repo");

		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true, // dirtyAtIndex
		);
	});

	it("passes dirtyAtIndex=false when refresh triggered by fingerprint change only", async () => {
		const cache = makeFreshCache();
		const updated = { ...cache, fingerprint: "newfingerprint" };

		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("newfingerprint");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false); // clean worktree
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: [],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		await rehydrateRepo("/repo");

		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			false, // dirtyAtIndex
		);
	});

	it("passes dirtyAtIndex=true when fingerprint is stale AND worktree is dirty", async () => {
		const cache = makeFreshCache();
		const updated = {
			...cache,
			fingerprint: "newfingerprint",
			dirtyAtIndex: true,
		};

		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("newfingerprint");
		vi.mocked(isWorktreeDirty).mockResolvedValue(true); // dirty
		vi.mocked(diffChangedFiles).mockResolvedValue({
			changed: ["src/main.ts"],
			removed: [],
			method: "git-diff",
		});
		vi.mocked(buildIncrementalIndex).mockResolvedValue(updated);
		vi.mocked(writeCache).mockResolvedValue(undefined);

		await rehydrateRepo("/repo");

		expect(vi.mocked(buildIncrementalIndex)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true, // dirtyAtIndex — worktree is dirty even though fingerprint also changed
		);
	});
});

describe("rehydrateRepo — pinned memories section", () => {
	it("includes a Pinned memories section when at least one is pinned", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);
		vi.mocked(renderPinnedSection).mockResolvedValue(
			"## Pinned memories (1)\n\n- **decision** — Always use pnpm\n  > use pnpm (mem-id)\n",
		);

		const result = await rehydrateRepo("/repo");

		const content = fs.readFileSync(result.briefingPath, "utf8");
		expect(content).toMatch(/## Pinned memories/);
	});

	it("omits the Pinned memories section when no memories are pinned", async () => {
		const cache = makeFreshCache();
		vi.mocked(readCacheForWorktree).mockResolvedValue(cache);
		vi.mocked(buildRepoFingerprint).mockResolvedValue("abc123");
		vi.mocked(isWorktreeDirty).mockResolvedValue(false);
		vi.mocked(renderPinnedSection).mockResolvedValue(null);

		const result = await rehydrateRepo("/repo");

		const content = fs.readFileSync(result.briefingPath, "utf8");
		expect(content).not.toMatch(/## Pinned memories/);
	});
});
