// src/lib/memory/surface.ts
import type { RetrieveHandle } from "./retrieve.js";
import { filterCandidates } from "./retrieve.js";
import { readMemoryVector } from "./embed.js";
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
	if (opts.topResults.length === 0) return [];
	if (!passesConfidenceGate(opts.mode, opts.topResults[0]!.score)) return [];

	const window = fileWindow(opts.topResults);
	if (window.length === 0) return [];

	const scopedThreshold = opts.scopedThreshold ?? TASK_MATCH_THRESHOLDS.scoped;
	const unscopedThreshold = opts.unscopedThreshold ?? TASK_MATCH_THRESHOLDS.unscoped;

	const candidates = filterCandidates(rh, {
		includeStatus: ["active"],
		candidatePoolSize: MEMORY_POOL_SIZE,
	});

	const matcher = createMatchCache();
	type RankedInternal = RelatedMemory & { _getCount: number };
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

		let v;
		try {
			v = await readMemoryVector(rh.repoKey, c.id);
		} catch {
			continue;
		}
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

	// Strip _getCount; wire shape is RelatedMemory.
	return ranked.map(({ _getCount: _ignored, ...rest }) => rest);
}
