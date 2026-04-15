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
	mode?: "fast" | "deep";
	/** Deep-only. Default 60, max 200. Ignored in fast mode. */
	poolSize?: number;
};

export type SuggestItem = {
	path: string;
	kind: "file" | "doc";
	score: number;
	reason: string;
};

export type DeepSuggestItem = SuggestItem & {
	contentHits?: { line: number; snippet: string }[];
	trigramMatches?: { taskToken: string; matchedToken: string; sim: number }[];
};

type SuggestResultCommon = {
	cacheStatus: "fresh" | "reindexed" | "stale";
	durationMs: number;
	task: string;
	from: string | null;
};

export type FastSuggestResult = SuggestResultCommon & {
	mode: "fast";
	results: SuggestItem[];
};

export type DeepSuggestResult = SuggestResultCommon & {
	mode: "deep";
	results: DeepSuggestItem[];
	poolSize: number;
	contentScanTruncated?: boolean;
	staleMixedEvidence?: boolean;
};

export type SuggestResult = FastSuggestResult | DeepSuggestResult;

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

		if (
			options.poolSize !== undefined &&
			(!Number.isInteger(options.poolSize) ||
				options.poolSize < 1 ||
				options.poolSize > 200)
		) {
			throw new IndexError("suggest poolSize must be an integer in [1, 200]");
		}
		if (options.mode !== undefined && options.mode !== "fast" && options.mode !== "deep") {
			throw new IndexError(`suggest mode must be 'fast' or 'deep' (got '${options.mode}')`);
		}

		let cache: RepoCache;
		let cacheStatus: SuggestResultCommon["cacheStatus"];

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
		const mode = options.mode ?? "fast";
		const startedAt = Date.now();

		if (mode === "fast") {
			const results = rankSuggestions(task, cache, {
				from,
				limit: options.limit,
			});
			return {
				mode: "fast",
				cacheStatus,
				task,
				from,
				results,
				durationMs: Date.now() - startedAt,
			} satisfies FastSuggestResult;
		}

		// mode === "deep" — delegated to Task 9
		const { rankSuggestionsDeep } = await import("./suggest-ranker-deep.js");
		const deepResult = await rankSuggestionsDeep(task, cache, identity.worktreePath, {
			from,
			limit: options.limit,
			poolSize: options.poolSize,
			stale: cacheStatus === "stale",
		});
		return {
			mode: "deep",
			cacheStatus,
			task,
			from,
			results: deepResult.results,
			poolSize: deepResult.poolSize,
			contentScanTruncated: deepResult.contentScanTruncated,
			staleMixedEvidence: deepResult.staleMixedEvidence,
			durationMs: Date.now() - startedAt,
		} satisfies DeepSuggestResult;
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		if (err instanceof IndexError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}
