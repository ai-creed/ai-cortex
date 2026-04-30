// src/lib/cache-coordinator.ts
import {
	buildRepoFingerprint,
	isWorktreeDirty,
	readCacheForWorktree,
	writeCache,
} from "./cache-store.js";
import { diffChangedFiles } from "./diff-files.js";
import { buildIncrementalIndex, indexRepo } from "./indexer.js";
import type { RepoCache, RepoIdentity } from "./models.js";

export type CacheResolutionOptions = {
	stale?: boolean;
};

export type CacheResolutionResult = {
	cache: RepoCache;
	cacheStatus: "fresh" | "reindexed" | "stale";
};

export async function resolveCacheWithFreshness(
	identity: RepoIdentity,
	options: CacheResolutionOptions,
): Promise<CacheResolutionResult> {
	const cached = await readCacheForWorktree(
		identity.repoKey,
		identity.worktreeKey,
	);

	if (!cached) {
		const cache = await indexRepo(identity.worktreePath);
		return { cache, cacheStatus: "reindexed" };
	}

	const fingerprint = await buildRepoFingerprint(identity.worktreePath);
	const fingerprintStale = cached.fingerprint !== fingerprint;
	const dirty = await isWorktreeDirty(identity.worktreePath);
	// Dirty-revert detection: cache was built from dirty worktree,
	// but worktree is now clean — cached content is stale
	const dirtyReverted = !dirty && !!cached.dirtyAtIndex;
	const isStale = fingerprintStale || dirty || dirtyReverted;

	if (!isStale) {
		return { cache: cached, cacheStatus: "fresh" };
	}

	if (options.stale) {
		return { cache: cached, cacheStatus: "stale" };
	}

	// Dirty-revert: git-diff sees no changes (worktree matches HEAD),
	// but cached hashes are stale. Force hash-compare so it detects
	// the delta between cached dirty hashes and clean disk content.
	const diff = await diffChangedFiles(identity, cached, {
		forceHashCompare: dirtyReverted,
	});
	const isDirtyRefresh = dirty;
	const cache = await buildIncrementalIndex(
		identity,
		cached,
		diff,
		isDirtyRefresh,
	);
	await writeCache(cache);
	return { cache, cacheStatus: "reindexed" };
}
