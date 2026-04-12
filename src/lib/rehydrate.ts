// src/lib/rehydrate.ts
import fs from "node:fs";
import path from "node:path";
import { renderBriefing } from "./briefing.js";
import {
	buildRepoFingerprint,
	getCacheDir,
	isWorktreeDirty,
	readCacheForWorktree,
	writeCache,
} from "./cache-store.js";
import { diffChangedFiles } from "./diff-files.js";
import { indexRepo, buildIncrementalIndex } from "./indexer.js";
import { IndexError, RepoIdentityError } from "./models.js";
import type { RepoCache } from "./models.js";
import { resolveRepoIdentity } from "./repo-identity.js";

export type RehydrateOptions = {
	stale?: boolean;
};

export type RehydrateResult = {
	briefingPath: string;
	cacheStatus: "fresh" | "reindexed" | "stale";
	cache: RepoCache;
};

export function rehydrateRepo(
	repoPath: string,
	options?: RehydrateOptions,
): RehydrateResult {
	try {
		const identity = resolveRepoIdentity(repoPath);
		const cached = readCacheForWorktree(identity.repoKey, identity.worktreeKey);

		let cache: RepoCache;
		let cacheStatus: RehydrateResult["cacheStatus"];

		if (!cached) {
			cache = indexRepo(repoPath);
			cacheStatus = "reindexed";
		} else {
			const fingerprint = buildRepoFingerprint(identity.worktreePath);
			const fingerprintStale = cached.fingerprint !== fingerprint;
			const dirty = isWorktreeDirty(identity.worktreePath);
			// Dirty-revert detection: cache was built from dirty worktree,
			// but worktree is now clean — cached content is stale
			const dirtyReverted = !dirty && !!cached.dirtyAtIndex;
			const isStale = fingerprintStale || dirty || dirtyReverted;

			if (!isStale) {
				cache = cached;
				cacheStatus = "fresh";
			} else if (options?.stale) {
				cache = cached;
				cacheStatus = "stale";
			} else {
				// Dirty-revert: git-diff sees no changes (worktree matches HEAD),
				// but cached hashes are stale. Force hash-compare so it detects
				// the delta between cached dirty hashes and clean disk content.
				const diff = diffChangedFiles(identity, cached, {
					forceHashCompare: dirtyReverted,
				});
				const isDirtyRefresh = dirty;
				cache = buildIncrementalIndex(
					identity,
					cached,
					diff,
					isDirtyRefresh,
				);
				writeCache(cache);
				cacheStatus = "reindexed";
			}
		}

		const md = renderBriefing(cache);
		const dir = getCacheDir(identity.repoKey);
		fs.mkdirSync(dir, { recursive: true });
		const briefingPath = path.join(dir, `${identity.worktreeKey}.md`);
		fs.writeFileSync(briefingPath, md);

		return { briefingPath, cacheStatus, cache };
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		if (err instanceof IndexError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}
