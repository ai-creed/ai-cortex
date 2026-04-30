// src/lib/suggest-ranker-deep.ts
//
// Deep (superset) ranker. Reuses the fast ranker with an enlarged pool so that
// files ranked below the user's `limit` by fast-scoring can still be rescued
// by trigram fuzzy match + content scan. Always slices to `limit` at the end.

import { contentScan } from "./content-scanner.js";
import type { ContentHit } from "./content-scanner.js";
import type { RepoCache } from "./models.js";
import type { DeepSuggestItem } from "./suggest.js";
import { rankSuggestions } from "./suggest-ranker.js";
import { tokenize, tokenizeTask } from "./tokenize.js";
import { buildTrigramIndex, trigramQuery } from "./trigram-index.js";

export type DeepRankOptions = {
	from?: string | null;
	limit?: number;
	poolSize?: number;
	stale?: boolean;
};

export type DeepRankResult = {
	results: DeepSuggestItem[];
	poolSize: number;
	contentScanTruncated?: boolean;
	staleMixedEvidence?: boolean;
};

const TRIGRAM_WEIGHT = 4;
const CONTENT_SCORE_PER_TOKEN = 3;
const CONTENT_SCORE_CAP = 9;
const DEFAULT_POOL = 60;

export async function rankSuggestionsDeep(
	task: string,
	cache: RepoCache,
	worktreePath: string,
	opts: DeepRankOptions = {},
): Promise<DeepRankResult> {
	const limit = opts.limit ?? 5;
	const poolSize = Math.max(opts.poolSize ?? DEFAULT_POOL, limit);

	// 1. Fast ranker with enlarged pool.
	const fastResults = rankSuggestions(task, cache, {
		from: opts.from ?? null,
		poolSize,
	});

	const byPath = new Map<string, DeepSuggestItem>();
	for (const item of fastResults) {
		byPath.set(item.path, { ...item });
	}

	// 2. Per-token trigram index over each file's path + function-name tokens.
	const fnsByFile = new Map<string, string[]>();
	for (const fn of cache.functions ?? []) {
		const arr = fnsByFile.get(fn.file) ?? [];
		arr.push(fn.qualifiedName);
		fnsByFile.set(fn.file, arr);
	}
	const trigramItems = cache.files.map((f) => {
		const parts: string[] = [f.path, ...(fnsByFile.get(f.path) ?? [])];
		const tokenSet = new Set<string>();
		for (const part of parts) for (const t of tokenize(part)) tokenSet.add(t);
		return { id: f.path, tokens: [...tokenSet] };
	});
	const trigramIdx = buildTrigramIndex(trigramItems);

	const taskTokens = tokenizeTask(task);
	const trigramOnlyPaths = new Set<string>();
	for (const tok of taskTokens) {
		const hits = trigramQuery(trigramIdx, tok);
		for (const [path, { sim, matchedToken }] of hits) {
			const existing = byPath.get(path);
			const bonus = sim * TRIGRAM_WEIGHT;
			const label = `trigram:${tok}~${matchedToken}@${sim.toFixed(2)}`;
			if (existing) {
				existing.score += bonus;
				existing.reason += ` | ${label}`;
				existing.trigramMatches = [
					...(existing.trigramMatches ?? []),
					{ taskToken: tok, matchedToken, sim },
				];
			} else {
				byPath.set(path, {
					path,
					kind: "file",
					score: bonus,
					reason: label,
					trigramMatches: [{ taskToken: tok, matchedToken, sim }],
				});
				trigramOnlyPaths.add(path);
			}
		}
	}

	// 3. Content scan over the current candidate pool.
	// allFilePaths is passed so that any remaining budget (after fast+trigram
	// candidates) is filled with zero-scored files — essential for tiny repos or
	// queries with no path/function-name overlap, where content scan is the only
	// rescue path.
	const allFilePaths = cache.files.map((f) => f.path);
	const candidatePaths = buildCandidatePool(
		byPath,
		trigramOnlyPaths,
		poolSize,
		allFilePaths,
	);
	const scanResult = contentScan(worktreePath, candidatePaths, taskTokens);

	for (const [path, hits] of scanResult.hits) {
		const uniqueTokens = new Set(hits.map((h) => h.token)).size;
		const bonus = Math.min(
			uniqueTokens * CONTENT_SCORE_PER_TOKEN,
			CONTENT_SCORE_CAP,
		);
		const existing = byPath.get(path);
		const snippetHits: { line: number; snippet: string }[] = hits.map(
			(h: ContentHit) => ({
				line: h.line,
				snippet: h.snippet,
			}),
		);
		const firstHitLabel = hits[0]
			? `content:${hits[0].token}@L${hits[0].line}`
			: "content";
		if (existing) {
			existing.score += bonus;
			existing.reason += ` | ${firstHitLabel}`;
			existing.contentHits = snippetHits;
		} else {
			byPath.set(path, {
				path,
				kind: "file",
				score: bonus,
				reason: firstHitLabel,
				contentHits: snippetHits,
			});
		}
	}

	// 4. Re-sort and slice to user-facing limit.
	const sorted = [...byPath.values()].sort(
		(a, b) =>
			b.score - a.score ||
			(a.kind === b.kind ? 0 : a.kind === "file" ? -1 : 1) ||
			a.path.localeCompare(b.path),
	);

	return {
		results: sorted.slice(0, limit),
		poolSize,
		contentScanTruncated: scanResult.truncated || undefined,
		staleMixedEvidence: opts.stale ? true : undefined,
	};
}

/**
 * Produce the list of paths to feed to contentScan.
 *
 * Guarantees:
 * 1. Trigram-only rescues are prioritized over same-ranked fast entries.
 * 2. Total length is always ≤ `poolSize`.
 * 3. Remaining budget after trigram-only selection is filled with
 *    highest-scoring fast entries.
 * 4. Any remaining budget after fast+trigram entries is filled with zero-scored
 *    files from `allFilePaths` (essential for tiny repos or queries with no
 *    path/function-name overlap — content scan is the only rescue path there).
 */
function buildCandidatePool(
	byPath: Map<string, DeepSuggestItem>,
	trigramOnlyPaths: Set<string>,
	poolSize: number,
	allFilePaths: string[] = [],
): string[] {
	const trigramOnlyRanked = [...trigramOnlyPaths]
		.filter((p) => byPath.has(p))
		.map((p) => ({ path: p, score: byPath.get(p)!.score }))
		.sort((a, b) => b.score - a.score)
		.slice(0, poolSize)
		.map((x) => x.path);

	const budget = Math.max(0, poolSize - trigramOnlyRanked.length);
	if (budget === 0) return trigramOnlyRanked;

	const fastLike = [...byPath.values()]
		.filter((v) => !trigramOnlyPaths.has(v.path))
		.sort((a, b) => b.score - a.score)
		.slice(0, budget)
		.map((v) => v.path);

	const chosen = new Set([...fastLike, ...trigramOnlyRanked]);

	// Fill any remaining budget with zero-scored files not yet in the pool.
	// This ensures content scan can rescue files invisible to fast + trigram.
	const remaining = Math.max(0, poolSize - chosen.size);
	if (remaining > 0 && allFilePaths.length > 0) {
		let added = 0;
		for (const p of allFilePaths) {
			if (added >= remaining) break;
			if (!chosen.has(p)) {
				chosen.add(p);
				added++;
			}
		}
	}

	return [...chosen];
}
