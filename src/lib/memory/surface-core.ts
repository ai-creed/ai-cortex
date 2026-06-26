// src/lib/memory/surface-core.ts
import type { RetrieveHandle } from "./retrieve.js";
import { filterCandidates, getGenericTags } from "./retrieve.js";
import { createMatchCache, patternSpecificity } from "./scope-match.js";
import { normalize, tagOverlapScore } from "./tag-overlap.js";

export type SurfacePointer = {
	id: string;
	title: string;
	type: string;
	/** The target path (one of the inputs) this memory matched. */
	path: string;
	/** Which match tier produced this pointer. Tier 1 = file-scope; Tier 2 = tag-scope fallback. */
	tier?: "file" | "tag";
};

export type MatchSurfaceOpts = {
	tier2?: boolean;
	tier2MinScore?: number;
};

const POOL = 10_000;
const CAP = 5;
const DEFAULT_TIER2_MIN_SCORE = 1;
const GENERIC_TAG_MIN_COUNT = 9;

type Ranked = SurfacePointer & {
	_spec: number;
	_getCount: number;
	_updatedAt: string;
};

/**
 * Deterministic, project-tier, scopeFiles-only matcher for edit-time
 * surfacing (spec §4, §4.1). For each active memory whose file scope
 * (literal or glob) covers one of `relPaths`, emit a pointer. Unscoped
 * and tag-only memories are excluded by design. Ranked precision-first:
 * pattern specificity → getCount → recency. Capped at 5 total. No
 * embedding, no model load. Never bumps usage counters.
 *
 * When `opts.tier2` is true, after Tier 1 (file-scope matches) fills,
 * Tier 2 fallback considers remaining active memories by path-token /
 * tag-token overlap and fills up to the cap.
 */
export function matchSurfaceMemories(
	rh: RetrieveHandle,
	relPaths: string[],
	opts: MatchSurfaceOpts = {},
): SurfacePointer[] {
	if (relPaths.length === 0) return [];

	const candidates = filterCandidates(rh, {
		includeStatus: ["active"],
		scope: { files: relPaths },
		candidatePoolSize: POOL,
	});

	const matcher = createMatchCache();
	const ranked: Ranked[] = [];

	for (const c of candidates) {
		const fileScopes = rh.index
			.scopeRows(c.id)
			.filter((s) => s.kind === "file")
			.map((s) => s.value);
		if (fileScopes.length === 0) continue; // exclude unscoped/tag-only

		let bestSpec = -Infinity;
		let bestPath: string | null = null;
		for (const rel of relPaths) {
			for (const pat of fileScopes) {
				if (!matcher(pat, rel)) continue;
				const spec = patternSpecificity(pat);
				if (spec > bestSpec) {
					bestSpec = spec;
					bestPath = rel;
				}
			}
		}
		if (bestPath === null) continue;

		ranked.push({
			id: c.id,
			title: c.title,
			type: c.type,
			path: bestPath,
			tier: "file",
			_spec: bestSpec,
			_getCount: c.getCount,
			_updatedAt: c.updatedAt,
		});
	}

	const tier1 = ranked
		.sort((a, b) => {
			if (b._spec !== a._spec) return b._spec - a._spec;
			if (b._getCount !== a._getCount) return b._getCount - a._getCount;
			if (a._updatedAt !== b._updatedAt)
				return a._updatedAt < b._updatedAt ? 1 : -1;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		})
		.slice(0, CAP)
		.map(({ _spec, _getCount, _updatedAt, ...p }) => p);

	if (!opts.tier2 || tier1.length >= CAP) return tier1;

	const tier1Ids = new Set(tier1.map((p) => p.id));
	const pathTokens = new Set<string>();
	for (const rel of relPaths) for (const t of normalize(rel)) pathTokens.add(t);
	if (pathTokens.size === 0) return tier1;

	const tier2Candidates = filterCandidates(rh, {
		includeStatus: ["active"],
		candidatePoolSize: POOL,
	}).filter((c) => !tier1Ids.has(c.id));

	const genericTagSet = getGenericTags(rh, GENERIC_TAG_MIN_COUNT);
	const minScore = opts.tier2MinScore ?? DEFAULT_TIER2_MIN_SCORE;

	type Tier2Ranked = SurfacePointer & {
		_score: number;
		_getCount: number;
		_updatedAt: string;
	};
	const tier2Ranked: Tier2Ranked[] = [];
	for (const c of tier2Candidates) {
		const tagValues = rh.index
			.scopeRows(c.id)
			.filter((s) => s.kind === "tag")
			.map((s) => s.value);
		if (tagValues.length === 0) continue;
		const score = tagOverlapScore(pathTokens, tagValues, genericTagSet);
		if (score < minScore) continue;
		tier2Ranked.push({
			id: c.id,
			title: c.title,
			type: c.type,
			path: relPaths[0]!,
			tier: "tag",
			_score: score,
			_getCount: c.getCount,
			_updatedAt: c.updatedAt,
		});
	}

	tier2Ranked.sort((a, b) => {
		if (b._score !== a._score) return b._score - a._score;
		if (b._getCount !== a._getCount) return b._getCount - a._getCount;
		if (a._updatedAt !== b._updatedAt)
			return a._updatedAt < b._updatedAt ? 1 : -1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	const tier2 = tier2Ranked
		.slice(0, CAP - tier1.length)
		.map(({ _score, _getCount, _updatedAt, ...p }) => p);

	return [...tier1, ...tier2];
}
