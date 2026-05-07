// src/lib/memory/surface.ts
import type { RetrieveHandle } from "./retrieve.js";
import { filterCandidates } from "./retrieve.js";
import { openMemoryVectorIndex } from "./embed.js";
import { createMatchCache } from "./scope-match.js";
import type { RelatedMemory } from "../suggest.js";

export const RANKER_CONFIDENCE_FLOORS = {
	fast: 10,
	deep: 15,
	semantic: 0.5,
} as const;

export const TASK_MATCH_THRESHOLDS = {
	scoped: 0.45,
	unscoped: 0.6,
} as const;

const FILE_WINDOW_RATIO = 0.7;
const FILE_WINDOW_CAP = 3;
const MEMORY_POOL_SIZE = 10000;

export type SuggestMode = "fast" | "deep" | "semantic";

export type RankedFile = { path: string; score: number };

export type MatchOptions = {
	mode: SuggestMode;
	topResults: RankedFile[];
	taskVec: Float32Array;
	scopedThreshold?: number;
	unscopedThreshold?: number;
};

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function passesConfidenceGate(mode: SuggestMode, top1Score: number): boolean {
	return top1Score >= RANKER_CONFIDENCE_FLOORS[mode];
}

function fileWindow(top: RankedFile[]): string[] {
	if (top.length === 0) return [];
	const top1 = top[0]!.score;
	const cutoff = top1 * FILE_WINDOW_RATIO;
	const passing = top.filter((r) => r.score >= cutoff);
	return passing.slice(0, FILE_WINDOW_CAP).map((r) => r.path);
}

// Internal shape carrying _getCount for tiebreaking across merge operations.
type RankedInternal = RelatedMemory & { _getCount: number };

/**
 * Internal per-store matcher. Walks active memories, applies confidence gates,
 * scoped/unscoped routing with glob-aware overlap, cosine threshold, sorts
 * (with getCount tiebreak), and returns the internal shape (with _getCount).
 * The public matchMemories strips _getCount; the cross-tier wrapper uses this
 * directly so _getCount survives the merge sort.
 */
async function matchMemoriesInternal(
	rh: RetrieveHandle,
	opts: MatchOptions,
): Promise<RankedInternal[]> {
	if (opts.topResults.length === 0) return [];
	if (!passesConfidenceGate(opts.mode, opts.topResults[0]!.score)) return [];

	const window = fileWindow(opts.topResults);
	if (window.length === 0) return [];

	const scopedThreshold = opts.scopedThreshold ?? TASK_MATCH_THRESHOLDS.scoped;
	const unscopedThreshold = opts.unscopedThreshold ?? TASK_MATCH_THRESHOLDS.unscoped;

	let lookupVector: Awaited<ReturnType<typeof openMemoryVectorIndex>> = null;
	try {
		lookupVector = await openMemoryVectorIndex(rh.repoKey);
	} catch {
		return []; // sidecar corruption; the matcher returns no surfacing
	}
	if (!lookupVector) return []; // no sidecar yet

	const candidates = filterCandidates(rh, {
		includeStatus: ["active"],
		candidatePoolSize: MEMORY_POOL_SIZE,
	});

	const matcher = createMatchCache();
	const ranked: RankedInternal[] = [];

	for (const c of candidates) {
		const scopeRows = rh.index.scopeRows(c.id);
		const fileScope = scopeRows
			.filter((s) => s.kind === "file")
			.map((s) => s.value);
		const tagScope = scopeRows
			.filter((s) => s.kind === "tag")
			.map((s) => s.value);

		let track: "scoped" | "unscoped";
		let fileOverlap: string[] = [];

		if (fileScope.length === 0) {
			track = "unscoped";
		} else {
			// fileOverlap holds matched WINDOW paths (not stored patterns).
			fileOverlap = window.filter((f) =>
				fileScope.some((p) => matcher(p, f)),
			);
			if (fileOverlap.length === 0) continue;
			track = "scoped";
		}

		const v = lookupVector(c.id);
		if (!v) continue;

		const taskScore = cosine(opts.taskVec, v.vector);
		const threshold = track === "scoped" ? scopedThreshold : unscopedThreshold;
		if (taskScore < threshold) continue;

		ranked.push({
			id: c.id,
			title: c.title,
			track,
			scope: { files: fileScope, tags: tagScope },
			matchScores: { task: taskScore, fileOverlap },
			_getCount: c.getCount,
		});
	}

	ranked.sort((a, b) => {
		if (b.matchScores.task !== a.matchScores.task) {
			return b.matchScores.task - a.matchScores.task;
		}
		if (b._getCount !== a._getCount) return b._getCount - a._getCount;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	return ranked;
}

/**
 * Per-store matcher. Walks active memories in the given store, applies
 * confidence gates, scoped/unscoped routing with glob-aware overlap, cosine
 * threshold, sorts (with getCount tiebreak), and returns the wire-shape array.
 * The cross-tier wrapper applies the final cap.
 */
export async function matchMemories(
	rh: RetrieveHandle,
	opts: MatchOptions,
): Promise<RelatedMemory[]> {
	const ranked = await matchMemoriesInternal(rh, opts);
	// Strip _getCount; wire shape is RelatedMemory.
	return ranked.map(({ _getCount: _ignored, ...rest }) => rest);
}

const PROJECT_BOOST = 0.1;
const FINAL_CAP = 3;

/**
 * Cross-tier matcher mirroring recallMemoryCrossTier in retrieve.ts:363.
 * Caller opens both RetrieveHandles; this function does NOT close them.
 * Project-tier results get a small score boost on the *internal sort key* so
 * that, all else equal, the project's own rules outrank global rules — but
 * matchScores.task on the wire stays the raw cosine ∈ [0, 1] per the spec.
 *
 * Either store failing (throw during walk) is tolerated — the other side's
 * results pass through. Only if both throw does the function return [].
 */
export async function matchMemoriesCrossTier(
	projectRh: RetrieveHandle,
	globalRh: RetrieveHandle,
	opts: MatchOptions,
): Promise<RelatedMemory[]> {
	const safe = async (rh: RetrieveHandle): Promise<RankedInternal[]> => {
		try {
			return await matchMemoriesInternal(rh, opts);
		} catch {
			return [];
		}
	};

	const [projectRaw, globalRaw] = await Promise.all([
		safe(projectRh),
		safe(globalRh),
	]);

	type WithSortKey = RankedInternal & { _sortKey: number };
	const projectKeyed: WithSortKey[] = projectRaw.map((r) => ({
		...r,
		_sortKey: r.matchScores.task + PROJECT_BOOST,
	}));
	const globalKeyed: WithSortKey[] = globalRaw.map((r) => ({
		...r,
		_sortKey: r.matchScores.task,
	}));

	const merged = [...projectKeyed, ...globalKeyed];
	merged.sort((a, b) => {
		if (b._sortKey !== a._sortKey) return b._sortKey - a._sortKey;
		if (b._getCount !== a._getCount) return b._getCount - a._getCount;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	// Strip both internal fields before returning the wire shape.
	return merged
		.slice(0, FINAL_CAP)
		.map(({ _sortKey: _ignoredSort, _getCount: _ignoredCount, ...rest }) => rest);
}
