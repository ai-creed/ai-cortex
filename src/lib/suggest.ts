// src/lib/suggest.ts
import {
	buildRepoFingerprint,
	isWorktreeDirty,
	readCacheForWorktree,
	writeCache,
} from "./cache-store.js";
import { diffChangedFiles } from "./diff-files.js";
import { buildIncrementalIndex, indexRepo } from "./indexer.js";
import { IndexError, RepoIdentityError } from "./models.js";
import type { RepoCache } from "./models.js";
import { resolveRepoIdentity } from "./repo-identity.js";
import { rankSuggestions } from "./suggest-ranker.js";

export type SuggestOptions = {
	from?: string;
	limit?: number;
	stale?: boolean;
};

export type SuggestItem = {
	path: string;
	kind: "file" | "doc";
	score: number;
	reason: string;
};

export type SuggestResult = {
	cacheStatus: "fresh" | "reindexed" | "stale";
	task: string;
	from: string | null;
	results: SuggestItem[];
};

function normalizeFrom(value: string | undefined, cache: RepoCache): string | null {
	if (!value) return null;
	const normalized = value.replace(/\\/g, "/").replace(/^\.?\//, "");
	return cache.files.some((file) => file.path === normalized) ? normalized : null;
}

export async function suggestRepo(
	repoPath: string,
	task: string,
	options: SuggestOptions = {},
): Promise<SuggestResult> {
	try {
		if (task.trim().length === 0) {
			throw new IndexError("suggest task must not be empty");
		}
		if (
			options.limit !== undefined &&
			(!Number.isInteger(options.limit) || options.limit < 1)
		) {
			throw new IndexError("suggest limit must be a positive integer");
		}

		const identity = resolveRepoIdentity(repoPath);
		const cached = readCacheForWorktree(identity.repoKey, identity.worktreeKey);

		let cache: RepoCache;
		let cacheStatus: SuggestResult["cacheStatus"];

		if (!cached) {
			cache = await indexRepo(repoPath);
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
			} else if (options.stale) {
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
				cache = await buildIncrementalIndex(identity, cached, diff, isDirtyRefresh);
				writeCache(cache);
				cacheStatus = "reindexed";
			}
		}

		const from = normalizeFrom(options.from, cache);
		const results = rankSuggestions(task, cache, {
			from,
			limit: options.limit,
		});

		return { cacheStatus, task, from, results };
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		if (err instanceof IndexError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}
