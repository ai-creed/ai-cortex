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
import { z } from "zod";

export type SuggestOptions = {
	from?: string;
	limit?: number;
	stale?: boolean;
	mode?: "fast" | "deep" | "semantic";
	/** Deep-only. Default 60, max 200. Ignored in fast mode. */
	poolSize?: number;
	/** Include trigramMatches in deep results. Default false. */
	verbose?: boolean;
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

export type SemanticSuggestItem = SuggestItem;

export type SemanticSuggestResult = SuggestResultCommon & {
	mode: "semantic";
	results: SemanticSuggestItem[];
	poolSize: number;
};

export type SuggestResult = FastSuggestResult | DeepSuggestResult | SemanticSuggestResult;

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
		if (
			options.mode !== undefined &&
			options.mode !== "fast" &&
			options.mode !== "deep" &&
			options.mode !== "semantic"
		) {
			throw new IndexError(`suggest mode must be 'fast', 'deep', or 'semantic' (got '${options.mode}')`);
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

		if (mode === "deep") {
			// mode === "deep" — delegated to Task 9
			const { rankSuggestionsDeep } = await import("./suggest-ranker-deep.js");
			const deepResult = await rankSuggestionsDeep(task, cache, identity.worktreePath, {
				from,
				limit: options.limit,
				poolSize: options.poolSize,
				stale: cacheStatus === "stale",
			});
			const results = options.verbose
				? deepResult.results
				: deepResult.results.map(({ trigramMatches: _trigramMatches, ...rest }) => rest);
			return {
				mode: "deep",
				cacheStatus,
				task,
				from,
				results,
				poolSize: deepResult.poolSize,
				contentScanTruncated: deepResult.contentScanTruncated,
				staleMixedEvidence: deepResult.staleMixedEvidence,
				durationMs: Date.now() - startedAt,
			} satisfies DeepSuggestResult;
		}

		if (mode === "semantic") {
			const { rankSuggestionsSemanticCore } = await import("./suggest-ranker-semantic.js");
			const semanticResult = await rankSuggestionsSemanticCore(task, cache, identity.worktreePath, {
				limit: options.limit,
				stale: cacheStatus === "stale",
			});
			return {
				mode: "semantic" as const,
				cacheStatus,
				task,
				from, // echoed for API consistency; semantic ranking does not use caller context
				results: semanticResult.results as SemanticSuggestItem[],
				poolSize: semanticResult.poolSize,
				durationMs: Date.now() - startedAt,
			} satisfies SemanticSuggestResult;
		}

		throw new IndexError(`unhandled suggest mode: '${mode}'`);
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		if (err instanceof IndexError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}

const SuggestItemSchema = z.object({
	path: z.string(),
	kind: z.enum(["file", "doc"]),
	score: z.number(),
	reason: z.string(),
});

const DeepSuggestItemSchema = SuggestItemSchema.extend({
	contentHits: z
		.array(z.object({ line: z.number(), snippet: z.string() }))
		.optional(),
	trigramMatches: z
		.array(
			z.object({
				taskToken: z.string(),
				matchedToken: z.string(),
				sim: z.number(),
			}),
		)
		.optional(),
});

const SuggestResultCommonSchema = z.object({
	cacheStatus: z.enum(["fresh", "reindexed", "stale"]),
	durationMs: z.number(),
	task: z.string(),
	from: z.string().nullable(),
});

export const FastSuggestResultSchema = SuggestResultCommonSchema.extend({
	mode: z.literal("fast"),
	results: z.array(SuggestItemSchema),
});

export const DeepSuggestResultSchema = SuggestResultCommonSchema.extend({
	mode: z.literal("deep"),
	results: z.array(DeepSuggestItemSchema),
	poolSize: z.number(),
	contentScanTruncated: z.boolean().optional(),
	staleMixedEvidence: z.boolean().optional(),
});

export const SemanticSuggestResultSchema = SuggestResultCommonSchema.extend({
	mode: z.literal("semantic"),
	results: z.array(SuggestItemSchema),
	poolSize: z.number(),
});
